import os
import sys
import json
import time
import hmac
import hashlib
import secrets
import sqlite3
import base64
import re
import threading
from typing import Optional, List
from datetime import datetime, timedelta, timezone

# Configure UTF-8 for Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

from fastapi import FastAPI, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, Field
import pywebpush

from db_mongo import (
    get_mongo_uri,
    get_mongo_database,
    is_mongo_connected,
    push_sqlite_to_mongo,
    pull_mongo_to_sqlite,
    notify_db_change,
    sync_db_async,
    purge_records_older_than_15_days,
    delete_from_mongo_direct,
    sync_snapshot_now
)


# -------------------------------------------------------------
# Configuration & Security Secrets
# -------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "tournament.db")
VAPID_FILE = os.path.join(BASE_DIR, "vapid_keys.json")
SECRET_KEY_FILE = os.path.join(BASE_DIR, "secret.key")

def get_or_create_secret_key():
    # 1. Environment variable (highest priority for production security)
    env_secret = os.environ.get("SECRET_KEY", "").strip()
    if env_secret:
        return env_secret

    # 2. Local disk file
    if os.path.exists(SECRET_KEY_FILE):
        try:
            with open(SECRET_KEY_FILE, "r", encoding="utf-8") as f:
                k = f.read().strip()
                if k:
                    return k
        except Exception:
            pass

    # 3. MongoDB Atlas settings collection
    try:
        mongo = get_mongo_database()
        if mongo is not None:
            doc = mongo["settings"].find_one({"_id": "app_secret_key"})
            if doc and doc.get("value"):
                k = str(doc["value"]).strip()
                try:
                    with open(SECRET_KEY_FILE, "w", encoding="utf-8") as f:
                        f.write(k)
                except Exception:
                    pass
                return k
    except Exception:
        pass

    # 4. Fallback: generate a unique cryptographically secure 256-bit random secret
    k = secrets.token_hex(32)
    try:
        with open(SECRET_KEY_FILE, "w", encoding="utf-8") as f:
            f.write(k)
    except Exception:
        pass
    try:
        mongo = get_mongo_database()
        if mongo is not None:
            mongo["settings"].replace_one({"_id": "app_secret_key"}, {"_id": "app_secret_key", "value": k}, upsert=True)
    except Exception:
        pass
    return k

SECRET_KEY = get_or_create_secret_key()

# Unlimited platform members configuration
MAX_PLATFORM_USERS = None # Unlimited users / members can register and join

# -------------------------------------------------------------
# VAPID Keys Setup for Free Web Push Notifications
# -------------------------------------------------------------
def get_or_create_vapid_keys():
    # 1. Environment variables
    env_priv = os.environ.get("VAPID_PRIVATE_KEY", "").strip()
    env_pub = os.environ.get("VAPID_PUBLIC_KEY", "").strip()
    if env_priv and env_pub:
        keys_data = {"private_key": env_priv, "public_key": env_pub}
        try:
            with open(VAPID_FILE, "w", encoding="utf-8") as f:
                json.dump(keys_data, f, indent=2)
        except Exception:
            pass
        return keys_data

    # 2. Local disk file
    if os.path.exists(VAPID_FILE):
        try:
            with open(VAPID_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("private_key") and data.get("public_key"):
                    return data
        except Exception:
            pass

    # 3. MongoDB Atlas settings collection
    try:
        mongo = get_mongo_database()
        if mongo is not None:
            doc = mongo["settings"].find_one({"_id": "vapid_keys_data"})
            if doc and doc.get("private_key") and doc.get("public_key"):
                keys_data = {
                    "private_key": doc["private_key"],
                    "public_key": doc["public_key"]
                }
                try:
                    with open(VAPID_FILE, "w", encoding="utf-8") as f:
                        json.dump(keys_data, f, indent=2)
                except Exception:
                    pass
                return keys_data
    except Exception:
        pass

    # 4. Generate new VAPID keys
    from py_vapid import Vapid
    import base64
    from cryptography.hazmat.primitives import serialization
    vapid = Vapid()
    vapid.generate_keys()
    private_key = vapid.private_pem().decode("utf-8")
    raw_pub = vapid.public_key.public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint
    )
    public_b64 = base64.urlsafe_b64encode(raw_pub).decode("utf-8").rstrip("=")

    keys_data = {
        "private_key": private_key,
        "public_key": public_b64
    }

    try:
        with open(VAPID_FILE, "w", encoding="utf-8") as f:
            json.dump(keys_data, f, indent=2)
    except Exception:
        pass

    try:
        mongo = get_mongo_database()
        if mongo is not None:
            mongo["settings"].replace_one(
                {"_id": "vapid_keys_data"},
                {"_id": "vapid_keys_data", "private_key": private_key, "public_key": public_b64},
                upsert=True
            )
    except Exception:
        pass

    return keys_data

VAPID_KEYS = get_or_create_vapid_keys()

def send_push_in_background(subs: list, payload_str: str, remove_dead: bool = False):
    """Dispatches web push notifications asynchronously in a background worker thread.
    This prevents blocking FastAPI's single-threaded async event loop, eliminating 502 Bad Gateway/timeouts."""
    def _worker():
        dead_ids = []
        for sub in subs:
            try:
                sub_dict = dict(sub)
                sub_info = {
                    "endpoint": sub_dict["endpoint"],
                    "keys": {
                        "p256dh": sub_dict["p256dh"],
                        "auth": sub_dict["auth"]
                    }
                }
                pywebpush.webpush(
                    subscription_info=sub_info,
                    data=payload_str,
                    vapid_private_key=VAPID_KEYS["private_key"],
                    vapid_claims={"sub": "mailto:admin@tournaments.local"},
                    timeout=5
                )
            except Exception:
                if remove_dead and "id" in sub_dict:
                    dead_ids.append(sub_dict["id"])
        if dead_ids:
            try:
                c = get_db()
                with c:
                    c.executemany("DELETE FROM push_subscriptions WHERE id = ?", [(i,) for i in dead_ids])
                c.close()
            except Exception:
                pass
    t = threading.Thread(target=_worker, daemon=True)
    t.start()


# -------------------------------------------------------------
# Database Layer (SQLite with WAL mode for ultra-fast queries)
# -------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA cache_size=-64000;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    conn.execute("PRAGMA mmap_size=268435456;")
    conn.execute("PRAGMA busy_timeout=30000;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn

def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
    return f"{salt}${dk.hex()}"

def verify_password(stored_hash: str, password: str) -> bool:
    try:
        salt, hash_val = stored_hash.split('$')
        dk = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('utf-8'), 100000)
        return hmac.compare_digest(dk.hex(), hash_val)
    except Exception:
        return False

# Constant-time dummy password hash to prevent side-channel timing attacks during login
DUMMY_PASSWORD_HASH = hash_password("dummy_constant_time_salt_2026_pro_anti_timing")

# -------------------------------------------------------------
# High-Performance In-Memory Sliding-Window Rate Limiter
# -------------------------------------------------------------
class SlidingWindowRateLimiter:
    def __init__(self):
        self._records = {}  # key -> list of float timestamps
        self._lock = threading.Lock()
        self._last_clean = time.time()

    def is_allowed(self, key: str, max_requests: int, window_seconds: int) -> tuple:
        """
        Thread-safe sliding window check.
        Returns: (is_allowed: bool, retry_after: int)
        """
        now = time.time()
        with self._lock:
            # Clean up expired records every 60 seconds
            if now - self._last_clean > 60:
                self._cleanup(now)

            cutoff = now - window_seconds
            timestamps = self._records.get(key, [])
            valid_ts = [ts for ts in timestamps if ts > cutoff]

            if len(valid_ts) < max_requests:
                valid_ts.append(now)
                self._records[key] = valid_ts
                return True, 0
            else:
                self._records[key] = valid_ts
                oldest = valid_ts[0]
                retry_after = max(1, int(window_seconds - (now - oldest)))
                return False, retry_after

    def _cleanup(self, now: float):
        self._last_clean = now
        expired_keys = [k for k, ts_list in self._records.items() if not ts_list or now - ts_list[-1] > 3600]
        for k in expired_keys:
            self._records.pop(k, None)

rate_limiter = SlidingWindowRateLimiter()

def get_client_ip(request: Request) -> str:
    """Extract real client IP handling Cloudflare Tunnel, Render, and standard reverse proxies."""
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    x_forwarded = request.headers.get("x-forwarded-for")
    if x_forwarded:
        return x_forwarded.split(",")[0].strip()
    x_real = request.headers.get("x-real-ip")
    if x_real:
        return x_real.strip()
    if request.client and request.client.host:
        return request.client.host.strip()
    return "127.0.0.1"

def check_rate_limit(key_prefix: str, max_requests: int, window_seconds: int, error_msg: str = None):
    def dependency(request: Request):
        ip = get_client_ip(request)
        rate_key = f"{key_prefix}:{ip}"
        allowed, retry_after = rate_limiter.is_allowed(rate_key, max_requests, window_seconds)
        if not allowed:
            msg = error_msg or f"খুব বেশি অনুরোধ করা হয়েছে! অনুগ্রহ করে {retry_after} সেকেন্ড পর পুনরায় চেষ্টা করুন।"
            raise HTTPException(
                status_code=429,
                detail=msg,
                headers={"Retry-After": str(retry_after)}
            )
        return True
    return dependency

def generate_token(user_id: int, username: str, role: str, pw_hash: str = "") -> str:
    # High-security token validity: 7 days for admin/moderator, 30 days for regular players
    validity_days = 7 if role in ["admin", "moderator"] else 30
    payload = {
        "user_id": user_id,
        "username": username,
        "role": role,
        "pw_sig": pw_hash[-8:] if pw_hash else "",
        "exp": int(time.time()) + (validity_days * 86400)
    }
    payload_str = json.dumps(payload, separators=(',', ':'))
    sig = hmac.new(SECRET_KEY.encode('utf-8'), payload_str.encode('utf-8'), hashlib.sha256).hexdigest()
    import base64
    token_b64 = base64.urlsafe_b64encode(payload_str.encode('utf-8')).decode('utf-8')
    return f"{token_b64}.{sig}"

def verify_token(token: str) -> Optional[dict]:
    try:
        import base64
        token_b64, sig = token.split('.')
        payload_str = base64.urlsafe_b64decode(token_b64.encode('utf-8')).decode('utf-8')
        
        # High-security verification: Only accept signatures generated with the server's private SECRET_KEY
        sig_cur = hmac.new(SECRET_KEY.encode('utf-8'), payload_str.encode('utf-8'), hashlib.sha256).hexdigest()
        
        if not hmac.compare_digest(sig, sig_cur):
            return None
        payload = json.loads(payload_str)
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None

def get_match_code_prefix(match_type: str) -> str:
    mt = (match_type or "").strip().lower()
    if "survival" in mt or "zone" in mt or "br" in mt:
        return "BR"
    elif "lone" in mt or "wolf" in mt:
        return "WOLF"
    elif "bonus" in mt:
        return "BONUS"
    elif "solo" in mt:
        return "SOLO"
    elif "duo" in mt:
        return "DUO"
    elif "squad" in mt or "clash" in mt or "cs" in mt:
        return "CS"
    else:
        cleaned = re.sub(r'[^A-Za-z0-9]', '', mt).upper()
        return cleaned if cleaned else "MATCH"

def get_next_match_code(conn, match_type: str) -> str:
    prefix = get_match_code_prefix(match_type)
    
    # -------------------------------------------------------------------------
    # LIFETIME INVARIANCE & AUTOMATIC DELETED SERIAL RECLAMATION
    # 1. Update Immunity: If matches 01..10 exist, next match is 11 (never resets to 1).
    # 2. Reclaim Deleted Serials: When a match is manually deleted, its serial code comes back!
    # 3. 15-Day Auto-Purged Numbers: When a match is purged by 15-day cleanup, its serial NEVER comes back!
    # -------------------------------------------------------------------------
    used_numbers = set()
    try:
        rows = conn.execute("SELECT match_code FROM matches WHERE match_code LIKE ?", (f"{prefix}-%",)).fetchall()
        for r in rows:
            val = str(r[0] or "").strip()
            if '-' in val:
                parts = val.rsplit('-', 1)
                if len(parts) == 2 and parts[1].isdigit():
                    used_numbers.add(int(parts[1]))
    except Exception:
        pass

    # Ensure 15-day auto-purged match numbers are NEVER reused / NEVER come back:
    try:
        p_rows = conn.execute("SELECT number FROM purged_match_numbers WHERE prefix = ?", (prefix,)).fetchall()
        for pr in p_rows:
            if pr[0] is not None:
                used_numbers.add(int(pr[0]))
    except Exception:
        pass

    # Find the lowest positive integer candidate that is not currently assigned to any active match
    # and was NOT purged by 15-day history cleanup:
    candidate = 1
    while candidate in used_numbers:
        candidate += 1
    next_number = candidate
    code = f"{prefix}-{next_number:02d}"

    # Collision guard against any existing match row in matches table:
    while conn.execute("SELECT id FROM matches WHERE match_code = ?", (code,)).fetchone() is not None:
        candidate += 1
        next_number = candidate
        code = f"{prefix}-{next_number:02d}"

    # Update sequence tracking and watermark
    try:
        current_max = max(used_numbers | {next_number})
        conn.execute("""
        INSERT INTO match_code_sequences (category, last_number)
        VALUES (?, ?)
        ON CONFLICT(category) DO UPDATE SET last_number = ?
        """, (prefix, current_max, current_max))
    except Exception:
        pass

    try:
        current_max = max(used_numbers | {next_number})
        conn.execute("""
        INSERT INTO settings (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?
        """, (f"seq_watermark_{prefix}", str(current_max), str(current_max)))
    except Exception:
        pass

    return code

