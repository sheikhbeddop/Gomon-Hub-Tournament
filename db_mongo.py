import os
import sys
import json
import time
import sqlite3
import hashlib
from datetime import datetime, timedelta


# UTF-8 encoding support
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "tournament.db")
CONFIG_FILE = os.path.join(BASE_DIR, "mongo_config.json")

# -------------------------------------------------------------------
# MongoDB Connection Configuration
# -------------------------------------------------------------------
DEFAULT_MONGO_URI = "mongodb+srv://sheikhmeraj042_db_user:9GMp9zBzHaKUwb9u@mytournament.ochkb49.mongodb.net/tournamentDB?appName=mytournament"

def get_mongo_uri() -> str:
    """Retrieve MongoDB URI from environment variable, mongo_config.json, or fallback."""
    uri = os.environ.get("MONGO_URI", "").strip()
    if uri:
        return uri
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                val = data.get("mongo_uri", "").strip()
                if val:
                    return val
        except Exception:
            pass
    return DEFAULT_MONGO_URI

_mongo_client = None
_mongo_db = None

def get_mongo_database():
    """Returns the MongoDB database instance if connected, else None."""
    global _mongo_client, _mongo_db
    if _mongo_db is not None:
        return _mongo_db

    uri = get_mongo_uri()
    if not uri:
        return None

    try:
        import pymongo
        # Server selection timeout: 5 seconds
        client = pymongo.MongoClient(uri, serverSelectionTimeoutMS=5000, connectTimeoutMS=5000)
        # Verify connection
        client.admin.command('ping')
        _mongo_client = client
        
        # Default database name: ff_tournaments (or extract from URI if present)
        parsed_db = None
        try:
            from pymongo.uri_parser import parse_uri
            parsed_db = parse_uri(uri).get('database')
        except Exception:
            pass
        db_name = parsed_db or "ff_tournaments"
        _mongo_db = client[db_name]
        print(f"[MongoDB] Successfully connected to MongoDB Atlas database: '{db_name}'")
        return _mongo_db
    except Exception as e:
        print(f"[MongoDB Warning] Could not connect to MongoDB: {e}")
        return None

def is_mongo_connected() -> bool:
    """Check if MongoDB is actively reachable."""
    db = get_mongo_database()
    return db is not None

# -------------------------------------------------------------------
# Collections List
# -------------------------------------------------------------------
TABLES_TO_COLLECTIONS = [
    "users",
    "matches",
    "participations",
    "deposits",
    "withdrawals",
    "audit_logs",
    "settings",
    "match_code_sequences",
    "push_subscriptions",
    "match_results",
    "banned_records"
]

