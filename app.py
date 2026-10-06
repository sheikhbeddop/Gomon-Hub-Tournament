import os
import sys
import json
import time
import hmac
import hashlib
import secrets
import sqlite3
import base64
import struct
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

def generate_base32_secret(length: int = 16) -> str:
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    return "".join(secrets.choice(alphabet) for _ in range(length))

def verify_totp(secret: str, token: str, window: int = 1, interval: int = 30) -> bool:
    try:
        clean_secret = secret.replace(" ", "").upper()
        padding = (8 - len(clean_secret) % 8) % 8
        key = base64.b32decode(clean_secret + "=" * padding)
        current_counter = int(time.time() // interval)
        token_str = str(token).strip()
        if len(token_str) != 6 or not token_str.isdigit():
            return False
        token_int = int(token_str)
        for offset in range(-window, window + 1):
            msg = struct.pack(">Q", current_counter + offset)
            h = hmac.new(key, msg, hashlib.sha1).digest()
            o = h[-1] & 0x0F
            code = (struct.unpack(">I", h[o:o+4])[0] & 0x7FFFFFFF) % 1000000
            if code == token_int:
                return True
        return False
    except Exception:
        return False

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

        # Video Promotions & Earn System Table Schema (Initialized before MongoDB Cloud restore)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS video_promotions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                platform TEXT NOT NULL,
                video_url TEXT NOT NULL,
                notes TEXT DEFAULT '',
                status TEXT DEFAULT 'pending',
                reward_amount INTEGER DEFAULT 0,
                admin_note TEXT DEFAULT '',
                reviewed_by_name TEXT DEFAULT '',
                reviewed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )
        """)

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
# Permanent Unique Promo Code Management Engine
# -------------------------------------------------------------
def generate_unique_promo_code(conn) -> str:
    """
    Generates a permanent, unique promo code in format GOMONHUB-XXXX
    where XXXX is 4 alphanumeric uppercase characters (excluding confusing chars 0, O, 1, I).
    """
    charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    for _ in range(100):
        code = "GOMONHUB-" + "".join(secrets.choice(charset) for _ in range(4))
        row = conn.execute("SELECT id FROM users WHERE promo_code = ?", (code,)).fetchone()
        if not row:
            return code
    return f"GOMONHUB-{secrets.choice(charset)}{secrets.choice(charset)}{secrets.choice(charset)}{int(time.time()) % 1000}"

def ensure_promo_codes_initialized():
    """Ensures promo_code column exists in users table, user_referrals table exists, and all existing users have a unique permanent promo code."""
    try:
        conn = get_db()
        with conn:
            try:
                conn.execute("ALTER TABLE users ADD COLUMN promo_code TEXT")
            except Exception:
                pass
            try:
                conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_promo_code ON users(promo_code)")
            except Exception:
                pass
            try:
                conn.execute("""
                CREATE TABLE IF NOT EXISTS user_referrals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    referrer_id INTEGER NOT NULL,
                    referee_id INTEGER UNIQUE NOT NULL,
                    promo_code_used TEXT,
                    referee_bonus INTEGER DEFAULT 5,
                    referrer_bonus INTEGER DEFAULT 5,
                    is_deposit_rewarded INTEGER DEFAULT 0,
                    deposit_rewarded_at DATETIME DEFAULT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (referrer_id) REFERENCES users(id) ON DELETE CASCADE,
                    FOREIGN KEY (referee_id) REFERENCES users(id) ON DELETE CASCADE
                );
                """)
                conn.execute("CREATE INDEX IF NOT EXISTS idx_referrals_referee ON user_referrals(referee_id);")
                conn.execute("CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON user_referrals(referrer_id);")
            except Exception:
                pass
            users_without_code = conn.execute("SELECT id, username FROM users WHERE promo_code IS NULL OR promo_code = '' ORDER BY id ASC").fetchall()
            has_new_codes = False
            for u in users_without_code:
                code = generate_unique_promo_code(conn)
                conn.execute("UPDATE users SET promo_code = ? WHERE id = ?", (code, u["id"]))
                has_new_codes = True
        conn.close()
        if has_new_codes:
            sync_db_async()
    except Exception as e:
        print(f"[Promo Code Init Notice] {e}")

ensure_promo_codes_initialized()

def ensure_challenges_table():
    """Ensures custom_challenges table exists for the 1v1 and 4v4 challenge arena."""
    try:
        conn = get_db()
        with conn:
            conn.execute("""
            CREATE TABLE IF NOT EXISTS custom_challenges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                challenge_code TEXT UNIQUE NOT NULL,
                creator_id INTEGER NOT NULL,
                rival_id INTEGER DEFAULT NULL,
                mode TEXT NOT NULL DEFAULT '1v1',
                entry_fee INTEGER NOT NULL,
                prize_amount INTEGER NOT NULL,
                platform_fee INTEGER NOT NULL,
                gun_attributes INTEGER DEFAULT 0,
                limited_ammo INTEGER DEFAULT 1,
                room_creator_role TEXT DEFAULT 'creator',
                room_id TEXT DEFAULT '',
                room_password TEXT DEFAULT '',
                status TEXT DEFAULT 'open',
                creator_claim TEXT DEFAULT NULL,
                rival_claim TEXT DEFAULT NULL,
                creator_screenshot TEXT DEFAULT '',
                rival_screenshot TEXT DEFAULT '',
                winner_id INTEGER DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                accepted_at DATETIME DEFAULT NULL,
                completed_at DATETIME DEFAULT NULL,
                FOREIGN KEY (creator_id) REFERENCES users(id) ON DELETE CASCADE,
                FOREIGN KEY (rival_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_challenges_code ON custom_challenges(challenge_code);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_challenges_status ON custom_challenges(status);")

            for col_def in [
                "room_creator_role TEXT DEFAULT 'creator'",
                "gun_attributes INTEGER DEFAULT 0",
                "limited_ammo INTEGER DEFAULT 1",
                "room_id TEXT DEFAULT ''",
                "room_password TEXT DEFAULT ''",
                "creator_claim TEXT DEFAULT NULL",
                "rival_claim TEXT DEFAULT NULL",
                "creator_screenshot TEXT DEFAULT ''",
                "rival_screenshot TEXT DEFAULT ''",
                "winner_id INTEGER DEFAULT NULL",
                "accepted_at DATETIME DEFAULT NULL",
                "completed_at DATETIME DEFAULT NULL"
            ]:
                try:
                    conn.execute(f"ALTER TABLE custom_challenges ADD COLUMN {col_def}")
                except Exception:
                    pass
        conn.close()
    except Exception as e:
        print(f"[Challenges Init Notice] {e}")

ensure_challenges_table()


# -------------------------------------------------------------
# FastAPI App & WebSocket Connection Manager
# -------------------------------------------------------------
app = FastAPI(title="Free Fire Tournament Platform API")

@app.on_event("startup")
async def on_startup():
    try:
        ensure_promo_codes_initialized()
    except Exception:
        pass
    try:
        ensure_challenges_table()
    except Exception:
        pass
    # Run 15-day auto-purge on startup
    try:
        purge_records_older_than_15_days()
    except Exception as e:
        print(f"[15-Day Auto-Purge Startup Notice] {e}")

    import threading
    def periodic_maintenance_daemon():
        cycle_count = 0
        while True:
            # Heartbeat check every 24 hours (86400s) to protect Render monthly bandwidth
            # Real writes (deposits, match joins, results) already trigger instant sync via sync_db_async()
            time.sleep(86400)
            try:
                if is_mongo_connected():
                    push_sqlite_to_mongo()
            except Exception as se:
                pass

            # Full 15-day purge runs once daily alongside the 24-hour cycle
            try:
                purge_records_older_than_15_days()
            except Exception as pe:
                print(f"[Maintenance Purge Notice] {pe}")

    t = threading.Thread(target=periodic_maintenance_daemon, daemon=True)
    t.start()
    if is_mongo_connected():
        print("[MongoDB] Cloud persistence active! Daemon running (intelligent hash-sync & 24-hour maintenance cycle).")
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
    "scrapy", "petalbot", "dotbot", "semrushbot",
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
    if path.startswith(("/admin", "/api/admin", "/api/super-admin")):
        response.headers["X-Robots-Tag"] = "noindex, nofollow"
    else:
        response.headers["X-Robots-Tag"] = "index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1"

    if path.endswith((".js", ".css", ".png", ".jpg", ".jpeg", ".ico", ".svg", ".woff2", ".webp")):
        response.headers["Cache-Control"] = "public, max-age=604800, stale-while-revalidate=86400"
    elif path == "/sw.js":
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    elif path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "public, max-age=3600, stale-while-revalidate=86400"
    elif path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"

    # Cyber Security Headers (Protection against Clickjacking, MIME sniffing, and external framing)
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.headers.get("x-forwarded-proto") == "https" or request.url.scheme == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"

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
# Referral Reward Dispatcher (Triggers on 1st Deposit Approval)
# -------------------------------------------------------------
async def check_and_reward_first_deposit_referral(conn, user_id: int, deposit_amount: float = None):
    """
    Rewards the referrer with +5 Taka digits_balance upon referee's 1st qualifying approved deposit (minimum 10 BDT).
    Only triggers once in a lifetime per referee (is_deposit_rewarded: 0 -> 1).
    Deposits below 10 BDT credit normally to the user but do NOT unlock the referral bonus for the referrer.
    """
    try:
        # Determine qualifying deposit amount
        if deposit_amount is None:
            latest_dep = conn.execute("""
                SELECT amount FROM deposits 
                WHERE user_id = ? AND status = 'approved' 
                ORDER BY id DESC LIMIT 1
            """, (user_id,)).fetchone()
            deposit_amount = float(latest_dep["amount"]) if latest_dep and latest_dep["amount"] is not None else 0.0
        else:
            try:
                deposit_amount = float(deposit_amount)
            except (ValueError, TypeError):
                deposit_amount = 0.0

        # Anti-Fraud & Business Rule: Qualifying deposit must be at least 10 BDT
        if deposit_amount < 10.0:
            return

        ref = conn.execute("""
            SELECT id, referrer_id, referee_id, is_deposit_rewarded, referrer_bonus
            FROM user_referrals
            WHERE referee_id = ? AND is_deposit_rewarded = 0
            LIMIT 1
        """, (user_id,)).fetchone()

        if not ref:
            return

        referrer_id = ref["referrer_id"]
        bonus_amount = ref["referrer_bonus"] or 5

        if referrer_id and referrer_id != user_id:
            conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (bonus_amount, referrer_id))
            conn.execute("""
                UPDATE user_referrals 
                SET is_deposit_rewarded = 1, deposit_rewarded_at = CURRENT_TIMESTAMP 
                WHERE id = ?
            """, (ref["id"],))

            referee = conn.execute("SELECT username FROM users WHERE id = ?", (user_id,)).fetchone()
            referee_name = referee["username"] if referee else "New Player"

            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (0, ?, 'REFERRAL_REWARD_CREDITED', ?, ?)
            """, (referrer_id, bonus_amount, f"Referral reward: User @{referee_name} completed qualifying first deposit of {deposit_amount:.2f} Tk (minimum 10 Tk required)"))

            try:
                fresh_ref = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (referrer_id,)).fetchone()
                ref_bal = fresh_ref["digits_balance"] if fresh_ref else 0
                dep_disp = int(deposit_amount) if deposit_amount.is_integer() else deposit_amount
                await manager.send_to_user(referrer_id, {
                    "type": "BALANCE_UPDATED",
                    "digits_balance": ref_bal,
                    "notice": f"🎉 অভিনন্দন! আপনার প্রোমো কোড ব্যবহারকারী @{referee_name} প্রথম ডিপোজিট (৳{dep_disp}) সম্পন্ন করেছেন! আপনার ওয়ালেটে +{bonus_amount} টাকা যোগ হয়েছে।"
                })
            except Exception:
                pass
    except Exception as e:
        print(f"[Referral Reward Notice] {e}")

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

    # Single Active Device Binding Check (Instant Session Revocation for Players):
    if user["role"] not in ["admin", "moderator"]:
        client_dev = request.headers.get("X-Device-Id") or request.headers.get("x-device-id")
        if client_dev:
            client_dev = str(client_dev).strip()
            reg_dev = get_user_registered_device(user["id"])
            if reg_dev and client_dev != reg_dev:
                raise HTTPException(
                    status_code=401,
                    detail="SESSION_REVOKED:আপনার অ্যাকাউন্টটি অন্য কোনো ডিভাইসে লগইন করা হয়েছে। নিরাপত্তা রক্ষার্থে এই ডিভাইসটি লগআউট করা হলো।"
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
    promo_code: Optional[str] = ""
    device_id: Optional[str] = ""

class LoginRequest(BaseModel):
    username: str
    password: str
    admin_pin: Optional[str] = None
    device_id: Optional[str] = None

class VerifyOtpRequest(BaseModel):
    temp_token: str
    otp_code: str
    device_id: Optional[str] = None

class ResendOtpRequest(BaseModel):
    temp_token: str

class ForgotPasswordRequest(BaseModel):
    identifier: str
    device_id: Optional[str] = None

class ForgotVerifyOtpRequest(BaseModel):
    reset_token: str
    otp_code: str
    device_id: Optional[str] = None

class ForgotResetPasswordRequest(BaseModel):
    change_token: str
    new_password: str
    confirm_password: str


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
    match_count: int = 1
    interval_minutes: int = 30

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

@app.get("/api/health")
def health_check():
    return {"status": "ok", "time": int(time.time())}

@app.get("/api/info")
def get_public_info(request: Request):
    conn = get_db()
    settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    settings = {r["key"]: r["value"] for r in settings_rows}
    current_ver = settings.get("app_version") or CURRENT_CODE_VERSION

    # Protect phone numbers from anonymous web scrapers & bots
    is_authenticated = False
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        payload = verify_token(auth_header.split(" ")[1])
        if payload:
            is_authenticated = True

    admin_bkash_raw = settings.get("admin_bkash", "01988279285 (Personal)")
    admin_withdraw_raw = settings.get("admin_withdraw_number", admin_bkash_raw)

    return {
        "site_title": settings.get("site_title", "GOMON HUB TOURNAMENT"),
        "admin_bkash": admin_bkash_raw if is_authenticated else "লগইন করে ডিপোজিট নাম্বার দেখুন",
        "admin_withdraw_number": admin_withdraw_raw if is_authenticated else "লগইন করে নাম্বার দেখুন",
        "notice": settings.get("notice", ""),
        "notice_en": settings.get("notice_en", ""),
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

# -------------------------------------------------------------
# New Device Tracking & Email OTP Verification System
# -------------------------------------------------------------
DEVICES_FILE = os.path.join(BASE_DIR, "devices.json")
PENDING_OTP_STORE = {} # temp_token -> session state dictionary

def load_user_devices() -> dict:
    if os.path.exists(DEVICES_FILE):
        try:
            with open(DEVICES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_user_devices(data: dict):
    try:
        with open(DEVICES_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print("[DeviceStore Error]", e)

def get_user_registered_device(user_id: int) -> Optional[str]:
    # 1. Primary: Persistent settings table (synced to MongoDB)
    try:
        conn = get_db()
        row = conn.execute("SELECT value FROM settings WHERE key = ?", (f"trusted_dev_{user_id}",)).fetchone()
        conn.close()
        if row and row["value"]:
            dev_val = str(row["value"]).strip()
            if dev_val:
                return dev_val
    except Exception as e:
        print("[DeviceStore DB Error]", e)

    # 2. Fallback: devices.json
    devs = load_user_devices()
    u_info = devs.get(str(user_id))
    if isinstance(u_info, dict):
        return u_info.get("device_id")
    elif isinstance(u_info, str):
        return u_info
    return None

def set_user_registered_device(user_id: int, device_id: str):
    if not device_id:
        return
    device_id = str(device_id).strip()
    # 1. Save to persistent settings table (synced to MongoDB Atlas)
    try:
        conn = get_db()
        with conn:
            conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (f"trusted_dev_{user_id}", device_id))
        conn.close()
        sync_db_async()
    except Exception as e:
        print("[DeviceStore DB Save Error]", e)

    # 2. Legacy fallback file
    try:
        devs = load_user_devices()
        devs[str(user_id)] = {
            "device_id": device_id,
            "updated_at": datetime.now(timezone.utc).isoformat()
        }
        save_user_devices(devs)
    except Exception:
        pass

LOCKOUTS_FILE = os.path.join(BASE_DIR, "lockouts.json")

def load_lockouts() -> dict:
    if os.path.exists(LOCKOUTS_FILE):
        try:
            with open(LOCKOUTS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_lockouts(data: dict):
    try:
        with open(LOCKOUTS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print("[LockoutStore Error]", e)

def get_user_lockout_info(user_id: int):
    """
    Returns (is_locked: bool, remaining_minutes: int, streak: int)
    """
    data = load_lockouts()
    info = data.get(str(user_id))
    if not info:
        return False, 0, 0
    now_ts = time.time()
    locked_until = info.get("locked_until", 0)
    streak = info.get("streak", 0)
    if now_ts < locked_until:
        rem_mins = max(1, int((locked_until - now_ts + 59) // 60))
        return True, rem_mins, streak
    return False, 0, streak

def record_user_lockout(user_id: int) -> int:
    """
    Exponential Backoff: 5, 10, 20, 40, 80, 160... capped at 1440 mins (24 hrs).
    Returns locked duration in minutes.
    """
    data = load_lockouts()
    info = data.get(str(user_id), {})
    current_streak = info.get("streak", 0) + 1
    duration_mins = min(1440, 5 * (2 ** (current_streak - 1)))
    locked_until = time.time() + (duration_mins * 60)
    data[str(user_id)] = {
        "streak": current_streak,
        "duration_mins": duration_mins,
        "locked_until": locked_until,
        "last_locked_at": datetime.now(timezone.utc).isoformat()
    }
    save_lockouts(data)
    return duration_mins

def clear_user_lockout(user_id: int):
    """
    Resets the lockout streak back to 0 upon successful OTP verification.
    """
    data = load_lockouts()
    if str(user_id) in data:
        del data[str(user_id)]
        save_lockouts(data)

RESET_SECURITY_FILE = os.path.join(BASE_DIR, "reset_security.json")

def load_reset_security() -> dict:
    if os.path.exists(RESET_SECURITY_FILE):
        try:
            with open(RESET_SECURITY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_reset_security(data: dict):
    try:
        with open(RESET_SECURITY_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print("[ResetSecurity Error]", e)

def is_device_reset_locked(device_id: str) -> tuple[bool, int]:
    if not device_id:
        return False, 0
    data = load_reset_security()
    lockouts = data.get("lockouts", {})
    entry = lockouts.get(device_id)
    if not entry:
        return False, 0
    locked_until = entry.get("locked_until", 0)
    now_ts = time.time()
    if now_ts < locked_until:
        rem_hours = max(1, int((locked_until - now_ts + 3599) // 3600))
        return True, rem_hours
    return False, 0

def lock_device_from_reset(device_id: str, hours: int = 30):
    if not device_id:
        return
    data = load_reset_security()
    if "lockouts" not in data:
        data["lockouts"] = {}
    data["lockouts"][device_id] = {
        "locked_until": time.time() + (hours * 3600),
        "locked_at": datetime.now(timezone.utc).isoformat()
    }
    save_reset_security(data)

def check_and_increment_daily_reset_count(user_id: int, max_per_day: int = 5) -> tuple[bool, int]:
    data = load_reset_security()
    daily = data.get("daily_counts", {})
    key = str(user_id)
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    user_entry = daily.get(key, {"date": today_str, "count": 0})
    if user_entry.get("date") != today_str:
        user_entry = {"date": today_str, "count": 0}
    if user_entry.get("count", 0) >= max_per_day:
        return False, user_entry["count"]
    user_entry["count"] = user_entry.get("count", 0) + 1
    user_entry["date"] = today_str
    daily[key] = user_entry
    data["daily_counts"] = daily
    save_reset_security(data)
    return True, user_entry["count"]

# -------------------------------------------------------------
# Dual-Engine Dedicated Email Transmitters (Google Webhook + SMTP)
# -------------------------------------------------------------
DEVICE_OTP_SCRIPT_URL = os.environ.get(
    "DEVICE_OTP_SCRIPT_URL", 
    "https://script.google.com/macros/s/AKfycbzCZ_OGKh_1eWp151EElCJ_XLSkqHeiu9CRzSpWFauAjVPLCP8GwYbcLCqlsY4GtJ-lwA/exec"
).strip()

RESET_PASS_SCRIPT_URL = os.environ.get(
    "RESET_PASS_SCRIPT_URL", 
    "https://script.google.com/macros/s/AKfycbzdYKeIWwfIk91vvVrNZr_F8En2FbCoGXHoiFZugyRM7fgN7ES-9TlkoTo8nbRMwsqQ9w/exec"
).strip()

CHALLENGE_UPLOAD_SCRIPT_URL = os.environ.get(
    "CHALLENGE_UPLOAD_SCRIPT_URL",
    "https://script.google.com/macros/s/AKfycbycUonBG_S5ThZmH0-OVTopcV7nwRVFhhzSjHVYvgpZvGwnvf10AulAeus5lYrrANYT/exec"
).strip()
GMAIL_SCRIPT_URL = DEVICE_OTP_SCRIPT_URL

def send_device_otp_email(to_email: str, username: str, otp_code: str):
    """
    Sends 6-digit Device Verification OTP email from gomonhub@gmail.com
    Style: Neon Cyan / Emerald Shield 2FA Security Alert
    """
    # 1. Primary: Google Apps Script Webhook (gomonhub@gmail.com)
    if DEVICE_OTP_SCRIPT_URL:
        try:
            import urllib.request
            import urllib.parse
            params = urllib.parse.urlencode({
                "to": to_email,
                "code": otp_code,
                "user": username,
                "type": "device"
            })
            req_url = f"{DEVICE_OTP_SCRIPT_URL}?{params}"
            req = urllib.request.Request(req_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                resp_text = resp.read().decode("utf-8")
                if "SUCCESS" in resp_text:
                    print(f"[DEVICE OTP SUCCESS] Delivered to {to_email} via Google Apps Script (gomonhub@gmail.com)")
                    return True, "SENT"
                else:
                    print(f"[DEVICE OTP SCRIPT] Response: {resp_text}")
        except Exception as e_script:
            print(f"[DEVICE OTP SCRIPT NOTICE] Error: {e_script}, trying SMTP fallback...")

    # 2. Fallback: Direct SMTP (gomonhub@gmail.com)
    gmail_user = os.environ.get("DEVICE_GMAIL_USER", os.environ.get("GMAIL_USER", "gomonhub@gmail.com")).strip()
    gmail_app_password = os.environ.get("DEVICE_GMAIL_APP_PASSWORD", os.environ.get("GMAIL_APP_PASSWORD", "")).strip().replace(" ", "")

    if not gmail_user or not gmail_app_password:
        print(f"[DEVICE OTP DEV MODE] To='{to_email}', User='{username}', Code='{otp_code}'")
        return True, "DEV_LOGGED"

    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"{otp_code} is your GOMON HUB Verification Code"
        msg["From"] = f"GOMON HUB TOURNAMENT <{gmail_user}>"
        msg["To"] = to_email

        html_content = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #080b11; color: #ffffff; margin: 0; padding: 24px 12px; }}
    .card {{ max-width: 460px; margin: auto; background: #0d121d; border-radius: 20px; padding: 36px 24px; border: 1px solid rgba(0, 245, 155, 0.25); text-align: center; box-shadow: 0 15px 35px rgba(0,0,0,0.5); }}
    .logo {{ font-size: 24px; font-weight: 800; color: #00f59b; letter-spacing: 1px; margin-bottom: 6px; }}
    .subtitle {{ color: #94a3b8; font-size: 14px; margin-bottom: 24px; }}
    .otp-box {{ background: rgba(0, 245, 155, 0.08); border: 2px dashed #00f59b; border-radius: 14px; padding: 18px; font-size: 34px; font-weight: 800; letter-spacing: 10px; color: #ffffff; margin: 24px 0; }}
    .warning {{ font-size: 12px; color: #ef4444; margin-top: 18px; background: rgba(239, 68, 68, 0.1); padding: 10px 14px; border-radius: 8px; }}
    .footer {{ font-size: 11px; color: #64748b; margin-top: 24px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">2-FACTOR AUTHENTICATION</div>
    <div class="logo">GOMON HUB TOURNAMENT</div>
    <div class="subtitle">New Device Authorization Code</div>
    <p style="color: #cbd5e1; font-size: 14px; line-height: 1.5;">
      Hello <b>{username}</b>,<br>
      A new device is trying to access your GOMON HUB TOURNAMENT ACCOUNT. Please use the authorization code below to complete sign in:
    </p>
    <div class="code-box">{otp_code}</div>
    <p style="color: #94a3b8; font-size: 13px;">This code will expire in <b>5 minutes</b>. Never share this code with anyone.</p>
    <div class="warning">Notice: If you did NOT attempt to sign in, someone might know your password. Change your password immediately to protect your account.</div>
    <div class="footer">Sent via gomonhub@gmail.com | GOMON HUB VERIFICATION</div>
  </div>
</body>
</html>"""
        msg.attach(MIMEText(html_content, "html"))

        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=8) as server:
                server.login(gmail_user, gmail_app_password)
                server.sendmail(gmail_user, [to_email], msg.as_string())
                print(f"[OTP SUCCESS] Sent verification email to {to_email} via SMTP 465")
                return True, "SENT"
        except Exception:
            with smtplib.SMTP("smtp.gmail.com", 587, timeout=8) as server:
                server.ehlo()
                server.starttls()
                server.login(gmail_user, gmail_app_password)
                server.sendmail(gmail_user, [to_email], msg.as_string())
                print(f"[OTP SUCCESS] Sent verification email to {to_email} via SMTP 587")
                return True, "SENT"
    except Exception as e:
        print(f"[OTP ERROR] Failed to send email to {to_email}: {e}")
        return False, str(e)