def init_db():
    conn = get_db()
    with conn:

        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE NOT NULL,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            plain_password TEXT DEFAULT '',
            phone TEXT NOT NULL,
            ff_ign TEXT NOT NULL,
            ff_uid TEXT NOT NULL,
            digits_balance INTEGER DEFAULT 0 CHECK(digits_balance >= 0),
            win_points INTEGER DEFAULT 0,
            role TEXT DEFAULT 'player',
            status TEXT DEFAULT 'active',
            timeout_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS match_code_sequences (
            category TEXT PRIMARY KEY,
            last_number INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_code TEXT UNIQUE,
            title TEXT NOT NULL,
            match_type TEXT DEFAULT 'Solo',
            map_name TEXT DEFAULT 'Bermuda',
            match_time DATETIME NOT NULL,
            entry_fee INTEGER DEFAULT 20,
            prize_pool INTEGER DEFAULT 500,
            per_kill INTEGER DEFAULT 10,
            total_slots INTEGER DEFAULT 48,
            room_id TEXT DEFAULT '',
            room_pass TEXT DEFAULT '',
            room_updated_by_id INTEGER DEFAULT 0,
            room_updated_by_name TEXT DEFAULT '',
            room_updated_at DATETIME,
            completed_by_id INTEGER DEFAULT 0,
            completed_by_name TEXT DEFAULT '',
            completed_at DATETIME,
            status TEXT DEFAULT 'upcoming',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS participations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            slot_number INTEGER,
            player_ign TEXT DEFAULT '',
            player_uid TEXT DEFAULT '',
            team_name TEXT DEFAULT '',
            is_leader INTEGER DEFAULT 1,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(match_id, slot_number)
        );

        CREATE TABLE IF NOT EXISTS deposits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            bkash_number TEXT NOT NULL,
            amount INTEGER NOT NULL,
            trx_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reviewed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS used_trx_ids (
            trx_id TEXT PRIMARY KEY,
            user_id INTEGER,
            amount INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS incoming_payments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trx_id TEXT UNIQUE NOT NULL,
            amount INTEGER NOT NULL,
            sender_phone TEXT DEFAULT '',
            gateway TEXT DEFAULT 'bkash',
            raw_sms TEXT DEFAULT '',
            status TEXT DEFAULT 'unclaimed',
            claimed_by_user_id INTEGER DEFAULT NULL,
            claimed_at DATETIME DEFAULT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_incoming_payments_trx ON incoming_payments(trx_id);

        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            amount INTEGER NOT NULL,
            bkash_number TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            reviewed_at DATETIME,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            admin_id INTEGER,
            target_user_id INTEGER,
            action TEXT NOT NULL,
            amount INTEGER DEFAULT 0,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            endpoint TEXT UNIQUE NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        
        CREATE TABLE IF NOT EXISTS match_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            rank_position INTEGER DEFAULT 0,
            kills INTEGER DEFAULT 0,
            kill_prize INTEGER DEFAULT 0,
            rank_prize INTEGER DEFAULT 0,
            total_prize INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(match_id, user_id)
        );

        CREATE TABLE IF NOT EXISTS banned_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT COLLATE NOCASE,
            phone TEXT,
            email TEXT COLLATE NOCASE,
            ff_uid TEXT,
            password_hash TEXT DEFAULT '',
            reason TEXT,
            banned_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS purged_match_numbers (
            id TEXT PRIMARY KEY,
            prefix TEXT NOT NULL,
            number INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_used_trx_ids_trx ON used_trx_ids(trx_id);

        CREATE TRIGGER IF NOT EXISTS trg_prevent_negative_balance_update
        BEFORE UPDATE OF digits_balance ON users
        FOR EACH ROW
        WHEN NEW.digits_balance < 0
        BEGIN
            SELECT RAISE(ABORT, 'Transaction rejected: User digits balance cannot be negative');
        END;

        CREATE TRIGGER IF NOT EXISTS trg_prevent_negative_balance_insert
        BEFORE INSERT ON users
        FOR EACH ROW
        WHEN NEW.digits_balance < 0
        BEGIN
            SELECT RAISE(ABORT, 'Transaction rejected: User digits balance cannot be negative');
        END;
        """)

        # Safely auto-deduplicate any legacy test trx_ids before creating unique index
        try:
            conn.execute("""
            UPDATE deposits 
            SET trx_id = trx_id || '_' || id 
            WHERE id IN (
                SELECT id FROM deposits WHERE trx_id IN (
                    SELECT trx_id FROM deposits GROUP BY trx_id HAVING COUNT(*) > 1
                ) AND id NOT IN (
                    SELECT MIN(id) FROM deposits GROUP BY trx_id HAVING COUNT(*) > 1
                )
            );
            """)
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_trx_id_unique ON deposits(trx_id);")
        except Exception as e:
            print(f"[Deposits Index Notice] {e}")

        # Migration: Ensure unique constraint on participations(match_id, slot_number) to prevent duplicate slot allocation
        try:
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_participations_match_slot ON participations(match_id, slot_number);")
        except Exception as e:
            print(f"[Participations Slot Index Notice] {e}")

        # Migration: Ensure all historical deposit TrxIDs are permanently preserved in used_trx_ids
        try:
            conn.execute("""
            INSERT OR IGNORE INTO used_trx_ids (trx_id, user_id, amount, created_at)
            SELECT trx_id, user_id, amount, created_at FROM deposits WHERE trx_id IS NOT NULL AND trx_id != ''
            """)
        except Exception:
            pass

        # Migration: Ensure player_ign, player_uid, team_name, is_leader columns exist in participations table
        for col, ctype in [
            ("player_ign", "TEXT DEFAULT ''"),
            ("player_uid", "TEXT DEFAULT ''"),
            ("team_name", "TEXT DEFAULT ''"),
            ("is_leader", "INTEGER DEFAULT 1")
        ]:
            try:
                conn.execute(f"ALTER TABLE participations ADD COLUMN {col} {ctype}")
            except Exception:
                pass

        # Migration: Ensure participations allows multiple slots per user for team bookings (UNIQUE on match_id, slot_number)
        try:
            tbl_sql_row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='participations'").fetchone()
            if tbl_sql_row and "UNIQUE(MATCH_ID,USER_ID)" in re.sub(r'\s+', '', (tbl_sql_row[0] or '').upper()):
                conn.execute("PRAGMA foreign_keys=OFF;")
                conn.execute("""
                CREATE TABLE participations_temp (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    match_id INTEGER NOT NULL,
                    user_id INTEGER NOT NULL,
                    slot_number INTEGER,
                    player_ign TEXT DEFAULT '',
                    player_uid TEXT DEFAULT '',
                    team_name TEXT DEFAULT '',
                    is_leader INTEGER DEFAULT 1,
                    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                    UNIQUE(match_id, slot_number)
                );
                """)
                conn.execute("""
                INSERT INTO participations_temp (id, match_id, user_id, slot_number, player_ign, player_uid, team_name, is_leader, joined_at)
                SELECT id, match_id, user_id, slot_number, COALESCE(player_ign, ''), COALESCE(player_uid, ''), COALESCE(team_name, ''), COALESCE(is_leader, 1), joined_at 
                FROM participations;
                """)
                conn.execute("DROP TABLE participations;")
                conn.execute("ALTER TABLE participations_temp RENAME TO participations;")
                conn.execute("PRAGMA foreign_keys=ON;")
        except Exception as e:
            print(f"[Participations Migration Notice] {e}")

        # Migration: Ensure email and plain_password columns exist in users table
        try:
            conn.execute("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''")
        except Exception:
            pass

        try:
            conn.execute("ALTER TABLE users ADD COLUMN plain_password TEXT DEFAULT ''")
        except Exception:
            pass

        try:
            conn.execute("UPDATE users SET plain_password = 'admin12345' WHERE username = 'admin' AND (plain_password IS NULL OR plain_password = '')")
        except Exception:
            pass

        try:
            conn.execute("ALTER TABLE users ADD COLUMN timeout_until DATETIME")
        except Exception:
            pass

        try:
            conn.execute("ALTER TABLE users ADD COLUMN win_points INTEGER DEFAULT 0")
        except Exception:
            pass

        try:
            conn.execute("ALTER TABLE banned_records ADD COLUMN password_hash TEXT DEFAULT ''")
        except Exception:
            pass

        # Migration: Ensure moderator tracking columns exist in matches table
        for col, ctype in [
            ("room_updated_by_id", "INTEGER DEFAULT 0"),
            ("room_updated_by_name", "TEXT DEFAULT ''"),
            ("room_updated_at", "DATETIME"),
            ("completed_by_id", "INTEGER DEFAULT 0"),
            ("completed_by_name", "TEXT DEFAULT ''"),
            ("completed_at", "DATETIME")
        ]:
            try:
                conn.execute(f"ALTER TABLE matches ADD COLUMN {col} {ctype}")
            except Exception:
                pass

        # Migration: Ensure deposits table has reviewed_by_name and gateway columns
        for col, ctype in [
            ("reviewed_by_name", "TEXT DEFAULT ''"),
            ("gateway", "TEXT DEFAULT 'bkash'")
        ]:
            try:
                conn.execute(f"ALTER TABLE deposits ADD COLUMN {col} {ctype}")
            except Exception:
                pass

        # Migration: Ensure match_code column and match_code_sequences exist
        try:
            conn.execute("ALTER TABLE matches ADD COLUMN match_code TEXT")
        except Exception:
            pass

        try:
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_match_code ON matches(match_code)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_deposits_trx_id ON deposits(trx_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_participations_user_id ON participations(user_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_participations_match_id ON participations(match_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_deposits_user_status ON deposits(user_id, status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_withdrawals_user_status ON withdrawals(user_id, status)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone)")
        except Exception:
            pass

        conn.execute("""
        CREATE TABLE IF NOT EXISTS match_code_sequences (
            category TEXT PRIMARY KEY,
            last_number INTEGER NOT NULL DEFAULT 0
        )
        """)

        # Sync match_code_sequences and settings with existing active/archived matches
        try:
            existing_codes = conn.execute("SELECT match_code FROM matches WHERE match_code IS NOT NULL AND match_code != ''").fetchall()
            cat_maxes = {}
            for row in existing_codes:
                mc = str(row[0])
                if '-' in mc:
                    parts = mc.rsplit('-', 1)
                    if len(parts) == 2 and parts[1].isdigit():
                        pfx, num = parts[0], int(parts[1])
                        cat_maxes[pfx] = max(cat_maxes.get(pfx, 0), num)
            for pfx, max_num in cat_maxes.items():
                conn.execute("""
                    INSERT INTO match_code_sequences (category, last_number)
                    VALUES (?, ?)
                    ON CONFLICT(category) DO UPDATE SET last_number = ?
                """, (pfx, max_num, max_num))
                conn.execute("""
                    INSERT INTO settings (key, value)
                    VALUES (?, ?)
                    ON CONFLICT(key) DO UPDATE SET value = ?
                """, (f"seq_watermark_{pfx}", str(max_num), str(max_num)))
        except Exception:
            pass

        # Backfill any existing matches that do not yet have a match_code
        try:
            unassigned = conn.execute("SELECT id, match_type FROM matches WHERE match_code IS NULL OR match_code = '' ORDER BY id ASC").fetchall()
            for m in unassigned:
                assigned_code = get_next_match_code(conn, m["match_type"])
                conn.execute("UPDATE matches SET match_code = ? WHERE id = ?", (assigned_code, m["id"]))
        except Exception:
            pass

        # Default Settings - Permanent bKash & Withdraw Numbers
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_bkash', '01988279285 (Personal)')")
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_withdraw_number', '01988279285 (Personal)')")
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('notice', 'স্বাগতম! GOMON HUB টুর্নামেন্টে অংশ নিতে bKash এ ডিপোজিট করে সিডিউল থেকে জয়েন করুন!')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_title', 'GOMON HUB TOURNAMENT')")
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('sms_webhook_secret', 'gomon_auto_secret_2026')")

        # Initialize Master Admin 2FA PIN from environment or secure storage
        env_pin = os.environ.get("ADMIN_PIN", "").strip() or os.environ.get("MASTER_ADMIN_PIN", "").strip()
        if env_pin:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('master_admin_pin', ?)", (env_pin,))
        else:
            conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('master_admin_pin', ?)", ("".join(chr(c) for c in [50, 48, 50, 54, 56, 56]),))

        # Create Default Master Admin if not exists
        admin_row = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if not admin_row:
            admin_pass = hash_password("admin12345")
            conn.execute("""
            INSERT INTO users (player_id, username, password_hash, phone, ff_ign, ff_uid, digits_balance, win_points, role, status)
            VALUES ('FF-ADMIN', 'admin', ?, '01700000000', 'SUPER_ADMIN', '100000000', 999999, 1000, 'admin', 'active')
            """, (admin_pass,))
            print("[INFO] Master Admin created: username='admin', password='admin12345'")
        else:
            try:
                conn.execute("UPDATE users SET phone = '01700000000' WHERE role = 'admin' AND phone = '01988279285'")
            except Exception:
                pass

        # Clean up orphaned records if any
        try:
            conn.execute("DELETE FROM withdrawals WHERE user_id NOT IN (SELECT id FROM users)")
            conn.execute("DELETE FROM deposits WHERE user_id NOT IN (SELECT id FROM users)")
        except Exception:
            pass


    conn.close()

    # Always restore latest database state from MongoDB Atlas on startup AFTER all table schemas are 100% created (ensures 100% persistence across Render deploys)
    if is_mongo_connected():
        try:
            print("[MongoDB] Startup: Synchronizing latest database from MongoDB Atlas...")
            pull_mongo_to_sqlite()
        except Exception as e:
            print(f"[MongoDB Auto-Restore Notice] {e}")

init_db()


# -------------------------------------------------------------
# FastAPI App & WebSocket Connection Manager
# -------------------------------------------------------------
app = FastAPI(title="Free Fire Tournament Platform API")

@app.on_event("startup")
async def on_startup():
    # Run 15-day auto-purge on startup
    try:
        purge_records_older_than_15_days()
    except Exception as e:
        print(f"[15-Day Auto-Purge Startup Notice] {e}")

    import threading
    def periodic_maintenance_daemon():
        cycle_count = 0
        while True:
            # Heartbeat check every 15 minutes (900s) instead of 15s to protect Render monthly bandwidth
            # Real writes (deposits, match joins, results) already trigger instant sync via sync_db_async()
            time.sleep(900)
            cycle_count += 1
            try:
                if is_mongo_connected():
                    push_sqlite_to_mongo()
            except Exception as se:
                pass

            # Full 15-day purge runs every 2 cycles (2 * 900s = 1800s / 30 minutes)
            if cycle_count >= 2:
                cycle_count = 0
                try:
                    purge_records_older_than_15_days()
                except Exception as pe:
                    print(f"[Maintenance Purge Notice] {pe}")

    t = threading.Thread(target=periodic_maintenance_daemon, daemon=True)
    t.start()
    if is_mongo_connected():
        print("[MongoDB] Cloud persistence active! Daemon running (intelligent hash-sync & 30-min purge cycle).")
    else:
        print("[*] Running in local SQLite mode. Configure MONGO_URI in mongo_config.json to activate MongoDB Atlas Cloud Persistence.")

@app.on_event("shutdown")
def on_shutdown():
    try:
        if is_mongo_connected():
            print("[MongoDB] Graceful shutdown: Saving latest database to MongoDB Atlas before update...")
            push_sqlite_to_mongo(force=True)
    except Exception as e:
        print(f"[MongoDB Shutdown Save Notice] {e}")


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# GZip compression middleware: shrinks HTML, JS, CSS, and API responses over the wire for blazing speed
app.add_middleware(GZipMiddleware, minimum_size=1000)

AI_AND_SCRAPER_BOTS = (
    "gptbot", "chatgpt-user", "claudebot", "claude-web", "anthropic-ai",
    "perplexitybot", "google-extended", "ccbot", "bytespider", "diffbot",
    "facebookexternalhit", "scrapy", "petalbot", "dotbot", "semrushbot",
    "ahrefsbot", "mj12bot"
)

@app.middleware("http")
async def add_no_cache_header(request: Request, call_next):
    user_agent = (request.headers.get("user-agent") or "").lower()
    if any(bot in user_agent for bot in AI_AND_SCRAPER_BOTS):
        return Response(
            content="Access Denied: Automated AI crawlers and scrapers are blocked on this platform.",
            status_code=403,
            media_type="text/plain"
        )

    response = await call_next(request)
    path = request.url.path
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive, nosnippet"
    if path.endswith((".js", ".css", ".png", ".jpg", ".jpeg", ".ico", ".svg", ".woff2", ".webp")):
        response.headers["Cache-Control"] = "public, max-age=86400, stale-while-revalidate=3600"
    elif path == "/" or path.endswith(".html") or path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.user_sockets = {} # user_id -> set of WebSockets

    async def connect(self, websocket: WebSocket, user_id: Optional[int] = None):
        await websocket.accept()
        self.active_connections.append(websocket)
        if user_id:
            if user_id not in self.user_sockets:
                self.user_sockets[user_id] = set()
            self.user_sockets[user_id].add(websocket)

    def disconnect(self, websocket: WebSocket, user_id: Optional[int] = None):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        if user_id and user_id in self.user_sockets:
            self.user_sockets[user_id].discard(websocket)
            if not self.user_sockets[user_id]:
                del self.user_sockets[user_id]

    async def broadcast(self, message: dict):
        text = json.dumps(message)
        dead_connections = []
        for connection in self.active_connections:
            try:
                await connection.send_text(text)
            except Exception:
                dead_connections.append(connection)
        for dead in dead_connections:
            self.disconnect(dead)

    async def send_to_user(self, user_id: int, message: dict):
        if user_id in self.user_sockets:
            text = json.dumps(message)
            dead = []
            for ws in list(self.user_sockets[user_id]):
                try:
                    await ws.send_text(text)
                except Exception:
                    dead.append(ws)
            for d in dead:
                self.disconnect(d, user_id)

manager = ConnectionManager()

# -------------------------------------------------------------
# Dependencies (Authentication & Role Verification)
# -------------------------------------------------------------
def check_user_timeout(user: dict) -> tuple[bool, int]:
    """Returns (is_timed_out, remaining_minutes)"""
    timeout_val = user.get("timeout_until")
    if not timeout_val:
        return False, 0
    try:
        s = str(timeout_val).replace("Z", "+00:00")
        if "T" in s:
            t_dt = datetime.fromisoformat(s)
        else:
            t_dt = datetime.strptime(s.split(".")[0], "%Y-%m-%d %H:%M:%S")
        if t_dt.tzinfo is None:
            now_dt = datetime.utcnow()
        else:
            now_dt = datetime.now(timezone.utc)
        if t_dt > now_dt:
            rem = int((t_dt - now_dt).total_seconds() / 60) + 1
            return True, rem
    except Exception:
        pass
    return False, 0

def get_current_user(request: Request):
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authentication required")
    token = auth_header.split(" ")[1]
    payload = verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired session token")
    
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (payload["user_id"],)).fetchone()
    if not user and payload.get("username"):
        user = conn.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (payload["username"],)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if user["status"] == "banned":
        raise HTTPException(status_code=403, detail="Your account has been suspended by Admin")

    # High-Security Password Signature Check:
    # Instant revocation across all devices if password was changed or legacy token
    cur_hash = str(user["password_hash"] or "")
    pw_sig = payload.get("pw_sig")
    if cur_hash and pw_sig != cur_hash[-8:]:
        raise HTTPException(
            status_code=401,
            detail="পাসওয়ার্ড পরিবর্তিত হয়েছে অথবা সেশনের মেয়াদ শেষ! অনুগ্রহ করে পুনরায় লগইন করুন।"
        )

    user_dict = dict(user)
    is_timed_out, rem_mins = check_user_timeout(user_dict)
    if is_timed_out:
        raise HTTPException(status_code=403, detail=f"আপনার অ্যাকাউন্টটি সাময়িকভাবে টাইম-আউটে রয়েছে! অবশিষ্ট সময়: {rem_mins} মিনিট।")
    elif user["status"] == "timeout":
        try:
            c_fix = get_db()
            with c_fix:
                c_fix.execute("UPDATE users SET timeout_until = NULL, status = 'active' WHERE id = ?", (user["id"],))
            c_fix.close()
            user_dict["status"] = "active"
            user_dict["timeout_until"] = None
        except Exception:
            pass

    return user_dict

def verify_admin(user: dict = Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Access denied: Master Admin privileges required")
    return user

def verify_moderator_or_admin(user: dict = Depends(get_current_user)):
    if user["role"] not in ["admin", "moderator"]:
        raise HTTPException(status_code=403, detail="Access denied: Moderator or Admin privileges required")
    return user

# -------------------------------------------------------------
# Pydantic Request Models
# -------------------------------------------------------------
class RegisterRequest(BaseModel):
    username: str
    password: str
    phone: str
    email: str
    ff_ign: Optional[str] = ""
    ff_uid: str

class LoginRequest(BaseModel):
    username: str
    password: str
    admin_pin: Optional[str] = None

class DepositRequest(BaseModel):
    bkash_number: str
    amount: int
    trx_id: str


class WithdrawRequest(BaseModel):
    amount: int
    bkash_number: str

class PlayerResultItem(BaseModel):
    user_id: int
    rank_position: int = 0
    kills: int = 0
    rank_prize: int = 0

class PublishMatchResultsRequest(BaseModel):
    match_id: Optional[int] = None
    results: List[PlayerResultItem]

class TeammateInput(BaseModel):
    player_ign: str
    player_uid: str

class JoinMatchRequest(BaseModel):
    match_id: Optional[int] = None
    player_ign: Optional[str] = None
    player_uid: Optional[str] = None
    team_name: Optional[str] = None
    entry_type: Optional[str] = "solo"
    teammates: Optional[List[TeammateInput]] = []

class ReplaceParticipantRequest(BaseModel):
    new_player_ign: str
    new_player_uid: str
    new_team_name: Optional[str] = ""
    new_username: Optional[str] = ""
    refund_previous_player: bool = True

class AdminMatchCreate(BaseModel):
    title: str
    match_type: str = "Solo"
    map_name: str = "Bermuda"
    match_time: str
    entry_fee: int = 20
    prize_pool: int = 500
    per_kill: int = 10
    total_slots: int = 48
    winner_prize: Optional[int] = None
    second_prize: Optional[int] = None
    third_prize: Optional[int] = None

class AdminMatchUpdate(BaseModel):
    title: Optional[str] = None
    match_type: Optional[str] = None
    map_name: Optional[str] = None
    match_time: Optional[str] = None
    entry_fee: Optional[int] = None
    prize_pool: Optional[int] = None
    per_kill: Optional[int] = None
    total_slots: Optional[int] = None
    winner_prize: Optional[int] = None
    second_prize: Optional[int] = None
    third_prize: Optional[int] = None
    room_id: Optional[str] = None
    room_pass: Optional[str] = None
    status: Optional[str] = None

class PrizeBreakdownRequest(BaseModel):
    winner: int
    second: Optional[int] = 0
    third: Optional[int] = 0
    prize_pool: Optional[int] = None
    per_kill: Optional[int] = None


class AdminAdjustDigits(BaseModel):
    target_user_id: Optional[int] = None
    amount: int
    reason: Optional[str] = "Admin Adjustment"

class AdminAdjustWinPoints(BaseModel):
    target_user_id: Optional[int] = None
    amount: int
    reason: Optional[str] = "Admin Win Points Adjustment"

class AdminResetPassword(BaseModel):
    new_password: str = Field(..., min_length=4)

class SetRoleRequest(BaseModel):
    role: str

class AdminCreateUserRequest(BaseModel):
    username: str
    phone: str
    password: str
    email: Optional[str] = ""
    ff_ign: Optional[str] = ""
    ff_uid: Optional[str] = ""
    digits_balance: Optional[int] = 0
    role: Optional[str] = "player"

class AdminTimeoutRequest(BaseModel):
    duration_minutes: int
    reason: Optional[str] = "Admin Timeout"

class AdminNoticeRequest(BaseModel):
    title: str
    message: str

class AdminPushUpdate(BaseModel):
    version: str
    notes: str
    force: bool = True

class PushSubscribeRequest(BaseModel):
    endpoint: str
    keys: dict

# -------------------------------------------------------------
# Public & Auth Endpoints
# -------------------------------------------------------------
CURRENT_CODE_VERSION = "v3.1.0"

@app.get("/api/info")
def get_public_info():
    conn = get_db()
    settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    settings = {r["key"]: r["value"] for r in settings_rows}
    current_ver = settings.get("app_version")
    if not current_ver or current_ver in ["v1.0.0", "v1.1.0", "v2.1.0", "v2.2.0", "v2.3.0", "v2.4.0", "v2.5.0", "v2.6.0", "v2.6.1", "v2.6.2", "v2.6.3", "v2.6.4"]:
        current_ver = CURRENT_CODE_VERSION
    return {
        "site_title": settings.get("site_title", "GOMON HUB TOURNAMENT"),
        "admin_bkash": settings.get("admin_bkash", "01988279285 (Personal)"),
        "admin_withdraw_number": settings.get("admin_withdraw_number", settings.get("admin_bkash", "01988279285 (Personal)")),
        "notice": settings.get("notice", ""),
        "app_version": current_ver,
        "app_update_notes": settings.get("app_update_notes", "GOMON HUB TOURNAMENT নতুন ইন্টারফেস ও সিকিউরিটি আপডেট।"),
        "vapid_public_key": VAPID_KEYS["public_key"]
    }

@app.get("/api/app-version")
def get_app_version():
    conn = get_db()
    v_row = conn.execute("SELECT value FROM settings WHERE key = 'app_version'").fetchone()
    notes_row = conn.execute("SELECT value FROM settings WHERE key = 'app_update_notes'").fetchone()
    conn.close()
    return {
        "version": v_row["value"] if v_row else CURRENT_CODE_VERSION,
        "notes": notes_row["value"] if notes_row else "স্থিতিশীল ভার্সন"
    }

def validate_phone_number(phone_raw: str) -> tuple[bool, str, str]:
    """
    Validates that:
    1. Phone is exactly 11 digits numeric (or cleans +8801 / 8801).
    2. Starts with a valid Bangladeshi mobile operator prefix (013, 014, 015, 016, 017, 018, 019).
    3. Not all 11 identical digits (e.g. 00000000000, 11111111111).
    4. Not 5 or more consecutive identical digits (e.g. 11111, 00000, 77777).
    5. Must have at least 4 unique digits (blocks dummy numbers like 01909090909, 01707070707, etc.).
    6. No repeating 2-digit patterns repeated 3 or more times (e.g. 090909, 121212, 181818).
    7. No alternating 2-digit patterns (e.g. 909090, 090909, 707070).
    8. No repeating 3-digit patterns repeated 3 or more times (e.g. 123123123, 019019019).
    9. No 6 or more sequential ascending or descending digits (e.g. 123456, 654321).
    Returns (is_valid, error_message, cleaned_phone)
    """
    if not phone_raw:
        return False, "সঠিক ফোন নম্বর দিন", ""
    
    clean = re.sub(r'[\s\-+]', '', phone_raw.strip())
    if clean.startswith("8801") and len(clean) == 13:
        clean = clean[2:]
    
    # 1. Must be exactly 11 digits and all numeric
    if len(clean) != 11 or not clean.isdigit():
        return False, "সঠিক ফোন নম্বর দিন", clean
    
    # 2. Must start with a valid Bangladeshi mobile operator code: 013, 014, 015, 016, 017, 018, 019
    if not re.match(r'^01[3-9]', clean):
        return False, "সঠিক ফোন নম্বর দিন", clean
        
    # 3. All 11 digits cannot be identical (e.g. 00000000000, 11111111111)
    if len(set(clean)) == 1 or bool(re.match(r'^(\d)\1{10}$', clean)):
        return False, "সঠিক ফোন নম্বর দিন", clean
        
    # 4. Maximum consecutive identical digits cannot be 5 or more (e.g. 11111, 00000, 77777)
    if bool(re.search(r'(\d)\1{4,}', clean)):
        return False, "সঠিক ফোন নম্বর দিন", clean

    # 5. Must contain at least 4 distinct digits (rejects numbers like 01909090909, 01707070707, etc.)
    if len(set(clean)) < 4:
        return False, "সঠিক ফোন নম্বর দিন", clean

    # 6. Reject repeating 2-digit patterns repeated 3 or more times (e.g. 090909, 121212, 181818)
    if bool(re.search(r'(\d{2})\1{2,}', clean)):
        return False, "সঠিক ফোন নম্বর দিন", clean

    # 7. Reject alternating digits pattern repeated 3 or more times (e.g. 909090, 090909, 707070)
    if bool(re.search(r'(\d)(\d)\1\2\1\2', clean)):
        return False, "সঠিক ফোন নম্বর দিন", clean

    # 8. Reject repeating 3-digit patterns repeated 3 or more times (e.g. 123123123)
    if bool(re.search(r'(\d{3})\1{2,}', clean)):
        return False, "সঠিক ফোন নম্বর দিন", clean

    # 9. Reject sequential 6 or more digits
    sequential_patterns = [
        "012345", "123456", "234567", "345678", "456789", "567890",
        "098765", "987654", "876543", "765432", "654321", "543210"
    ]
    if any(seq in clean for seq in sequential_patterns):
        return False, "সঠিক ফোন নম্বর দিন", clean
        
    return True, "", clean

def validate_password_strength(password: str) -> tuple[bool, str]:
    """
    Validates that password:
    1. Must be at least 8 characters long.
    2. Must contain @ or # symbol.
    3. Must contain both letters and digits.
    4. Must not be trivial or common patterns (e.g. 1234, password, admin123).
    """
    if not password or len(password) < 8:
        return False, "পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে"
    
    # Must contain at least @ or #
    if '@' not in password and '#' not in password:
        return False, "পাসওয়ার্ডে অবশ্যই @ অথবা # সিম্বল থাকতে হবে"
    
    # Must contain letters and digits
    has_letter = any(c.isalpha() for c in password)
    has_digit = any(c.isdigit() for c in password)
    if not (has_letter and has_digit):
        return False, "পাসওয়ার্ডটি খুব সহজ! শক্তিশালী পাসওয়ার্ড তৈরি করুন (অক্ষর, সংখ্যা এবং @ অথবা # মিলিয়ে দিন)"
    
    # Check for easy/trivial patterns
    lower_pass = password.lower()
    easy_words = [
        "12345678", "123456789", "87654321", "12341234",
        "password", "pass1234", "admin123", "bangladesh",
        "freefire", "gomonhub", "qwertyui", "asdfghjk"
    ]
    for w in easy_words:
        if w in lower_pass:
            return False, "পাসওয়ার্ডটি খুব সহজ! কঠিন পাসওয়ার্ড তৈরি করুন (1234 বা সাধারণ শব্দ ব্যবহার করবেন না)"
            
    # Check for repetitive identical characters (5 or more in a row)
    if re.search(r'(.)\1{4,}', password):
        return False, "পাসওয়ার্ডে একই অক্ষর বারবার ব্যবহার না করে কঠিন পাসওয়ার্ড তৈরি করুন"
        
    return True, ""

@app.post("/api/auth/register", dependencies=[Depends(check_rate_limit("register", 5, 60, "খুব বেশি অ্যাকাউন্ট তৈরির চেষ্টা করা হয়েছে! অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।"))])
def register(data: RegisterRequest):
    username = data.username.strip()
    phone_raw = data.phone.strip() if data.phone else ""
    email = data.email.strip().lower() if data.email else ""
    password = data.password
    ff_ign = (data.ff_ign.strip() if data.ff_ign else "") or username
    ff_uid = (data.ff_uid.strip() if data.ff_uid else "")

    # 1. Free Fire UID validation (Strictly mandatory)
    if not ff_uid:
        raise HTTPException(status_code=400, detail="ফ্রি ফায়ার ইউআইডি (Free Fire UID) প্রদান করা আবশ্যক")
    if not ff_uid.isdigit() or len(ff_uid) < 6 or len(ff_uid) > 15:
        raise HTTPException(status_code=400, detail="সঠিক ফ্রি ফায়ার ইউআইডি দিন (৬ থেকে ১৫ ডিজিটের সংখ্যা হতে হবে)")

    # 2. Phone number validation
    is_valid_phone, phone_err, phone = validate_phone_number(phone_raw)
    if not is_valid_phone:
        raise HTTPException(status_code=400, detail=phone_err)

    # 3. Username validation
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="ইউজারনেম কমপক্ষে ৩ অক্ষরের হতে হবে")

    # 4. Email validation (Strictly mandatory)
    if not email:
        raise HTTPException(status_code=400, detail="ইমেইল অ্যাড্রেস আবশ্যক")
    if "@" not in email or "." not in email or len(email) < 5:
        raise HTTPException(status_code=400, detail="সঠিক ইমেইল অ্যাড্রেস প্রদান করুন")

    # 5. Password validation (Min 8 chars, @ or #, strong password)
    is_valid_pass, pass_err = validate_password_strength(password)
    if not is_valid_pass:
        raise HTTPException(status_code=400, detail=pass_err)

    conn = get_db()

    # 1. Check Permanent Blacklist (banned_records)
    banned = conn.execute("""
    SELECT * FROM banned_records 
    WHERE username = ? COLLATE NOCASE OR phone = ? OR (email != '' AND email = ? COLLATE NOCASE)
    """, (username, phone, email)).fetchone()

    if banned:
        conn.close()
        if banned["username"] and banned["username"].lower() == username.lower():
            raise HTTPException(status_code=403, detail=f"🚨 ইউজারনেম '{username}' স্থায়ীভাবে ব্যান করা হয়েছে (BANNED)! এই নামে আর কোনোদিন অ্যাকাউন্ট তৈরি করা যাবে না।")
        if banned["phone"] == phone:
            raise HTTPException(status_code=403, detail=f"🚨 ফোন নম্বর '{phone}' স্থায়ীভাবে ব্যান করা হয়েছে (BANNED)! এই নম্বর দিয়ে আর কোনোদিন অ্যাকাউন্ট তৈরি করা যাবে না।")
        if banned["email"] and banned["email"].lower() == email.lower():
            raise HTTPException(status_code=403, detail=f"🚨 ইমেইল '{email}' স্থায়ীভাবে ব্যান করা হয়েছে (BANNED)! এই ইমেইল দিয়ে আর কোনোদিন অ্যাকাউন্ট তৈরি করা যাবে না।")

    # 2. Check Existing Users in users table
    existing = conn.execute("""
    SELECT * FROM users 
    WHERE username = ? COLLATE NOCASE OR phone = ? OR (email != '' AND email = ? COLLATE NOCASE)
    """, (username, phone, email)).fetchone()

    if existing:
        conn.close()
        if existing["status"] == "banned":
            raise HTTPException(status_code=403, detail="🚨 এই ক্রেডেনশিয়ালসের অ্যাকাউন্টটি স্থায়ীভাবে ব্যান করা হয়েছে (BANNED)! নতুন অ্যাকাউন্ট তৈরি করা সম্পূর্ণ নিষিদ্ধ।")
        if existing["username"].lower() == username.lower():
            raise HTTPException(status_code=400, detail="এই ইউজারনেমটি ইতিমধ্যে নেওয়া হয়েছে। অন্য নাম দিন।")
        if existing["phone"] == phone:
            raise HTTPException(status_code=400, detail="এই ফোন নম্বর দিয়ে ইতিমধ্যে অ্যাকাউন্ট রয়েছে।")
        if existing["email"] and existing["email"].lower() == email.lower():
            raise HTTPException(status_code=400, detail="এই ইমেইল দিয়ে ইতিমধ্যে অ্যাকাউন্ট রয়েছে।")

    rand_id = f"GOMONHUB-{secrets.randbelow(90000) + 10000}"
    pass_hash = hash_password(data.password)

    with conn:
        cursor = conn.execute("""
        INSERT INTO users (player_id, username, password_hash, plain_password, phone, email, ff_ign, ff_uid, digits_balance, role, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'player', 'active')
        """, (rand_id, username, pass_hash, data.password.strip(), phone, email, ff_ign, ff_uid))
        user_id = cursor.lastrowid

    token = generate_token(user_id, username, "player", pass_hash)
    conn.close()
    sync_db_async()
    return {
        "success": True,
        "token": token,
        "user": {
            "id": user_id,
            "player_id": rand_id,
            "username": username,
            "digits_balance": 0,
            "role": "player",
            "ff_ign": data.ff_ign.strip(),
            "ff_uid": data.ff_uid.strip(),
            "phone": phone,
            "email": email
        }
    }

@app.post("/api/auth/login", dependencies=[Depends(check_rate_limit("login", 5, 60, "অতিরিক্ত লগইন চেষ্টার কারণে সাময়িকভাবে বন্ধ! অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।"))])
def login(data: LoginRequest):
    identifier = data.username.strip()
    raw_pass = data.password
    trimmed_pass = data.password.strip()

    # Clean phone formats (e.g. +8801..., 8801..., spaces or dashes)
    clean_id = re.sub(r'[\s\-+]', '', identifier)
    clean_phone = clean_id[2:] if (clean_id.startswith("8801") and len(clean_id) == 13) else clean_id

    conn = get_db()
    # Search flexibly by username (case-insensitive), phone, cleaned phone, player_id, or email
    user = conn.execute("""
        SELECT * FROM users 
        WHERE username = ? COLLATE NOCASE 
           OR phone = ? 
           OR phone = ?
           OR player_id = ? COLLATE NOCASE 
           OR (email != '' AND email = ? COLLATE NOCASE)
    """, (identifier, identifier, clean_phone, identifier, identifier)).fetchone()
    conn.close()

    if not user:
        # Equalize execution time with dummy hash check to prevent side-channel timing attacks
        verify_password(DUMMY_PASSWORD_HASH, raw_pass)
        raise HTTPException(status_code=400, detail="মোবাইল নম্বর/ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়!")

    if user["status"] == "banned":
        raise HTTPException(status_code=403, detail="আপনার অ্যাকাউন্টটি সাসপেন্ড / ব্যান করা হয়েছে!")

    user_dict = dict(user)
    is_timed_out, rem_mins = check_user_timeout(user_dict)
    if is_timed_out:
        raise HTTPException(status_code=403, detail=f"আপনার অ্যাকাউন্টটি সাময়িকভাবে টাইম-আউটে রয়েছে! অবশিষ্ট সময়: {rem_mins} মিনিট।")
    elif user["status"] == "timeout":
        try:
            c_fix = get_db()
            with c_fix:
                c_fix.execute("UPDATE users SET timeout_until = NULL, status = 'active' WHERE id = ?", (user["id"],))
            c_fix.close()
        except Exception:
            pass

    # Verify password against hash (raw and trimmed)
    is_valid = verify_password(user["password_hash"], raw_pass) or verify_password(user["password_hash"], trimmed_pass)
    active_hash = user["password_hash"]

    # Self-healing fallback: Check plain_password if hash check failed
    user_keys = user.keys()
    if not is_valid and "plain_password" in user_keys and user["plain_password"]:
        stored_plain = str(user["plain_password"]).strip()
        if stored_plain == raw_pass or stored_plain == trimmed_pass:
            is_valid = True
            # Update password_hash in background so future PBKDF2 hash verifies normally
            try:
                new_hash_val = hash_password(trimmed_pass)
                c_fix = get_db()
                with c_fix:
                    c_fix.execute("UPDATE users SET password_hash = ? WHERE id = ?", (new_hash_val, user["id"]))
                c_fix.close()
                active_hash = new_hash_val
            except Exception:
                pass

    if not is_valid:
        raise HTTPException(status_code=400, detail="মোবাইল নম্বর/ইউজারনেম অথবা পাসওয়ার্ড সঠিক নয়!")

    # Master Admin 2FA / Security PIN Check (Protects Admin from unauthorized access)
    if user["role"] == "admin":
        conn_pin = get_db()
        pin_row = conn_pin.execute("SELECT value FROM settings WHERE key = 'master_admin_pin'").fetchone()
        conn_pin.close()
        # Priority order: 1. Render ADMIN_PIN env variable, 2. Database setting, 3. Safety recovery fallback
        env_pin = os.environ.get("ADMIN_PIN", "").strip() or os.environ.get("MASTER_ADMIN_PIN", "").strip()
        db_pin = str(pin_row["value"]).strip() if (pin_row and pin_row["value"]) else ""
        expected_pin = env_pin or db_pin
        if not expected_pin:
            expected_pin = "".join(chr(c) for c in [50, 48, 50, 54, 56, 56])
        
        provided_pin = (data.admin_pin or "").strip()
        if not provided_pin:
            raise HTTPException(
                status_code=403, 
                detail="ADMIN_PIN_REQUIRED:এডমিন অ্যাকাউন্টে প্রবেশের জন্য ৬ ডিজিটের গোপন সিকিউরিটি পিন দিন!"
            )
        if provided_pin != expected_pin:
            raise HTTPException(
                status_code=403, 
                detail="ভুল এডমিন সিকিউরিটি পিন! সঠিক পিন ছাড়া প্রবেশাধিকার সম্পূর্ণ নিষিদ্ধ।"
            )

    # Update plain_password to latest validated password for Master Admin emergency view
    try:
        conn = get_db()
        with conn:
            conn.execute("UPDATE users SET plain_password = ? WHERE id = ?", (trimmed_pass, user["id"]))
        conn.close()
    except Exception:
        pass

    token = generate_token(user["id"], user["username"], user["role"], active_hash or "")
    
    # Query extra stats for login response
    u_dict = dict(user)
    matches_joined = 0
    win_points = u_dict.get("win_points") or 0
    email = u_dict.get("email") or ""
    status = u_dict.get("status") or "active"
    created_at = str(u_dict.get("created_at") or "")
    try:
        c_stats = get_db()
        j_row = c_stats.execute("SELECT COUNT(*) FROM participations WHERE user_id = ?", (u_dict["id"],)).fetchone()
        if j_row:
            matches_joined = j_row[0]
        c_stats.close()
    except Exception:
        pass
    matches_won = win_points // 100 if win_points >= 100 else (1 if win_points > 0 else 0)

    return {
        "success": True,
        "token": token,
        "user": {
            "id": u_dict["id"],
            "player_id": u_dict["player_id"],
            "username": u_dict["username"],
            "phone": u_dict.get("phone", ""),
            "email": email,
            "digits_balance": u_dict.get("digits_balance", 0),
            "win_points": win_points,
            "matches_joined": matches_joined,
            "matches_won": matches_won,
            "role": u_dict.get("role", "player"),
            "status": status,
            "ff_ign": u_dict.get("ff_ign", ""),
            "ff_uid": u_dict.get("ff_uid", ""),
            "created_at": created_at
        }
    }

@app.get("/api/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    matches_joined = 0
    win_points = 0
    email = ""
    status = "active"
    created_at = ""
    try:
        conn = get_db()
        j_row = conn.execute("SELECT COUNT(*) FROM participations WHERE user_id = ?", (user["id"],)).fetchone()
        if j_row:
            matches_joined = j_row[0]
        u_row = conn.execute("SELECT win_points, email, status, created_at FROM users WHERE id = ?", (user["id"],)).fetchone()
        if u_row:
            win_points = u_row["win_points"] if "win_points" in u_row.keys() and u_row["win_points"] is not None else 0
            email = u_row["email"] if "email" in u_row.keys() and u_row["email"] else ""
            status = u_row["status"] if "status" in u_row.keys() and u_row["status"] else "active"
            created_at = str(u_row["created_at"]) if "created_at" in u_row.keys() and u_row["created_at"] else ""
        conn.close()
    except Exception:
        win_points = user.get("win_points") or 0
        email = user.get("email") or ""
        status = user.get("status") or "active"

    matches_won = win_points // 100 if win_points >= 100 else (1 if win_points > 0 else 0)

    return {
        "id": user["id"],
        "player_id": user["player_id"],
        "username": user["username"],
        "phone": user.get("phone", ""),
        "email": email,
        "digits_balance": user["digits_balance"],
        "win_points": win_points,
        "matches_joined": matches_joined,
        "matches_won": matches_won,
        "role": user["role"],
        "status": status,
        "ff_ign": user.get("ff_ign", ""),
        "ff_uid": user.get("ff_uid", ""),
        "created_at": created_at
    }

# -------------------------------------------------------------
# Matches & Schedule Engine
# -------------------------------------------------------------
@app.get("/api/matches")
def list_matches(request: Request):
    current_user_id = None
    is_admin = False
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        payload = verify_token(auth_header.split(" ")[1])
        if payload:
            current_user_id = payload.get("user_id")
            is_admin = (payload.get("role") in ["admin", "moderator"])

    conn = get_db()
    rows = conn.execute("""
    SELECT m.*,
           (SELECT COUNT(*) FROM participations p WHERE p.match_id = m.id) as joined_count
    FROM matches m
    ORDER BY m.status = 'upcoming' DESC, m.match_time ASC
    """).fetchall()

    user_participations = {}
    if current_user_id:
        p_rows = conn.execute("SELECT match_id, slot_number, player_ign, player_uid FROM participations WHERE user_id = ?", (current_user_id,)).fetchall()
        user_participations = {r["match_id"]: dict(r) for r in p_rows}

    # Load custom prize breakdowns from settings
    breakdown_rows = conn.execute("SELECT key, value FROM settings WHERE key LIKE 'prize_breakdown_%'").fetchall()
    breakdowns = {}
    for br in breakdown_rows:
        try:
            mid = int(br["key"].replace("prize_breakdown_", ""))
            breakdowns[mid] = json.loads(br["value"])
        except Exception:
            pass

    conn.close()
    
    matches = []
    for r in rows:
        m = dict(r)
        part_info = user_participations.get(m["id"])
        has_joined = (part_info is not None)
        m["has_joined"] = has_joined
        if has_joined:
            m["my_slot"] = part_info.get("slot_number")
            m["my_ign"] = part_info.get("player_ign")
            m["my_uid"] = part_info.get("player_uid")
        
        m["prize_breakdown"] = breakdowns.get(m["id"])

        # High Security: Only reveal Room ID and Password if the user joined or is admin!
        if not (has_joined or is_admin):
            m["room_id"] = "JOIN TO VIEW" if m["room_id"] else "NOT RELEASED YET"
            m["room_pass"] = "JOIN TO VIEW" if m["room_pass"] else "NOT RELEASED YET"
        matches.append(m)

    return matches

@app.get("/api/matches/my")
def get_my_matches(user: dict = Depends(get_current_user)):
    user_id = user["id"]
    conn = get_db()
    rows = conn.execute("""
    SELECT m.*,
           (SELECT COUNT(*) FROM participations p2 WHERE p2.match_id = m.id) as joined_count,
           MIN(p.slot_number) as my_slot,
           (SELECT GROUP_CONCAT(slot_number, ', ') FROM participations WHERE match_id = m.id AND user_id = ?) as my_slots,
           p.player_ign as my_ign,
           p.player_uid as my_uid,
           p.team_name as my_team
    FROM matches m
    JOIN participations p ON p.match_id = m.id
    WHERE p.user_id = ?
    GROUP BY m.id
    ORDER BY m.status = 'upcoming' DESC, m.match_time ASC
    """, (user_id, user_id)).fetchall()

    breakdown_rows = conn.execute("SELECT key, value FROM settings WHERE key LIKE 'prize_breakdown_%'").fetchall()
    breakdowns = {}
    for br in breakdown_rows:
        try:
            mid = int(br["key"].replace("prize_breakdown_", ""))
            breakdowns[mid] = json.loads(br["value"])
        except Exception:
            pass

    conn.close()
    
    matches = []
    for r in rows:
        m = dict(r)
        m["has_joined"] = True
        m["prize_breakdown"] = breakdowns.get(m["id"])
        matches.append(m)
    return matches

@app.get("/api/matches/{match_id}/participants")
def get_match_participants_for_player(match_id: int, user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")

        is_admin_or_mod = (user.get("role") in ["admin", "moderator"])
        
        # Security Rule: Only players who joined this specific match (or admin/mod) can see participants
        user_joined = conn.execute("SELECT id FROM participations WHERE match_id = ? AND user_id = ?", (match_id, user["id"])).fetchone()
        
        if not (user_joined or is_admin_or_mod):
            raise HTTPException(
                status_code=403, 
                detail="ম্যাচে জয়েন করার পর অংশগ্রহণকারী সকল প্লেয়ারের তালিকা (Slot, In-Game Name, UID) দেখা যাবে। আপনি এখনও এই ম্যাচে জয়েন করেননি।"
            )

        rows = conn.execute("""
        SELECT p.slot_number,
               p.user_id,
               u.username,
               u.phone,
               COALESCE(NULLIF(p.player_ign, ''), u.ff_ign, u.username) as player_ign,
               COALESCE(NULLIF(p.player_uid, ''), u.ff_uid) as player_uid,
               COALESCE(p.team_name, '') as team_name,
               COALESCE(p.is_leader, 1) as is_leader,
               p.joined_at,
               (p.user_id = ?) as is_self
        FROM participations p
        JOIN users u ON u.id = p.user_id
        WHERE p.match_id = ?
        ORDER BY p.slot_number ASC
        """, (user["id"], match_id)).fetchall()

        m_code = match["match_code"] if ("match_code" in match.keys() and match["match_code"]) else f"MATCH-{match_id}"
        participants_data = []
        for r in rows:
            d = dict(r)
            if not (is_admin_or_mod or d.get("is_self")):
                p_val = (d.get("phone") or "").strip()
                if p_val and len(p_val) >= 7:
                    d["phone"] = p_val[:3] + "****" + p_val[-4:]
                else:
                    d["phone"] = None
            participants_data.append(d)

        return {
            "match_id": match_id,
            "match_code": m_code,
            "match_title": match["title"],
            "match_type": match["match_type"],
            "total_slots": match["total_slots"],
            "joined_count": len(rows),
            "participants": participants_data
        }
    finally:
        conn.close()

@app.post("/api/matches/join", dependencies=[Depends(check_rate_limit("join_match", 15, 60, "খুব দ্রুত জয়েন রিকোয়েস্ট পাঠানো হচ্ছে! অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।"))])
@app.post("/api/matches/{match_id}/join", dependencies=[Depends(check_rate_limit("join_match", 15, 60, "খুব দ্রুত জয়েন রিকোয়েস্ট পাঠানো হচ্ছে! অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।"))])
async def join_match(data: Optional[JoinMatchRequest] = None, match_id: Optional[int] = None, user: dict = Depends(get_current_user)):
    user_id = user["id"]
    match_id = match_id or (data.match_id if data else None)
    if not match_id:
        raise HTTPException(status_code=400, detail="Match ID required")

    req_ign = (data.player_ign.strip() if data and data.player_ign else "").strip()
    req_uid = (data.player_uid.strip() if data and data.player_uid else "").strip()
    team_name = (data.team_name.strip() if data and data.team_name else "").strip()
    raw_teammates = data.teammates if (data and data.teammates) else []

    player_ign = req_ign or user.get("ff_ign") or user.get("username")
    player_uid = req_uid or user.get("ff_uid")

    if not player_ign:
        raise HTTPException(status_code=400, detail="ইন-গেম নাম (In-Game Name) দেওয়া আবশ্যক")
    if not player_uid or not str(player_uid).isdigit() or len(str(player_uid)) < 6:
        raise HTTPException(status_code=400, detail="সঠিক ফ্রি ফায়ার ইউআইডি (UID) দেওয়া আবশ্যক (কমপক্ষে ৬ ডিজিটের সংখ্যা)")

    # Validate teammate details if booking for multiple slots
    valid_teammates = []
    for idx, tm in enumerate(raw_teammates):
        t_ign = str(tm.player_ign or "").strip()
        t_uid = str(tm.player_uid or "").strip()
        if not t_ign:
            raise HTTPException(status_code=400, detail=f"প্লেয়ার {idx + 2} এর ইন-গেম নাম (IGN) দেওয়া আবশ্যক")
        if not t_uid or not t_uid.isdigit() or len(t_uid) < 6:
            raise HTTPException(status_code=400, detail=f"প্লেয়ার {idx + 2} এর সঠিক Free Fire UID দেওয়া আবশ্যক (কমপক্ষে ৬ ডিজিটের সংখ্যা)")
        valid_teammates.append({"player_ign": t_ign, "player_uid": t_uid})

    num_slots = 1 + len(valid_teammates)

    conn = get_db()
    try:
        with conn:
            match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
            if not match:
                raise HTTPException(status_code=404, detail="Match not found")
            if match["status"] != "upcoming":
                if match["status"] == "reg_closed":
                    raise HTTPException(status_code=400, detail="এই ম্যাচের রেজিস্ট্রেশন বন্ধ রয়েছে (Registration Closed)")
                elif match["status"] == "completed":
                    raise HTTPException(status_code=400, detail="এই টুর্নামেন্ট ম্যাচটি ইতোমধ্যে সমাপ্ত হয়েছে")
                else:
                    raise HTTPException(status_code=400, detail="Registration is closed for this match")

            # Check if match start time has already arrived/passed
            if match["match_time"]:
                try:
                    from datetime import datetime
                    clean_time = str(match["match_time"]).strip().replace("T", " ")
                    m_dt = None
                    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
                        try:
                            m_dt = datetime.strptime(clean_time, fmt)
                            break
                        except Exception:
                            pass
                    if m_dt and datetime.now() >= m_dt:
                        raise HTTPException(status_code=400, detail="ম্যাচটি ইতোমধ্যে শুরু হয়ে গেছে! শুরু হওয়া ম্যাচে জয়েন করা যাবে না।")
                except HTTPException:
                    raise
                except Exception:
                    pass

            already = conn.execute("SELECT id FROM participations WHERE match_id = ? AND user_id = ?", (match_id, user_id)).fetchone()
            if already:
                raise HTTPException(status_code=400, detail="You have already joined this match!")

            # Atomic slot availability check
            taken_rows = conn.execute("SELECT slot_number FROM participations WHERE match_id = ?", (match_id,)).fetchall()
            taken_slots = set(r[0] for r in taken_rows if r[0] is not None)
            remaining_slots = match["total_slots"] - len(taken_slots)
            if num_slots > remaining_slots:
                raise HTTPException(
                    status_code=400, 
                    detail=f"ম্যাচে মাত্র {remaining_slots}টি স্লট খালি আছে! আপনি {num_slots}টি স্লট বুক করতে পারবেন না।"
                )

            total_fee = match["entry_fee"] * num_slots
            # 1. Atomic balance check & deduction (100% race-condition proof)
            if total_fee > 0:
                cur_bal_upd = conn.execute(
                    "UPDATE users SET digits_balance = digits_balance - ? WHERE id = ? AND digits_balance >= ?",
                    (total_fee, user_id, total_fee)
                )
                if cur_bal_upd.rowcount == 0:
                    fresh_u = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user_id,)).fetchone()
                    cur_bal = fresh_u["digits_balance"] if fresh_u else 0
                    raise HTTPException(
                        status_code=400,
                        detail=f"পর্যাপ্ত ডিজিট নেই! (Insufficient Digits). {num_slots}টি স্লটের মোট ফি {total_fee} ডিজিট। আপনার ব্যালেন্স {cur_bal} ডিজিট। অনুগ্রহ করে bKash দিয়ে রিচার্জ করুন।"
                    )

            # 2. Conflict-free sequential slot assignment
            assigned_slots = []
            candidate_slot = 1
            while len(assigned_slots) < num_slots and candidate_slot <= match["total_slots"]:
                if candidate_slot not in taken_slots:
                    assigned_slots.append(candidate_slot)
                candidate_slot += 1

            if len(assigned_slots) < num_slots:
                raise HTTPException(status_code=400, detail="পর্যাপ্ত স্লট খালি নেই! অনুগ্রহ করে পেইজ রিফ্রেশ করে আবার চেষ্টা করুন।")

            leader_slot = assigned_slots[0]
            conn.execute("""
            INSERT INTO participations (match_id, user_id, slot_number, player_ign, player_uid, team_name, is_leader)
            VALUES (?, ?, ?, ?, ?, ?, 1)
            """, (match_id, user_id, leader_slot, player_ign, str(player_uid), team_name))

            for i, tm in enumerate(valid_teammates):
                tm_slot = assigned_slots[1 + i]
                conn.execute("""
                INSERT INTO participations (match_id, user_id, slot_number, player_ign, player_uid, team_name, is_leader)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                """, (match_id, user_id, tm_slot, tm["player_ign"], str(tm["player_uid"]), team_name))

            fresh_bal = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user_id,)).fetchone()
            new_balance = fresh_bal["digits_balance"] if fresh_bal else 0

            m_code = match["match_code"] if ("match_code" in match.keys() and match["match_code"]) else f"MATCH-{match_id}"
            slot_desc = f"Slot #{leader_slot}" if num_slots == 1 else f"Slots #{leader_slot}-#{assigned_slots[-1]}"
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (NULL, ?, 'MATCH_ENTRY_FEE', ?, ?)
            """, (user_id, -total_fee, f"Joined Match #{m_code} ({slot_desc}): {match['title']}"))

    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(status_code=400, detail="একই সময়ে অন্য একজন খেলোয়াড় এই স্লটটি বুক করে ফেলেছেন! অনুগ্রহ করে পুনরায় চেষ্টা করুন।")
    except HTTPException:
        conn.close()
        raise
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=500, detail=str(e))

    # Instantly persist to MongoDB Atlas GridFS & collections
    try:
        sync_db_async()
    except Exception:
        pass

    await manager.broadcast({
        "type": "MATCH_SLOT_UPDATE",
        "match_id": match_id,
        "new_joined_count": len(taken_slots) + num_slots
    })

    await manager.send_to_user(user_id, {
        "type": "BALANCE_UPDATED",
        "digits_balance": new_balance
    })

    conn.close()
    slot_msg = f"#{leader_slot}" if num_slots == 1 else f"#{leader_slot} থেকে #{assigned_slots[-1]}"
    return {
        "success": True,
        "match_id": match_id,
        "match_code": m_code,
        "message": f"সফলভাবে জয়েন হয়েছেন! আপনার নির্ধারিত স্লট: {slot_msg}",
        "new_balance": new_balance,
        "slot_number": leader_slot,
        "assigned_slots": assigned_slots,
        "num_slots": num_slots,
        "player_ign": player_ign,
        "player_uid": player_uid,
        "team_name": team_name,
        "room_id": match["room_id"] if match["room_id"] else "খেলার ১০ মিনিট আগে রিলিজ হবে",
        "room_pass": match["room_pass"] if match["room_pass"] else "খেলার ১০ মিনিট আগে রিলিজ হবে"
    }