# -------------------------------------------------------------------
# Push SQLite Data to MongoDB Collections (Zero Data Loss)
# -------------------------------------------------------------------
def push_sqlite_to_mongo(conn=None) -> bool:
    """Reads all records from SQLite and saves them into MongoDB collections."""
    # STRICT PRODUCTION GUARD: Only Render (Live Web) can push to production MongoDB Atlas!
    # Local development on PC is strictly BLOCKED from pushing test users to live Atlas.
    if not (os.environ.get("RENDER") or os.environ.get("PRODUCTION") or os.environ.get("FORCE_MONGO_PUSH")):
        print("[MongoDB Guard] Local development: Push to production Atlas blocked to protect live client data.")
        return False

    db = get_mongo_database()
    if db is None:
        return False

    should_close = False
    if conn is None:
        if not os.path.exists(DB_PATH):
            return False
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        should_close = True

    try:
        # SAFETY GUARD: Never wipe MongoDB if local SQLite has 0 users but MongoDB has users!
        try:
            sqlite_user_cnt = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            if sqlite_user_cnt == 0:
                mongo_user_cnt = db["users"].count_documents({})
                if mongo_user_cnt > 0:
                    print(f"[MongoDB Guard] SQLite has 0 users but MongoDB has {mongo_user_cnt} users! Auto-recovering from MongoDB...")
                    if should_close:
                        conn.close()
                        should_close = False
                    pull_mongo_to_sqlite()
                    return True
        except Exception:
            pass

        for table in TABLES_TO_COLLECTIONS:
            try:
                cursor = conn.execute(f"SELECT * FROM {table}")
                col_names = [d[0] for d in cursor.description] if cursor.description else []
                rows = cursor.fetchall()
            except Exception:
                continue

            col = db[table]
            if not rows:
                continue

            docs = []
            for r in rows:
                if isinstance(r, sqlite3.Row) or isinstance(r, dict):
                    doc = dict(r)
                else:
                    doc = dict(zip(col_names, r))

                # Map SQLite 'id' or 'key' for MongoDB indexing
                if "id" in doc:
                    doc["_id"] = doc["id"]
                elif "key" in doc:
                    doc["_id"] = doc["key"]
                elif "category" in doc:
                    doc["_id"] = doc["category"]
                elif "endpoint" in doc:
                    doc["_id"] = doc["endpoint"]
                docs.append(doc)

            # Upsert into MongoDB
            import pymongo
            for d in docs:
                col.replace_one({"_id": d["_id"]}, d, upsert=True)

            # Purge deleted records from MongoDB collections so deleted ghosts never return
            if docs:
                current_ids = [d["_id"] for d in docs]
                col.delete_many({"_id": {"$nin": current_ids}})
            elif table not in ["users", "settings"]:
                col.delete_many({})

        # Also store full binary snapshot with hash for instant recovery
        actual_db_path = DB_PATH
        try:
            cur = conn.cursor()
            cur.execute("PRAGMA database_list")
            dblist = cur.fetchall()
            if dblist and len(dblist) > 0:
                p = dblist[0][2] if isinstance(dblist[0], (tuple, list)) else dblist[0]["file"]
                if p:
                    actual_db_path = p
        except Exception:
            pass

        if os.path.exists(actual_db_path):
            with open(actual_db_path, "rb") as f:
                db_bytes = f.read()
            if db_bytes:
                db["db_snapshots"].replace_one(
                    {"_id": "latest"},
                    {
                        "_id": "latest",
                        "data": db_bytes,
                        "size": len(db_bytes),
                        "updated_at": datetime.utcnow().isoformat(),
                        "hash": hashlib.md5(db_bytes).hexdigest()
                    },
                    upsert=True
                )
        print("[MongoDB] Synced SQLite database to MongoDB Atlas successfully.")
        return True
    except Exception as e:
        print(f"[MongoDB Error] Failed to push to MongoDB: {e}")
        return False
    finally:
        if should_close:
            conn.close()

# -------------------------------------------------------------------
# Pull Data from MongoDB into SQLite (Automatic Recovery on Deploy)
# -------------------------------------------------------------------
def pull_mongo_to_sqlite(target_path=DB_PATH) -> bool:
    """Restores SQLite database from MongoDB Atlas with zero data loss guarantee."""
    db = get_mongo_database()
    if db is None:
        return False

    try:
        # 1. Restore binary snapshot if exists
        snap = db["db_snapshots"].find_one({"_id": "latest"})
        if snap and "data" in snap and snap["data"]:
            with open(target_path, "wb") as f:
                f.write(snap["data"])
            print(f"[MongoDB] Restored full database from MongoDB Atlas snapshot ({snap.get('size', 0)} bytes).")

        # 2. Re-sync table records from MongoDB collections to ensure 100% latest documents
        if not os.path.exists(target_path):
            # If target db does not exist, let init_db create schema first
            return True

        conn = sqlite3.connect(target_path)
        conn.row_factory = sqlite3.Row
        with conn:
            for table in TABLES_TO_COLLECTIONS:
                try:
                    cursor = conn.execute(f"SELECT * FROM {table} LIMIT 0")
                    col_names = [d[0] for d in cursor.description]
                except Exception:
                    continue

                col = db[table]
                docs = list(col.find())
                if not docs:
                    continue

                for doc in docs:
                    fields = [k for k in doc.keys() if k in col_names]
                    if not fields:
                        continue
                    placeholders = ", ".join(["?"] * len(fields))
                    field_str = ", ".join(fields)
                    values = [doc[k] for k in fields]
                    try:
                        conn.execute(
                            f"INSERT OR REPLACE INTO {table} ({field_str}) VALUES ({placeholders})",
                            values
                        )
                    except Exception:
                        pass
        conn.close()
        print("[MongoDB] Collections re-synchronized into SQLite successfully.")
        return True
    except Exception as e:
        print(f"[MongoDB Error] Failed to pull from MongoDB: {e}")
        return False

