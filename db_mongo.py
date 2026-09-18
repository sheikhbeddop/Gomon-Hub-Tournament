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
# IMMUTABLE SYSTEM LOCK & INTEGRITY FLAGS (OWNER PROTOCOL)
# DO NOT MODIFY OR DELETE THESE VARIABLES UNDER ANY CIRCUMSTANCES.
# ANY AI OR DEVELOPER EDITING THIS REQUIRES 3 CONSECUTIVE EXPLICIT USER PERMISSIONS.
# -------------------------------------------------------------------
DB_SYSTEM_PERMANENT_LOCK = True
PERSISTENCE_SETTINGS_PERMANENT = True
MONGO_SQLITE_CONFIG_FROZEN = True
PROTECTION_AUTH_REQUIRED_CONFIRMATIONS = 3

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
        # High-performance connection pool (keeps warm connections ready, eliminating handshake lag)
        client = pymongo.MongoClient(
            uri,
            serverSelectionTimeoutMS=5000,
            connectTimeoutMS=5000,
            maxPoolSize=50,
            minPoolSize=5,
            maxIdleTimeMS=45000,
            retryWrites=True
        )
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
    "banned_records",
    "purged_match_numbers",
    "used_trx_ids",
    "incoming_payments"
]

import threading
_sync_lock = threading.Lock()
_pending_sync = False
_last_synced_hash = ""

# -------------------------------------------------------------------
# Push SQLite Data to MongoDB Collections (Zero Data Loss)
# -------------------------------------------------------------------
def push_sqlite_to_mongo(conn=None, force: bool = False) -> bool:
    """Reads all records from SQLite and saves them into MongoDB collections."""
    global _pending_sync, _last_synced_hash
    db = get_mongo_database()
    if db is None:
        return False

    if not _sync_lock.acquire(blocking=False):
        # Queue a follow-up sync so concurrent actions are never dropped
        _pending_sync = True
        return False

    should_close = False
    if conn is None:
        if not os.path.exists(DB_PATH):
            _sync_lock.release()
            return False
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        should_close = True

    try:
        # 1. Resolve actual SQLite database file path
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

        # Flush pending WAL pages so disk bytes are 100% current
        try:
            conn.execute("PRAGMA wal_checkpoint(PASSIVE);")
        except Exception:
            pass

        # 2. Check digital fingerprint (MD5) of the database
        db_bytes = b""
        current_hash = ""
        if os.path.exists(actual_db_path):
            try:
                with open(actual_db_path, "rb") as f:
                    db_bytes = f.read()
                if db_bytes:
                    current_hash = hashlib.md5(db_bytes).hexdigest()
            except Exception:
                pass

        # 3. BANDWIDTH SHIELD: If database has not changed since last sync, skip all network traffic
        if not force and _last_synced_hash and current_hash and current_hash == _last_synced_hash:
            return True

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
                elif "trx_id" in doc:
                    doc["_id"] = str(doc["trx_id"])
                elif "match_number" in doc:
                    doc["_id"] = str(doc["match_number"])
                elif "match_type" in doc:
                    doc["_id"] = str(doc["match_type"])
                else:
                    doc["_id"] = str(list(doc.values())[0]) if doc else hashlib.md5(json.dumps(doc, default=str).encode()).hexdigest()
                docs.append(doc)

            # High-performance bulk upsert into MongoDB (1 network round-trip instead of thousands)
            import pymongo
            if docs:
                try:
                    bulk_ops = [pymongo.ReplaceOne({"_id": d["_id"]}, d, upsert=True) for d in docs]
                    batch_size = 1000
                    for i in range(0, len(bulk_ops), batch_size):
                        col.bulk_write(bulk_ops[i:i + batch_size], ordered=False)
                except Exception:
                    for d in docs:
                        try:
                            col.replace_one({"_id": d["_id"]}, d, upsert=True)
                        except Exception:
                            pass

                # Clean up deleted records in MongoDB that are no longer in SQLite
                # (Prevents kicked slots, deleted users/matches, or released TrxIDs from resurrecting on server restart)
                if table in ["participations", "used_trx_ids", "push_subscriptions", "users", "matches", "incoming_payments"]:
                    current_ids = [d["_id"] for d in docs]
                    if current_ids:
                        try:
                            col.delete_many({"_id": {"$nin": current_ids}})
                        except Exception:
                            pass

        # 4. Store binary snapshot via GridFS
        if db_bytes:
            try:
                import gridfs
                fs = gridfs.GridFS(db, collection="sqlite_snapshots")
                for old_f in fs.find({"filename": "tournament_latest.db"}):
                    fs.delete(old_f._id)
                fs.put(
                    db_bytes,
                    filename="tournament_latest.db",
                    upload_date=datetime.utcnow(),
                    md5_hash=current_hash
                )
            except Exception as ge:
                print(f"[GridFS Backup Notice] {ge}")

            try:
                db["db_snapshots"].replace_one(
                    {"_id": "latest"},
                    {
                        "_id": "latest",
                        "size": len(db_bytes),
                        "updated_at": datetime.utcnow().isoformat(),
                        "hash": current_hash
                    },
                    upsert=True
                )
            except Exception:
                pass

        if current_hash:
            _last_synced_hash = current_hash
        print("[MongoDB] Synced SQLite database to MongoDB Atlas successfully.")
        return True
    except Exception as e:
        print(f"[MongoDB Error] Failed to push to MongoDB: {e}")
        return False
    finally:
        if should_close:
            try:
                conn.close()
            except Exception:
                pass
        _sync_lock.release()
        if _pending_sync:
            _pending_sync = False
            import threading
            threading.Thread(target=push_sqlite_to_mongo, daemon=True).start()