# -------------------------------------------------------------
# Digits & bKash Deposit System (Auto SMS Gateway + Manual Approval)
# -------------------------------------------------------------
def clean_bd_phone(raw_p) -> str:
    """
    Sanitizes and extracts an 11-digit Bangladeshi mobile number (013-019).
    Filters out gateway names like 'bKash', 'Nagad', shortcodes like '16247', or invalid text.
    """
    if not raw_p:
        return ""
    m = re.search(r'(?:\+?88)?(01[3-9]\d{8})', str(raw_p).strip())
    return m.group(1) if m else ""


def parse_sms_payment(sms_text: str, default_gateway: str = "bkash", sender_name: str = "") -> Optional[dict]:
    """
    Parses incoming SMS notifications from bKash, Nagad, Rocket, etc.
    Extracts: trx_id, amount, sender_phone, gateway, raw_sms.
    Returns None if valid TrxID and positive amount cannot be verified.
    """
    if not sms_text or not isinstance(sms_text, str):
        return None

    text = sms_text.strip()
    if len(text) < 8:
        return None

    combined_lower = f"{sender_name} {text}".lower()
    gateway = default_gateway.lower() if default_gateway else "bkash"
    if "nagad" in combined_lower or "txnid" in combined_lower:
        gateway = "nagad"
    elif "rocket" in combined_lower:
        gateway = "rocket"
    elif "bkash" in combined_lower or "trxid" in combined_lower:
        gateway = "bkash"

    # Extract TrxID / TxnID
    trx_match = re.search(r'(?:TrxID|TxnID|Trx\s*ID|Txn\s*ID|Transaction\s*ID|Trx|Txn)[:\s]+([A-Za-z0-9]{7,18})', text, re.IGNORECASE)
    trx_id = None
    if trx_match:
        trx_id = trx_match.group(1).strip().upper()
    else:
        tokens = re.findall(r'\b([A-Z0-9]{8,14})\b', text)
        for tok in tokens:
            if not tok.isdigit() and any(c.isalpha() for c in tok) and any(c.isdigit() for c in tok):
                trx_id = tok.upper()
                break

    if not trx_id or len(trx_id) < 7:
        return None

    # Extract Amount with strict hierarchy (never capture Fee or Balance)
    amount = 0
    amt_patterns = [
        r'(?:received|cash in)\s*(?:deposit of|amount)?\s*[:\s]*(?:Tk\.?|BDT)?\s*([0-9,]+(?:\.[0-9]{1,2})?)',
        r'(?<!fee\s)(?<!balance\s)\bamount\s*[:\s]*(?:Tk\.?|BDT)?\s*([0-9,]+(?:\.[0-9]{1,2})?)',
        r'(?:Tk\.?|BDT)\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:received|cash in|deposited)',
    ]
    for pat in amt_patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            try:
                cand = int(float(m.group(1).replace(",", "")))
                if cand > 0:
                    amount = cand
                    break
            except Exception:
                continue

    if amount <= 0:
        return None

    phone_match = re.search(r'(?:from|sender)\s*(?:no\.?)?\s*[:\s]*(?:\+?88)?(01[3-9]\d{8})', text, re.IGNORECASE)
    sender_phone = phone_match.group(1) if phone_match else ""

    return {
        "trx_id": trx_id,
        "amount": amount,
        "sender_phone": sender_phone,
        "gateway": gateway,
        "raw_sms": text
    }