# -------------------------------------------------------------------
# Auto-Sync Hook on Database Write
# -------------------------------------------------------------------
_last_sync_time = 0

def notify_db_change(table_name: str, doc_data: dict = None):
    """Called after an INSERT / UPDATE / DELETE to keep MongoDB in sync."""
    global _last_sync_time
    # Throttle full snapshot syncs to avoid excessive network calls, but sync changes
    now = time.time()
    db = get_mongo_database()
    if db is None:
        return

    try:
        if doc_data and table_name in TABLES_TO_COLLECTIONS:
            doc = dict(doc_data)
            if "id" in doc:
                doc["_id"] = doc["id"]
            elif "key" in doc:
                doc["_id"] = doc["key"]
            col = db[table_name]
            if "_id" in doc:
                col.replace_one({"_id": doc["_id"]}, doc, upsert=True)

        # Trigger full periodic sync every 30 seconds if active
        if now - _last_sync_time > 30:
            _last_sync_time = now
            import threading
            threading.Thread(target=push_sqlite_to_mongo, daemon=True).start()
    except Exception as e:
        print(f"[MongoDB Sync Notice] {e}")

def sync_db_async():
    """Instantly pushes database changes to MongoDB in an asynchronous thread."""
    import threading
    threading.Thread(target=push_sqlite_to_mongo, daemon=True).start()