# -------------------------------------------------------------------
# Pull Data from MongoDB into SQLite (Automatic Recovery on Deploy)
# -------------------------------------------------------------------
def pull_mongo_to_sqlite(target_path=DB_PATH) -> bool:
    """Restores SQLite database from MongoDB Atlas with zero data loss guarantee."""
    db = get_mongo_database()
    if db is None:
        return False

    try:
        # 1. Restore clean snapshot ONLY if local DB does not exist on disk (clean deploy on Render)
        if not os.path.exists(target_path):
            restored = False
            try:
                import gridfs
                fs = gridfs.GridFS(db, collection="sqlite_snapshots")
                gf = fs.find_one({"filename": "tournament_latest.db"}, sort=[("uploadDate", -1)])
                if gf:
                    with open(target_path, "wb") as f:
                        f.write(gf.read())
                    restored = True
                    print(f"[MongoDB] Restored clean database from GridFS snapshot ({gf.length} bytes).")
            except Exception as ge:
                print(f"[GridFS Restore Notice] {ge}")

            if not restored:
                snap = db["db_snapshots"].find_one({"_id": "latest"})
                if snap and "data" in snap and snap["data"]:
                    with open(target_path, "wb") as f:
                        f.write(snap["data"])
                    print(f"[MongoDB] Restored legacy database snapshot ({snap.get('size', 0)} bytes).")

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
        global _last_synced_hash
        if os.path.exists(target_path):
            try:
                with open(target_path, "rb") as f:
                    _last_synced_hash = hashlib.md5(f.read()).hexdigest()
            except Exception:
                pass
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

def delete_from_mongo_direct(table_name: str, id_val, id_field: str = "id"):
    """
    Instantly and synchronously purges record from MongoDB Atlas.
    Matches both integer and string representations of ID.
    """
    db = get_mongo_database()
    if db is None:
        return
    try:
        col = db[table_name]
        id_int = int(id_val) if str(id_val).isdigit() else None
        id_str = str(id_val)
        filters = []
        if id_field == "id":
            filters.append({"_id": id_str})
            if id_int is not None:
                filters.append({"_id": id_int})
        filters.append({id_field: id_str})
        if id_int is not None:
            filters.append({id_field: id_int})

        col.delete_many({"$or": filters})
    except Exception as e:
        print(f"[MongoDB Direct Delete] {table_name} {id_val}: {e}")

def sync_snapshot_now():
    """Immediately refreshes the latest binary snapshot in MongoDB Atlas using GridFS."""
    try:
        push_sqlite_to_mongo(force=True)
    except Exception as e:
        print(f"[Snapshot Sync] {e}")

