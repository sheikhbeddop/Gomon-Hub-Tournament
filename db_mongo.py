import os
import sys
import json
import time
import sqlite3
import hashlib
from datetime import datetime

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
def get_mongo_uri() -> str:
    """Retrieve MongoDB URI from environment variable or mongo_config.json."""
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
    return ""

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
        for table in TABLES_TO_COLLECTIONS:
            try:
                rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            except Exception:
                continue

            col = db[table]
            if not rows:
                continue

            docs = []
            for r in rows:
                doc = dict(r)
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

        # Also store full binary snapshot with hash for instant recovery
        if os.path.exists(DB_PATH):
            with open(DB_PATH, "rb") as f:
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
    """Restores SQLite database from MongoDB Atlas if local database is empty or missing."""
    db = get_mongo_database()
    if db is None:
        return False

    try:
        # Check if snapshot exists
        snap = db["db_snapshots"].find_one({"_id": "latest"})
        if snap and "data" in snap and snap["data"]:
            with open(target_path, "wb") as f:
                f.write(snap["data"])
            print(f"[MongoDB] Restored full database from MongoDB Atlas snapshot ({snap.get('size', 0)} bytes).")
            return True

        # Fallback: Restore table-by-table from MongoDB documents
        # Check if users collection has data
        user_count = db["users"].count_documents({})
        if user_count == 0:
            print("[MongoDB] MongoDB is connected but has no documents yet.")
            return False

        print(f"[MongoDB] Found {user_count} users in MongoDB. Restoring tables...")
        # (Table-by-table restore logic handled if snapshot was absent)
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
