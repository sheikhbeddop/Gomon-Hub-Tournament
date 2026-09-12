import os
import sys
import json
import sqlite3

# UTF-8 encoding support
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

from db_mongo import get_mongo_uri, get_mongo_database, push_sqlite_to_mongo, pull_mongo_to_sqlite, DB_PATH

def main():
    print("========================================================")
    print("[*] FREE FIRE TOURNAMENT -> MONGODB MIGRATION TOOL")
    print("========================================================")
    
    uri = get_mongo_uri()
    if not uri:
        print("\n[!] ERROR: No MongoDB URI found!")
        print("Please provide your MongoDB URI either in:")
        print("1. 'mongo_config.json' file: {\"mongo_uri\": \"mongodb+srv://...\"}")
        print("2. Or set environment variable: set MONGO_URI=\"mongodb+srv://...\"\n")
        sys.exit(1)

    masked_uri = uri
    if "@" in uri:
        proto, rest = uri.split("://", 1)
        creds, host = rest.split("@", 1)
        masked_uri = f"{proto}://*****:*****@{host}"
    print(f"[*] MongoDB URI: {masked_uri}")

    print("[*] Connecting to MongoDB Atlas...")
    db = get_mongo_database()
    if db is None:
        print("[!] ERROR: Failed to connect to MongoDB Atlas.")
        print("Please check your internet connection and MongoDB credentials/IP whitelist (0.0.0.0/0).")
        sys.exit(1)

    print("[OK] Connected successfully to MongoDB Atlas!\n")

    action = "--push"
    if len(sys.argv) > 1:
        action = sys.argv[1].lower()

    if action in ["--pull", "pull"]:
        print("[*] Action: PULL (Restoring database from MongoDB Atlas to local)...")
        success = pull_mongo_to_sqlite()
        if success:
            print("\n[OK] Local database restored from MongoDB Atlas successfully!")
        else:
            print("\n[!] Failed to restore from MongoDB Atlas.")
    else:
        print("[*] Action: PUSH (Uploading local SQLite users & matches to MongoDB Atlas)...")
        if not os.path.exists(DB_PATH):
            print(f"[!] Local database {DB_PATH} not found!")
            sys.exit(1)

        conn = sqlite3.connect(DB_PATH)
        user_cnt = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        match_cnt = conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
        dep_cnt = conn.execute("SELECT COUNT(*) FROM deposits").fetchone()[0]
        conn.close()

        print(f"  - Local Users: {user_cnt}")
        print(f"  - Local Matches: {match_cnt}")
        print(f"  - Local Deposits: {dep_cnt}")

        print("\n[*] Uploading records to MongoDB Atlas collections...")
        success = push_sqlite_to_mongo()
        if success:
            print("\n========================================================")
            print("[OK] MIGRATION COMPLETED SUCCESSFULLY!")
            print(f"  + {user_cnt} users safely migrated to MongoDB.")
            print(f"  + {match_cnt} matches safely migrated to MongoDB.")
            print(f"  + {dep_cnt} deposits safely migrated to MongoDB.")
            print("[*] Your live data is now permanently safe in MongoDB Atlas!")
            print("========================================================\n")
        else:
            print("\n[!] Migration encountered an error.")

if __name__ == "__main__":
    main()