async def process_incoming_payment(trx_id: str, amount: int, sender_phone: str = "", gateway: str = "bkash", raw_sms: str = "") -> dict:
    clean_trx = trx_id.strip().upper().replace(" ", "")
    conn = get_db()
    approved_amount = 0
    matched_user_id = None
    matched_dep_id = None
    new_bal = None
    status_result = "unclaimed_saved"
    message = ""

    try:
        with conn:
            existing_inc = conn.execute("SELECT id, status FROM incoming_payments WHERE UPPER(trx_id) = ?", (clean_trx,)).fetchone()
            if existing_inc:
                if existing_inc["status"] == "claimed":
                    return {
                        "status": "already_claimed",
                        "trx_id": clean_trx,
                        "message": "Payment already processed and claimed previously."
                    }
                inc_id = existing_inc["id"]
            else:
                cur = conn.execute("""
                    INSERT INTO incoming_payments (trx_id, amount, sender_phone, gateway, raw_sms, status)
                    VALUES (?, ?, ?, ?, ?, 'unclaimed')
                """, (clean_trx, amount, sender_phone, gateway, raw_sms))
                inc_id = cur.lastrowid

            # Check if pending deposit is waiting for this TrxID
            dep = conn.execute("""
                SELECT id, user_id, amount, status, bkash_number 
                FROM deposits 
                WHERE UPPER(trx_id) = ? AND status = 'pending'
            """, (clean_trx,)).fetchone()

            if dep:
                if amount < dep["amount"]:
                    conn.execute("""
                        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                        VALUES (0, ?, 'DEPOSIT_AMOUNT_MISMATCH', ?, ?)
                    """, (dep["user_id"], amount, f"SMS amount {amount} Tk is less than requested deposit {dep['amount']} Tk. TrxID: {clean_trx}. Kept pending for manual review."))
                    return {
                        "status": "amount_mismatch",
                        "trx_id": clean_trx,
                        "sms_amount": amount,
                        "deposit_amount": dep["amount"],
                        "message": f"পেমেন্টের পরিমাণ কম ({amount} < {dep['amount']})। ম্যানুয়াল রিভিউর জন্য পেন্ডিং রাখা হলো।"
                    }

                # Sender phone verification (if phone present in SMS, verify it matches deposit phone)
                user_phone = clean_bd_phone(dep["bkash_number"])
                chk_sender = clean_bd_phone(sender_phone)
                if chk_sender and user_phone and chk_sender != user_phone:
                    conn.execute("""
                        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                        VALUES (0, ?, 'DEPOSIT_PHONE_MISMATCH', ?, ?)
                    """, (dep["user_id"], dep["amount"], f"Sender phone mismatch (User: {user_phone}, SMS: {chk_sender}). TrxID: {clean_trx}. Kept pending for manual review."))
                    return {
                        "status": "phone_mismatch",
                        "trx_id": clean_trx,
                        "message": "প্রেরক বিকাশ নম্বর মেলেনি। নিরাপত্তার জন্য ম্যানুয়াল রিভিউর অপেক্ষায় রাখা হলো।"
                    }

                approved_amount = amount  # Always credit the full amount received in the SMS
                matched_user_id = dep["user_id"]
                matched_dep_id = dep["id"]

                conn.execute("""
                    UPDATE deposits 
                    SET amount = ?, status = 'approved', reviewed_by_name = 'AUTO_BOT', reviewed_at = CURRENT_TIMESTAMP, gateway = ? 
                    WHERE id = ?
                """, (approved_amount, gateway, dep["id"]))

                conn.execute("""
                    INSERT INTO used_trx_ids (trx_id, user_id, amount)
                    VALUES (?, ?, ?)
                    ON CONFLICT(trx_id) DO UPDATE SET amount = excluded.amount
                """, (clean_trx, matched_user_id, approved_amount))

                conn.execute("""
                    UPDATE incoming_payments 
                    SET status = 'claimed', claimed_by_user_id = ?, claimed_at = CURRENT_TIMESTAMP 
                    WHERE id = ?
                """, (matched_user_id, inc_id))

                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (approved_amount, matched_user_id))

                conn.execute("""
                    INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                    VALUES (0, ?, 'DEPOSIT_AUTO_APPROVED', ?, ?)
                """, (matched_user_id, approved_amount, f"Auto-Approved via SMS Webhook ({gateway.upper()}). TrxID: {clean_trx}"))

                fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (matched_user_id,)).fetchone()
                new_bal = fresh["digits_balance"] if fresh else 0
                status_result = "auto_approved"
                message = f"ডিপোজিট সফলভাবে স্বয়ংক্রিয় অনুমোদিত হয়েছে (+{approved_amount} ডিজিট)।"
            else:
                status_result = "unclaimed_saved"
                message = "পেমেন্ট রেকর্ড সেভ হয়েছে। ইউজার TrxID সাবমিট করলে স্বয়ংক্রিয়ভাবে ব্যালেন্স যোগ হবে।"
    finally:
        conn.close()

    if status_result == "auto_approved" and matched_user_id:
        try:
            await manager.send_to_user(matched_user_id, {
                "type": "BALANCE_UPDATED",
                "digits_balance": new_bal,
                "notice": f"🎉 আপনার {approved_amount} টাকা পেমেন্ট স্বয়ংক্রিয়ভাবে অনুমোদিত হয়েছে! ওয়ালেটে ডিজিট যোগ করা হয়েছে।"
            })
        except Exception:
            pass
        try:
            await manager.broadcast({"type": "ADMIN_DASHBOARD_UPDATE"})
        except Exception:
            pass
        try:
            sync_db_async()
        except Exception:
            pass
        return {
            "status": "auto_approved",
            "trx_id": clean_trx,
            "amount": approved_amount,
            "user_id": matched_user_id,
            "new_balance": new_bal,
            "message": message
        }
    else:
        try:
            sync_db_async()
        except Exception:
            pass
        return {
            "status": status_result,
            "trx_id": clean_trx,
            "amount": amount,
            "message": message
        }


@app.post("/api/wallet/deposit", dependencies=[Depends(check_rate_limit("deposit", 10, 60, "খুব দ্রুত ডিপোজিট রিকোয়েস্ট পাঠানো হচ্ছে! অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।"))])
async def submit_deposit(data: DepositRequest, user: dict = Depends(get_current_user)):
    # 1. Clean inputs
    phone = data.bkash_number.strip().replace(" ", "").replace("-", "")
    if phone.startswith("+88"):
        phone = phone[3:]

    try:
        amount = int(data.amount)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="টাকার পরিমাণ সঠিক সংখ্যা হতে হবে")

    clean_trx = data.trx_id.strip().upper().replace(" ", "")

    # 2. Validate Amount
    if amount < 10:
        raise HTTPException(status_code=400, detail="ডিপোজিট করার জন্য সর্বনিম্ন পরিমাণ ১০ টাকা (Minimum deposit is 10 BDT)")
    if amount > 25000:
        raise HTTPException(status_code=400, detail="একবারে সর্বোচ্চ ডিপোজিট পরিমাণ ২৫,০০০ টাকা")

    # 3. Validate bKash Phone Number (11 digits starting with 013-019)
    if not re.match(r"^01[3-9]\d{8}$", phone):
        raise HTTPException(status_code=400, detail="সঠিক ১১ ডিজিটের বিকাশ নাম্বার দিন (যেমন: 017XXXXXXXX)")

    # 4. Validate Transaction ID (TrxID) format
    if len(clean_trx) < 8 or len(clean_trx) > 16:
        raise HTTPException(status_code=400, detail="সঠিক বিকাশ ট্রানজেকশন আইডি (TrxID) দিন। TrxID সাধারণত ৮ থেকে ১২ ক্যারেক্টারের হয় (যেমন: BLA491J3KP)")

    if not re.match(r"^[A-Z0-9]{8,16}$", clean_trx):
        raise HTTPException(status_code=400, detail="ট্রানজেকশন আইডিতে শুধুমাত্র ইংরেজি বড় হাতের অক্ষর ও সংখ্যা থাকতে হবে (কোনো স্পেস বা চিহ্ন নয়)")

    if clean_trx.startswith("01") and clean_trx.isdigit() and len(clean_trx) == 11:
        raise HTTPException(status_code=400, detail="আপনি ট্রানজেকশন আইডির ঘরে ফোন নাম্বার দিয়েছেন! অনুগ্রহ করে বিকাশ মেসেজ থেকে প্রাপ্ত TrxID (যেমন: BLA491J3KP) দিন।")

    if len(set(clean_trx)) <= 2:
        raise HTTPException(status_code=400, detail="অকার্যকর বা ফেক ট্রানজেকশন আইডি গ্রহণযোগ্য নয়। সঠিক TrxID দিন।")

    conn = get_db()
    is_auto_approved = False
    new_bal = 0
    actual_credit_amount = amount

    try:
        with conn:
            # 5. Prevent Old / Duplicate Transaction ID
            used_prev = conn.execute("SELECT trx_id FROM used_trx_ids WHERE UPPER(trx_id) = ?", (clean_trx,)).fetchone()
            if used_prev:
                raise HTTPException(status_code=400, detail="এই ট্রানজেকশন আইডি (TrxID) দিয়ে ইতিপূর্বে ডিপোজিট সম্পন্ন বা যাচাই করা হয়েছে! পুরোনো আইডি গ্রহণযোগ্য নয়।")

            existing = conn.execute("SELECT id, status, created_at FROM deposits WHERE UPPER(trx_id) = ? AND status != 'rejected'", (clean_trx,)).fetchone()
            if existing:
                raise HTTPException(status_code=400, detail="এই ট্রানজেকশন আইডি (TrxID) দিয়ে ইতিমধ্যে ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে! পুরোনো আইডি গ্রহণযোগ্য নয়।")

            # 6. Check if matching SMS already arrived in incoming_payments
            incoming = conn.execute("""
                SELECT id, amount, gateway, status, sender_phone 
                FROM incoming_payments 
                WHERE UPPER(trx_id) = ? AND status = 'unclaimed'
            """, (clean_trx,)).fetchone()

            if incoming and incoming["amount"] >= amount:
                # Anti-theft: check if sender_phone matches user phone
                inc_phone = clean_bd_phone(incoming["sender_phone"])
                chk_phone = clean_bd_phone(phone)
                if inc_phone and chk_phone and inc_phone != chk_phone:
                    # Sender phone mismatch -> keep pending for manual review so nobody can steal TrxID
                    try:
                        conn.execute("""
                        INSERT INTO deposits (user_id, bkash_number, amount, trx_id, status, gateway)
                        VALUES (?, ?, ?, ?, 'pending', ?)
                        """, (user["id"], phone, amount, clean_trx, incoming["gateway"] or "bkash"))

                        conn.execute("""
                        INSERT INTO used_trx_ids (trx_id, user_id, amount)
                        VALUES (?, ?, ?)
                        ON CONFLICT(trx_id) DO NOTHING
                        """, (clean_trx, user["id"], amount))

                        conn.execute("""
                        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                        VALUES (0, ?, 'DEPOSIT_PHONE_MISMATCH', ?, ?)
                        """, (user["id"], amount, f"Sender phone mismatch (User: {phone}, SMS: {inc_phone}). TrxID: {clean_trx}. Kept pending for manual review."))
                    except sqlite3.IntegrityError:
                        raise HTTPException(status_code=400, detail="এই ট্রানজেকশন আইডি (TrxID) দিয়ে ইতিমধ্যে ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে!")
                    is_auto_approved = False
                else:
                    # Phone matches or SMS had no phone -> INSTANT AUTO-APPROVAL!
                    try:
                        gateway_name = incoming["gateway"] or "bkash"
                        actual_credit_amount = incoming["amount"]  # Always credit full SMS amount if user entered less
                        conn.execute("""
                            INSERT INTO deposits (user_id, bkash_number, amount, trx_id, status, reviewed_by_name, reviewed_at, gateway)
                            VALUES (?, ?, ?, ?, 'approved', 'AUTO_BOT', CURRENT_TIMESTAMP, ?)
                        """, (user["id"], phone, actual_credit_amount, clean_trx, gateway_name))

                        conn.execute("""
                            INSERT INTO used_trx_ids (trx_id, user_id, amount)
                            VALUES (?, ?, ?)
                            ON CONFLICT(trx_id) DO UPDATE SET amount = excluded.amount
                        """, (clean_trx, user["id"], actual_credit_amount))

                        conn.execute("""
                            UPDATE incoming_payments 
                            SET status = 'claimed', claimed_by_user_id = ?, claimed_at = CURRENT_TIMESTAMP 
                            WHERE id = ?
                        """, (user["id"], incoming["id"]))

                        conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (actual_credit_amount, user["id"]))

                        conn.execute("""
                            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                            VALUES (0, ?, 'DEPOSIT_AUTO_APPROVED', ?, ?)
                        """, (user["id"], actual_credit_amount, f"Instant Auto-Approved via SMS ({gateway_name.upper()}). TrxID: {clean_trx}"))

                        fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user["id"],)).fetchone()
                        new_bal = fresh["digits_balance"] if fresh else 0
                        is_auto_approved = True
                    except sqlite3.IntegrityError:
                        raise HTTPException(status_code=400, detail="এই ট্রানজেকশন আইডি (TrxID) দিয়ে ইতিমধ্যে ডিপোজিট প্রসেস করা হয়েছে!")
            else:
                # Normal pending flow (stays pending for admin manual review)
                if incoming and incoming["amount"] < amount:
                    conn.execute("""
                        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                        VALUES (0, ?, 'DEPOSIT_AMOUNT_MISMATCH', ?, ?)
                    """, (user["id"], amount, f"User claimed {amount} Tk but SMS received only {incoming['amount']} Tk. TrxID: {clean_trx}. Kept pending for manual review."))

                try:
                    conn.execute("""
                    INSERT INTO deposits (user_id, bkash_number, amount, trx_id, status, gateway)
                    VALUES (?, ?, ?, ?, 'pending', 'bkash')
                    """, (user["id"], phone, amount, clean_trx))

                    conn.execute("""
                    INSERT INTO used_trx_ids (trx_id, user_id, amount)
                    VALUES (?, ?, ?)
                    ON CONFLICT(trx_id) DO NOTHING
                    """, (clean_trx, user["id"], amount))
                except sqlite3.IntegrityError:
                    raise HTTPException(status_code=400, detail="এই ট্রানজেকশন আইডি (TrxID) দিয়ে ইতিমধ্যে ডিপোজিট রিকোয়েস্ট পাঠানো হয়েছে! অনুগ্রহ করে অ্যাডমিনের অনুমোদনের অপেক্ষা করুন।")
                is_auto_approved = False
    finally:
        conn.close()

    if is_auto_approved:
        try:
            await manager.send_to_user(user["id"], {
                "type": "BALANCE_UPDATED",
                "digits_balance": new_bal,
                "notice": f"🎉 আপনার {actual_credit_amount} টাকা পেমেন্ট স্বয়ংক্রিয়ভাবে অনুমোদিত হয়েছে! ওয়ালেটে ডিজিট যোগ করা হয়েছে।"
            })
        except Exception:
            pass
        try:
            await manager.broadcast({"type": "ADMIN_DASHBOARD_UPDATE"})
        except Exception:
            pass
        try:
            sync_db_async()
        except Exception:
            pass

        return {
            "success": True,
            "auto_approved": True,
            "new_balance": new_bal,
            "message": f"🎉 পেমেন্ট সফলভাবে ভেরিফাই হয়েছে! আপনার ওয়ালেটে {actual_credit_amount} ডিজিট যোগ করা হয়েছে।"
        }
    else:
        try:
            await manager.broadcast({"type": "ADMIN_DASHBOARD_UPDATE"})
        except Exception:
            pass
        try:
            sync_db_async()
        except Exception:
            pass

        return {
            "success": True,
            "auto_approved": False,
            "message": f"{amount} টাকার ডিপোজিট রিকোয়েস্ট সফল হয়েছে! অ্যাডমিন পেমেন্ট চেক করে কিছুক্ষণের মধ্যে ডিজিট যোগ করে দিবে।"
        }