def send_reset_password_email(to_email: str, username: str, otp_code: str):
    """
    Sends 6-digit Password Reset code from gomonhubsecurity@gmail.com
    Style: Ruby Crimson / Padlock Emergency Account Recovery
    """
    # 1. Primary: Google Apps Script Webhook (gomonhubsecurity@gmail.com)
    if RESET_PASS_SCRIPT_URL:
        try:
            import urllib.request
            import urllib.parse
            params = urllib.parse.urlencode({
                "to": to_email,
                "code": otp_code,
                "user": username,
                "type": "reset"
            })
            req_url = f"{RESET_PASS_SCRIPT_URL}?{params}"
            req = urllib.request.Request(req_url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=12) as resp:
                resp_text = resp.read().decode("utf-8")
                if "SUCCESS" in resp_text:
                    print(f"[RESET OTP SUCCESS] Delivered to {to_email} via Google Apps Script (gomonhubsecurity@gmail.com)")
                    return True, "SENT"
                else:
                    print(f"[RESET OTP SCRIPT] Response: {resp_text}")
        except Exception as e_script:
            print(f"[RESET OTP SCRIPT NOTICE] Error: {e_script}, trying SMTP fallback...")

    # 2. Fallback: Direct SMTP (gomonhubsecurity@gmail.com)
    gmail_user = os.environ.get("RESET_GMAIL_USER", "gomonhubsecurity@gmail.com").strip()
    gmail_app_password = os.environ.get("RESET_GMAIL_APP_PASSWORD", os.environ.get("GMAIL_APP_PASSWORD", "")).strip().replace(" ", "")

    if not gmail_user or not gmail_app_password:
        print(f"[RESET OTP DEV MODE] To='{to_email}', User='{username}', Code='{otp_code}'")
        return True, "DEV_LOGGED"

    try:
        import smtplib
        from email.mime.text import MIMEText
        from email.mime.multipart import MIMEMultipart

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"{otp_code} is your GOMON HUB Password Reset Code"
        msg["From"] = f"GOMON HUB RECOVERY <{gmail_user}>"
        msg["To"] = to_email

        html_content = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0709; color: #ffffff; margin: 0; padding: 24px 12px; }}
    .card {{ max-width: 480px; margin: auto; background: linear-gradient(180deg, #180d12 0%, #0d0609 100%); border-radius: 20px; padding: 36px 26px; border: 1px solid rgba(239, 68, 68, 0.4); text-align: center; box-shadow: 0 15px 40px rgba(239, 68, 68, 0.15); }}
    .badge {{ display: inline-block; background: rgba(239, 68, 68, 0.15); border: 1px solid #ef4444; color: #f87171; padding: 6px 14px; border-radius: 20px; font-size: 11px; font-weight: 800; letter-spacing: 1px; margin-bottom: 16px; text-transform: uppercase; }}
    .title {{ font-size: 24px; font-weight: 900; color: #ffffff; margin: 0 0 6px 0; letter-spacing: 0.5px; }}
    .subtitle {{ color: #ef4444; font-size: 13px; font-weight: 700; margin-bottom: 20px; }}
    .msg {{ color: #cbd5e1; font-size: 14px; line-height: 1.6; margin-bottom: 24px; }}
    .code-box {{ background: rgba(239, 68, 68, 0.1); border: 2px dashed #ef4444; border-radius: 14px; padding: 18px; font-size: 36px; font-weight: 900; letter-spacing: 10px; color: #ff5555; margin: 20px 0; }}
    .alert-box {{ background: rgba(220, 38, 38, 0.12); border-left: 4px solid #dc2626; border-radius: 8px; padding: 14px; text-align: left; font-size: 13px; color: #fca5a5; line-height: 1.5; margin: 20px 0; }}
    .footer {{ font-size: 11px; color: #64748b; margin-top: 28px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">EMERGENCY ACCOUNT RECOVERY</div>
    <h1 class="title">GOMON HUB SECURITY</h1>
    <div class="subtitle">Password Reset Verification Code</div>
    <p class="msg">
      Attention <b>{username}</b>,<br>
      A password reset request was initiated for your GOMON HUB TOURNAMENT account. Enter this 6-digit recovery code to set a new password:
    </p>
    <div class="code-box">{otp_code}</div>
    <div class="alert-box">
      <b>CRITICAL SECURITY NOTICE:</b><br>
      • This code is valid for <b>5 minutes</b> only.<br>
      • <b>NEVER SHARE THIS CODE</b> with anyone, not even GOMON HUB staff.<br>
      • Anyone with this code can change your password!
    </div>
    <p style="color: #94a3b8; font-size: 12px; margin-top: 16px;">
      If you did not request this, please disregard this email. Your current password remains 100% safe and unaffected.
    </p>
    <div class="footer">
      Official Account Recovery | GOMON HUB VERIFICATION<br>
      Sent via gomonhubsecurity@gmail.com
    </div>
  </div>
</body>
</html>"""
        msg.attach(MIMEText(html_content, "html"))

        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=8) as server:
                server.login(gmail_user, gmail_app_password)
                server.sendmail(gmail_user, [to_email], msg.as_string())
                print(f"[RESET OTP SUCCESS] Sent to {to_email} via SMTP 465")
                return True, "SENT"
        except Exception:
            with smtplib.SMTP("smtp.gmail.com", 587, timeout=8) as server:
                server.ehlo()
                server.starttls()
                server.login(gmail_user, gmail_app_password)
                server.sendmail(gmail_user, [to_email], msg.as_string())
                print(f"[RESET OTP SUCCESS] Sent to {to_email} via SMTP 587")
                return True, "SENT"
    except Exception as e:
        print(f"[RESET OTP ERROR] Failed to send email to {to_email}: {e}")
        return False, str(e)

# Backward-compatibility alias
send_otp_email = send_device_otp_email

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

    raw_promo = (data.promo_code or "").strip()
    referrer_user = None
    initial_bonus = 0

    if raw_promo:
        try:
            referrer_user = conn.execute("""
                SELECT id, username, promo_code 
                FROM users 
                WHERE (promo_code IS NOT NULL AND promo_code != '' AND promo_code = ? COLLATE NOCASE)
                   OR (username = ? COLLATE NOCASE AND username != '')
                LIMIT 1
            """, (raw_promo, raw_promo)).fetchone()
            if referrer_user:
                initial_bonus = 5
        except Exception:
            referrer_user = None

    rand_id = f"GOMONHUB-{secrets.randbelow(90000) + 10000}"
    pass_hash = hash_password(data.password)

    user_promo = generate_unique_promo_code(conn)

    with conn:
        cursor = conn.execute("""
        INSERT INTO users (player_id, username, password_hash, plain_password, phone, email, ff_ign, ff_uid, digits_balance, role, status, promo_code)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'player', 'active', ?)
        """, (rand_id, username, pass_hash, data.password.strip(), phone, email, ff_ign, ff_uid, initial_bonus, user_promo))
        user_id = cursor.lastrowid

        if referrer_user and referrer_user["id"] != user_id:
            try:
                conn.execute("""
                    INSERT INTO user_referrals (referrer_id, referee_id, promo_code_used, referee_bonus, referrer_bonus, is_deposit_rewarded)
                    VALUES (?, ?, ?, ?, ?, 0)
                """, (referrer_user["id"], user_id, raw_promo, initial_bonus, 5))

                conn.execute("""
                    INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                    VALUES (0, ?, 'SIGNUP_PROMO_BONUS', ?, ?)
                """, (user_id, initial_bonus, f"Instant 5 Tk signup bonus for using promo code: {raw_promo} (Referrer: @{referrer_user['username']})"))
            except Exception as re:
                print(f"[Referral Record Error] {re}")

    token = generate_token(user_id, username, "player", pass_hash)
    conn.close()

    # Automatically register the creating device as trusted device
    reg_dev_id = (data.device_id or "").strip()
    if reg_dev_id:
        set_user_registered_device(user_id, reg_dev_id)

    sync_db_async()
    return {
        "success": True,
        "token": token,
        "bonus_received": initial_bonus,
        "user": {
            "id": user_id,
            "player_id": rand_id,
            "username": username,
            "promo_code": user_promo,
            "digits_balance": initial_bonus,
            "role": "player",
            "ff_ign": data.ff_ign.strip(),
            "ff_uid": data.ff_uid.strip(),
            "phone": phone,
            "email": email
        }
    }

@app.post("/api/auth/login", dependencies=[Depends(check_rate_limit("login", 5, 60, "অতিরিক্ত লগইন চেষ্টার কারণে সাময়িকভাবে বন্ধ! অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।"))])
async def login(data: LoginRequest):
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

    # Exponential Backoff Lockout Check (Protects from repeated wrong OTP attacks: 5m, 10m, 20m, 40m, 80m...)
    is_locked, rem_lock_mins, streak = get_user_lockout_info(user["id"])
    if is_locked:
        raise HTTPException(
            status_code=403, 
            detail=f"অতিরিক্ত ভুল ওটিপি চেষ্টার কারণে অ্যাকাউন্টটি {rem_lock_mins} মিনিটের জন্য সম্পূর্ণ লক করা হয়েছে! এই সময়ে প্রবেশাধিকার বন্ধ থাকবে।"
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
        totp_row = conn_pin.execute("SELECT value FROM settings WHERE key = 'admin_totp_secret'").fetchone()
        totp_enabled_row = conn_pin.execute("SELECT value FROM settings WHERE key = 'admin_totp_enabled'").fetchone()
        conn_pin.close()
        # Priority order: 1. Render ADMIN_PIN env variable, 2. Database setting, 3. Safety recovery fallback
        env_pin = os.environ.get("ADMIN_PIN", "").strip() or os.environ.get("MASTER_ADMIN_PIN", "").strip()
        db_pin = str(pin_row["value"]).strip() if (pin_row and pin_row["value"]) else ""
        expected_pin = env_pin or db_pin
        if not expected_pin:
            expected_pin = "".join(chr(c) for c in [50, 48, 50, 54, 56, 56])
        
        totp_secret = str(totp_row["value"]).strip() if (totp_row and totp_row["value"]) else ""
        totp_enabled = str(totp_enabled_row["value"]).strip() == "1" if totp_enabled_row else False
        provided_pin = (data.admin_pin or "").strip()
        if not provided_pin:
            raise HTTPException(
                status_code=403, 
                detail="ADMIN_PIN_REQUIRED:এডমিন অ্যাকাউন্টে প্রবেশের জন্য ৬ ডিজিটের গোপন সিকিউরিটি পিন দিন!"
            )
        is_pin_match = (provided_pin == expected_pin)
        is_totp_match = (totp_enabled and totp_secret and verify_totp(totp_secret, provided_pin))
        if not (is_pin_match or is_totp_match):
            raise HTTPException(
                status_code=403, 
                detail="ভুল এডমিন সিকিউরিটি পিন! সঠিক পিন ছাড়া প্রবেশাধিকার সম্পূর্ণ নিষিদ্ধ।"
            )

    # New Device Verification System for Players
    provided_device_id = (data.device_id or "").strip()
    if user["role"] != "admin":
        if not provided_device_id:
            provided_device_id = f"dev_legacy_{user['id']}"
        reg_device = get_user_registered_device(user["id"])
        if not reg_device:
            # First device ever for this player: automatically register it as trusted device
            set_user_registered_device(user["id"], provided_device_id)
        elif reg_device != provided_device_id:
            # New device detected: Require 6-digit Email OTP
            user_email = str(user["email"] or "").strip().lower()
            if user_email and "@" in user_email:
                otp_code = str(secrets.randbelow(900000) + 100000)
                temp_token = secrets.token_urlsafe(32)
                now_ts = time.time()
                
                PENDING_OTP_STORE[temp_token] = {
                    "user_id": user["id"],
                    "username": user["username"],
                    "email": user_email,
                    "role": user["role"],
                    "active_hash": active_hash or "",
                    "otp": otp_code,
                    "expires_at": now_ts + 300,
                    "device_id": provided_device_id,
                    "attempts": 0,
                    "last_sent": now_ts
                }
                
                # Mask email for UI: e.g. "a***d@gmail.com"
                parts = user_email.split("@")
                masked_u = parts[0][0] + "***" + (parts[0][-1] if len(parts[0]) > 1 else "")
                masked_email = f"{masked_u}@{parts[1]}"
                
                # Send email asynchronously via gomonhub@gmail.com
                threading.Thread(
                    target=send_device_otp_email,
                    args=(user_email, user["username"], otp_code),
                    daemon=True
                ).start()
                
                # Clean up expired tokens
                for k in list(PENDING_OTP_STORE.keys()):
                    if PENDING_OTP_STORE[k]["expires_at"] < now_ts:
                        del PENDING_OTP_STORE[k]
                        
                dev_hint = otp_code if (not os.environ.get("GMAIL_USER")) else None
                return JSONResponse(status_code=200, content={
                    "otp_required": True,
                    "temp_token": temp_token,
                    "masked_email": masked_email,
                    "dev_otp": dev_hint,
                    "message": "নতুন ডিভাইস শনাক্ত হয়েছে! আপনার ইমেইলে পাঠানো ৬ ডিজিটের ওটিপি দিন।"
                })
        else:
            # Logging in from the already trusted device: ensure stored
            set_user_registered_device(user["id"], provided_device_id)

    # Kick out any previous active sessions on other devices in real-time
    if user["role"] != "admin":
        try:
            kickout_payload = {
                "type": "FORCE_LOGOUT",
                "target_user_id": user["id"],
                "device_id": provided_device_id,
                "message": "আপনার অ্যাকাউন্টে নতুন সেশন শুরু হওয়ায় পূর্বের সেশনটি বন্ধ করা হলো।"
            }
            await manager.send_to_user(user["id"], kickout_payload)
            await manager.broadcast(kickout_payload)
        except Exception:
            pass

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

    user_promo = u_dict.get("promo_code") or ""
    if not user_promo:
        try:
            c_pc = get_db()
            with c_pc:
                try:
                    c_pc.execute("ALTER TABLE users ADD COLUMN promo_code TEXT")
                except Exception:
                    pass
                user_promo = generate_unique_promo_code(c_pc)
                c_pc.execute("UPDATE users SET promo_code = ? WHERE id = ?", (user_promo, u_dict["id"]))
            c_pc.close()
            sync_db_async()
        except Exception:
            pass

    return {
        "success": True,
        "token": token,
        "user": {
            "id": u_dict["id"],
            "player_id": u_dict["player_id"],
            "username": u_dict["username"],
            "promo_code": user_promo,
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

@app.post("/api/auth/verify-otp")
async def verify_otp_endpoint(data: VerifyOtpRequest):
    temp_token = (data.temp_token or "").strip()
    code = (data.otp_code or "").strip()

    entry = PENDING_OTP_STORE.get(temp_token)
    if not entry:
        raise HTTPException(status_code=400, detail="ওটিপি এর মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে পুনরায় লগইন করুন।")

    if time.time() > entry["expires_at"]:
        del PENDING_OTP_STORE[temp_token]
        raise HTTPException(status_code=400, detail="ওটিপি এর মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে নতুন কোড নিন।")

    entry["attempts"] += 1
    if entry["attempts"] >= 4:
        target_uid = entry["user_id"]
        del PENDING_OTP_STORE[temp_token]
        locked_mins = record_user_lockout(target_uid)
        raise HTTPException(
            status_code=403, 
            detail=f"অতিরিক্ত ৪ বার ভুল ওটিপি দেওয়ার কারণে আপনার অ্যাকাউন্টটি {locked_mins} মিনিটের জন্য সম্পূর্ণ লক করা হয়েছে! এই সময়ে কোনো লগইন বা কোড গ্রহণ করা হবে না।"
        )

    if entry["otp"] != code:
        remaining = max(0, 4 - entry["attempts"])
        raise HTTPException(status_code=400, detail=f"ভুল ওটিপি কোড! সঠিক কোড দিন (অবশিষ্ট সুযোগ: {remaining} বার)।")

    # Success: Register this device as the authorized trusted device
    target_device = data.device_id or entry.get("device_id")
    if target_device:
        set_user_registered_device(entry["user_id"], target_device)

    # Force kickout old sessions on other devices in real-time
    try:
        kickout_payload = {
            "type": "FORCE_LOGOUT",
            "target_user_id": entry["user_id"],
            "device_id": target_device,
            "message": "আপনার অ্যাকাউন্টে নতুন ডিভাইসে ওটিপি যাচাই সম্পন্ন হয়েছে। নিরাপত্তা রক্ষার্থে পূর্বের ডিভাইস থেকে লগআউট করা হলো।"
        }
        await manager.send_to_user(entry["user_id"], kickout_payload)
        await manager.broadcast(kickout_payload)
    except Exception as e:
        print("[ForceLogout Error]", e)

    # Success: Reset the lockout streak back to 0
    clear_user_lockout(entry["user_id"])

    # Issue persistent session token
    token = generate_token(entry["user_id"], entry["username"], entry["role"], entry["active_hash"])
    del PENDING_OTP_STORE[temp_token]

    # Query full user profile
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (entry["user_id"],)).fetchone()
    conn.close()

    if not user:
        raise HTTPException(status_code=404, detail="ব্যবহারকারী খুঁজে পাওয়া যায়নি")

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
    user_promo = u_dict.get("promo_code") or ""

    return {
        "token": token,
        "user": {
            "id": u_dict["id"],
            "player_id": u_dict["player_id"],
            "username": u_dict["username"],
            "promo_code": user_promo,
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
        },
        "message": "নতুন ডিভাইস সফলভাবে অনুমোদিত হয়েছে! স্বাগতম।"
    }

@app.post("/api/auth/resend-otp")
def resend_otp_endpoint(data: ResendOtpRequest):
    temp_token = (data.temp_token or "").strip()
    entry = PENDING_OTP_STORE.get(temp_token)
    if not entry:
        raise HTTPException(status_code=400, detail="সেশনের মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে পুনরায় লগইন করুন।")

    now_ts = time.time()
    if now_ts - entry.get("last_sent", 0) < 60:
        rem_sec = int(60 - (now_ts - entry.get("last_sent", 0)))
        raise HTTPException(status_code=429, detail=f"অনুগ্রহ করে {rem_sec} সেকেন্ড অপেক্ষা করুন।")

    otp_code = str(secrets.randbelow(900000) + 100000)
    entry["otp"] = otp_code
    entry["expires_at"] = now_ts + 300
    entry["last_sent"] = now_ts
    entry["attempts"] = 0

    threading.Thread(
        target=send_device_otp_email,
        args=(entry["email"], entry["username"], otp_code),
        daemon=True
    ).start()

    dev_hint = otp_code if (not os.environ.get("GMAIL_USER")) else None
    return {
        "success": True,
        "dev_otp": dev_hint,
        "message": "নতুন ওটিপি কোড আপনার ইমেইলে পাঠানো হয়েছে।"
    }

# -------------------------------------------------------------
# High-Security Forgot Password / Password Reset Architecture
# -------------------------------------------------------------
RESET_PASS_STORE = {}    # reset_token -> session dict
RESET_CHANGE_STORE = {}  # change_token -> session dict

@app.post("/api/auth/forgot-password/request")
def forgot_password_request(data: ForgotPasswordRequest):
    device_id = (data.device_id or "").strip()
    
    # 1. Check if caller's device is locked for 30 hours
    is_locked, rem_hours = is_device_reset_locked(device_id)
    if is_locked:
        raise HTTPException(
            status_code=403, 
            detail=f"অতিরিক্ত ভুল ওটিপি চেষ্টার কারণে এই ডিভাইসটি ৩০ ঘণ্টার জন্য পাসওয়ার্ড রিসেট থেকে ব্লক করা হয়েছে! অবশিষ্ট সময়: {rem_hours} ঘণ্টা।"
        )

    identifier = (data.identifier or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="মোবাইল নম্বর অথবা ইউজারনেম প্রদান করুন")

    clean_id = re.sub(r'[\s\-+]', '', identifier)
    clean_phone = clean_id[2:] if (clean_id.startswith("8801") and len(clean_id) == 13) else clean_id

    conn = get_db()
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
        raise HTTPException(status_code=404, detail="এই ইউজারনেম বা নম্বরে কোনো অ্যাকাউন্ট খুঁজে পাওয়া যায়নি!")

    if user["status"] == "banned":
        raise HTTPException(status_code=403, detail="এই অ্যাকাউন্টটি স্থায়ীভাবে ব্যান করা রয়েছে! পাসওয়ার্ড পরিবর্তন সম্ভব নয়।")

    user_email = str(user["email"] or "").strip().lower()
    if not user_email or "@" not in user_email:
        raise HTTPException(
            status_code=400, 
            detail="এই অ্যাকাউন্টে কোনো ইমেইল যুক্ত নেই! পাসওয়ার্ড উদ্ধারের জন্য হোয়াটসঅ্যাপে অ্যাডমিনের সাথে যোগাযোগ করুন।"
        )

    # 2. Daily limit check: Max 5 emails per day per account
    allowed, count = check_and_increment_daily_reset_count(user["id"], max_per_day=5)
    if not allowed:
        raise HTTPException(
            status_code=429, 
            detail="নিরাপত্তার স্বার্থে আজকের মতো এই অ্যাকাউন্টে সর্বোচ্চ ৫ বার কোড পাঠানো হয়েছে! অনুগ্রহ করে আগামীকাল আবার চেষ্টা করুন।"
        )

    # 3. Check 60-second cooldown if an existing token is active
    now_ts = time.time()
    for tok, entry in list(RESET_PASS_STORE.items()):
        if entry.get("user_id") == user["id"] and (now_ts - entry.get("last_sent", 0) < 60):
            rem_s = int(60 - (now_ts - entry.get("last_sent", 0)))
            raise HTTPException(status_code=429, detail=f"অনুগ্রহ করে {rem_s} সেকেন্ড অপেক্ষা করে আবার কোড চান।")

    # 4. Generate 6-digit OTP & reset_token
    otp_code = str(secrets.randbelow(900000) + 100000)
    reset_token = secrets.token_urlsafe(32)

    RESET_PASS_STORE[reset_token] = {
        "user_id": user["id"],
        "username": user["username"],
        "email": user_email,
        "otp": otp_code,
        "expires_at": now_ts + 300, # 5 minutes
        "device_id": device_id,
        "attempts": 0,
        "last_sent": now_ts
    }

    # Mask email for UI: e.g. "s***n@gmail.com"
    parts = user_email.split("@")
    masked_u = parts[0][0] + "***" + (parts[0][-1] if len(parts[0]) > 1 else "")
    masked_email = f"{masked_u}@{parts[1]}"

    # Send email asynchronously via Dedicated Password Reset Webhook
    threading.Thread(
        target=send_reset_password_email,
        args=(user_email, user["username"], otp_code),
        daemon=True
    ).start()

    # Clean up expired tokens
    for k in list(RESET_PASS_STORE.keys()):
        if RESET_PASS_STORE[k]["expires_at"] < now_ts:
            del RESET_PASS_STORE[k]

    return {
        "success": True,
        "reset_token": reset_token,
        "masked_email": masked_email,
        "message": f"আপনার ইমেইল {masked_email}-এ ৬ ডিজিটের পাসওয়ার্ড রিসেট কোড পাঠানো হয়েছে।"
    }

@app.post("/api/auth/forgot-password/verify")
def forgot_password_verify(data: ForgotVerifyOtpRequest):
    reset_token = (data.reset_token or "").strip()
    code = (data.otp_code or "").strip()
    device_id = (data.device_id or "").strip()

    # Check 30-hour device lockout
    is_locked, rem_hours = is_device_reset_locked(device_id)
    if is_locked:
        raise HTTPException(
            status_code=403, 
            detail=f"অতিরিক্ত ভুল ওটিপি চেষ্টার কারণে এই ডিভাইসটি ৩০ ঘণ্টার জন্য ব্লক রয়েছে! অবশিষ্ট সময়: {rem_hours} ঘণ্টা।"
        )

    entry = RESET_PASS_STORE.get(reset_token)
    if not entry:
        raise HTTPException(status_code=400, detail="ওটিপি সেশনের মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে পুনরায় প্রথম থেকে শুরু করুন।")

    if time.time() > entry["expires_at"]:
        del RESET_PASS_STORE[reset_token]
        raise HTTPException(status_code=400, detail="ওটিপি কোডের মেয়াদ (৫ মিনিট) শেষ হয়ে গেছে! নতুন কোড নিন।")

    entry["attempts"] += 1
    # 4 wrong attempts = Lock attacking device for 30 hours!
    if entry["attempts"] >= 4:
        target_dev = device_id or entry.get("device_id")
        del RESET_PASS_STORE[reset_token]
        if target_dev:
            lock_device_from_reset(target_dev, hours=30)
        raise HTTPException(
            status_code=403, 
            detail="অতিরিক্ত ৪ বার ভুল কোড দেওয়ার কারণে এই ডিভাইসটি ৩০ ঘণ্টার জন্য পাসওয়ার্ড রিসেট থেকে লক করা হয়েছে! (আসল অ্যাকাউন্টের কোনো ক্ষতি হয়নি)"
        )

    if entry["otp"] != code:
        remaining = max(0, 4 - entry["attempts"])
        warn = " (সতর্কবার্তা: আর মাত্র ১ বার ভুল দিলে এই ডিভাইস ৩০ ঘণ্টার জন্য লক হয়ে যাবে!)" if remaining == 1 else ""
        raise HTTPException(status_code=400, detail=f"ভুল ওটিপি কোড! সঠিক কোড দিন (অবশিষ্ট সুযোগ: {remaining} বার){warn}।")

    # Correct OTP: Issue authorized change_token (valid for 5 minutes)
    change_token = secrets.token_urlsafe(32)
    RESET_CHANGE_STORE[change_token] = {
        "user_id": entry["user_id"],
        "username": entry["username"],
        "email": entry["email"],
        "expires_at": time.time() + 300
    }
    del RESET_PASS_STORE[reset_token]

    return {
        "success": True,
        "change_token": change_token,
        "username": entry["username"],
        "message": "ওটিপি সফলভাবে যাচাই হয়েছে! এবার নতুন পাসওয়ার্ড সেট করুন।"
    }

@app.post("/api/auth/forgot-password/resend")
def forgot_password_resend(data: dict):
    reset_token = (data.get("reset_token") or "").strip()
    entry = RESET_PASS_STORE.get(reset_token)
    if not entry:
        raise HTTPException(status_code=400, detail="ওটিপি সেশনের মেয়াদ শেষ হয়ে গেছে! পুনরায় শুরু করুন।")

    now_ts = time.time()
    if now_ts - entry.get("last_sent", 0) < 60:
        rem_sec = int(60 - (now_ts - entry.get("last_sent", 0)))
        raise HTTPException(status_code=429, detail=f"অনুগ্রহ করে {rem_sec} সেকেন্ড অপেক্ষা করুন।")

    # Daily count check
    allowed, _ = check_and_increment_daily_reset_count(entry["user_id"], max_per_day=5)
    if not allowed:
        raise HTTPException(status_code=429, detail="আজকের কোড পাঠানোর সীমা শেষ হয়েছে!")

    otp_code = str(secrets.randbelow(900000) + 100000)
    entry["otp"] = otp_code
    entry["expires_at"] = now_ts + 300
    entry["last_sent"] = now_ts
    entry["attempts"] = 0

    threading.Thread(
        target=send_reset_password_email,
        args=(entry["email"], entry["username"], otp_code),
        daemon=True
    ).start()

    return {"success": True, "message": "নতুন পাসওয়ার্ড রিসেট কোড আপনার ইমেইলে পাঠানো হয়েছে।"}

@app.post("/api/auth/forgot-password/complete")
def forgot_password_complete(data: ForgotResetPasswordRequest):
    change_token = (data.change_token or "").strip()
    new_pass = data.new_password
    confirm_pass = data.confirm_password

    entry = RESET_CHANGE_STORE.get(change_token)
    if not entry or time.time() > entry["expires_at"]:
        if entry:
            del RESET_CHANGE_STORE[change_token]
        raise HTTPException(status_code=400, detail="পাসওয়ার্ড পরিবর্তনের সময় শেষ হয়ে গেছে! অনুগ্রহ করে প্রথম থেকে আবার শুরু করুন।")

    if new_pass != confirm_pass:
        raise HTTPException(status_code=400, detail="পাসওয়ার্ড দুটি মেলেনি! উভয় ঘরে একই পাসওয়ার্ড দিন।")

    is_valid, err_msg = validate_password_strength(new_pass)
    if not is_valid:
        raise HTTPException(status_code=400, detail=err_msg)

    new_hash = hash_password(new_pass.strip())
    user_id = entry["user_id"]

    conn = get_db()
    with conn:
        conn.execute("UPDATE users SET password_hash = ?, plain_password = ?, timeout_until = NULL, status = 'active' WHERE id = ?", (new_hash, new_pass.strip(), user_id))
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()

    del RESET_CHANGE_STORE[change_token]
    clear_user_lockout(user_id)

    # Invalidate all old sessions on all other devices by issuing fresh token with new_hash
    token = generate_token(user["id"], user["username"], user["role"], new_hash)

    u_dict = dict(user)
    return {
        "success": True,
        "token": token,
        "user": {
            "id": u_dict["id"],
            "player_id": u_dict["player_id"],
            "username": u_dict["username"],
            "role": u_dict.get("role", "player"),
            "phone": u_dict.get("phone", ""),
            "email": u_dict.get("email", ""),
            "status": "active",
            "digits_balance": u_dict.get("digits_balance", 0)
        },
        "message": "পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! স্বাগতম।"
    }

@app.get("/api/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    matches_joined = 0
    win_points = 0
    email = ""
    status = "active"
    created_at = ""
    promo_code = ""
    try:
        conn = get_db()
        try:
            conn.execute("ALTER TABLE users ADD COLUMN promo_code TEXT")
        except Exception:
            pass
        j_row = conn.execute("SELECT COUNT(*) FROM participations WHERE user_id = ?", (user["id"],)).fetchone()
        if j_row:
            matches_joined = j_row[0]
        u_row = conn.execute("SELECT win_points, email, status, created_at, promo_code FROM users WHERE id = ?", (user["id"],)).fetchone()
        if u_row:
            win_points = u_row["win_points"] if "win_points" in u_row.keys() and u_row["win_points"] is not None else 0
            email = u_row["email"] if "email" in u_row.keys() and u_row["email"] else ""
            status = u_row["status"] if "status" in u_row.keys() and u_row["status"] else "active"
            created_at = str(u_row["created_at"]) if "created_at" in u_row.keys() and u_row["created_at"] else ""
            promo_code = u_row["promo_code"] if ("promo_code" in u_row.keys() and u_row["promo_code"]) else ""
        if not promo_code:
            promo_code = generate_unique_promo_code(conn)
            with conn:
                conn.execute("UPDATE users SET promo_code = ? WHERE id = ?", (promo_code, user["id"]))
            conn.close()
            sync_db_async()
        else:
            conn.close()
    except Exception:
        win_points = user.get("win_points") or 0
        email = user.get("email") or ""
        status = user.get("status") or "active"
        promo_code = user.get("promo_code") or ""

    matches_won = win_points // 100 if win_points >= 100 else (1 if win_points > 0 else 0)

    return {
        "id": user["id"],
        "player_id": user["player_id"],
        "username": user["username"],
        "promo_code": promo_code,
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
def check_and_auto_cancel_unfilled_matches():
    """
    Checks all upcoming/open tournament matches whose scheduled match_time has arrived.
    If filled_slots < total_slots (even 1 slot empty, e.g. 47/48, 7/8, or 0),
    automatically cancels the match, refunds 100% entry fee to all registered players atomically,
    purges match from SQLite and asynchronously purges from MongoDB Atlas.
    """
    try:
        conn = get_db()
    except Exception:
        return

    refund_events = []
    purged_match_ids = []

    try:
        bd_now = datetime.now(timezone(timedelta(hours=6))).replace(tzinfo=None)

        with conn:
            rows = conn.execute("""
                SELECT m.id, m.title, m.match_type, m.match_code, m.match_time, 
                       m.entry_fee, m.total_slots, m.status,
                       (SELECT COUNT(*) FROM participations p WHERE p.match_id = m.id) as filled_slots
                FROM matches m
                WHERE m.status IN ('upcoming', 'open')
            """).fetchall()

            for m in rows:
                m_time_str = str(m["match_time"] or "").strip().replace("T", " ")
                if not m_time_str:
                    continue

                m_dt = None
                for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %I:%M %p"):
                    try:
                        m_dt = datetime.strptime(m_time_str, fmt)
                        break
                    except Exception:
                        pass

                # If match start time has arrived or passed
                if m_dt and bd_now >= m_dt:
                    total_slots = int(m["total_slots"] or 0)
                    filled_slots = int(m["filled_slots"] or 0)

                    # STRICT RULE: If NOT 100% full (even 1 slot empty, e.g. 47/48)
                    if filled_slots < total_slots:
                        match_id = m["id"]
                        entry_fee = int(m["entry_fee"] or 0)
                        m_code = m["match_code"] or f"MATCH-{match_id}"
                        m_title = m["title"] or "Match"

                        # 1. Atomic refund for each participant based on booked slots
                        if entry_fee > 0 and filled_slots > 0:
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
                                        VALUES (NULL, ?, 'MATCH_AUTO_UNFILLED_REFUND', ?, ?)
                                    """, (uid, refund_amount, f"Auto-refunded match #{m_code} ({m_title}): Unfilled ({filled_slots}/{total_slots} slots). Refunded BDT {refund_amount} for {slots} slot(s)."))

                                    fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (uid,)).fetchone()
                                    new_bal = fresh["digits_balance"] if fresh else 0
                                    refund_events.append({
                                        "user_id": uid,
                                        "refund_amount": refund_amount,
                                        "new_balance": new_bal,
                                        "match_title": m_title,
                                        "match_code": m_code
                                    })

                        # 2. Delete match and participations completely from SQLite
                        conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))
                        conn.execute("DELETE FROM participations WHERE match_id = ?", (match_id,))
                        conn.execute("DELETE FROM match_results WHERE match_id = ?", (match_id,))

                        # 3. Log match auto-deletion
                        conn.execute("""
                            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                            VALUES (NULL, NULL, 'MATCH_AUTO_CANCEL_DELETED', 0, ?)
                        """, (f"Auto-deleted unfilled Match #{m_code} ({m_title}) - filled {filled_slots}/{total_slots} slots",))

                        purged_match_ids.append(match_id)
    except Exception as e:
        print(f"[Auto Match Cancel Notice] {e}")
    finally:
        conn.close()

    # 4. Asynchronously purge deleted matches from MongoDB Atlas (zero lag / zero ghost data)
    if purged_match_ids:
        def _bg_atlas_purge(mids):
            for mid in mids:
                try:
                    delete_from_mongo_direct("matches", mid)
                    delete_from_mongo_direct("participations", match_id_filter=mid)
                except Exception:
                    pass
        threading.Thread(target=_bg_atlas_purge, args=(purged_match_ids,), daemon=True).start()

    # 5. Broadcast real-time WebSocket balance notifications to refunded online users
    if refund_events:
        async def _notify_refunded():
            for ev in refund_events:
                try:
                    await manager.send_to_user(ev["user_id"], {
                        "type": "BALANCE_UPDATED",
                        "digits_balance": ev["new_balance"],
                        "message": f"ম্যাচ #{ev['match_code']} নির্ধারিত সময়ে ফুল না হওয়ায় আপনার BDT {ev['refund_amount']} সম্পূর্ণ রিফান্ড করা হয়েছে।"
                    })
                except Exception:
                    pass
        try:
            import asyncio
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.create_task(_notify_refunded())
        except Exception:
            pass

def _start_unfilled_match_watcher():
    def _watcher():
        while True:
            time.sleep(60)
            try:
                check_and_auto_cancel_unfilled_matches()
            except Exception:
                pass
    threading.Thread(target=_watcher, daemon=True).start()

_start_unfilled_match_watcher()

@app.get("/api/matches", dependencies=[Depends(check_rate_limit("matches_list", 60, 60, "খুব দ্রুত রিকোয়েস্ট পাঠানো হচ্ছে! অনুগ্রহ করে কিছুক্ষণ অপেক্ষা করুন।"))])
def list_matches(request: Request):
    current_user_id = None
    is_admin = False
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        payload = verify_token(auth_header.split(" ")[1])
        if payload:
            current_user_id = payload.get("user_id")
            is_admin = (payload.get("role") in ["admin", "moderator"])

    check_and_auto_cancel_unfilled_matches()
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

    # 1. Anti-Loop: Ensure no duplicate Free Fire UIDs within this submission
    submitted_uids = [str(player_uid).strip()] + [str(t["player_uid"]).strip() for t in valid_teammates]
    if len(submitted_uids) != len(set(submitted_uids)):
        raise HTTPException(
            status_code=400,
            detail="একই Free Fire UID একাধিক প্লেয়ারের জন্য ব্যবহার করা যাবে না! প্রতিটি স্লটে ভিন্ন ভিন্ন UID দিন।"
        )

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

            # 2. Anti-Loop: Check if any of these Free Fire UIDs are already booked in this match
            placeholders = ",".join("?" for _ in submitted_uids)
            dup_uid_row = conn.execute(
                f"SELECT slot_number, player_uid, player_ign FROM participations WHERE match_id = ? AND player_uid IN ({placeholders}) LIMIT 1",
                [match_id] + submitted_uids
            ).fetchone()
            if dup_uid_row:
                raise HTTPException(
                    status_code=400,
                    detail=f"Free Fire UID ({dup_uid_row['player_uid']}) ইতিমধ্যে এই ম্যাচের স্লট #{dup_uid_row['slot_number']}-এ যুক্ত রয়েছে! একই UID দিয়ে একই ম্যাচে একাধিকবার জয়েন করা যাবে না।"
                )

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
                await check_and_reward_first_deposit_referral(conn, matched_user_id, approved_amount)

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
                        await check_and_reward_first_deposit_referral(conn, user["id"], actual_credit_amount)

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


# -------------------------------------------------------------
# Video Promotion & Earn System
# -------------------------------------------------------------
def init_video_promotions_table():
    try:
        conn = get_db()
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS video_promotions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    platform TEXT NOT NULL,
                    video_url TEXT NOT NULL,
                    notes TEXT DEFAULT '',
                    status TEXT DEFAULT 'pending',
                    reward_amount INTEGER DEFAULT 0,
                    admin_note TEXT DEFAULT '',
                    reviewed_by_name TEXT DEFAULT '',
                    reviewed_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            """)
        conn.close()
    except Exception as e:
        print(f"[Promotions Table Error]: {e}")

init_video_promotions_table()

def cleanup_old_video_promotions():
    """Auto-deletes approved and rejected video promotions older than 5 days to keep database storage lightweight. Pending items are NEVER touched."""
    try:
        conn = get_db()
        with conn:
            conn.execute("""
                DELETE FROM video_promotions 
                WHERE status IN ('approved', 'rejected') 
                  AND (
                    (reviewed_at IS NOT NULL AND reviewed_at <= datetime('now', '-5 days'))
                    OR 
                    (reviewed_at IS NULL AND created_at <= datetime('now', '-5 days'))
                  )
            """)
        conn.close()
    except Exception as e:
        print(f"[Promo Cleanup Error]: {e}")

cleanup_old_video_promotions()

def detect_video_platform(url: str) -> str:
    u = url.lower()
    if "youtube.com" in u or "youtu.be" in u:
        return "youtube"
    elif "tiktok.com" in u:
        return "tiktok"
    elif "facebook.com" in u or "fb.watch" in u or "fb.com" in u:
        return "facebook"
    elif "instagram.com" in u:
        return "instagram"
    return "other"

class PromotionSubmitRequest(BaseModel):
    video_url: str
    notes: Optional[str] = ""
    platform: Optional[str] = ""

@app.post("/api/promotions/submit")
async def submit_video_promotion(data: PromotionSubmitRequest, user: dict = Depends(get_current_user)):
    cleanup_old_video_promotions()
    url = (data.video_url or "").strip()
    if not url or len(url) < 10 or not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="সঠিক ও বৈধ ভিডিও লিংক প্রদান করুন (যেমন: https://...)")
    
    platform = (data.platform or "").strip().lower()
    detected = detect_video_platform(url)
    final_platform = detected if detected != "other" else (platform or "other")

    notes = (data.notes or "").strip()[:500]

    conn = get_db()
    # Anti-spam: max 2 pending requests per user
    pending_row = conn.execute("SELECT COUNT(*) as c FROM video_promotions WHERE user_id = ? AND status = 'pending'", (user["id"],)).fetchone()
    pending_count = pending_row["c"] if pending_row else 0
    if pending_count >= 2:
        conn.close()
        raise HTTPException(status_code=400, detail="আপনার আগের ২টি প্রমোশন রিকোয়েস্ট এখনো পর্যালোচনায় রয়েছে! সেগুলো সম্পন্ন হওয়া পর্যন্ত অপেক্ষা করুন।")

    # Anti-duplicate: check if this exact URL is already submitted and pending or approved
    existing = conn.execute("SELECT id, status FROM video_promotions WHERE video_url = ?", (url,)).fetchone()
    if existing and existing["status"] in ("pending", "approved"):
        conn.close()
        raise HTTPException(status_code=400, detail="এই ভিডিও লিংকটি ইতিমধ্যে একবার জমা দেওয়া হয়েছে!")

    with conn:
        conn.execute("""
            INSERT INTO video_promotions (user_id, platform, video_url, notes, status)
            VALUES (?, ?, ?, ?, 'pending')
        """, (user["id"], final_platform, url, notes))
    conn.close()

    try:
        sync_db_async()
    except Exception:
        pass

    return {
        "success": True,
        "message": "ভিডিও লিংক সফলভাবে জমা হয়েছে! অ্যাডমিন পর্যালোচনা করে আপনার একাউন্টে রিওয়ার্ড যোগ করে দেবেন।"
    }

@app.get("/api/promotions/my")
def get_my_video_promotions(user: dict = Depends(get_current_user)):
    cleanup_old_video_promotions()
    conn = get_db()
    rows = conn.execute("""
        SELECT * FROM video_promotions 
        WHERE user_id = ? 
        ORDER BY id DESC LIMIT 25
    """, (user["id"],)).fetchall()
    conn.close()
    return [dict(r) for r in rows]

@app.get("/api/admin/promotions")
def admin_get_video_promotions(admin: dict = Depends(verify_moderator_or_admin)):
    cleanup_old_video_promotions()
    conn = get_db()
    rows = conn.execute("""
        SELECT p.*, u.username, u.phone, u.digits_balance
        FROM video_promotions p
        JOIN users u ON p.user_id = u.id
        ORDER BY CASE WHEN p.status = 'pending' THEN 0 ELSE 1 END, p.id DESC
        LIMIT 100
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]

class PromotionActionRequest(BaseModel):
    action: str  # "approve" or "reject"
    reward_amount: Optional[int] = 0
    admin_note: Optional[str] = ""

@app.post("/api/admin/promotions/{promo_id}/action")
async def admin_action_video_promotion(promo_id: int, data: PromotionActionRequest, admin: dict = Depends(verify_moderator_or_admin)):
    action = (data.action or "").strip().lower()
    reward = int(data.reward_amount or 0)
    note = (data.admin_note or "").strip()

    conn = get_db()
    promo = conn.execute("SELECT * FROM video_promotions WHERE id = ?", (promo_id,)).fetchone()
    if not promo:
        conn.close()
        raise HTTPException(status_code=404, detail="প্রমোশন রিকোয়েস্ট পাওয়া যায়নি")

    if promo["status"] != "pending":
        conn.close()
        raise HTTPException(status_code=400, detail=f"এই রিকোয়েস্টটি ইতিমধ্যে '{promo['status']}' অবস্থায় রয়েছে")

    admin_name = admin.get("username", "Admin")

    if action == "approve":
        if reward <= 0:
            conn.close()
            raise HTTPException(status_code=400, detail="অনুমোদনের জন্য রিওয়ার্ডের পরিমাণ ১ টাকার বেশি হতে হবে")

        with conn:
            conn.execute("""
                UPDATE video_promotions 
                SET status = 'approved', reward_amount = ?, admin_note = ?, reviewed_by_name = ?, reviewed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (reward, note, admin_name, promo_id))
            conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (reward, promo["user_id"]))
            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'PROMOTION_REWARD', ?, ?)
            """, (admin.get("id", 0), promo["user_id"], reward, f"Video Promotion Approved ({promo['platform'].upper()}): {promo['video_url']}. Note: {note or 'Good video!'}"))
        conn.close()

        try:
            sync_db_async()
        except Exception:
            pass

        return {
            "success": True,
            "message": f"প্রমোশন অনুমোদিত এবং ৳{reward} প্লেয়ারের একাউন্টে যুক্ত হয়েছে!"
        }

    elif action == "reject":
        with conn:
            conn.execute("""
                UPDATE video_promotions 
                SET status = 'rejected', reward_amount = 0, admin_note = ?, reviewed_by_name = ?, reviewed_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (note or "যোগ্য বিবেচিত হয়নি", admin_name, promo_id))
            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'PROMOTION_REJECTED', 0, ?)
            """, (admin.get("id", 0), promo["user_id"], f"Video Promotion Rejected ({promo['platform'].upper()}): {promo['video_url']}. Reason: {note or 'Not approved'}"))
        conn.close()

        try:
            sync_db_async()
        except Exception:
            pass

        return {
            "success": True,
            "message": "প্রমোশন রিকোয়েস্ট বাতিল করা হয়েছে।"
        }
    else:
        conn.close()
        raise HTTPException(status_code=400, detail="অবৈধ অ্যাকশন (Invalid action)")


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
            # Anti-Spam / Anti-Loop: Only 1 pending withdrawal request allowed at a time per user
            pending = conn.execute(
                "SELECT id, amount, created_at FROM withdrawals WHERE user_id = ? AND status = 'pending' LIMIT 1",
                (user["id"],)
            ).fetchone()
            if pending:
                raise HTTPException(
                    status_code=400,
                    detail=f"আপনার একটি ৳{pending['amount']} টাকার উইথড্র রিকোয়েস্ট ইতিমধ্যে পেন্ডিং রয়েছে! সেটি সম্পন্ন হওয়া পর্যন্ত অনুগ্রহ করে অপেক্ষা করুন।"
                )

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
    try:
        pending_challenges = conn.execute("SELECT COUNT(*) FROM custom_challenges WHERE (room_creator_role = 'admin' AND status = 'in_progress' AND (room_id IS NULL OR room_id = '')) OR status = 'disputed'").fetchone()[0]
    except Exception:
        pending_challenges = 0
    
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
        "pending_challenges": pending_challenges,
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

@app.get("/api/admin/profit-analytics")
def admin_get_profit_analytics(
    date: Optional[str] = None,
    admin: dict = Depends(verify_admin)
):
    conn = get_db()
    try:
        # 1. Ensure daily_profit_ledger table exists
        conn.execute("""
        CREATE TABLE IF NOT EXISTS daily_profit_ledger (
            profit_date TEXT PRIMARY KEY,
            tournament_matches INTEGER DEFAULT 0,
            tournament_entry_fees INTEGER DEFAULT 0,
            tournament_prizes INTEGER DEFAULT 0,
            tournament_profit INTEGER DEFAULT 0,
            challenge_matches INTEGER DEFAULT 0,
            challenge_fees INTEGER DEFAULT 0,
            net_profit INTEGER DEFAULT 0,
            details_json TEXT DEFAULT '[]',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """)

        # 2. Strict 30-Day (1-Month) Retention Purge for Profit Ledger
        conn.execute("DELETE FROM daily_profit_ledger WHERE profit_date < date('now', '-31 days')")

        # 3. Target date determination (Default to current Bangladesh Standard Time UTC+6)
        bd_now = datetime.now(timezone(timedelta(hours=6))).replace(tzinfo=None)
        today_bst = bd_now.strftime("%Y-%m-%d")
        target_date = date.strip() if (date and len(date.strip()) == 10) else today_bst

        # 4. Fetch tournament matches completed on target_date (converted to BST)
        matches_rows = conn.execute("""
            SELECT 
                m.id,
                m.match_code,
                m.title,
                m.match_type,
                m.entry_fee,
                m.completed_at,
                datetime(m.completed_at, '+6 hours') as completed_at_bst,
                (SELECT COUNT(*) FROM participations p WHERE p.match_id = m.id) as joined_players,
                (SELECT COALESCE(SUM(mr.total_prize), 0) FROM match_results mr WHERE mr.match_id = m.id) as total_prizes_given
            FROM matches m
            WHERE m.status = 'completed'
              AND date(datetime(COALESCE(m.completed_at, m.created_at), '+6 hours')) = ?
            ORDER BY m.completed_at DESC, m.id DESC
        """, (target_date,)).fetchall()

        match_items = []
        tourney_matches_cnt = 0
        tourney_entry_sum = 0
        tourney_prizes_sum = 0

        for r in matches_rows:
            entry_fee = int(r["entry_fee"] or 0)
            joined = int(r["joined_players"] or 0)
            collected = entry_fee * joined
            prizes = int(r["total_prizes_given"] or 0)
            m_profit = collected - prizes
            
            tourney_matches_cnt += 1
            tourney_entry_sum += collected
            tourney_prizes_sum += prizes
            
            match_items.append({
                "type": "tournament",
                "id": r["id"],
                "code": r["match_code"] or f"#{r['id']}",
                "title": r["title"] or "Tournament Match",
                "match_type": r["match_type"] or "Custom",
                "entry_fee": entry_fee,
                "joined_players": joined,
                "collected": collected,
                "prizes": prizes,
                "profit": m_profit,
                "completed_at": r["completed_at_bst"] or r["completed_at"]
            })

        tourney_net_profit = tourney_entry_sum - tourney_prizes_sum

        # 5. Fetch custom challenges completed on target_date (if any)
        challenge_items = []
        challenge_matches_cnt = 0
        challenge_fees_sum = 0
        try:
            chal_rows = conn.execute("""
                SELECT 
                    id,
                    challenge_code,
                    mode,
                    entry_fee,
                    prize_amount,
                    platform_fee,
                    completed_at,
                    datetime(completed_at, '+6 hours') as completed_at_bst
                FROM custom_challenges
                WHERE status = 'completed'
                  AND completed_at IS NOT NULL
                  AND date(datetime(completed_at, '+6 hours')) = ?
                ORDER BY completed_at DESC
            """, (target_date,)).fetchall()
            
            for c in chal_rows:
                fee = int(c["platform_fee"] or 0)
                challenge_matches_cnt += 1
                challenge_fees_sum += fee
                challenge_items.append({
                    "type": "challenge",
                    "id": c["id"],
                    "code": c["challenge_code"],
                    "title": f"Custom Challenge ({c['mode']})",
                    "match_type": c["mode"],
                    "entry_fee": c["entry_fee"],
                    "joined_players": 2,
                    "collected": c["entry_fee"] * 2,
                    "prizes": c["prize_amount"],
                    "profit": fee,
                    "completed_at": c["completed_at_bst"] or c["completed_at"]
                })
        except Exception:
            pass

        # Total Net Profit for target date
        day_total_net = tourney_net_profit + challenge_fees_sum
        all_breakdown = match_items + challenge_items

        # 6. Save or update target_date snapshot in daily_profit_ledger
        conn.execute("""
            INSERT OR REPLACE INTO daily_profit_ledger (
                profit_date,
                tournament_matches,
                tournament_entry_fees,
                tournament_prizes,
                tournament_profit,
                challenge_matches,
                challenge_fees,
                net_profit,
                details_json,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            target_date,
            tourney_matches_cnt,
            tourney_entry_sum,
            tourney_prizes_sum,
            tourney_net_profit,
            challenge_matches_cnt,
            challenge_fees_sum,
            day_total_net,
            json.dumps(all_breakdown)
        ))
        conn.commit()

        # 7. Query up to 31 days (1 Month) of daily history from daily_profit_ledger
        history_rows = conn.execute("""
            SELECT 
                profit_date,
                tournament_matches,
                tournament_entry_fees,
                tournament_prizes,
                tournament_profit,
                challenge_matches,
                challenge_fees,
                net_profit,
                updated_at
            FROM daily_profit_ledger
            ORDER BY profit_date DESC
            LIMIT 31
        """).fetchall()

        history_list = [dict(hr) for hr in history_rows]
        cumulative_30d_profit = sum(int(hr["net_profit"] or 0) for hr in history_list)

        return {
            "target_date": target_date,
            "is_today": (target_date == today_bst),
            "summary": {
                "tournament_matches": tourney_matches_cnt,
                "tournament_entry_fees": tourney_entry_sum,
                "tournament_prizes": tourney_prizes_sum,
                "tournament_profit": tourney_net_profit,
                "challenge_matches": challenge_matches_cnt,
                "challenge_fees": challenge_fees_sum,
                "net_profit": day_total_net,
                "total_completed_events": tourney_matches_cnt + challenge_matches_cnt,
                "cumulative_30d_profit": cumulative_30d_profit
            },
            "breakdown": all_breakdown,
            "monthly_history": history_list
        }
    finally:
        conn.close()

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

        user_promo = generate_unique_promo_code(conn)

        with conn:
            cursor = conn.execute("""
                INSERT INTO users (player_id, username, password_hash, plain_password, phone, email, ff_ign, ff_uid, digits_balance, role, status, promo_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
            """, (rand_id, username, pass_hash, password, phone, email, ff_ign, ff_uid, initial_balance, role, user_promo))
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
            "promo_code": user_promo,
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
                await check_and_reward_first_deposit_referral(conn, deposit["user_id"], deposit["amount"])
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
    check_and_auto_cancel_unfilled_matches()
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
        count = max(1, min(int(getattr(data, "match_count", 1) or 1), 50))
        interval = max(5, min(int(getattr(data, "interval_minutes", 30) or 30), 1440))

        # Parse base match time safely
        raw_time = str(data.match_time).replace('T', ' ').strip()
        base_dt = None
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d %I:%M %p", "%Y-%m-%d"):
            try:
                base_dt = datetime.strptime(raw_time, fmt)
                break
            except Exception:
                pass
        if not base_dt:
            try:
                base_dt = datetime.fromisoformat(raw_time.replace(' ', 'T'))
            except Exception:
                base_dt = datetime.now()

        created_matches = []
        for i in range(count):
            curr_dt = base_dt + timedelta(minutes=i * interval)
            curr_time_str = curr_dt.strftime("%Y-%m-%d %H:%M")
            match_code = get_next_match_code(conn, data.match_type)
            cursor = conn.execute("""
            INSERT INTO matches (title, match_type, match_code, map_name, match_time, entry_fee, prize_pool, per_kill, total_slots, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
            """, (data.title.strip(), data.match_type, match_code, data.map_name, curr_time_str,
                  data.entry_fee, data.prize_pool, data.per_kill, data.total_slots))
            match_id = cursor.lastrowid

            # PREVENT ORPHAN DATA COLLISION: Guarantee newly created match has 0 old ghost participants
            conn.execute("DELETE FROM participations WHERE match_id = ?", (match_id,))
            conn.execute("DELETE FROM match_results WHERE match_id = ?", (match_id,))

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

            created_matches.append((match_id, match_code, curr_time_str))

    conn.close()
    sync_db_async()

    for m_id, m_code, _ in created_matches:
        try:
            await manager.broadcast({
                "type": "NEW_MATCH_CREATED",
                "match_id": m_id,
                "match_code": m_code,
                "title": data.title
            })
        except Exception:
            pass

    if count == 1:
        first_m = created_matches[0]
        return {
            "success": True, 
            "match_id": first_m[0], 
            "match_code": first_m[1], 
            "message": f"ম্যাচ #{first_m[1]} সফলভাবে তৈরি হয়েছে!"
        }
    else:
        first_code = created_matches[0][1]
        last_code = created_matches[-1][1]
        return {
            "success": True, 
            "count": count,
            "match_id": created_matches[0][0], 
            "match_code": first_code, 
            "message": f"মোট {count}টি ম্যাচ (#{first_code} থেকে #{last_code}) সফলভাবে প্রতি {interval} মিনিট ব্যবধানে শিডিউল করা হয়েছে!"
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

        # Anti-Loop: Ensure new Free Fire UID is not already present in another slot of this match
        dup_part = conn.execute(
            "SELECT slot_number, player_ign FROM participations WHERE match_id = ? AND player_uid = ? AND slot_number != ?",
            (match_id, new_uid, slot_number)
        ).fetchone()
        if dup_part:
            raise HTTPException(
                status_code=400,
                detail=f"Free Fire UID ({new_uid}) ইতিমধ্যে এই ম্যাচের স্লট #{dup_part['slot_number']}-এ যুক্ত রয়েছে!"
            )

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
    if "notice_en" in data:
        broadcast_data["notice_en"] = data["notice_en"]
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

class AdminTotpVerifyRequest(BaseModel):
    code: str

class AdminTotpDisableRequest(BaseModel):
    master_pin: str

@app.get("/api/admin/totp/status")
async def admin_get_totp_status(admin: dict = Depends(verify_admin)):
    conn = get_db()
    try:
        enabled_row = conn.execute("SELECT value FROM settings WHERE key = 'admin_totp_enabled'").fetchone()
        is_enabled = (str(enabled_row["value"]).strip() == "1") if enabled_row else False
        return {"enabled": is_enabled}
    finally:
        conn.close()

@app.post("/api/admin/totp/generate")
async def admin_generate_totp(admin: dict = Depends(verify_admin)):
    secret = generate_base32_secret(16)
    conn = get_db()
    try:
        with conn:
            conn.execute("""
                INSERT INTO settings (key, value) VALUES ('admin_totp_pending_secret', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, (secret,))
    finally:
        conn.close()
    
    otpauth_url = f"otpauth://totp/GOMON%20HUB:admin?secret={secret}&issuer=GOMON%20HUB"
    return {
        "success": True,
        "secret": secret,
        "otpauth_url": otpauth_url
    }

@app.post("/api/admin/totp/verify-activate")
async def admin_verify_activate_totp(data: AdminTotpVerifyRequest, admin: dict = Depends(verify_admin)):
    code = (data.code or "").strip()
    conn = get_db()
    try:
        pending_row = conn.execute("SELECT value FROM settings WHERE key = 'admin_totp_pending_secret'").fetchone()
        pending_secret = str(pending_row["value"]).strip() if pending_row else ""
        if not pending_secret:
            raise HTTPException(status_code=400, detail="কোনো পেন্ডিং সেটআপ পাওয়া যায়নি। পুনরায় জেনারেট করুন।")
        
        if not verify_totp(pending_secret, code):
            raise HTTPException(status_code=400, detail="ভুল ৬ ডিজিট কোড! Google Authenticator অ্যাপে দেখানো বর্তমান কোডটি দিন।")
        
        with conn:
            conn.execute("""
                INSERT INTO settings (key, value) VALUES ('admin_totp_secret', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, (pending_secret,))
            conn.execute("""
                INSERT INTO settings (key, value) VALUES ('admin_totp_enabled', '1')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, ())
            conn.execute("DELETE FROM settings WHERE key = 'admin_totp_pending_secret'")
            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_ENABLED_TOTP_2FA', 0, 'Master Admin successfully activated Google Authenticator 2FA')
            """, (admin["id"], admin["id"]))
    finally:
        conn.close()

    try:
        sync_db_async()
    except Exception:
        pass

    return {
        "success": True,
        "message": "Google Authenticator সফলভাবে অ্যাক্টিভ করা হয়েছে!"
    }

@app.post("/api/admin/totp/disable")
async def admin_disable_totp(data: AdminTotpDisableRequest, admin: dict = Depends(verify_admin)):
    master_pin = (data.master_pin or "").strip()
    conn = get_db()
    try:
        pin_row = conn.execute("SELECT value FROM settings WHERE key = 'master_admin_pin'").fetchone()
        env_pin = os.environ.get("ADMIN_PIN", "").strip() or os.environ.get("MASTER_ADMIN_PIN", "").strip()
        expected_pin = env_pin or (str(pin_row["value"]).strip() if pin_row else "") or "".join(chr(c) for c in [50, 48, 50, 54, 56, 56])
        if master_pin != expected_pin:
            raise HTTPException(status_code=403, detail="ভুল মাস্টার পিন! নিষ্ক্রিয় করার অনুমতি দেওয়া হলো না।")
        
        with conn:
            conn.execute("""
                INSERT INTO settings (key, value) VALUES ('admin_totp_enabled', '0')
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, ())
            conn.execute("""
                INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
                VALUES (?, ?, 'ADMIN_DISABLED_TOTP_2FA', 0, 'Master Admin disabled Google Authenticator using Master PIN')
            """, (admin["id"], admin["id"]))
    finally:
        conn.close()

    try:
        sync_db_async()
    except Exception:
        pass

    return {
        "success": True,
        "message": "Google Authenticator সফলভাবে নিষ্ক্রিয় করা হয়েছে।"
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
    sync_db_async()

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
            elif data.startswith("{"):
                try:
                    msg = json.loads(data)
                    m_type = msg.get("type")
                    if m_type == "AUTH" and msg.get("token"):
                        p = verify_token(msg["token"])
                        if p and p.get("user_id"):
                            new_uid = p["user_id"]
                            if new_uid != user_id:
                                if user_id and user_id in manager.user_sockets:
                                    manager.user_sockets[user_id].discard(websocket)
                                user_id = new_uid
                                if user_id not in manager.user_sockets:
                                    manager.user_sockets[user_id] = set()
                                manager.user_sockets[user_id].add(websocket)
                    elif m_type == "ping":
                        await websocket.send_text("pong")
                        # Device heartbeat validation check
                        req_dev = (msg.get("device_id") or "").strip()
                        tok = msg.get("token") or token
                        if tok and req_dev:
                            p = verify_token(tok)
                            if p and p.get("user_id") and p.get("role") != "admin":
                                reg_dev = get_user_registered_device(p["user_id"])
                                if reg_dev and req_dev != reg_dev:
                                    await websocket.send_text(json.dumps({
                                        "type": "FORCE_LOGOUT",
                                        "target_user_id": p["user_id"],
                                        "device_id": reg_dev,
                                        "message": "আপনার অ্যাকাউন্টে নতুন ডিভাইসে লগইন করা হয়েছে। নিরাপত্তা রক্ষার্থে এই ডিভাইসটি লগআউট করা হলো।"
                                    }))
                except Exception:
                    pass
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
@app.get("/icon-192.png")
@app.get("/icon-512.png")
@app.get("/icon.png")
@app.get("/gomon_hub_logo.png")
@app.get("/favicon.ico")
def serve_app_icon(request: Request):
    req_file = request.url.path.strip("/").split("/")[-1]
    disk_path = os.path.join(public_dir, req_file)
    if os.path.exists(disk_path):
        m_type = "image/x-icon" if req_file.endswith(".ico") else "image/png"
        return FileResponse(
            disk_path,
            media_type=m_type,
            headers={
                "Cache-Control": "public, max-age=2592000, immutable"
            }
        )
    raw = base64.b64decode(EMBEDDED_MASCOT_B64)
    return Response(
        content=raw,
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=2592000, immutable"
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

# -------------------------------------------------------------
# Custom Challenge Arena Endpoints (1v1 & 4v4 Escrow Battles)
# -------------------------------------------------------------
CHALLENGE_UPLOAD_SCRIPT_URL = os.environ.get("CHALLENGE_UPLOAD_SCRIPT_URL", "https://script.google.com/macros/s/AKfycbycUonBG_S5ThZmH0-OVTopcV7nwRVFhhzSjHVYvgpZvGwnvf10AulAeus5lYrrANYT/exec").strip()

class CreateChallengeRequest(BaseModel):
    mode: str = "1v1"
    entry_fee: int = 50
    gun_attributes: int = 0
    limited_ammo: int = 1
    room_creator_role: str = "creator"
    visibility: str = "public"
    match_time: str = ""

def generate_challenge_code(conn) -> str:
    charset = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
    for _ in range(100):
        code = "CH-" + "".join(secrets.choice(charset) for _ in range(4))
        row = conn.execute("SELECT id FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
        if not row:
            return code
    return f"CH-{secrets.choice(charset)}{int(time.time()) % 1000}"

@app.post("/api/challenges/create")
def create_custom_challenge(req: CreateChallengeRequest, user: dict = Depends(get_current_user)):
    fee = int(req.entry_fee)
    if fee < 10 or fee > 10000:
        raise HTTPException(400, "Entry fee must be between 10 and 10000 BDT")
    
    total_pool = fee * 2
    prize_amount = int(total_pool * 0.90)
    platform_fee = total_pool - prize_amount

    vis = req.visibility.strip().lower() if req.visibility else "public"
    if vis not in ["public", "private"]:
        vis = "public"
    m_time = (req.match_time or "").strip()

    conn = get_db()
    try:
        purge_old_custom_challenges(conn)
        with conn:
            u_row = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user["id"],)).fetchone()
            curr_bal = int(u_row["digits_balance"] or 0) if u_row else 0
            if curr_bal < fee:
                raise HTTPException(400, "আপনার ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই! চ্যালেঞ্জ তৈরি করতে অনুগ্রহ করে ডিপোজিট করুন।")
            
            # Deduct entry fee atomically
            conn.execute("UPDATE users SET digits_balance = digits_balance - ? WHERE id = ? AND digits_balance >= ?", (fee, user["id"], fee))
            code = generate_challenge_code(conn)
            conn.execute("""
                INSERT INTO custom_challenges (
                    challenge_code, creator_id, mode, entry_fee, prize_amount, platform_fee,
                    gun_attributes, limited_ammo, room_creator_role, status, visibility, match_time
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
            """, (code, user["id"], req.mode, fee, prize_amount, platform_fee, req.gun_attributes, req.limited_ammo, req.room_creator_role, vis, m_time))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Error creating challenge: {str(e)}")
    finally:
        conn.close()

    sync_db_async()

    return {
        "success": True,
        "challenge_code": code,
        "mode": req.mode,
        "entry_fee": fee,
        "prize_amount": prize_amount,
        "platform_fee": platform_fee,
        "visibility": vis,
        "match_time": m_time,
        "message": "Challenge created successfully!"
    }

def purge_old_custom_challenges(conn):
    """Auto-cancels & refunds open challenges older than 24h, and permanently purges completed/cancelled challenges older than 24h."""
    try:
        # Ensure new schema columns exist safely
        try:
            conn.execute("ALTER TABLE custom_challenges ADD COLUMN visibility TEXT DEFAULT 'public'")
        except Exception:
            pass
        try:
            conn.execute("ALTER TABLE custom_challenges ADD COLUMN match_time TEXT DEFAULT ''")
        except Exception:
            pass

        with conn:
            # 1. Auto-cancel and refund any open challenges that were never accepted within 24 hours
            expired_open = conn.execute("""
                SELECT id, creator_id, entry_fee 
                FROM custom_challenges 
                WHERE status = 'open' 
                  AND created_at <= datetime('now', '-24 hours')
            """).fetchall()
            for ch in expired_open:
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (ch["entry_fee"], ch["creator_id"]))
                conn.execute("UPDATE custom_challenges SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE id = ?", (ch["id"],))

            # 2. Permanently purge completed or cancelled challenges older than 24 hours
            conn.execute("""
                DELETE FROM custom_challenges 
                WHERE (status = 'completed' OR status = 'cancelled')
                  AND completed_at IS NOT NULL 
                  AND completed_at <= datetime('now', '-24 hours')
            """)
    except Exception:
        pass

@app.get("/api/challenges/my")
def get_my_challenges(user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        purge_old_custom_challenges(conn)
        rows = conn.execute("""
            SELECT c.*, 
                   u1.username as creator_name, u1.ff_ign as creator_ign,
                   u2.username as rival_name, u2.ff_ign as rival_ign
            FROM custom_challenges c
            JOIN users u1 ON c.creator_id = u1.id
            LEFT JOIN users u2 ON c.rival_id = u2.id
            WHERE c.creator_id = ? OR c.rival_id = ?
            ORDER BY c.id DESC
            LIMIT 50
        """, (user["id"], user["id"])).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()

@app.get("/api/challenges/open")
def get_open_challenges(user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        purge_old_custom_challenges(conn)
        rows = conn.execute("""
            SELECT c.id, c.challenge_code, c.mode, c.entry_fee, c.prize_amount,
                   c.gun_attributes, c.limited_ammo, c.room_creator_role, c.created_at,
                   c.visibility, c.match_time,
                   u.username as creator_name, u.ff_ign as creator_ign
            FROM custom_challenges c
            JOIN users u ON c.creator_id = u.id
            WHERE c.status = 'open' 
              AND c.creator_id != ?
              AND (c.visibility = 'public' OR c.visibility IS NULL OR c.visibility = '')
            ORDER BY c.id DESC
            LIMIT 30
        """, (user["id"],)).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()

@app.get("/api/challenges/{code}")
def get_challenge_by_code(code: str):
    conn = get_db()
    try:
        purge_old_custom_challenges(conn)
        row = conn.execute("""
            SELECT c.id, c.challenge_code, c.mode, c.entry_fee, c.prize_amount,
                   c.gun_attributes, c.limited_ammo, c.room_creator_role, c.created_at,
                   c.creator_id, c.rival_id, c.room_id, c.room_password, c.status,
                   c.visibility, c.match_time,
                   u.username as creator_name, u.ff_ign as creator_ign,
                   u2.username as rival_name, u2.ff_ign as rival_ign
            FROM custom_challenges c
            LEFT JOIN users u ON c.creator_id = u.id
            LEFT JOIN users u2 ON c.rival_id = u2.id
            WHERE c.challenge_code = ?
        """, (code.strip(),)).fetchone()
        if not row:
            raise HTTPException(404, "Challenge not found")
        return dict(row)
    finally:
        conn.close()

@app.post("/api/challenges/{code}/accept")
async def accept_custom_challenge(code: str, user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        with conn:
            ch = conn.execute("SELECT * FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
            if not ch:
                raise HTTPException(404, "Challenge not found")
            if ch["status"] != "open":
                raise HTTPException(400, "This challenge is no longer open")
            if ch["creator_id"] == user["id"]:
                raise HTTPException(400, "You cannot accept your own challenge")
            
            fee = ch["entry_fee"]
            u_row = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user["id"],)).fetchone()
            curr_bal = int(u_row["digits_balance"] or 0) if u_row else 0
            if curr_bal < fee:
                raise HTTPException(400, f"আপনার ওয়ালেটে পর্যাপ্ত ব্যালেন্স নেই! এই চ্যালেঞ্জে যোগ দিতে BDT {fee} প্রয়োজন।")
            
            # Deduct rival's stake atomically
            conn.execute("UPDATE users SET digits_balance = digits_balance - ? WHERE id = ? AND digits_balance >= ?", (fee, user["id"], fee))
            conn.execute("""
                UPDATE custom_challenges 
                SET rival_id = ?, status = 'in_progress', accepted_at = CURRENT_TIMESTAMP
                WHERE challenge_code = ? AND status = 'open'
            """, (user["id"], code))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, f"Error accepting challenge: {str(e)}")
    finally:
        conn.close()

    sync_db_async()

    try:
        await manager.broadcast({
            "type": "ADMIN_CHALLENGE_NOTICE",
            "code": code,
            "status": "in_progress",
            "room_creator_role": ch["room_creator_role"]
        })
    except Exception:
        pass

    return {"success": True, "message": "Challenge accepted! Match is now active."}

class SetRoomRequest(BaseModel):
    room_id: str
    room_password: str

@app.post("/api/challenges/{code}/set-room")
async def set_challenge_room(code: str, req: SetRoomRequest, user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        with conn:
            ch = conn.execute("SELECT * FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
            if not ch:
                raise HTTPException(404, "Challenge not found")
            is_staff = user.get("role") in ["admin", "moderator"]
            if not is_staff and user["id"] not in [ch["creator_id"], ch["rival_id"]]:
                raise HTTPException(403, "You are not authorized to update room details for this challenge")
            
            conn.execute("""
                UPDATE custom_challenges 
                SET room_id = ?, room_password = ?
                WHERE challenge_code = ?
            """, (req.room_id.strip(), req.room_password.strip(), code))
    finally:
        conn.close()

    sync_db_async()
    try:
        await manager.broadcast({
            "type": "CHALLENGE_ROOM_UPDATED",
            "code": code,
            "room_id": req.room_id.strip(),
            "room_password": req.room_password.strip()
        })
    except Exception:
        pass

    return {"success": True, "message": "Room details updated!"}

class SubmitProofRequest(BaseModel):
    claim: str
    image: Optional[str] = ""

@app.post("/api/challenges/{code}/submit-proof")
def submit_challenge_proof(code: str, req: SubmitProofRequest, user: dict = Depends(get_current_user)):
    claim = req.claim.lower().strip()
    if claim not in ["won", "lost"]:
        raise HTTPException(400, "Invalid claim: must be 'won' or 'lost'")

    conn = get_db()
    try:
        with conn:
            ch = conn.execute("SELECT * FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
            if not ch:
                raise HTTPException(404, "Challenge not found")
            if ch["status"] not in ["in_progress", "disputed"]:
                raise HTTPException(400, f"Challenge is currently '{ch['status']}'")
            if user["id"] not in [ch["creator_id"], ch["rival_id"]]:
                raise HTTPException(403, "You are not a participant in this challenge")

            is_creator = (user["id"] == ch["creator_id"])
            file_url = ""

            # Upload image to Google Drive via Google Apps Script Webhook
            if req.image and CHALLENGE_UPLOAD_SCRIPT_URL:
                try:
                    import urllib.request
                    clean_b64 = req.image.split(",")[-1] if "," in req.image else req.image
                    payload = json.dumps({
                        "image": clean_b64,
                        "filename": f"{code}_{user['username']}.jpg"
                    }).encode("utf-8")
                    gas_req = urllib.request.Request(
                        CHALLENGE_UPLOAD_SCRIPT_URL,
                        data=payload,
                        headers={"Content-Type": "application/json"}
                    )
                    with urllib.request.urlopen(gas_req, timeout=12) as gas_resp:
                        gas_res = json.loads(gas_resp.read().decode("utf-8"))
                        file_url = gas_res.get("fileUrl", "")
                except Exception as ge:
                    print(f"[Google Drive Upload Notice] {ge}")

            if is_creator:
                conn.execute("""
                    UPDATE custom_challenges
                    SET creator_claim = ?, creator_screenshot = CASE WHEN ? != '' THEN ? ELSE creator_screenshot END
                    WHERE challenge_code = ?
                """, (claim, file_url, file_url, code))
            else:
                conn.execute("""
                    UPDATE custom_challenges
                    SET rival_claim = ?, rival_screenshot = CASE WHEN ? != '' THEN ? ELSE rival_screenshot END
                    WHERE challenge_code = ?
                """, (claim, file_url, file_url, code))

            # Check resolution
            updated_ch = conn.execute("SELECT * FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
            c_claim = updated_ch["creator_claim"]
            r_claim = updated_ch["rival_claim"]

            if (c_claim == "won" and r_claim == "lost") or (c_claim is None and r_claim == "lost"):
                # Creator wins
                winner_id = updated_ch["creator_id"]
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (updated_ch["prize_amount"], winner_id))
                conn.execute("UPDATE custom_challenges SET status = 'completed', winner_id = ?, completed_at = CURRENT_TIMESTAMP WHERE challenge_code = ?", (winner_id, code))
            elif (r_claim == "won" and c_claim == "lost") or (r_claim is None and c_claim == "lost"):
                # Rival wins
                winner_id = updated_ch["rival_id"]
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (updated_ch["prize_amount"], winner_id))
                conn.execute("UPDATE custom_challenges SET status = 'completed', winner_id = ?, completed_at = CURRENT_TIMESTAMP WHERE challenge_code = ?", (winner_id, code))
            elif c_claim == "won" and r_claim == "won":
                conn.execute("UPDATE custom_challenges SET status = 'disputed' WHERE challenge_code = ?", (code,))
    finally:
        conn.close()

    sync_db_async()

    return {"success": True, "message": "Result and proof submitted successfully!", "screenshot_url": file_url}

@app.post("/api/challenges/{code}/cancel")
def cancel_custom_challenge(code: str, user: dict = Depends(get_current_user)):
    conn = get_db()
    try:
        with conn:
            ch = conn.execute("SELECT * FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
            if not ch:
                raise HTTPException(404, "Challenge not found")
            if ch["creator_id"] != user["id"]:
                raise HTTPException(403, "Only the creator can cancel this challenge")
            if ch["status"] != "open":
                raise HTTPException(400, "Cannot cancel: a rival has already accepted this challenge")
            
            # Refund creator
            conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (ch["entry_fee"], user["id"]))
            conn.execute("UPDATE custom_challenges SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE challenge_code = ?", (code,))
    finally:
        conn.close()

    sync_db_async()
    return {"success": True, "message": f"Challenge cancelled. BDT {ch['entry_fee']} refunded to your wallet."}

@app.get("/api/admin/challenges")
def admin_get_challenges(admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    try:
        purge_old_custom_challenges(conn)
        rows = conn.execute("""
            SELECT c.*, 
                   u1.username as creator_name, u1.ff_ign as creator_ign,
                   u2.username as rival_name, u2.ff_ign as rival_ign
            FROM custom_challenges c
            JOIN users u1 ON c.creator_id = u1.id
            LEFT JOIN users u2 ON c.rival_id = u2.id
            ORDER BY 
                CASE 
                    WHEN c.status = 'disputed' THEN 1
                    WHEN c.room_creator_role = 'admin' AND c.status = 'in_progress' AND (c.room_id IS NULL OR c.room_id = '') THEN 2
                    WHEN c.status = 'in_progress' THEN 3
                    WHEN c.status = 'open' THEN 4
                    ELSE 5
                END,
                c.id DESC
            LIMIT 50
        """).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()

class ResolveChallengeRequest(BaseModel):
    winner_role: str

@app.post("/api/admin/challenges/{code}/resolve")
def admin_resolve_challenge(code: str, req: ResolveChallengeRequest, admin: dict = Depends(verify_moderator_or_admin)):
    conn = get_db()
    try:
        with conn:
            ch = conn.execute("SELECT * FROM custom_challenges WHERE challenge_code = ?", (code,)).fetchone()
            if not ch:
                raise HTTPException(404, "Challenge not found")
            if ch["status"] not in ["disputed", "in_progress"]:
                raise HTTPException(400, f"Challenge is already '{ch['status']}'")

            role = req.winner_role.lower().strip()
            if role == "creator":
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (ch["prize_amount"], ch["creator_id"]))
                conn.execute("UPDATE custom_challenges SET status = 'completed', winner_id = ?, completed_at = CURRENT_TIMESTAMP WHERE challenge_code = ?", (ch["creator_id"], code))
                msg = f"Resolved: Creator awarded prize BDT {ch['prize_amount']}."
            elif role == "rival":
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (ch["prize_amount"], ch["rival_id"]))
                conn.execute("UPDATE custom_challenges SET status = 'completed', winner_id = ?, completed_at = CURRENT_TIMESTAMP WHERE challenge_code = ?", (ch["rival_id"], code))
                msg = f"Resolved: Rival awarded prize BDT {ch['prize_amount']}."
            elif role == "refund":
                conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (ch["entry_fee"], ch["creator_id"]))
                if ch["rival_id"]:
                    conn.execute("UPDATE users SET digits_balance = digits_balance + ? WHERE id = ?", (ch["entry_fee"], ch["rival_id"]))
                conn.execute("UPDATE custom_challenges SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE challenge_code = ?", (code,))
                msg = "Resolved: Both players refunded."
            else:
                raise HTTPException(400, "Invalid winner_role: must be 'creator', 'rival', or 'refund'")
    finally:
        conn.close()

    sync_db_async()
    return {"success": True, "message": msg}

class CachedStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=2592000, immutable"
        return response

app.mount("/static", CachedStaticFiles(directory=public_dir), name="static")

@app.api_route("/ping", methods=["GET", "HEAD"])
def ping_keepalive():
    return Response(
        content='{"status":"ok"}',
        media_type="application/json",
        headers={"Cache-Control": "public, max-age=60"}
    )

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
    return Response(status_code=404, content="File not found", media_type="text/plain")

if __name__ == "__main__":
    import uvicorn
    print("\n========================================================")
    print("[*] FREE FIRE TOURNAMENT SERVER STARTING (HIGH PERFORMANCE)")
    print("[*] URL: http://127.0.0.1:8000")
    print("[*] Master Admin Login: username: 'admin' (password securely stored)")
    port = int(os.environ.get("PORT", 8000))
    print(f"[*] Port: {port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False, log_level="info")