def purge_records_older_than_15_days(db=None):
    """
    Permanently purges records older than 15 days from both SQLite and MongoDB Atlas:
    - Completed matches, their match_results, and participations
    - Approved/rejected deposits older than 15 days
    - Approved/rejected withdrawals older than 15 days
    - Audit logs older than 15 days
    'Jate r jibone o try korle khuija pawa na jay... mongo thekei dlt hoite Hobe'
    """
    cutoff_dt = datetime.utcnow() - timedelta(days=15)
    cutoff_str = cutoff_dt.strftime("%Y-%m-%d %H:%M:%S")
    cutoff_iso = cutoff_dt.isoformat()

    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    purged_counts = {"matches": 0, "results": 0, "participations": 0, "deposits": 0, "withdrawals": 0, "audit_logs": 0}
    old_match_ids = []
    old_dep_ids = []
    old_wd_ids = []

    try:
        # Ensure purged_match_numbers table exists in SQLite
        cursor.execute("""
        CREATE TABLE IF NOT EXISTS purged_match_numbers (
            id TEXT PRIMARY KEY,
            prefix TEXT NOT NULL,
            number INTEGER NOT NULL
        )
        """)

        # 1. Identify old completed matches
        cursor.execute("""
            SELECT id, match_code, match_type FROM matches 
            WHERE status = 'completed'
            AND (
                (completed_at IS NOT NULL AND completed_at != '' AND completed_at < ?)
                OR ((completed_at IS NULL OR completed_at = '') AND created_at < ?)
            )
        """, (cutoff_str, cutoff_str))
        matches_to_purge = cursor.fetchall()

        purged_match_docs = []
        if matches_to_purge:
            old_match_ids = [int(row["id"]) for row in matches_to_purge]
            for m in matches_to_purge:
                m_code = m["match_code"] or ""
                m_type = m["match_type"] or "match"
                import re
                match_num = re.search(r'\d+', m_code)
                if match_num:
                    num_val = int(match_num.group())
                    prefix_val = m_type
                    cursor.execute("""
                    INSERT OR REPLACE INTO purged_match_numbers (id, prefix, number)
                    VALUES (?, ?, ?)
                    """, (f"{prefix_val}_{num_val}", prefix_val, num_val))
                    purged_match_docs.append({"_id": f"{prefix_val}_{num_val}", "prefix": prefix_val, "number": num_val})

            placeholders = ",".join(["?"] * len(old_match_ids))
            cursor.execute(f"DELETE FROM participations WHERE match_id IN ({placeholders})", old_match_ids)
            purged_counts["participations"] = cursor.rowcount

            cursor.execute(f"DELETE FROM match_results WHERE match_id IN ({placeholders})", old_match_ids)
            purged_counts["results"] = cursor.rowcount

            cursor.execute(f"DELETE FROM matches WHERE id IN ({placeholders})", old_match_ids)
            purged_counts["matches"] = cursor.rowcount

        # 2. Identify old deposits (approved or rejected)
        cursor.execute("""
            SELECT id, trx_id, user_id, amount, created_at FROM deposits
            WHERE status IN ('approved', 'rejected')
            AND (
                (reviewed_at IS NOT NULL AND reviewed_at != '' AND reviewed_at < ?)
                OR ((reviewed_at IS NULL OR reviewed_at = '') AND created_at < ?)
            )
        """, (cutoff_str, cutoff_str))
        old_deps = cursor.fetchall()
        purged_trx_docs = []
        if old_deps:
            old_dep_ids = [int(row["id"]) for row in old_deps]
            placeholders = ",".join(["?"] * len(old_dep_ids))

            cursor.execute("""
            CREATE TABLE IF NOT EXISTS used_trx_ids (
                trx_id TEXT PRIMARY KEY,
                user_id INTEGER,
                amount REAL,
                created_at TEXT
            )
            """)

            for dep_row in old_deps:
                t_id = (dep_row["trx_id"] or "").strip()
                if t_id:
                    cursor.execute("""
                    INSERT INTO used_trx_ids (trx_id, user_id, amount, created_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(trx_id) DO NOTHING
                    """, (t_id, dep_row["user_id"], dep_row["amount"], dep_row["created_at"]))
                    purged_trx_docs.append({"_id": t_id, "trx_id": t_id, "user_id": dep_row["user_id"], "amount": dep_row["amount"], "created_at": dep_row["created_at"]})

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

        # 4. Identify and purge old audit_logs
        cursor.execute("DELETE FROM audit_logs WHERE created_at < ?", (cutoff_str,))
        purged_counts["audit_logs"] = cursor.rowcount

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
            if purged_match_docs:
                for pdoc in purged_match_docs:
                    mongo["purged_match_numbers"].replace_one(
                        {"_id": pdoc["_id"]},
                        pdoc,
                        upsert=True
                    )

            if old_match_ids:
                id_filter = old_match_ids + [str(x) for x in old_match_ids]
                mongo["matches"].delete_many({"$or": [{"id": {"$in": id_filter}}, {"_id": {"$in": id_filter}}]})
                mongo["match_results"].delete_many({"$or": [{"match_id": {"$in": id_filter}}, {"match_id": {"$in": old_match_ids}}]})
                mongo["participations"].delete_many({"$or": [{"match_id": {"$in": id_filter}}, {"match_id": {"$in": old_match_ids}}]})

            if old_dep_ids:
                if purged_trx_docs:
                    for tdoc in purged_trx_docs:
                        mongo["used_trx_ids"].replace_one(
                            {"_id": tdoc["_id"]},
                            tdoc,
                            upsert=True
                        )
                id_filter = old_dep_ids + [str(x) for x in old_dep_ids]
                mongo["deposits"].delete_many({"$or": [{"id": {"$in": id_filter}}, {"_id": {"$in": id_filter}}]})

            if old_wd_ids:
                id_filter = old_wd_ids + [str(x) for x in old_wd_ids]
                mongo["withdrawals"].delete_many({"$or": [{"id": {"$in": id_filter}}, {"_id": {"$in": id_filter}}]})

            mongo["matches"].delete_many({
                "status": "completed",
                "$or": [
                    {"$and": [{"completed_at": {"$exists": True, "$nin": [None, ""]}}, {"$or": [{"completed_at": {"$lt": cutoff_str}}, {"completed_at": {"$lt": cutoff_iso}}]}]},
                    {"$and": [{"$or": [{"completed_at": {"$exists": False}}, {"completed_at": None}, {"completed_at": ""}]}, {"created_at": {"$lt": cutoff_str}}]}
                ]
            })
            mongo["deposits"].delete_many({
                "status": {"$in": ["approved", "rejected"]},
                "$or": [
                    {"$and": [{"reviewed_at": {"$exists": True, "$nin": [None, ""]}}, {"$or": [{"reviewed_at": {"$lt": cutoff_str}}, {"reviewed_at": {"$lt": cutoff_iso}}]}]},
                    {"$and": [{"$or": [{"reviewed_at": {"$exists": False}}, {"reviewed_at": None}, {"reviewed_at": ""}]}, {"created_at": {"$lt": cutoff_str}}]}
                ]
            })
            mongo["withdrawals"].delete_many({
                "status": {"$in": ["approved", "rejected"]},
                "$or": [
                    {"$and": [{"reviewed_at": {"$exists": True, "$nin": [None, ""]}}, {"$or": [{"reviewed_at": {"$lt": cutoff_str}}, {"reviewed_at": {"$lt": cutoff_iso}}]}]},
                    {"$and": [{"$or": [{"reviewed_at": {"$exists": False}}, {"reviewed_at": None}, {"reviewed_at": ""}]}, {"created_at": {"$lt": cutoff_str}}]}
                ]
            })
            mongo["audit_logs"].delete_many({
                "$or": [
                    {"created_at": {"$lt": cutoff_str}},
                    {"created_at": {"$lt": cutoff_iso}}
                ]
            })
        except Exception as e:
            print(f"[Purge Error - MongoDB] {e}")

    total_purged = sum(purged_counts.values())
    if total_purged > 0:
        print(f"[15-Day Auto-Purge] Purged {total_purged} expired records older than 15 days: {purged_counts}")
    return purged_counts