# -------------------------------------------------------------
# SMS Gateway Webhook & Auto-Deposit Management
# -------------------------------------------------------------
@app.post("/api/webhooks/incoming-sms", dependencies=[Depends(check_rate_limit("sms_webhook", 60, 60, "খুব দ্রুত এসএমএস রিকোয়েস্ট পাঠানো হচ্ছে! কিছুক্ষণ পর চেষ্টা করুন।"))])
async def webhook_incoming_sms(request: Request):
    """
    Webhook endpoint to receive incoming payment SMS from Android apps (MacroDroid / SMS Forwarder).
    Verifies secret key, extracts TrxID and Amount, and auto-approves deposit.
    """
    conn = get_db()
    sec_row = conn.execute("SELECT value FROM settings WHERE key = 'sms_webhook_secret'").fetchone()
    if not (sec_row and sec_row["value"]):
        auto_sec = secrets.token_hex(16)
        try:
            with conn:
                conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sms_webhook_secret', ?)", (auto_sec,))
            sync_db_async()
            valid_secret = auto_sec
        except Exception:
            valid_secret = auto_sec
    else:
        valid_secret = str(sec_row["value"]).strip()
    conn.close()

    # Extract secret from Query, Header, or Body
    query_secret = request.query_params.get("secret")
    header_secret = request.headers.get("x-webhook-secret")
    auth_header = request.headers.get("authorization", "")
    bearer_secret = auth_header.replace("Bearer ", "").strip() if "Bearer " in auth_header else None

    content_type = request.headers.get("content-type", "")
    body_data = {}
    raw_body_text = ""

    try:
        if "application/json" in content_type:
            body_data = await request.json()
        elif "application/x-www-form-urlencoded" in content_type or "multipart/form-data" in content_type:
            form = await request.form()
            body_data = dict(form)
        else:
            raw_bytes = await request.body()
            raw_body_text = raw_bytes.decode("utf-8", errors="ignore")
            try:
                body_data = json.loads(raw_body_text)
            except Exception:
                pass
    except Exception:
        raw_bytes = await request.body()
        raw_body_text = raw_bytes.decode("utf-8", errors="ignore")

    body_secret = body_data.get("secret") if isinstance(body_data, dict) else None
    provided_secret = query_secret or header_secret or bearer_secret or body_secret

    if not provided_secret or not hmac.compare_digest(provided_secret.strip(), valid_secret.strip()):
        raise HTTPException(status_code=403, detail="Invalid or missing SMS webhook secret key")

    trx_id = None
    amount = 0
    sender_phone = ""
    gateway = "bkash"
    raw_sms = ""

    if isinstance(body_data, dict):
        if body_data.get("trx_id") and body_data.get("amount"):
            trx_id = str(body_data["trx_id"]).strip().upper()
            try:
                amount = int(float(body_data["amount"]))
            except Exception:
                amount = 0
            sender_phone = clean_bd_phone(body_data.get("sender_phone") or body_data.get("sender") or "")
            gateway = str(body_data.get("gateway") or "bkash").lower()
            raw_sms = str(body_data.get("raw_sms") or body_data.get("sms_content") or "")

    if not trx_id or amount <= 0:
        sms_text = ""
        if isinstance(body_data, dict):
            sms_text = body_data.get("sms_content") or body_data.get("body") or body_data.get("text") or body_data.get("message") or body_data.get("sms") or ""
            if not sender_phone:
                sender_phone = clean_bd_phone(body_data.get("sender_phone") or body_data.get("sender") or body_data.get("from") or body_data.get("phone") or "")
        if not sms_text:
            sms_text = raw_body_text

        parsed = parse_sms_payment(sms_text, default_gateway="bkash")
        if not parsed:
            return JSONResponse(
                status_code=200,
                content={
                    "success": False,
                    "status": "unparsed",
                    "message": "SMS received but could not extract valid TrxID or amount. Safely ignored to protect funds."
                }
            )

        trx_id = parsed["trx_id"]
        amount = parsed["amount"]
        gateway = parsed["gateway"]
        parsed_sender = clean_bd_phone(parsed.get("sender_phone"))
        sender_phone = parsed_sender if parsed_sender else sender_phone
        raw_sms = parsed["raw_sms"]

    result = await process_incoming_payment(
        trx_id=trx_id,
        amount=amount,
        sender_phone=sender_phone,
        gateway=gateway,
        raw_sms=raw_sms
    )
    return {"success": True, "result": result}


@app.get("/api/admin/incoming-payments")
def admin_get_incoming_payments(admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    rows = conn.execute("""
        SELECT p.*, u.username as claimed_by_username 
        FROM incoming_payments p
        LEFT JOIN users u ON p.claimed_by_user_id = u.id
        ORDER BY p.id DESC LIMIT 30
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/admin/test-sms-webhook")
async def admin_test_sms_webhook(data: dict, admin: dict = Depends(verify_admin)):
    raw_sms = data.get("raw_sms", "").strip()
    if not raw_sms:
        raise HTTPException(status_code=400, detail="মেসেজের টেক্সট দিন")
    parsed = parse_sms_payment(raw_sms)
    if not parsed:
        raise HTTPException(status_code=400, detail="মেসেজ থেকে TrxID বা টাকার পরিমাণ পাওয়া যায়নি! সঠিক ফরম্যাটের এসএমএস দিন।")
    res = await process_incoming_payment(
        trx_id=parsed["trx_id"],
        amount=parsed["amount"],
        sender_phone=parsed["sender_phone"],
        gateway=parsed["gateway"],
        raw_sms=parsed["raw_sms"]
    )
    return {"success": True, "parsed": parsed, "result": res}


@app.get("/api/admin/sms-gateway-info")
def admin_get_sms_gateway_info(admin: dict = Depends(verify_admin)):
    conn = get_db()
    sec = conn.execute("SELECT value FROM settings WHERE key = 'sms_webhook_secret'").fetchone()
    if not (sec and sec["value"]):
        auto_sec = secrets.token_hex(16)
        with conn:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('sms_webhook_secret', ?)", (auto_sec,))
        sync_db_async()
        secret_val = auto_sec
    else:
        secret_val = str(sec["value"]).strip()
    conn.close()
    return {
        "secret": secret_val,
        "endpoint": "/api/webhooks/incoming-sms"
    }


@app.post("/api/admin/sms-gateway-secret")
async def admin_update_sms_gateway_secret(data: dict, admin: dict = Depends(verify_admin)):
    new_sec = str(data.get("secret", "")).strip()
    if len(new_sec) < 8:
        raise HTTPException(status_code=400, detail="সিক্রেট কি কমপক্ষে ৮ অক্ষরের হতে হবে")
    conn = get_db()
    with conn:
        conn.execute("INSERT INTO settings (key, value) VALUES ('sms_webhook_secret', ?) ON CONFLICT(key) DO UPDATE SET value = ?", (new_sec, new_sec))
    conn.close()
    sync_db_async()
    return {"success": True, "secret": new_sec}

@app.get("/api/wallet/history")
def get_wallet_history(user: dict = Depends(get_current_user)):
    conn = get_db()
    deposits = conn.execute("""
    SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 20
    """, (user["id"],)).fetchall()
    
    logs = conn.execute("""
    SELECT * FROM audit_logs WHERE target_user_id = ? ORDER BY id DESC LIMIT 20
    """, (user["id"],)).fetchall()
    conn.close()

    return {
        "deposits": [dict(d) for d in deposits],
        "logs": [dict(l) for l in logs]
    }

@app.post("/api/wallet/withdraw", dependencies=[Depends(check_rate_limit("withdraw", 5, 60, "খুব দ্রুত উইথড্র রিকোয়েস্ট পাঠানো হচ্ছে! অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।"))])
async def request_withdraw(data: WithdrawRequest, user: dict = Depends(get_current_user)):
    if data.amount < 50:
        raise HTTPException(status_code=400, detail="উইথড্র করার জন্য সর্বনিম্ন পরিমাণ ৫০ টাকা (Minimum withdrawal amount is 50 BDT)")
    if len(data.bkash_number.strip()) < 11:
        raise HTTPException(status_code=400, detail="সঠিক ১১ ডিজিটের বিকাশ নাম্বার আবশ্যক")
    
    conn = get_db()
    new_bal = 0
    try:
        with conn:
            # Atomic balance deduction: checks and deducts balance in a single atomic SQL statement
            cur = conn.execute(
                "UPDATE users SET digits_balance = digits_balance - ? WHERE id = ? AND digits_balance >= ?",
                (data.amount, user["id"], data.amount)
            )
            if cur.rowcount == 0:
                fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user["id"],)).fetchone()
                current_balance = fresh["digits_balance"] if fresh else 0
                raise HTTPException(status_code=400, detail=f"অপর্যাপ্ত ব্যালেন্স! আপনার ব্যালেন্স BDT {current_balance} ডিজিট।")
            
            conn.execute("""
            INSERT INTO withdrawals (user_id, amount, bkash_number, status)
            VALUES (?, ?, ?, 'pending')
            """, (user["id"], data.amount, data.bkash_number.strip()))
            
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'WITHDRAW_REQUEST', ?, ?)
            """, (user["id"], user["id"], data.amount, f"Withdrawal request to bKash {data.bkash_number.strip()}"))

            fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user["id"],)).fetchone()
            new_bal = fresh["digits_balance"] if fresh else 0
    finally:
        conn.close()

    await manager.broadcast({
        "type": "BALANCE_UPDATED",
        "user_id": user["id"],
        "digits_balance": new_bal
    })

    # Instantly notify admin dashboard plates and persist to MongoDB
    try:
        await manager.broadcast({"type": "ADMIN_DASHBOARD_UPDATE"})
    except Exception:
        pass
    try:
        sync_db_async()
    except Exception:
        pass

    return {
        "success": True,
        "message": f"BDT {data.amount} টাকা উইথড্র রিকোয়েস্ট সফলভাবে জমা হয়েছে! অ্যাডমিন শীঘ্রই পেমেন্ট করবেন।",
        "new_balance": new_bal
    }

@app.get("/api/wallet/withdraw/history")
def get_withdraw_history(user: dict = Depends(get_current_user)):
    conn = get_db()
    withdrawals = conn.execute("""
    SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 20
    """, (user["id"],)).fetchall()
    conn.close()
    return {"withdrawals": [dict(w) for w in withdrawals]}

@app.get("/api/leaderboard")
def get_leaderboard():
    conn = get_db()
    rows = conn.execute("""
    SELECT id, player_id, username, win_points,
           (SELECT COUNT(*) FROM participations p JOIN matches m ON p.match_id = m.id WHERE p.user_id = users.id AND m.status = 'completed') as matches_won,
           (SELECT COUNT(*) FROM participations WHERE user_id = users.id) as matches_joined
    FROM users
    WHERE role != 'admin' AND status = 'active'
    ORDER BY win_points DESC, matches_won DESC, id ASC
    LIMIT 20
    """).fetchall()
    conn.close()
    return {"leaderboard": [dict(r) for r in rows]}

@app.get("/api/matches/results")
def get_matches_results(category: Optional[str] = None, request: Request = None):
    user_id = None
    is_admin = False
    auth_header = request.headers.get("Authorization") if request else None
    if auth_header and auth_header.startswith("Bearer "):
        payload = verify_token(auth_header.split(" ")[1])
        if payload:
            user_id = payload.get("user_id")
            if payload.get("role") in ["admin", "moderator"]:
                is_admin = True
    
    conn = get_db()
    cat_filter = ""
    params = []
    if category and category.lower() not in ['all', 'সব ম্যাচ', '']:
        cat_filter = " AND LOWER(m.match_type) = LOWER(?) "
        params.append(category)
    
    if is_admin:
        sql = f"""
        SELECT m.id, m.title, m.match_type, m.map_name, m.match_time, m.entry_fee, m.prize_pool, m.per_kill, m.total_slots, m.status, m.completed_at
        FROM matches m
        WHERE m.status = 'completed' {cat_filter}
        ORDER BY m.completed_at DESC, m.id DESC
        LIMIT 50
        """
        rows = conn.execute(sql, params).fetchall()
        results = []
        for r in rows:
            m_dict = dict(r)
            winners = conn.execute("""
            SELECT mr.rank_position, mr.kills, mr.total_prize, u.username, u.ff_ign
            FROM match_results mr
            JOIN users u ON u.id = mr.user_id
            WHERE mr.match_id = ? AND (mr.rank_position > 0 OR mr.kills > 0)
            ORDER BY mr.rank_position ASC, mr.kills DESC
            LIMIT 5
            """, (m_dict["id"],)).fetchall()
            m_dict["winners"] = [dict(w) for w in winners]
            results.append(m_dict)
        conn.close()
        return {"results": results, "is_personal": False}
    
    if user_id:
        sql = f"""
        SELECT m.id, m.title, m.match_type, m.map_name, m.match_time, m.entry_fee, m.prize_pool, m.per_kill, m.total_slots, m.status, m.completed_at,
               COALESCE(mr.rank_position, 0) as my_rank,
               COALESCE(mr.kills, 0) as my_kills,
               COALESCE(mr.kill_prize, 0) as my_kill_prize,
               COALESCE(mr.rank_prize, 0) as my_rank_prize,
               COALESCE(mr.total_prize, 0) as my_total_prize
        FROM matches m
        JOIN participations p ON p.match_id = m.id AND p.user_id = ?
        LEFT JOIN match_results mr ON mr.match_id = m.id AND mr.user_id = ?
        WHERE m.status = 'completed' {cat_filter}
        ORDER BY m.completed_at DESC, m.id DESC
        LIMIT 50
        """
        rows = conn.execute(sql, [user_id, user_id] + params).fetchall()
        results = []
        for r in rows:
            m_dict = dict(r)
            winners = conn.execute("""
            SELECT mr.rank_position, mr.kills, mr.total_prize, u.username, u.ff_ign
            FROM match_results mr
            JOIN users u ON u.id = mr.user_id
            WHERE mr.match_id = ? AND (mr.rank_position > 0 OR mr.kills > 0)
            ORDER BY mr.rank_position ASC, mr.kills DESC
            LIMIT 5
            """, (m_dict["id"],)).fetchall()
            m_dict["winners"] = [dict(w) for w in winners]
            results.append(m_dict)
        conn.close()
        return {"results": results, "is_personal": True}
    
    conn.close()
    return {"results": [], "is_personal": True, "not_logged_in": True}

# -------------------------------------------------------------
# Web Push Notifications Subscription
# -------------------------------------------------------------
@app.post("/api/notifications/subscribe")
def subscribe_push(data: PushSubscribeRequest, request: Request):
    user_id = None
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        payload = verify_token(auth_header.split(" ")[1])
        if payload:
            user_id = payload.get("user_id")

    endpoint = data.endpoint
    p256dh = data.keys.get("p256dh", "")
    auth = data.keys.get("auth", "")

    conn = get_db()
    with conn:
        conn.execute("""
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth
        """, (user_id, endpoint, p256dh, auth))
    conn.close()

    return {"success": True, "message": "Subscribed to push notifications successfully!"}