def purge_records_older_than_15_days(db=None):
    """
    Permanently purges records older than 15 days from both SQLite and MongoDB Atlas:
    - Completed matches, their match_results, and participations
    - Approved/rejected deposits older than 15 days
    - Approved/rejected withdrawals older than 15 days
    'Jate r jibone o try korle khuija pawa na jay... mongo thekei dlt hoite Hobe'
    """
    cutoff_dt = datetime.utcnow() - timedelta(days=15)
    cutoff_str = cutoff_dt.strftime("%Y-%m-%d %H:%M:%S")
    cutoff_iso = cutoff_dt.isoformat()

    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    purged_counts = {"matches": 0, "results": 0, "participations": 0, "deposits": 0, "withdrawals": 0}
    old_match_ids = []
    old_dep_ids = []
    old_wd_ids = []

    try:
        # 1. Identify old completed matches
        cursor.execute("""
            SELECT id FROM matches 
            WHERE status = 'completed' 
            AND (
                (completed_at IS NOT NULL AND completed_at != '' AND completed_at < ?)
                OR ((completed_at IS NULL OR completed_at = '') AND created_at < ?)
            )
        """, (cutoff_str, cutoff_str))
        old_match_rows = cursor.fetchall()
        old_match_ids = [int(row["id"]) for row in old_match_rows]

        if old_match_ids:
            placeholders = ",".join(["?"] * len(old_match_ids))
            
            # Delete match_results
            cursor.execute(f"DELETE FROM match_results WHERE match_id IN ({placeholders})", old_match_ids)
            purged_counts["results"] = cursor.rowcount

            # Delete participations
            cursor.execute(f"DELETE FROM participations WHERE match_id IN ({placeholders})", old_match_ids)
            purged_counts["participations"] = cursor.rowcount

            # Delete matches
            cursor.execute(f"DELETE FROM matches WHERE id IN ({placeholders})", old_match_ids)
            purged_counts["matches"] = cursor.rowcount

        # 2. Identify old deposits (approved or rejected)
        cursor.execute("""
            SELECT id FROM deposits
            WHERE status IN ('approved', 'rejected')
            AND (
                (reviewed_at IS NOT NULL AND reviewed_at != '' AND reviewed_at < ?)
                OR ((reviewed_at IS NULL OR reviewed_at = '') AND created_at < ?)
            )
        """, (cutoff_str, cutoff_str))
        old_dep_ids = [int(row["id"]) for row in cursor.fetchall()]
        if old_dep_ids:
            placeholders = ",".join(["?"] * len(old_dep_ids))
            cursor.execute(f"DELETE FROM deposits WHERE id IN ({placeholders})", old_dep_ids)
            purged_counts["deposits"] = cursor.rowcount

        # 3. Identify old withdrawals (approved or rejected)
        cursor.execute("""
            SELECT id FROM withdrawals
            WHERE status IN ('approved', 'rejected')
            AND (
                (reviewed_at IS NOT NULL AND reviewed_at != '' AND reviewed_at < ?)
                OR ((reviewed_at IS NULL OR reviewed_at = '') AND created_at < ?)
            )
        """, (cutoff_str, cutoff_str))
        old_wd_ids = [int(row["id"]) for row in cursor.fetchall()]
        if old_wd_ids:
            placeholders = ",".join(["?"] * len(old_wd_ids))
            cursor.execute(f"DELETE FROM withdrawals WHERE id IN ({placeholders})", old_wd_ids)
            purged_counts["withdrawals"] = cursor.rowcount

        conn.commit()
    except Exception as e:
        print(f"[Purge Error - SQLite] {e}")
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        conn.close()

    # Permanently purge from MongoDB Atlas
    mongo = db if db is not None else get_mongo_database()
    if mongo is not None:
        try:
            if old_match_ids:
                id_filter = old_match_ids + [str(x) for x in old_match_ids]
                mongo["matches"].delete_many({"$or": [{"id": {"$in": id_filter}}, {"_id": {"$in": id_filter}}]})
                mongo["match_results"].delete_many({"$or": [{"match_id": {"$in": id_filter}}, {"match_id": {"$in": old_match_ids}}]})
                mongo["participations"].delete_many({"$or": [{"match_id": {"$in": id_filter}}, {"match_id": {"$in": old_match_ids}}]})

            if old_dep_ids:
                id_filter = old_dep_ids + [str(x) for x in old_dep_ids]
                mongo["deposits"].delete_many({"$or": [{"id": {"$in": id_filter}}, {"_id": {"$in": id_filter}}]})

            if old_wd_ids:
                id_filter = old_wd_ids + [str(x) for x in old_wd_ids]
                mongo["withdrawals"].delete_many({"$or": [{"id": {"$in": id_filter}}, {"_id": {"$in": id_filter}}]})

            mongo["matches"].delete_many({
                "status": "completed",
                "$or": [
                    {"completed_at": {"$lt": cutoff_str}},
                    {"completed_at": {"$lt": cutoff_iso}},
                    {"created_at": {"$lt": cutoff_str}}
                ]
            })
            mongo["deposits"].delete_many({
                "status": {"$in": ["approved", "rejected"]},
                "$or": [
                    {"reviewed_at": {"$lt": cutoff_str}},
                    {"reviewed_at": {"$lt": cutoff_iso}},
                    {"created_at": {"$lt": cutoff_str}}
                ]
            })
            mongo["withdrawals"].delete_many({
                "status": {"$in": ["approved", "rejected"]},
                "$or": [
                    {"reviewed_at": {"$lt": cutoff_str}},
                    {"reviewed_at": {"$lt": cutoff_iso}},
                    {"created_at": {"$lt": cutoff_str}}
                ]
            })
        except Exception as e:
            print(f"[Purge Error - MongoDB] {e}")

    total_purged = sum(purged_counts.values())
    if total_purged > 0:
        print(f"[15-Day Auto-Purge] Purged {total_purged} expired records older than 15 days: {purged_counts}")
    return purged_counts