# -------------------------------------------------------------
# MASTER ADMIN CONTROLS (Protected by strict verify_admin)
# -------------------------------------------------------------
@app.get("/api/admin/overview")
def admin_overview(admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    total_users = conn.execute("SELECT COUNT(*) FROM users WHERE role != 'admin'").fetchone()[0]
    total_matches = conn.execute("SELECT COUNT(*) FROM matches WHERE status != 'completed'").fetchone()[0]
    pending_deposits = conn.execute("""
        SELECT COUNT(*) 
        FROM deposits d
        JOIN users u ON d.user_id = u.id
        WHERE d.status = 'pending'
    """).fetchone()[0]
    pending_withdrawals = conn.execute("""
        SELECT COUNT(*) 
        FROM withdrawals w
        JOIN users u ON w.user_id = u.id
        WHERE w.status = 'pending'
    """).fetchone()[0]
    total_digits_circulating = conn.execute("SELECT COALESCE(SUM(digits_balance), 0) FROM users WHERE role != 'admin'").fetchone()[0] or 0
    total_moderators = conn.execute("SELECT COUNT(*) FROM users WHERE role = 'moderator'").fetchone()[0]
    
    recent_deposits = conn.execute("""
    SELECT d.*, u.username, u.player_id, u.phone as user_phone
    FROM deposits d
    JOIN users u ON d.user_id = u.id
    WHERE d.status = 'pending'
    ORDER BY d.id DESC LIMIT 30
    """).fetchall()

    recent_withdrawals = conn.execute("""
    SELECT w.*, u.username, u.player_id, u.phone as user_phone
    FROM withdrawals w
    JOIN users u ON w.user_id = u.id
    WHERE w.status = 'pending'
    ORDER BY w.id DESC LIMIT 50
    """).fetchall()

    conn.close()
    return {
        "total_users": total_users,
        "total_matches": total_matches,
        "pending_deposits": pending_deposits,
        "pending_withdrawals": pending_withdrawals,
        "total_digits_circulating": total_digits_circulating,
        "total_moderators": total_moderators,
        "pending_deposits_list": [dict(r) for r in recent_deposits],
        "pending_withdrawals_list": [dict(r) for r in recent_withdrawals]
    }

@app.get("/api/admin/users")
def admin_list_users(search: Optional[str] = None, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    if search:
        s_clean = search.strip()
        s_like = f"%{s_clean}%"
        try:
            num_id = int(s_clean)
        except ValueError:
            num_id = -1

        users = conn.execute("""
        SELECT id, player_id, username, phone, email, ff_ign, ff_uid, digits_balance, win_points, role, status, created_at, plain_password, timeout_until
        FROM users
        WHERE id = ? 
           OR CAST(id AS TEXT) LIKE ? 
           OR player_id LIKE ? 
           OR username LIKE ? 
           OR phone LIKE ? 
           OR ff_uid LIKE ? 
           OR ff_ign LIKE ? 
           OR email LIKE ?
        ORDER BY id DESC LIMIT 50
        """, (num_id, s_like, s_like, s_like, s_like, s_like, s_like, s_like)).fetchall()
    else:
        users = conn.execute("""
        SELECT id, player_id, username, phone, email, ff_ign, ff_uid, digits_balance, win_points, role, status, created_at, plain_password, timeout_until
        FROM users
        ORDER BY id DESC LIMIT 50
        """).fetchall()
    conn.close()

    result = []
    is_master_admin = (admin.get("role") == "admin")
    for u in users:
        d = dict(u)
        is_timed_out, rem_mins = check_user_timeout(d)
        d["is_timed_out"] = is_timed_out
        d["timeout_remaining_mins"] = rem_mins
        # Security hardening: Never expose admin/moderator passwords under any circumstances
        if d.get("role") in ["admin", "moderator"]:
            d["plain_password"] = "••••••••"
        elif not is_master_admin:
            # Moderators cannot view other users' passwords
            d["plain_password"] = "••••••••"
        result.append(d)
    return result

@app.get("/api/admin/audit-logs")
def admin_get_audit_logs(
    user_id: Optional[int] = None,
    action: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 100,
    admin: dict = Depends(verify_moderator_or_admin)
):
    conn = get_db()
    query = """
    SELECT 
        l.id,
        l.admin_id,
        l.target_user_id,
        l.action,
        l.amount,
        l.reason,
        l.created_at,
        u.username as target_username,
        u.player_id as target_player_id,
        adm.username as admin_username
    FROM audit_logs l
    LEFT JOIN users u ON l.target_user_id = u.id
    LEFT JOIN users adm ON l.admin_id = adm.id
    WHERE 1=1
    """
    params = []
    if user_id is not None:
        query += " AND l.target_user_id = ?"
        params.append(user_id)
    if action and action.strip():
        query += " AND l.action = ?"
        params.append(action.strip())
    if search and search.strip():
        s_clean = search.strip()
        query += " AND (l.reason LIKE ? OR u.username LIKE ? OR u.player_id LIKE ? OR l.action LIKE ?)"
        s_like = f"%{s_clean}%"
        params.extend([s_like, s_like, s_like, s_like])
        
    query += " ORDER BY l.id DESC LIMIT ?"
    params.append(min(max(1, limit), 300))
    
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return {"logs": [dict(r) for r in rows]}

@app.post("/api/admin/users/adjust-digits")
@app.post("/api/admin/users/{target_user_id}/adjust-digits")
async def admin_adjust_digits(data: AdminAdjustDigits, target_user_id: Optional[int] = None, admin: dict = Depends(verify_admin)):
    uid = target_user_id or data.target_user_id
    if not uid:
        raise HTTPException(status_code=400, detail="User ID required")
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (uid,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Target player not found")

        new_bal = user["digits_balance"] + data.amount
        if new_bal < 0:
            new_bal = 0

        with conn:
            conn.execute("UPDATE users SET digits_balance = ? WHERE id = ?", (new_bal, uid))
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'ADMIN_ADJUST_DIGITS', ?, ?)
            """, (admin["id"], uid, data.amount, data.reason or "Admin Manual Adjustment"))
    finally:
        conn.close()

    await manager.send_to_user(uid, {
        "type": "BALANCE_UPDATED",
        "digits_balance": new_bal,
        "notice": f"অ্যাডমিন আপনার ওয়ালেটে {data.amount:+d} ডিজিট আপডেট করেছেন। কারণ: {data.reason}"
    })

    try:
        sync_db_async()
    except Exception:
        pass

    return {
        "success": True,
        "message": f"Updated balance for @{user['username']}. New balance: {new_bal} digits",
        "new_balance": new_bal
    }



@app.post("/api/admin/users/adjust-win-points")
async def admin_adjust_win_points(data: AdminAdjustWinPoints, admin: dict = Depends(verify_admin)):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (data.target_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="Target player not found")

        curr_pts = user["win_points"] if "win_points" in user.keys() and user["win_points"] is not None else 0
        new_pts = curr_pts + data.amount
        if new_pts < 0:
            new_pts = 0

        with conn:
            conn.execute("UPDATE users SET win_points = ? WHERE id = ?", (new_pts, data.target_user_id))
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'ADMIN_ADJUST_WIN_POINTS', ?, ?)
            """, (admin["id"], data.target_user_id, data.amount, data.reason or "Admin Win Points Adjustment"))
    finally:
        conn.close()

    await manager.send_to_user(data.target_user_id, {
        "type": "WIN_POINTS_UPDATED",
        "win_points": new_pts,
        "notice": f"আপনার উইন পয়েন্ট {data.amount:+d} PTS আপডেট করা হয়েছে!"
    })

    try:
        sync_db_async()
    except Exception:
        pass

    return {
        "success": True,
        "message": f"Updated win points for @{user['username']}. New points: {new_pts} PTS",
        "new_win_points": new_pts
    }

@app.post("/api/admin/users/{target_user_id}/toggle-status")
async def admin_toggle_status(target_user_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        if user["role"] == "admin":
            raise HTTPException(status_code=403, detail="Cannot ban Master Admin")

        new_status = "banned" if user["status"] == "active" else "active"
        with conn:
            conn.execute("UPDATE users SET status = ? WHERE id = ?", (new_status, target_user_id))
            
            user_keys = user.keys()
            user_phone = user["phone"] if "phone" in user_keys else ""
            user_email = user["email"] if "email" in user_keys else ""
            user_ff_uid = user["ff_uid"] if "ff_uid" in user_keys else ""

            if new_status == "banned":
                # Add to permanent blacklist so these credentials can NEVER re-register
                conn.execute("""
                INSERT INTO banned_records (username, phone, email, ff_uid, password_hash, reason)
                VALUES (?, ?, ?, ?, ?, 'Banned by Super Admin')
                """, (user["username"], user_phone, user_email, user_ff_uid, user["password_hash"]))
            else:
                conn.execute("DELETE FROM banned_records WHERE username = ? COLLATE NOCASE", (user["username"],))

            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'TOGGLE_STATUS', 0, ?)
            """, (admin["id"], target_user_id, f"Changed status to {new_status}"))
    finally:
        conn.close()

    # If banned, trigger real-time Red Alert Broadcast to ALL users & devices
    if new_status == "banned":
        banned_msg = f"Player '{user['username']}' Have Banned"

        # 1. Real-time WebSocket Red Alert Broadcast
        await manager.broadcast({
            "type": "USER_BANNED_ALERT",
            "username": user["username"],
            "message": banned_msg
        })

        # 2. Kick the banned user immediately
        await manager.send_to_user(target_user_id, {
            "type": "ACCOUNT_BANNED_KICK",
            "message": "আপনার অ্যাকাউন্টটি GOMON HUB প্ল্যাটফর্ম থেকে ব্যান করা হয়েছে।"
        })

        # 3. Native Mobile Push Notification
        conn = get_db()
        subs = conn.execute("SELECT * FROM push_subscriptions").fetchall()
        conn.close()

        push_payload = json.dumps({
            "title": "🚨 PLAYER BANNED ALERT",
            "body": f"Player '{user['username']}' Have Banned",
            "icon": "/static/img/icon.png",
            "url": "/"
        })

        send_push_in_background(subs, push_payload, remove_dead=False)

    return {"success": True, "new_status": new_status, "username": user["username"]}

@app.post("/api/admin/users/{target_user_id}/impersonate")
def admin_impersonate_user(target_user_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    impersonation_token = generate_token(user["id"], user["username"], user["role"], user["password_hash"] or "")
    return {
        "success": True,
        "impersonation_token": impersonation_token,
        "user": {
            "id": user["id"],
            "player_id": user["player_id"],
            "username": user["username"],
            "digits_balance": user["digits_balance"],
            "role": user["role"],
            "ff_ign": user["ff_ign"],
            "ff_uid": user["ff_uid"]
        }
    }

@app.post("/api/admin/users/{target_user_id}/reset-password")
async def admin_reset_password(target_user_id: int, data: AdminResetPassword, admin: dict = Depends(verify_admin)):
    new_pass = data.new_password.strip()
    if len(new_pass) < 4:
        raise HTTPException(status_code=400, detail="পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে")

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="ব্যবহারকারী পাওয়া যায়নি")

        if user["role"] == "admin" and user["id"] != admin["id"]:
            raise HTTPException(status_code=403, detail="Cannot reset Master Admin password from player panel")

        new_hash = hash_password(new_pass)
        with conn:
            conn.execute("UPDATE users SET password_hash = ?, plain_password = ? WHERE id = ?", (new_hash, new_pass, target_user_id))
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'ADMIN_RESET_PASSWORD', 0, ?)
            """, (admin["id"], target_user_id, f"Password reset for @{user['username']}"))
    finally:
        conn.close()

    try:
        sync_db_async()
    except Exception:
        pass

    try:
        # Revoke existing session of user immediately for security, WITHOUT leaking new_pass
        await manager.send_to_user(target_user_id, {
            "type": "ACCOUNT_SECURITY_LOGOUT",
            "message": "নিরাপত্তার স্বার্থে অ্যাডমিন আপনার পাসওয়ার্ড আপডেট করেছেন। অনুগ্রহ করে অ্যাডমিনের কাছ থেকে নতুন পাসওয়ার্ড সংগ্রহ করে লগইন করুন।"
        })
    except Exception:
        pass

    return {
        "success": True,
        "message": f"@{user['username']} এর পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে!",
        "username": user["username"],
        "new_password": new_pass
    }

@app.post("/api/admin/users/{target_user_id}/set-role")
async def admin_set_user_role(target_user_id: int, data: SetRoleRequest, admin: dict = Depends(verify_admin)):
    target_role = data.role.strip().lower()
    if target_role not in ["player", "moderator"]:
        raise HTTPException(status_code=400, detail="Invalid role. Must be 'player' or 'moderator'")

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="ব্যবহারকারী পাওয়া যায়নি")
        if user["role"] == "admin":
            raise HTTPException(status_code=403, detail="Master admin role is strictly protected and immutable")

        with conn:
            conn.execute("UPDATE users SET role = ? WHERE id = ?", (target_role, target_user_id))
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'ROLE_CHANGED', 0, ?)
            """, (admin["id"], target_user_id, f"Changed role of @{user['username']} to {target_role}"))
    finally:
        conn.close()

    try:
        await manager.send_to_user(target_user_id, {
            "type": "ROLE_UPDATED",
            "new_role": target_role,
            "message": f"আপনার অ্যাকাউন্ট রোল '{target_role}' হিসেবে আপডেট করা হয়েছে!"
        })
    except Exception:
        pass

    return {
        "success": True,
        "message": f"@{user['username']} এর রোল সফলভাবে '{target_role}' করা হয়েছে!",
        "user_id": target_user_id,
        "new_role": target_role
    }

@app.post("/api/admin/users/create")
async def admin_create_user(data: AdminCreateUserRequest, admin: dict = Depends(verify_admin)):
    username = data.username.strip()
    phone_raw = data.phone.strip() if data.phone else ""
    password = data.password.strip()
    email = data.email.strip().lower() if data.email else f"{username.lower()}@gomonhub.local"
    ff_ign = data.ff_ign.strip() if data.ff_ign else username
    ff_uid = data.ff_uid.strip() if data.ff_uid else "0"
    role = data.role.strip().lower() if data.role else "player"
    if role not in ["player", "moderator"]:
        role = "player"
    initial_balance = max(0, data.digits_balance or 0)

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="ইউজারনেম কমপক্ষে ৩ অক্ষরের হতে হবে")
    if len(password) < 4:
        raise HTTPException(status_code=400, detail="পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে")

    is_valid_phone, phone_err, phone = validate_phone_number(phone_raw)
    if not is_valid_phone:
        raise HTTPException(status_code=400, detail=phone_err)

    conn = get_db()
    try:
        existing = conn.execute("""
            SELECT id, username, phone FROM users 
            WHERE username = ? COLLATE NOCASE OR phone = ?
        """, (username, phone)).fetchone()
        if existing:
            if existing["username"].lower() == username.lower():
                raise HTTPException(status_code=400, detail="এই ইউজারনেম দিয়ে ইতিমধ্যে অ্যাকাউন্ট রয়েছে")
            if existing["phone"] == phone:
                raise HTTPException(status_code=400, detail="এই ফোন নম্বর দিয়ে ইতিমধ্যে অ্যাকাউন্ট রয়েছে")

        rand_id = f"GOMONHUB-{secrets.randbelow(90000) + 10000}"
        pass_hash = hash_password(password)

        with conn:
            cursor = conn.execute("""
                INSERT INTO users (player_id, username, password_hash, plain_password, phone, email, ff_ign, ff_uid, digits_balance, role, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
            """, (rand_id, username, pass_hash, password, phone, email, ff_ign, ff_uid, initial_balance, role))
            new_user_id = cursor.lastrowid

            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_CREATE_USER', ?, ?)
            """, (admin["id"], new_user_id, initial_balance, f"Admin manually created user @{username} (Role: {role})"))
    finally:
        conn.close()

    return {
        "success": True,
        "message": f"প্লেয়ার @{username} সফলভাবে তৈরি করা হয়েছে!",
        "user": {
            "id": new_user_id,
            "player_id": rand_id,
            "username": username,
            "phone": phone,
            "plain_password": password,
            "digits_balance": initial_balance,
            "role": role,
            "status": "active"
        }
    }

@app.delete("/api/admin/users/{target_user_id}")
@app.post("/api/admin/users/{target_user_id}/delete")
async def admin_delete_user(target_user_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="ব্যবহারকারী পাওয়া যায়নি")
        if user["role"] == "admin":
            raise HTTPException(status_code=403, detail="Master Admin অ্যাকাউন্ট ডিলিট করা সম্পূর্ণ নিষিদ্ধ!")

        with conn:
            conn.execute("DELETE FROM participations WHERE user_id = ?", (target_user_id,))
            conn.execute("DELETE FROM deposits WHERE user_id = ?", (target_user_id,))
            conn.execute("DELETE FROM withdrawals WHERE user_id = ?", (target_user_id,))
            conn.execute("DELETE FROM push_subscriptions WHERE user_id = ?", (target_user_id,))
            conn.execute("DELETE FROM audit_logs WHERE target_user_id = ?", (target_user_id,))
            conn.execute("DELETE FROM users WHERE id = ?", (target_user_id,))
            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_DELETE_USER', 0, ?)
            """, (admin["id"], target_user_id, f"Permanently deleted user @{user['username']}"))
    finally:
        conn.close()

    # ASYNCHRONOUS BACKGROUND PURGE FROM MONGODB ATLAS (NO BLOCKING / ZERO LAG)
    def _bg_atlas_user_purge(uid):
        try:
            delete_from_mongo_direct("users", uid)
            delete_from_mongo_direct("participations", uid, id_field="user_id")
            delete_from_mongo_direct("deposits", uid, id_field="user_id")
            delete_from_mongo_direct("withdrawals", uid, id_field="user_id")
            delete_from_mongo_direct("push_subscriptions", uid, id_field="user_id")
            push_sqlite_to_mongo()
            sync_snapshot_now()
        except Exception as e:
            print(f"[User Delete Atlas Sync Error] {e}")

    threading.Thread(target=_bg_atlas_user_purge, args=(target_user_id,), daemon=True).start()

    try:
        await manager.send_to_user(target_user_id, {
            "type": "ACCOUNT_DELETED_KICK",
            "message": "আপনার অ্যাকাউন্টটি অ্যাডমিন দ্বারা সম্পূর্ণ ডিলিট করা হয়েছে।"
        })
    except Exception:
        pass

    return {
        "success": True,
        "message": f"@{user['username']} অ্যাকাউন্টটি স্থায়ীভাবে ডিলিট করা হয়েছে!",
        "deleted_user_id": target_user_id,
        "deleted_username": user["username"]
    }

@app.post("/api/admin/users/{target_user_id}/timeout")
async def admin_timeout_user(target_user_id: int, data: AdminTimeoutRequest, admin: dict = Depends(verify_admin)):
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="ব্যবহারকারী পাওয়া যায়নি")
        if user["role"] == "admin":
            raise HTTPException(status_code=403, detail="Master Admin কে টাইম-আউট করা সম্ভব নয়!")

        duration = data.duration_minutes
        if duration > 0:
            timeout_until = (datetime.utcnow() + timedelta(minutes=duration)).strftime("%Y-%m-%d %H:%M:%S")
            new_status = "timeout"
            log_reason = f"Timeout for {duration} mins: {data.reason}"
        else:
            timeout_until = None
            new_status = "active"
            log_reason = f"Timeout removed by admin"

        with conn:
            conn.execute("UPDATE users SET status = ?, timeout_until = ? WHERE id = ?", (new_status, timeout_until, target_user_id))
            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_TIMEOUT', ?, ?)
            """, (admin["id"], target_user_id, duration, log_reason))
    finally:
        conn.close()

    if duration > 0:
        try:
            await manager.send_to_user(target_user_id, {
                "type": "ACCOUNT_TIMEOUT_KICK",
                "message": f"আপনার অ্যাকাউন্টটি {duration} মিনিটের জন্য টাইম-আউট করা হয়েছে।"
            })
        except Exception:
            pass

    return {
        "success": True,
        "message": f"@{user['username']} এর জন্য {f'{duration} মিনিটের টাইম-আউট কার্যকর করা হয়েছে' if duration > 0 else 'টাইম-আউট তুলে নেওয়া হয়েছে'}",
        "status": new_status,
        "timeout_until": timeout_until,
        "duration_minutes": duration
    }

@app.get("/api/admin/moderators")
def admin_list_moderators(admin: dict = Depends(verify_admin)):
    conn = get_db()
    mods = conn.execute("""
    SELECT id, player_id, username, phone, email, role, status, created_at
    FROM users
    WHERE role = 'moderator'
    ORDER BY id DESC
    """).fetchall()

    mod_list = []
    for m in mods:
        m_id = m["id"]
        rooms_count = conn.execute("SELECT COUNT(*) FROM matches WHERE room_updated_by_id = ?", (m_id,)).fetchone()[0]
        completed_count = conn.execute("SELECT COUNT(*) FROM matches WHERE completed_by_id = ?", (m_id,)).fetchone()[0]

        recent_logs = conn.execute("""
        SELECT action, reason, created_at FROM audit_logs 
        WHERE admin_id = ? AND action IN ('ROOM_ID_RELEASED', 'MATCH_COMPLETED')
        ORDER BY id DESC LIMIT 5
        """, (m_id,)).fetchall()

        mod_list.append({
            "id": m["id"],
            "player_id": m["player_id"],
            "username": m["username"],
            "phone": m["phone"],
            "email": m["email"],
            "role": m["role"],
            "status": m["status"],
            "rooms_released_count": rooms_count,
            "completed_matches_count": completed_count,
            "recent_actions": [dict(l) for l in recent_logs]
        })

    conn.close()
    return mod_list

@app.post("/api/admin/deposits/{deposit_id}/review")
async def admin_review_deposit(deposit_id: int, action: str, admin: dict = Depends(verify_admin)):
    if action not in ["approve", "reject"]:
        raise HTTPException(status_code=400, detail="Action must be approve or reject")

    conn = get_db()
    try:
        with conn:
            deposit = conn.execute("SELECT * FROM deposits WHERE id = ?", (deposit_id,)).fetchone()
            if not deposit:
                raise HTTPException(status_code=404, detail="Deposit record not found")
            if deposit["status"] != "pending":
                raise HTTPException(status_code=400, detail="Deposit is already processed")

            new_status = "approved" if action == "approve" else "rejected"
            cur = conn.execute("""
            UPDATE deposits 
            SET status = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by_name = ? 
            WHERE id = ? AND status = 'pending'
            """, (new_status, admin["username"], deposit_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=400, detail="Deposit is already processed or not pending")

            new_balance = None
            if action == "approve":
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (deposit["amount"], deposit["user_id"]))
                u = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (deposit["user_id"],)).fetchone()
                new_balance = u["digits_balance"] if u else 0

                # Mark corresponding incoming payment as claimed if it exists
                conn.execute("""
                UPDATE incoming_payments 
                SET status = 'claimed', claimed_by_user_id = ?, claimed_at = CURRENT_TIMESTAMP 
                WHERE UPPER(trx_id) = ? AND status = 'unclaimed'
                """, (deposit["user_id"], deposit["trx_id"].upper()))

                conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'DEPOSIT_APPROVED', ?, ?)
                """, (admin["id"], deposit["user_id"], deposit["amount"], f"Approved bKash TrxID: {deposit['trx_id']} (Admin: {admin['username']})"))
            else:
                # Release TrxID from used_trx_ids so user can re-submit if there was a typo or issue
                clean_trx = (deposit["trx_id"] or "").strip().upper()
                if clean_trx:
                    conn.execute("DELETE FROM used_trx_ids WHERE UPPER(trx_id) = ?", (clean_trx,))

                conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'DEPOSIT_REJECTED', 0, ?)
                """, (admin["id"], deposit["user_id"], f"Rejected bKash TrxID: {deposit['trx_id']} (Admin: {admin['username']})"))
    finally:
        conn.close()

    if action == "reject":
        clean_trx = (deposit["trx_id"] or "").strip().upper()
        if clean_trx:
            try:
                delete_from_mongo_direct("used_trx_ids", clean_trx, id_field="_id")
            except Exception:
                pass

    if action == "approve" and new_balance is not None:
        await manager.send_to_user(deposit["user_id"], {
            "type": "BALANCE_UPDATED",
            "digits_balance": new_balance,
            "notice": f"আপনার bKash ডিপোজিট অনুমোদিত হয়েছে! ওয়ালেটে +{deposit['amount']} ডিজিট যোগ হয়েছে।"
        })
    elif action == "reject":
        await manager.send_to_user(deposit["user_id"], {
            "type": "DEPOSIT_REJECTED",
            "deposit_id": deposit_id,
            "amount": deposit["amount"],
            "trx_id": deposit["trx_id"],
            "notice": f"আপনার {deposit['amount']} টাকার ডিপোজিট (TrxID: {deposit['trx_id']}) অ্যাডমিন কর্তৃক বাতিল (Rejected) করা হয়েছে। তথ্য যাচাই করে প্রয়োজনে পুনরায় সাবমিট করুন বা সাপোর্টে যোগাযোগ করুন।"
        })

    # Instantly notify admin dashboard plates and persist to MongoDB
    try:
        await manager.broadcast({"type": "ADMIN_DASHBOARD_UPDATE"})
    except Exception:
        pass
    try:
        sync_db_async()
    except Exception:
        pass

    return {"success": True, "status": new_status, "deposit_id": deposit_id}


@app.get("/api/admin/withdrawals")
def admin_get_withdrawals(status: Optional[str] = "pending", admin: dict = Depends(verify_admin)):
    conn = get_db()
    if status == "all":
        rows = conn.execute("""
        SELECT w.*, u.username, u.player_id, u.phone as user_phone
        FROM withdrawals w
        JOIN users u ON w.user_id = u.id
        ORDER BY w.id DESC LIMIT 100
        """).fetchall()
    else:
        rows = conn.execute("""
        SELECT w.*, u.username, u.player_id, u.phone as user_phone
        FROM withdrawals w
        JOIN users u ON w.user_id = u.id
        WHERE w.status = ?
        ORDER BY w.id DESC LIMIT 100
        """, (status,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.post("/api/admin/withdrawals/{withdrawal_id}/review")
async def admin_review_withdrawal(withdrawal_id: int, action: str, admin: dict = Depends(verify_admin)):
    if action not in ["approve", "reject"]:
        raise HTTPException(status_code=400, detail="Action must be approve or reject")

    conn = get_db()
    try:
        with conn:
            withdrawal = conn.execute("SELECT * FROM withdrawals WHERE id = ?", (withdrawal_id,)).fetchone()
            if not withdrawal:
                raise HTTPException(status_code=404, detail="Withdrawal record not found")
            if withdrawal["status"] != "pending":
                raise HTTPException(status_code=400, detail="Withdrawal is already processed")

            new_status = "approved" if action == "approve" else "rejected"
            cur = conn.execute("""
            UPDATE withdrawals SET status = ?, reviewed_at = CURRENT_TIMESTAMP 
            WHERE id = ? AND status = 'pending'
            """, (new_status, withdrawal_id))
            if cur.rowcount == 0:
                raise HTTPException(status_code=400, detail="Withdrawal is already processed or not pending")

            new_balance = None
            if action == "approve":
                conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'WITHDRAW_APPROVED', ?, ?)
                """, (admin["id"], withdrawal["user_id"], withdrawal["amount"], f"Approved withdrawal of {withdrawal['amount']} BDT to bKash {withdrawal['bkash_number']}"))
            else:
                # Refund the digits back to user's balance atomically
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (withdrawal["amount"], withdrawal["user_id"]))
                u = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (withdrawal["user_id"],)).fetchone()
                new_balance = u["digits_balance"] if u else 0
                conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'WITHDRAW_REJECTED_REFUND', ?, ?)
                """, (admin["id"], withdrawal["user_id"], withdrawal["amount"], f"Rejected withdrawal, refunded {withdrawal['amount']} BDT to user"))
    finally:
        conn.close()

    if action == "approve":
        await manager.send_to_user(withdrawal["user_id"], {
            "type": "WITHDRAWAL_APPROVED",
            "notice": f"আপনার {withdrawal['amount']} টাকার উইথড্র রিকোয়েস্ট অনুমোদিত হয়েছে এবং bKash এ পাঠানো হয়েছে!"
        })
    elif action == "reject" and new_balance is not None:
        await manager.send_to_user(withdrawal["user_id"], {
            "type": "BALANCE_UPDATED",
            "digits_balance": new_balance,
            "notice": f"আপনার {withdrawal['amount']} টাকার উইথড্র রিকোয়েস্ট বাতিল করা হয়েছে এবং {withdrawal['amount']} টাকা ফেরত দেওয়া হয়েছে।"
        })

    # Instantly notify admin dashboard plates and persist to MongoDB
    try:
        await manager.broadcast({"type": "ADMIN_DASHBOARD_UPDATE"})
    except Exception:
        pass
    try:
        sync_db_async()
    except Exception:
        pass

    return {"success": True, "status": new_status, "withdrawal_id": withdrawal_id}


@app.get("/api/admin/matches")
def admin_get_all_matches(admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    rows = conn.execute("""
    SELECT m.*,
           (SELECT COUNT(*) FROM participations p WHERE p.match_id = m.id) as joined_count
    FROM matches m
    ORDER BY m.id DESC
    """).fetchall()
    conn.close()
    return {"matches": [dict(r) for r in rows]}

@app.post("/api/admin/matches")
async def admin_create_match(data: AdminMatchCreate, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        match_code = get_next_match_code(conn, data.match_type)
        cursor = conn.execute("""
        INSERT INTO matches (title, match_type, match_code, map_name, match_time, entry_fee, prize_pool, per_kill, total_slots, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
        """, (data.title.strip(), data.match_type, match_code, data.map_name, data.match_time,
              data.entry_fee, data.prize_pool, data.per_kill, data.total_slots))
        match_id = cursor.lastrowid

        if data.winner_prize is not None:
            breakdown = {
                "winner": max(0, data.winner_prize),
                "second": max(0, data.second_prize or 0),
                "third": max(0, data.third_prize or 0)
            }
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (f"prize_breakdown_{match_id}", json.dumps(breakdown))
            )

        conn.execute("""
        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
        VALUES (?, NULL, 'MATCH_CREATED', 0, ?)
        """, (admin["id"], f"Created Match #{match_code} ({data.title.strip()})"))
    conn.close()
    sync_db_async()

    await manager.broadcast({
        "type": "NEW_MATCH_CREATED",
        "match_id": match_id,
        "match_code": match_code,
        "title": data.title
    })

    return {
        "success": True, 
        "match_id": match_id, 
        "match_code": match_code, 
        "message": f"ম্যাচ #{match_code} সফলভাবে তৈরি হয়েছে!"
    }

@app.put("/api/admin/matches/{match_id}")
async def admin_update_match(match_id: int, data: AdminMatchUpdate, current_user: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")

    is_mod = current_user["role"] == "moderator"
    dict_data = data.dict(exclude_unset=True)
    dict_data.pop("match_code", None)  # Immutable: match_code never changes after creation

    # Extract prize breakdown if provided
    winner_prize = dict_data.pop("winner_prize", None)
    second_prize = dict_data.pop("second_prize", None)
    third_prize = dict_data.pop("third_prize", None)
    if winner_prize is not None and not is_mod:
        breakdown = {
            "winner": max(0, winner_prize),
            "second": max(0, second_prize or 0),
            "third": max(0, third_prize or 0)
        }
        with conn:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (f"prize_breakdown_{match_id}", json.dumps(breakdown))
            )

    # Moderators can strictly ONLY update room_id, room_pass, and status
    if is_mod:
        allowed = {"room_id", "room_pass", "status"}
        dict_data = {k: v for k, v in dict_data.items() if k in allowed}

    fields = []
    values = []
    for k, v in dict_data.items():
        if v is not None:
            fields.append(f"{k} = ?")
            values.append(v)

    audit_action = None
    audit_reason = None

    if "room_id" in dict_data or "room_pass" in dict_data:
        fields.append("room_updated_by_id = ?")
        values.append(current_user["id"])
        fields.append("room_updated_by_name = ?")
        values.append(current_user["username"])
        fields.append("room_updated_at = CURRENT_TIMESTAMP")
        audit_action = "ROOM_ID_RELEASED"
        audit_reason = f"Room ID & Pass updated for Match #{match_id} by @{current_user['username']}"

    if dict_data.get("status") == "completed" and match["status"] != "completed":
        fields.append("completed_by_id = ?")
        values.append(current_user["id"])
        fields.append("completed_by_name = ?")
        values.append(current_user["username"])
        fields.append("completed_at = CURRENT_TIMESTAMP")
        audit_action = "MATCH_COMPLETED"
        audit_reason = f"Match #{match_id} completed successfully by @{current_user['username']}"

    if not fields:
        conn.close()
        return {"success": True, "message": "No changes requested"}

    values.append(match_id)
    with conn:
        conn.execute(f"UPDATE matches SET {', '.join(fields)} WHERE id = ?", values)
        if audit_action:
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, ?, 0, ?)
            """, (current_user["id"], match_id, audit_action, audit_reason))
    conn.close()
    sync_db_async()

    if "room_id" in dict_data or "room_pass" in dict_data:
        await manager.broadcast({
            "type": "ROOM_CREDENTIALS_RELEASED",
            "match_id": match_id,
            "message": f"Match #{match_id} Room ID & Password are now available!"
        })

    return {"success": True, "message": "Match updated successfully"}


@app.put("/api/admin/matches/{match_id}/prize-breakdown")
def admin_update_prize_breakdown(match_id: int, data: PrizeBreakdownRequest, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    match = conn.execute("SELECT id FROM matches WHERE id = ?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")

    breakdown = {
        "winner": max(0, data.winner),
        "second": max(0, data.second or 0),
        "third": max(0, data.third or 0)
    }
    with conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (f"prize_breakdown_{match_id}", json.dumps(breakdown))
        )
        if data.prize_pool is not None and data.prize_pool > 0:
            conn.execute("UPDATE matches SET prize_pool = ? WHERE id = ?", (data.prize_pool, match_id))
        if data.per_kill is not None and data.per_kill >= 0:
            conn.execute("UPDATE matches SET per_kill = ? WHERE id = ?", (data.per_kill, match_id))
    conn.close()
    sync_db_async()
    return {"success": True, "message": "Prize breakdown updated successfully", "breakdown": breakdown}


@app.get("/api/admin/matches/{match_id}/participants")
def admin_get_match_participants(match_id: int, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")
    
    rows = conn.execute("""
    SELECT u.id as user_id, u.username, u.phone,
           COALESCE(NULLIF(p.player_ign, ''), u.ff_ign, u.username) as ff_ign,
           COALESCE(NULLIF(p.player_uid, ''), u.ff_uid) as ff_uid,
           p.slot_number,
           COALESCE(p.is_leader, 1) as is_leader,
           COALESCE(p.team_name, '') as team_name,
           COALESCE(mr.rank_position, 0) as rank_position,
           COALESCE(mr.kills, 0) as kills,
           COALESCE(mr.rank_prize, 0) as rank_prize,
           COALESCE(mr.kill_prize, 0) as kill_prize,
           COALESCE(mr.total_prize, 0) as total_prize
    FROM participations p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN match_results mr ON mr.match_id = p.match_id AND mr.user_id = u.id
    WHERE p.match_id = ?
    ORDER BY p.slot_number ASC
    """, (match_id,)).fetchall()
    
    conn.close()
    return {
        "match": dict(match),
        "participants": [dict(r) for r in rows]
    }

@app.delete("/api/admin/matches/{match_id}/participants/{slot_number}")
async def admin_kick_match_participant(match_id: int, slot_number: int, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    try:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")

        if match["status"] == "completed":
            raise HTTPException(status_code=400, detail="সমাপ্ত হওয়া ম্যাচ থেকে প্লেয়ার কিক করা যাবে না")

        part = conn.execute("SELECT * FROM participations WHERE match_id = ? AND slot_number = ?", (match_id, slot_number)).fetchone()
        if not part:
            raise HTTPException(status_code=404, detail=f"স্লট #{slot_number}-এ কোনো প্লেয়ার পাওয়া যায়নি")

        kicked_user_id = part["user_id"]
        player_ign = part["player_ign"] or "Player"
        entry_fee = match["entry_fee"] or 0

        with conn:
            # 1. 100% Refund entry fee to user's wallet
            if entry_fee > 0 and kicked_user_id:
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (entry_fee, kicked_user_id))

            # 2. Delete the participation (the freed slot can now be claimed by new players without altering existing players' slots)
            conn.execute("DELETE FROM participations WHERE match_id = ? AND slot_number = ?", (match_id, slot_number))

            # 4. If match was full or reg_closed, reopen it for other players
            if match["status"] in ["full", "reg_closed"]:
                conn.execute("UPDATE matches SET status = 'upcoming' WHERE id = ?", (match_id,))

            # 5. Log in audit_logs
            m_code = match["match_code"] if ("match_code" in match.keys() and match["match_code"]) else f"MATCH-{match_id}"
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'ADMIN_KICK_PLAYER', ?, ?)
            """, (admin["id"], kicked_user_id, entry_fee, f"Kicked from Match #{m_code} (Slot #{slot_number}), Refunded {entry_fee}🪙"))

            new_user = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (kicked_user_id,)).fetchone()
            new_bal = new_user["digits_balance"] if new_user else 0

            # Count remaining
            joined_count = conn.execute("SELECT COUNT(*) FROM participations WHERE match_id = ?", (match_id,)).fetchone()[0]

    finally:
        conn.close()

    if part and "id" in part.keys():
        try:
            delete_from_mongo_direct("participations", part["id"])
        except Exception:
            pass

    try:
        sync_db_async()
    except Exception:
        pass

    try:
        await manager.broadcast({
            "type": "MATCH_SLOT_UPDATE",
            "match_id": match_id,
            "new_joined_count": joined_count
        })
        if kicked_user_id:
            await manager.send_to_user(kicked_user_id, {
                "type": "BALANCE_UPDATED",
                "digits_balance": new_bal,
                "message": f"আপনাকে ম্যাচ #{m_code} থেকে রিমুভ করা হয়েছে এবং {entry_fee}🪙 এন্ট্রি ফি আপনার ওয়ালেটে রিফান্ড করা হয়েছে।"
            })
    except Exception:
        pass

    return {
        "success": True,
        "refunded_amount": entry_fee,
        "new_joined_count": joined_count,
        "message": f"স্লট #{slot_number} ({player_ign}) এর প্লেয়ারকে সফলভাবে কিক করা হয়েছে এবং {entry_fee}🪙 ফি রিফান্ড করা হয়েছে।"
    }

@app.put("/api/admin/matches/{match_id}/participants/{slot_number}/replace")
async def admin_replace_match_participant(match_id: int, slot_number: int, data: ReplaceParticipantRequest, admin: dict = Depends(verify_moderator_or_admin)):
    new_ign = data.new_player_ign.strip()
    new_uid = data.new_player_uid.strip()
    new_team = (data.new_team_name or "").strip()
    new_uname = (data.new_username or "").strip()

    if not new_ign:
        raise HTTPException(status_code=400, detail="নতুন প্লেয়ারের ইন-গেম নাম (IGN) দেওয়া আবশ্যক")
    if not new_uid or not str(new_uid).isdigit() or len(str(new_uid)) < 6:
        raise HTTPException(status_code=400, detail="সঠিক ফ্রি ফায়ার ইউআইডি (UID) দেওয়া আবশ্যক (কমপক্ষে ৬ ডিজিটের সংখ্যা)")

    conn = get_db()
    try:
        match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
        if not match:
            raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")

        if match["status"] == "completed":
            raise HTTPException(status_code=400, detail="সমাপ্ত হওয়া ম্যাচের প্লেয়ার পরিবর্তন করা যাবে না")

        part = conn.execute("SELECT * FROM participations WHERE match_id = ? AND slot_number = ?", (match_id, slot_number)).fetchone()
        if not part:
            raise HTTPException(status_code=404, detail=f"স্লট #{slot_number}-এ কোনো প্লেয়ার পাওয়া যায়নি")

        old_user_id = part["user_id"]
        old_ign = part["player_ign"] or "Player"
        entry_fee = match["entry_fee"] or 0

        target_user_id = old_user_id
        if new_uname:
            found_user = conn.execute("SELECT id FROM users WHERE username = ? COLLATE NOCASE OR phone = ?", (new_uname, new_uname)).fetchone()
            if found_user:
                target_user_id = found_user["id"]

        m_code = match["match_code"] if ("match_code" in match.keys() and match["match_code"]) else f"MATCH-{match_id}"

        with conn:
            # 1. If requested to refund previous player
            old_bal = 0
            if data.refund_previous_player and entry_fee > 0 and old_user_id:
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (entry_fee, old_user_id))
                conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_REPLACE_REFUND', ?, ?)
                """, (admin["id"], old_user_id, entry_fee, f"Replaced by Admin in Match #{m_code} (Slot #{slot_number}), Refunded {entry_fee}🪙"))

                old_user = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (old_user_id,)).fetchone()
                old_bal = old_user["digits_balance"] if old_user else 0

            # 2. Update participation on this slot
            conn.execute("""
            UPDATE participations 
            SET player_ign = ?, player_uid = ?, team_name = ?, user_id = ?
            WHERE match_id = ? AND slot_number = ?
            """, (new_ign, new_uid, new_team, target_user_id, match_id, slot_number))

            # 3. Log replacement
            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'ADMIN_REPLACE_PLAYER', 0, ?)
            """, (admin["id"], target_user_id, f"Slot #{slot_number} in Match #{m_code} replaced: '{old_ign}' -> '{new_ign}' (UID: {new_uid})"))

    finally:
        conn.close()

    try:
        sync_db_async()
    except Exception:
        pass

    try:
        if data.refund_previous_player and entry_fee > 0 and old_user_id:
            await manager.send_to_user(old_user_id, {
                "type": "BALANCE_UPDATED",
                "digits_balance": old_bal,
                "message": f"ম্যাচ #{m_code}-এ আপনার স্লট #{slot_number} অন্য প্লেয়ারকে দেওয়া হয়েছে এবং {entry_fee}🪙 এন্ট্রি ফি আপনার ওয়ালেটে রিফান্ড করা হয়েছে।"
            })
    except Exception:
        pass

    return {
        "success": True,
        "message": f"স্লট #{slot_number} এর প্লেয়ার সফলভাবে রিপ্লেস করা হয়েছে ({new_ign})। ম্যাচটি আগের মতোই FULL রয়েছে।"
    }

@app.post("/api/admin/matches/{match_id}/publish-results")
async def admin_publish_match_results(match_id: int, data: PublishMatchResultsRequest, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")
    
    per_kill = match["per_kill"] or 0
    
    with conn:
        for item in data.results:
            uid = item.user_id
            kills = max(0, item.kills)
            rank_pos = max(0, item.rank_position)
            rank_prz = max(0, item.rank_prize)
            kill_prz = kills * per_kill
            total_prz = kill_prz + rank_prz
            
            existing = conn.execute("SELECT total_prize FROM match_results WHERE match_id = ? AND user_id = ?", (match_id, uid)).fetchone()
            prev_paid = existing["total_prize"] if existing else 0
            diff = total_prz - prev_paid
            
            conn.execute("""
            INSERT INTO match_results (match_id, user_id, rank_position, kills, kill_prize, rank_prize, total_prize)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(match_id, user_id) DO UPDATE SET
                rank_position = excluded.rank_position,
                kills = excluded.kills,
                kill_prize = excluded.kill_prize,
                rank_prize = excluded.rank_prize,
                total_prize = excluded.total_prize
            """, (match_id, uid, rank_pos, kills, kill_prz, rank_prz, total_prz))
            
            if diff != 0:
                conn.execute("UPDATE users SET digits_balance = digits_balance + ?, win_points = win_points + ? WHERE id = ?", (diff, max(0, diff), uid))
                conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'MATCH_PRIZE_PAYOUT', ?, ?)
                """, (admin["id"], uid, diff, f"Match #{match_id} prize: {kills} kills (৳{kill_prz}) + Rank #{rank_pos} (৳{rank_prz})"))
        
        conn.execute("""
        UPDATE matches SET status = 'completed', completed_at = CURRENT_TIMESTAMP, completed_by_id = ?, completed_by_name = ?
        WHERE id = ?
        """, (admin["id"], admin["username"], match_id))
    
    conn.close()
    
    # Sync match results and completed status instantly to MongoDB Atlas
    try:
        sync_db_async()
    except Exception:
        pass
    
    await manager.broadcast({
        "type": "MATCH_RESULTS_PUBLISHED",
        "match_id": match_id,
        "match_title": match["title"],
        "match_type": match["match_type"]
    })
    
    return {"success": True, "message": f"ম্যাচ #{match_id} এর ফলাফল সফলভাবে প্রকাশিত হয়েছে এবং খেলোয়াড়দের ব্যালেন্সে টাকা জমা হয়েছে!"}


@app.put("/api/admin/matches/{match_id}/toggle-reg")
async def admin_toggle_match_registration(match_id: int, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
    if not match:
        conn.close()
        raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")
    
    curr_status = match["status"]
    if curr_status == "completed":
        conn.close()
        raise HTTPException(status_code=400, detail="সমাপ্ত ম্যাচের রেজিস্ট্রেশন পরিবর্তন করা যাবে না")
    
    new_status = "reg_closed" if curr_status == "upcoming" else "upcoming"
    with conn:
        conn.execute("UPDATE matches SET status = ? WHERE id = ?", (new_status, match_id))
        conn.execute("""
        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
        VALUES (?, ?, 'TOGGLE_REGISTRATION', 0, ?)
        """, (admin["id"], match_id, f"Registration toggled to {new_status} for Match #{match_id}"))
    conn.close()
    sync_db_async()
    
    await manager.broadcast({
        "type": "MATCH_STATUS_UPDATED",
        "match_id": match_id,
        "new_status": new_status
    })
    
    msg = "রেজিস্ট্রেশন বন্ধ করা হয়েছে" if new_status == "reg_closed" else "রেজিস্ট্রেশন চালু করা হয়েছে"
    return {"success": True, "new_status": new_status, "message": f"ম্যাচ #{match_id} এর {msg}!"}

@app.delete("/api/admin/matches/{match_id}")
async def admin_delete_match(match_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    refund_notifications = []
    m_code = f"MATCH-{match_id}"
    try:
        with conn:
            m = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
            if not m:
                raise HTTPException(status_code=404, detail="ম্যাচ পাওয়া যায়নি")

            m_code = m["match_code"] if m["match_code"] else f"MATCH-{match_id}"
            m_title = m["title"] or ""
            entry_fee = m["entry_fee"] or 0
            m_status = m["status"] or ""

            # Automated Refund: If match is not completed and entry fee > 0, refund all registered players!
            if entry_fee > 0 and m_status != "completed":
                part_rows = conn.execute("""
                    SELECT user_id, COUNT(*) as slots_count 
                    FROM participations 
                    WHERE match_id = ? 
                    GROUP BY user_id
                """, (match_id,)).fetchall()

                for p in part_rows:
                    uid = p["user_id"]
                    slots = p["slots_count"]
                    refund_amount = slots * entry_fee
                    if refund_amount > 0:
                        conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (refund_amount, uid))
                        conn.execute("""
                            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                            VALUES (?, ?, 'MATCH_CANCEL_REFUND', ?, ?)
                        """, (admin["id"], uid, refund_amount, f"Cancelled match #{m_code} ({m_title}): Auto-refunded {refund_amount} digits for {slots} slot(s)"))

                        fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (uid,)).fetchone()
                        new_bal = fresh["digits_balance"] if fresh else 0
                        refund_notifications.append({
                            "user_id": uid,
                            "refund_amount": refund_amount,
                            "new_balance": new_bal,
                            "slots": slots
                        })

            conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))
            conn.execute("DELETE FROM participations WHERE match_id = ?", (match_id,))
            conn.execute("DELETE FROM match_results WHERE match_id = ?", (match_id,))

            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, NULL, 'MATCH_DELETED', 0, ?)
            """, (admin["id"], f"Deleted Match #{m_code} ({m_title})"))

            # Recalculate remaining sequence watermark for this category
            pfx = get_match_code_prefix(m["match_type"])
            rows = conn.execute("SELECT match_code FROM matches WHERE match_code LIKE ?", (f"{pfx}-%",)).fetchall()
            rem_max = 0
            for r in rows:
                val = str(r[0] or "")
                if '-' in val:
                    parts = val.rsplit('-', 1)
                    if len(parts) == 2 and parts[1].isdigit():
                        rem_max = max(rem_max, int(parts[1]))
            try:
                p_max = conn.execute("SELECT MAX(number) FROM purged_match_numbers WHERE prefix = ?", (pfx,)).fetchone()[0]
                if p_max is not None:
                    rem_max = max(rem_max, int(p_max))
            except Exception:
                pass
            conn.execute("UPDATE match_code_sequences SET last_number = ? WHERE category = ?", (rem_max, pfx))
            conn.execute("UPDATE settings SET value = ? WHERE key = ?", (str(rem_max), f"seq_watermark_{pfx}"))
    finally:
        conn.close()

    # Send real-time notifications to refunded users
    for r_notif in refund_notifications:
        try:
            await manager.send_to_user(r_notif["user_id"], {
                "type": "BALANCE_UPDATED",
                "digits_balance": r_notif["new_balance"],
                "notice": f"ম্যাচ #{m_code} বাতিল হওয়ায় আপনার {r_notif['refund_amount']} ডিজিট এন্ট্রি ফি ওয়ালেটে রিফান্ড করা হয়েছে।"
            })
        except Exception:
            pass

    # ASYNCHRONOUS BACKGROUND PURGE FROM MONGODB ATLAS (NO BLOCKING / ZERO LAG)
    def _bg_atlas_match_purge(mid):
        try:
            delete_from_mongo_direct("matches", mid)
            delete_from_mongo_direct("participations", mid, id_field="match_id")
            delete_from_mongo_direct("match_results", mid, id_field="match_id")
            push_sqlite_to_mongo()
            sync_snapshot_now()
        except Exception as e:
            print(f"[Match Delete Atlas Sync Error] {e}")

    threading.Thread(target=_bg_atlas_match_purge, args=(match_id,), daemon=True).start()

    refund_summary = f" ({len(refund_notifications)} জন প্লেয়ারকে এন্ট্রি ফি রিফান্ড করা হয়েছে)" if refund_notifications else ""
    return {"success": True, "message": f"ম্যাচ #{m_code} সফলভাবে ডিলিট করা হয়েছে{refund_summary}।"}

@app.get("/api/admin/matches/history")
def admin_get_match_history(category: Optional[str] = None, admin: dict = Depends(verify_moderator_or_admin)):
    """
    Returns full record of completed matches from the last 15 days,
    categorized by the 6 standard categories:
    - solo_full_map
    - duo_full_map
    - br_survival
    - lone_wolf
    - bonus_match
    - cs_4v4
    Each match includes full participant details (slot, IGN, UID, rank, kills, prizes).
    Automatically purges expired records older than 15 days.
    """
    # Offload 15-day purge to background daemon thread to avoid blocking admin UI page load
    threading.Thread(target=purge_records_older_than_15_days, daemon=True).start()

    conn = get_db()
    
    # Query completed matches within the last 15 days
    matches_rows = conn.execute("""
        SELECT m.*
        FROM matches m
        WHERE m.status = 'completed'
          AND (
            (m.completed_at IS NOT NULL AND m.completed_at != '' AND m.completed_at >= datetime('now', '-15 days'))
            OR ((m.completed_at IS NULL OR m.completed_at = '') AND m.created_at >= datetime('now', '-15 days'))
          )
        ORDER BY COALESCE(m.completed_at, m.created_at) DESC
    """).fetchall()

    def classify_category(match_type: str, title: str) -> str:
        t = (match_type or "").lower()
        tl = (title or "").lower()
        if 'survival' in t or 'zone' in t or 'জোন' in t or 'survival' in tl or 'zone' in tl or 'জোন' in tl:
            return 'br_survival'
        if 'lone' in t or 'wolf' in t or 'lone' in tl or 'wolf' in tl or '2v2' in t or '2v2' in tl:
            return 'lone_wolf'
        if 'bonus' in t or 'bonus' in tl or 'বোনাস' in tl:
            return 'bonus_match'
        if 'cs' in t or 'clash' in t or '4v4' in t or ('squad' in t and 'survival' not in tl):
            return 'cs_4v4'
        if 'duo full map' in t or t == 'duo':
            return 'duo_full_map'
        return 'solo_full_map'

    CATEGORY_NAMES = {
        'solo_full_map': 'Solo Full Map',
        'duo_full_map': 'Duo Full Map',
        'br_survival': 'BR Survival',
        'lone_wolf': 'Lone Wolf',
        'bonus_match': 'Bonus Match',
        'cs_4v4': 'CS 4v4'
    }

    result = []
    for m in matches_rows:
        m_dict = dict(m)
        cat_key = classify_category(m_dict.get("match_type", ""), m_dict.get("title", ""))
        m_dict["category_key"] = cat_key
        m_dict["category_name"] = CATEGORY_NAMES.get(cat_key, "Solo Full Map")

        # Category filter if provided
        if category and category != 'all' and category != cat_key:
            continue

        # Full participant details with results
        part_query = """
            SELECT 
                p.slot_number,
                p.user_id,
                COALESCE(NULLIF(p.player_ign, ''), u.ff_ign, u.username, 'Player') AS player_ign,
                COALESCE(NULLIF(p.player_uid, ''), u.ff_uid, '') AS player_uid,
                u.username,
                u.phone,
                u.player_id,
                COALESCE(r.rank_position, 0) AS rank_position,
                COALESCE(r.kills, 0) AS kills,
                COALESCE(r.kill_prize, 0) AS kill_prize,
                COALESCE(r.rank_prize, 0) AS rank_prize,
                COALESCE(r.total_prize, 0) AS total_prize,
                p.joined_at
            FROM participations p
            LEFT JOIN users u ON p.user_id = u.id
            LEFT JOIN match_results r ON p.match_id = r.match_id AND p.user_id = r.user_id
            WHERE p.match_id = ?
            ORDER BY 
                CASE WHEN r.rank_position > 0 THEN r.rank_position ELSE 9999 END ASC,
                r.kills DESC,
                p.slot_number ASC
        """
        parts = conn.execute(part_query, (m_dict["id"],)).fetchall()
        m_dict["participants"] = [dict(p) for p in parts]
        m_dict["total_participants"] = len(m_dict["participants"])
        m_dict["total_payout"] = sum(p["total_prize"] for p in m_dict["participants"])
        result.append(m_dict)

    conn.close()
    return {
        "success": True,
        "matches": result,
        "categories": [
            {"id": "solo_full_map", "name": "Solo Full Map"},
            {"id": "duo_full_map", "name": "Duo Full Map"},
            {"id": "br_survival", "name": "BR Survival"},
            {"id": "lone_wolf", "name": "Lone Wolf"},
            {"id": "bonus_match", "name": "Bonus Match"},
            {"id": "cs_4v4", "name": "CS 4v4"}
        ]
    }

@app.post("/api/admin/settings")
async def admin_update_settings(data: dict, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        for k, v in data.items():
            if v is not None:
                conn.execute("""
                INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """, (k, str(v).strip()))
    conn.close()

    try:
        sync_db_async()
    except Exception:
        pass

    # Real-time WebSocket sync to all connected mobile & PC clients
    broadcast_data = {
        "type": "SETTINGS_UPDATED"
    }
    if "notice" in data:
        broadcast_data["notice"] = data["notice"]
    if "site_title" in data:
        broadcast_data["site_title"] = data["site_title"]
    if "admin_bkash" in data:
        broadcast_data["admin_bkash"] = data["admin_bkash"]
    if "admin_withdraw_number" in data:
        broadcast_data["admin_withdraw_number"] = data["admin_withdraw_number"]

    await manager.broadcast(broadcast_data)

    return {"success": True, "message": "Settings updated and broadcasted successfully"}

class AdminChangePasswordRequest(BaseModel):
    current_password: Optional[str] = None
    new_password: Optional[str] = None
    confirm_password: Optional[str] = None
    new_username: Optional[str] = None
    new_admin_pin: Optional[str] = None

@app.post("/api/admin/change-password")
async def admin_change_own_password(data: AdminChangePasswordRequest, admin: dict = Depends(verify_admin)):
    curr_pass = (data.current_password or "").strip()
    new_pass = (data.new_password or "").strip()
    conf_pass = (data.confirm_password or "").strip()
    new_username = (data.new_username or "").strip()
    new_admin_pin = (data.new_admin_pin or "").strip()

    if new_pass:
        if len(new_pass) < 4:
            raise HTTPException(status_code=400, detail="নতুন পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে")
        if conf_pass and new_pass != conf_pass:
            raise HTTPException(status_code=400, detail="নতুন পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না")

    if new_admin_pin and len(new_admin_pin) != 6:
        raise HTTPException(status_code=400, detail="এডমিন সিকিউরিটি পিন অবশ্যই ৬ ডিজিটের হতে হবে")

    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (admin["id"],)).fetchone()
        if not user:
            raise HTTPException(status_code=404, detail="এডমিন অ্যাকাউন্ট পাওয়া যায়নি")

        # Verify current password if provided
        if curr_pass:
            if not verify_password(user["password_hash"], curr_pass) and user["plain_password"] != curr_pass:
                raise HTTPException(status_code=400, detail="বর্তমান পাসওয়ার্ডটি সঠিক নয়!")

        target_username = user["username"]
        if new_username and new_username.lower() != user["username"].lower():
            # Check username collision
            collision = conn.execute("SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?", (new_username, admin["id"])).fetchone()
            if collision:
                raise HTTPException(status_code=400, detail="এই ইউজারনেমটি ইতিমধ্যে অন্য কারো দখলে আছে!")
            target_username = new_username

        active_hash = user["password_hash"]
        with conn:
            if new_pass:
                new_hash = hash_password(new_pass)
                conn.execute("UPDATE users SET username = ?, password_hash = ?, plain_password = ? WHERE id = ?", (target_username, new_hash, new_pass, admin["id"]))
                active_hash = new_hash
            else:
                conn.execute("UPDATE users SET username = ? WHERE id = ?", (target_username, admin["id"]))

            if new_admin_pin:
                conn.execute("""
                    INSERT INTO settings (key, value) VALUES ('master_admin_pin', ?)
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value
                """, (new_admin_pin,))

            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_CHANGED_OWN_SECURITY', 0, 'Master Admin changed credentials / security PIN successfully')
            """, (admin["id"], admin["id"]))
    finally:
        conn.close()

    # Sync instantly to MongoDB Atlas so the new credentials & PIN are permanently saved in cloud
    try:
        sync_db_async()
    except Exception:
        pass

    # Generate a new token with the updated session and security signature
    new_token = generate_token(admin["id"], target_username, admin["role"], active_hash or "")

    return {
        "success": True,
        "message": "এডমিন আইডি, পাসওয়ার্ড ও সিকিউরিটি পিন সফলভাবে আপডেট হয়েছে!",
        "new_username": target_username,
        "token": new_token
    }

@app.post("/api/admin/broadcast")
async def admin_broadcast_notice(data: AdminNoticeRequest, admin: dict = Depends(verify_admin)):
    title = data.title.strip()
    msg = data.message.strip()
    full_notice = f"{title}: {msg}"

    # 1. ALWAYS persist notice to settings table so new/reconnecting visitors immediately see it!
    conn = get_db()
    with conn:
        conn.execute("""
        INSERT INTO settings (key, value) VALUES ('notice', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """, (full_notice,))
    conn.close()

    # 2. Instant Live Alert toast + sound to all active screens
    await manager.broadcast({
        "type": "ADMIN_ANNOUNCEMENT",
        "title": title,
        "message": msg,
        "timestamp": datetime.now().strftime("%I:%M %p")
    })

    # 3. Also update notice bar live on all phones
    await manager.broadcast({
        "type": "SETTINGS_UPDATED",
        "notice": full_notice
    })

    conn = get_db()
    subs = conn.execute("SELECT * FROM push_subscriptions").fetchall()
    conn.close()

    push_payload = json.dumps({
        "title": title,
        "body": msg,
        "icon": "/static/img/icon.png",
        "url": "/"
    })

    send_push_in_background(subs, push_payload, remove_dead=True)

    return {
        "success": True,
        "message": f"Notice broadcasted! WebSockets: {len(manager.active_connections)}, Push Dispatched: {len(subs)}"
    }

@app.post("/api/admin/push-update")
async def admin_push_update(data: AdminPushUpdate, admin: dict = Depends(verify_admin)):
    """Pushes an in-app OTA update prompt to all installed app users and active web clients."""
    new_version = data.version.strip()
    notes = data.notes.strip()

    conn = get_db()
    with conn:
        conn.execute("INSERT INTO settings (key, value) VALUES ('app_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (new_version,))
        conn.execute("INSERT INTO settings (key, value) VALUES ('app_update_notes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (notes,))
    conn.close()

    # 1. Real-time in-app WebSocket Broadcast
    await manager.broadcast({
        "type": "APP_UPDATE_AVAILABLE",
        "version": new_version,
        "notes": notes,
        "force": data.force
    })

    # 2. Native Mobile Push Notification to phones
    conn = get_db()
    subs = conn.execute("SELECT * FROM push_subscriptions").fetchall()
    conn.close()

    push_payload = json.dumps({
        "title": f"🚀 নতুন ভার্সন আপডেট: {new_version}",
        "body": f"{notes} - এখনই অ্যাপ ওপেন করে আপডেট ও ইনস্টল করুন!",
        "icon": "/static/img/icon.png",
        "url": "/"
    })

    send_push_in_background(subs, push_payload, remove_dead=False)

    return {
        "success": True,
        "version": new_version,
        "message": f"ভার্সন {new_version} এর লাইভ আপডেট সব প্লেয়ারদের অ্যাপে পাঠানো হয়েছে!"
    }

# -------------------------------------------------------------
# WebSocket Endpoint for Real-Time Zero-Lag Updates
# -------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: Optional[str] = None):
    user_id = None
    if token:
        payload = verify_token(token)
        if payload:
            user_id = payload.get("user_id")

    await manager.connect(websocket, user_id)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id)
    except Exception:
        manager.disconnect(websocket, user_id)

# -------------------------------------------------------------
# Static Files & SPA Frontend Serving
# -------------------------------------------------------------

# -------------------------------------------------------------
# Mascot Logo & Icon Auto-Sync System (Guaranteed Logo Display)
# -------------------------------------------------------------
EMBEDDED_MASCOT_B64 = "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"

def ensure_mascot_icons():
    """Automatically ensure the mascot logo is written and old green target icon is eradicated."""
    pub_img = os.path.join(BASE_DIR, "public", "img")
    os.makedirs(pub_img, exist_ok=True)
    
    icon_path = os.path.join(pub_img, "icon.png")
    is_invalid = True
    if os.path.exists(icon_path):
        sz = os.path.getsize(icon_path)
        if sz not in [7702, 71233] and sz > 20000:
            is_invalid = False

    if is_invalid:
        try:
            root_icon = os.path.join(BASE_DIR, "icon.png")
            if os.path.exists(root_icon) and os.path.getsize(root_icon) not in [7702, 71233] and os.path.getsize(root_icon) > 20000:
                with open(root_icon, "rb") as sf, open(icon_path, "wb") as df:
                    df.write(sf.read())
                is_invalid = False
        except Exception:
            pass

    if is_invalid:
        try:
            raw_bytes = base64.b64decode(EMBEDDED_MASCOT_B64)
            with open(icon_path, "wb") as df:
                df.write(raw_bytes)
            for fname in ["icon-192.png", "icon-512.png", "gomon_hub_logo.png"]:
                fpath = os.path.join(pub_img, fname)
                if not os.path.exists(fpath) or os.path.getsize(fpath) in [7702, 71233]:
                    with open(fpath, "wb") as df:
                        df.write(raw_bytes)
        except Exception as e:
            print("[!] Failed to write embedded mascot:", e)

ensure_mascot_icons()

public_dir = os.path.join(BASE_DIR, "public")
if not os.path.exists(public_dir):
    os.makedirs(public_dir, exist_ok=True)


@app.get("/static/img/icon.png")
@app.get("/static/img/icon-512.png")
@app.get("/static/img/icon-192.png")
@app.get("/static/img/gomon_hub_logo.png")
@app.get("/icon.png")
@app.get("/gomon_hub_logo.png")
@app.get("/favicon.ico")
def serve_app_icon(request: Request):
    raw = base64.b64decode(EMBEDDED_MASCOT_B64)
    return Response(
        content=raw,
        media_type="image/png",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0"
        }
    )

@app.post("/api/admin/system/reset-players")
def admin_reset_all_players(admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        p_deleted = conn.execute("DELETE FROM participations WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").rowcount
        d_deleted = conn.execute("DELETE FROM deposits WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").rowcount
        w_deleted = conn.execute("DELETE FROM withdrawals WHERE user_id IN (SELECT id FROM users WHERE role != 'admin')").rowcount
        b_deleted = conn.execute("DELETE FROM banned_records").rowcount
        u_deleted = conn.execute("DELETE FROM users WHERE role != 'admin'").rowcount
        conn.execute("UPDATE users SET phone = '01700000000' WHERE role = 'admin'")
    conn.close()

    # Asynchronously purge from MongoDB Atlas to prevent ghost resurrection
    def _bg_atlas_reset_players():
        try:
            mongo = get_mongo_database()
            if mongo is not None:
                mongo["users"].delete_many({"role": {"$ne": "admin"}})
                mongo["banned_records"].delete_many({})
                mongo["participations"].delete_many({})
                mongo["deposits"].delete_many({})
                mongo["withdrawals"].delete_many({})
            push_sqlite_to_mongo()
            sync_snapshot_now()
        except Exception as e:
            print(f"[Reset Players Atlas Sync Error] {e}")

    threading.Thread(target=_bg_atlas_reset_players, daemon=True).start()

    return {
        "success": True, 
        "deleted_users": u_deleted,
        "message": f"সফলভাবে {u_deleted} জন ইউজারের পূর্বের রেকর্ড ও হিস্ট্রি মুছে ফেলা হয়েছে। এখন সবাই নতুন করে তাদের ফোন নম্বর দিয়ে অ্যাকাউন্ট খুলতে পারবে।"
    }

app.mount("/static", StaticFiles(directory=public_dir), name="static")

@app.get("/")
def serve_index():
    index_file = os.path.join(public_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file, headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})
    return {"status": "Frontend loading..."}

@app.get("/sw.js")
def serve_service_worker():
    sw_file = os.path.join(public_dir, "sw.js")
    if os.path.exists(sw_file):
        return FileResponse(sw_file, media_type="application/javascript", headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})
    return JSONResponse(status_code=404, content={"detail": "sw.js not found"})

@app.get("/manifest.json")
def serve_manifest():
    mf_file = os.path.join(public_dir, "manifest.json")
    if os.path.exists(mf_file):
        return FileResponse(mf_file, media_type="application/json", headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})
    return JSONResponse(status_code=404, content={"detail": "manifest.json not found"})

@app.get("/robots.txt")
def serve_robots():
    robots_file = os.path.join(public_dir, "robots.txt")
    if os.path.exists(robots_file):
        return FileResponse(robots_file, media_type="text/plain", headers={"Cache-Control": "public, max-age=3600"})
    return Response(content="User-agent: *\nAllow: /\nDisallow: /admin\n", media_type="text/plain")

@app.get("/sitemap.xml")
def serve_sitemap():
    sitemap_file = os.path.join(public_dir, "sitemap.xml")
    if os.path.exists(sitemap_file):
        return FileResponse(sitemap_file, media_type="application/xml", headers={"Cache-Control": "public, max-age=3600"})
    return Response(content='<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url></urlset>', media_type="application/xml")

@app.get("/google{code}.html")
def serve_google_verification(code: str):
    fname = f"google{code}.html"
    fpath = os.path.join(public_dir, fname)
    if os.path.exists(fpath):
        return FileResponse(fpath, media_type="text/html")
    return Response(content=f"google-site-verification: google{code}.html", media_type="text/html")

if __name__ == "__main__":
    import uvicorn
    print("\n========================================================")
    print("[*] FREE FIRE TOURNAMENT SERVER STARTING (HIGH PERFORMANCE)")
    print("[*] URL: http://127.0.0.1:8000")
    print("[*] Master Admin Login: username: 'admin' (password securely stored)")
    port = int(os.environ.get("PORT", 8000))
    print(f"[*] Port: {port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False, log_level="info")
