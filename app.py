import os
import sys
import json
import time
import hmac
import hashlib
import secrets
import sqlite3
from typing import Optional, List
from datetime import datetime

# Configure UTF-8 for Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

from fastapi import FastAPI, HTTPException, Depends, Request, WebSocket, WebSocketDisconnect, status
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import pywebpush

# -------------------------------------------------------------
# Configuration & Security Secrets
# -------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "tournament.db")
VAPID_FILE = os.path.join(BASE_DIR, "vapid_keys.json")
SECRET_KEY_FILE = os.path.join(BASE_DIR, "secret.key")

if os.path.exists(SECRET_KEY_FILE):
    with open(SECRET_KEY_FILE, "r") as f:
        SECRET_KEY = f.read().strip()
else:
    SECRET_KEY = secrets.token_hex(32)
    with open(SECRET_KEY_FILE, "w") as f:
        f.write(SECRET_KEY)

# -------------------------------------------------------------
# VAPID Keys Setup for Free Web Push Notifications
# -------------------------------------------------------------
def get_or_create_vapid_keys():
    if os.path.exists(VAPID_FILE):
        try:
            with open(VAPID_FILE, "r") as f:
                return json.load(f)
        except Exception:
            pass
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
    with open(VAPID_FILE, "w") as f:
        json.dump(keys_data, f, indent=2)
    return keys_data

VAPID_KEYS = get_or_create_vapid_keys()

# -------------------------------------------------------------
# Database Layer (SQLite with WAL mode for ultra-fast queries)
# -------------------------------------------------------------
def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=20.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
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

def generate_token(user_id: int, username: str, role: str) -> str:
    payload = {
        "user_id": user_id,
        "username": username,
        "role": role,
        "exp": int(time.time()) + (30 * 86400) # 30 days
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
        expected_sig = hmac.new(SECRET_KEY.encode('utf-8'), payload_str.encode('utf-8'), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return None
        payload = json.loads(payload_str)
        if payload.get("exp", 0) < int(time.time()):
            return None
        return payload
    except Exception:
        return None

def init_db():
    conn = get_db()
    with conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id TEXT UNIQUE NOT NULL,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            phone TEXT NOT NULL,
            ff_ign TEXT NOT NULL,
            ff_uid TEXT NOT NULL,
            digits_balance INTEGER DEFAULT 0,
            role TEXT DEFAULT 'player',
            status TEXT DEFAULT 'active',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
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
            status TEXT DEFAULT 'upcoming',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS participations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            slot_number INTEGER,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(match_id, user_id)
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

        CREATE TABLE IF NOT EXISTS banned_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT COLLATE NOCASE,
            phone TEXT,
            email TEXT COLLATE NOCASE,
            ff_uid TEXT,
            reason TEXT,
            banned_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        """)

        # Migration: Ensure email column exists in users table
        try:
            conn.execute("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''")
        except Exception:
            pass

        # Default Settings
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('admin_bkash', '01700000000 (Personal)')")
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('notice', 'স্বাগতম! GOMON HUB টুর্নামেন্টে অংশ নিতে bKash এ ডিপোজিট করে সিডিউল থেকে জয়েন করুন!')")
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_title', 'GOMON HUB')")

        # Create Default Master Admin if not exists
        admin_row = conn.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1").fetchone()
        if not admin_row:
            admin_pass = hash_password("admin12345")
            conn.execute("""
            INSERT INTO users (player_id, username, password_hash, phone, ff_ign, ff_uid, digits_balance, role, status)
            VALUES ('FF-ADMIN', 'admin', ?, '01700000000', 'SUPER_ADMIN', '100000000', 999999, 'admin', 'active')
            """, (admin_pass,))
            print("[INFO] Master Admin created: username='admin', password='admin12345'")

    conn.close()

init_db()

# -------------------------------------------------------------
# FastAPI App & WebSocket Connection Manager
# -------------------------------------------------------------
app = FastAPI(title="Free Fire Tournament Platform API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_header(request: Request, call_next):
    response = await call_next(request)
    path = request.url.path
    if path == "/" or path.endswith(".html") or path.endswith(".js") or path.endswith(".css") or path.startswith("/api/"):
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
    conn.close()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    if user["status"] == "banned":
        raise HTTPException(status_code=403, detail="Your account has been suspended by Admin")
    return dict(user)

def verify_admin(user: dict = Depends(get_current_user)):
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Access denied: Master Admin privileges required")
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
    ff_uid: Optional[str] = ""

class LoginRequest(BaseModel):
    username: str
    password: str

class DepositRequest(BaseModel):
    bkash_number: str
    amount: int
    trx_id: str

class JoinMatchRequest(BaseModel):
    match_id: int

class AdminMatchCreate(BaseModel):
    title: str
    match_type: str = "Solo"
    map_name: str = "Bermuda"
    match_time: str
    entry_fee: int = 20
    prize_pool: int = 500
    per_kill: int = 10
    total_slots: int = 48

class AdminMatchUpdate(BaseModel):
    title: Optional[str] = None
    match_type: Optional[str] = None
    map_name: Optional[str] = None
    match_time: Optional[str] = None
    entry_fee: Optional[int] = None
    prize_pool: Optional[int] = None
    per_kill: Optional[int] = None
    total_slots: Optional[int] = None
    room_id: Optional[str] = None
    room_pass: Optional[str] = None
    status: Optional[str] = None

class AdminAdjustDigits(BaseModel):
    target_user_id: int
    amount: int
    reason: str

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
CURRENT_CODE_VERSION = "v2.5.0"

@app.get("/api/info")
def get_public_info():
    conn = get_db()
    settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    settings = {r["key"]: r["value"] for r in settings_rows}
    current_ver = settings.get("app_version")
    if not current_ver or current_ver in ["v1.0.0", "v1.1.0", "v2.1.0", "v2.2.0", "v2.3.0", "v2.4.0"]:
        current_ver = CURRENT_CODE_VERSION
    return {
        "site_title": settings.get("site_title", "GOMON HUB"),
        "admin_bkash": settings.get("admin_bkash", "01700000000"),
        "notice": settings.get("notice", ""),
        "app_version": current_ver,
        "app_update_notes": settings.get("app_update_notes", "GOMON HUB নতুন ইন্টারফেস ও সিকিউরিটি আপডেট।"),
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

@app.post("/api/auth/register")
def register(data: RegisterRequest):
    username = data.username.strip()
    phone = data.phone.strip()
    email = data.email.strip().lower()
    ff_ign = (data.ff_ign.strip() if data.ff_ign else "") or username
    ff_uid = (data.ff_uid.strip() if data.ff_uid else "") or "0"

    if len(username) < 3:
        raise HTTPException(status_code=400, detail="Username must be at least 3 characters")
    if len(data.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if not phone:
        raise HTTPException(status_code=400, detail="ফোন নম্বর আবশ্যক")
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="সঠিক ইমেইল অ্যাড্রেস প্রদান করুন")

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

    # 2. Check Password against banned records and banned accounts
    banned_hashes = conn.execute("""
    SELECT password_hash FROM banned_records WHERE password_hash != ''
    UNION
    SELECT password_hash FROM users WHERE status = 'banned'
    """).fetchall()

    for b_row in banned_hashes:
        if b_row["password_hash"] and verify_password(data.password, b_row["password_hash"]):
            conn.close()
            raise HTTPException(status_code=403, detail="🚨 এই পাসওয়ার্ডটি পূর্বে ব্যানকৃত অ্যাকাউন্টে ব্যবহৃত হয়েছিল! সুরক্ষা নিশ্চিত করতে অন্য একটি নতুন পাসওয়ার্ড দিন।")

    # 3. Check Existing Users in users table
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
        INSERT INTO users (player_id, username, password_hash, phone, email, ff_ign, ff_uid, digits_balance, role, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'player', 'active')
        """, (rand_id, username, pass_hash, phone, email, ff_ign, ff_uid))
        user_id = cursor.lastrowid

    token = generate_token(user_id, username, "player")
    conn.close()
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

@app.post("/api/auth/login")
def login(data: LoginRequest):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username = ?", (data.username.strip(),)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid username or password")
    if not verify_password(user["password_hash"], data.password):
        raise HTTPException(status_code=400, detail="Invalid username or password")
    if user["status"] == "banned":
        raise HTTPException(status_code=403, detail="Your account has been suspended by Admin")

    token = generate_token(user["id"], user["username"], user["role"])
    return {
        "success": True,
        "token": token,
        "user": {
            "id": user["id"],
            "player_id": user["player_id"],
            "username": user["username"],
            "digits_balance": user["digits_balance"],
            "role": user["role"],
            "ff_ign": user["ff_ign"],
            "ff_uid": user["ff_uid"],
            "phone": user["phone"]
        }
    }

@app.get("/api/auth/me")
def get_me(user: dict = Depends(get_current_user)):
    return {
        "id": user["id"],
        "player_id": user["player_id"],
        "username": user["username"],
        "digits_balance": user["digits_balance"],
        "role": user["role"],
        "ff_ign": user["ff_ign"],
        "ff_uid": user["ff_uid"],
        "phone": user["phone"]
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
            is_admin = (payload.get("role") == "admin")

    conn = get_db()
    rows = conn.execute("""
    SELECT m.*,
           (SELECT COUNT(*) FROM participations p WHERE p.match_id = m.id) as joined_count
    FROM matches m
    ORDER BY m.status = 'upcoming' DESC, m.match_time ASC
    """).fetchall()

    user_participations = set()
    if current_user_id:
        p_rows = conn.execute("SELECT match_id FROM participations WHERE user_id = ?", (current_user_id,)).fetchall()
        user_participations = {r["match_id"] for r in p_rows}

    conn.close()
    
    matches = []
    for r in rows:
        m = dict(r)
        has_joined = (m["id"] in user_participations)
        m["has_joined"] = has_joined
        
        # High Security: Only reveal Room ID and Password if the user joined or is admin!
        if not (has_joined or is_admin):
            m["room_id"] = "JOIN TO VIEW" if m["room_id"] else "NOT RELEASED YET"
            m["room_pass"] = "JOIN TO VIEW" if m["room_pass"] else "NOT RELEASED YET"
        matches.append(m)

    return matches

@app.post("/api/matches/join")
async def join_match(data: JoinMatchRequest, user: dict = Depends(get_current_user)):
    user_id = user["id"]
    match_id = data.match_id

    conn = get_db()
    try:
        with conn:
            match = conn.execute("SELECT * FROM matches WHERE id = ?", (match_id,)).fetchone()
            if not match:
                raise HTTPException(status_code=404, detail="Match not found")
            if match["status"] != "upcoming":
                raise HTTPException(status_code=400, detail="Registration is closed for this match")

            already = conn.execute("SELECT id FROM participations WHERE match_id = ? AND user_id = ?", (match_id, user_id)).fetchone()
            if already:
                raise HTTPException(status_code=400, detail="You have already joined this match!")

            joined_count = conn.execute("SELECT COUNT(*) FROM participations WHERE match_id = ?", (match_id,)).fetchone()[0]
            if joined_count >= match["total_slots"]:
                raise HTTPException(status_code=400, detail="Match is full! No slots available.")

            user_fresh = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (user_id,)).fetchone()
            if user_fresh["digits_balance"] < match["entry_fee"]:
                raise HTTPException(
                    status_code=400,
                    detail=f"পর্যাপ্ত ডিজিট নেই! (Insufficient Digits). এই ম্যাচে জয়েন করতে {match['entry_fee']} ডিজিট লাগবে। আপনার ব্যালেন্স {user_fresh['digits_balance']} ডিজিট। অনুগ্রহ করে bKash দিয়ে রিচার্জ করুন।"
                )

            new_balance = user_fresh["digits_balance"] - match["entry_fee"]
            conn.execute("UPDATE users SET digits_balance = ? WHERE id = ?", (new_balance, user_id))

            slot_num = joined_count + 1
            conn.execute("""
            INSERT INTO participations (match_id, user_id, slot_number)
            VALUES (?, ?, ?)
            """, (match_id, user_id, slot_num))

            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (NULL, ?, 'MATCH_ENTRY_FEE', ?, ?)
            """, (user_id, -match["entry_fee"], f"Joined Match #{match_id}: {match['title']}"))

    except HTTPException:
        conn.close()
        raise
    except Exception as e:
        conn.close()
        raise HTTPException(status_code=500, detail=str(e))

    await manager.broadcast({
        "type": "MATCH_SLOT_UPDATE",
        "match_id": match_id,
        "new_joined_count": joined_count + 1
    })

    await manager.send_to_user(user_id, {
        "type": "BALANCE_UPDATED",
        "digits_balance": new_balance
    })

    conn.close()
    return {
        "success": True,
        "message": f"সফলভাবে জয়েন হয়েছেন! আপনার স্লট নম্বর: {slot_num}",
        "new_balance": new_balance,
        "slot_number": slot_num,
        "room_id": match["room_id"] if match["room_id"] else "খেলার ১০ মিনিট আগে রিলিজ হবে",
        "room_pass": match["room_pass"] if match["room_pass"] else "খেলার ১০ মিনিট আগে রিলিজ হবে"
    }

# -------------------------------------------------------------
# Digits & bKash Deposit System
# -------------------------------------------------------------
@app.post("/api/wallet/deposit")
def submit_deposit(data: DepositRequest, user: dict = Depends(get_current_user)):
    if data.amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be greater than 0")
    if len(data.bkash_number.strip()) < 11:
        raise HTTPException(status_code=400, detail="Valid 11-digit bKash number required")
    if len(data.trx_id.strip()) < 4:
        raise HTTPException(status_code=400, detail="Valid bKash Transaction ID (TrxID) is required")

    conn = get_db()
    with conn:
        conn.execute("""
        INSERT INTO deposits (user_id, bkash_number, amount, trx_id, status)
        VALUES (?, ?, ?, ?, 'pending')
        """, (user["id"], data.bkash_number.strip(), data.amount, data.trx_id.strip().upper()))
    conn.close()

    return {
        "success": True,
        "message": "ডিপোজিট রিকোয়েস্ট সফল হয়েছে! অ্যাডমিন পেমেন্ট চেক করে কয়েক মিনিটের মধ্যে আপনার অ্যাকাউন্টে ডিজিট যোগ করে দিবে।"
    }

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
def admin_overview(admin: dict = Depends(verify_admin)):
    conn = get_db()
    total_users = conn.execute("SELECT COUNT(*) FROM users WHERE role != 'admin'").fetchone()[0]
    total_matches = conn.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
    pending_deposits = conn.execute("SELECT COUNT(*) FROM deposits WHERE status = 'pending'").fetchone()[0]
    total_digits_circulating = conn.execute("SELECT SUM(digits_balance) FROM users WHERE role != 'admin'").fetchone()[0] or 0
    
    recent_deposits = conn.execute("""
    SELECT d.*, u.username, u.player_id, u.phone as user_phone
    FROM deposits d
    JOIN users u ON d.user_id = u.id
    WHERE d.status = 'pending'
    ORDER BY d.id DESC LIMIT 30
    """).fetchall()

    conn.close()
    return {
        "total_users": total_users,
        "total_matches": total_matches,
        "pending_deposits": pending_deposits,
        "total_digits_circulating": total_digits_circulating,
        "pending_deposits_list": [dict(r) for r in recent_deposits]
    }

@app.get("/api/admin/users")
def admin_list_users(search: Optional[str] = None, admin: dict = Depends(verify_admin)):
    conn = get_db()
    if search:
        s = f"%{search.strip()}%"
        users = conn.execute("""
        SELECT id, player_id, username, phone, ff_ign, ff_uid, digits_balance, role, status, created_at
        FROM users
        WHERE username LIKE ? OR player_id LIKE ? OR phone LIKE ? OR ff_uid LIKE ?
        ORDER BY id DESC LIMIT 50
        """, (s, s, s, s)).fetchall()
    else:
        users = conn.execute("""
        SELECT id, player_id, username, phone, ff_ign, ff_uid, digits_balance, role, status, created_at
        FROM users
        ORDER BY id DESC LIMIT 50
        """).fetchall()
    conn.close()
    return [dict(u) for u in users]

@app.post("/api/admin/users/adjust-digits")
async def admin_adjust_digits(data: AdminAdjustDigits, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (data.target_user_id,)).fetchone()
        if not user:
            conn.close()
            raise HTTPException(status_code=404, detail="Target player not found")

        new_bal = user["digits_balance"] + data.amount
        if new_bal < 0:
            new_bal = 0

        conn.execute("UPDATE users SET digits_balance = ? WHERE id = ?", (new_bal, data.target_user_id))
        
        conn.execute("""
        INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
        VALUES (?, ?, 'ADMIN_ADJUST_DIGITS', ?, ?)
        """, (admin["id"], data.target_user_id, data.amount, data.reason or "Admin Manual Adjustment"))

    conn.close()

    await manager.send_to_user(data.target_user_id, {
        "type": "BALANCE_UPDATED",
        "digits_balance": new_bal,
        "notice": f"অ্যাডমিন আপনার ওয়ালেটে {data.amount:+d} ডিজিট আপডেট করেছেন। কারণ: {data.reason}"
    })

    return {
        "success": True,
        "message": f"Updated balance for @{user['username']}. New balance: {new_bal} digits",
        "new_balance": new_bal
    }

@app.post("/api/admin/users/{target_user_id}/toggle-status")
async def admin_toggle_status(target_user_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
        if not user:
            conn.close()
            raise HTTPException(status_code=404, detail="User not found")
        if user["role"] == "admin":
            conn.close()
            raise HTTPException(status_code=400, detail="Cannot ban Master Admin")

        new_status = "banned" if user["status"] == "active" else "active"
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

        for sub in subs:
            try:
                pywebpush.webpush(
                    subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                    data=push_payload,
                    vapid_private_key=VAPID_KEYS["private_key"],
                    vapid_claims={"sub": "mailto:admin@tournaments.local"},
                    timeout=4
                )
            except Exception:
                pass

    return {"success": True, "new_status": new_status, "username": user["username"]}

@app.post("/api/admin/users/{target_user_id}/impersonate")
def admin_impersonate_user(target_user_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE id = ?", (target_user_id,)).fetchone()
    conn.close()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    impersonation_token = generate_token(user["id"], user["username"], user["role"])
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

@app.post("/api/admin/deposits/{deposit_id}/review")
async def admin_review_deposit(deposit_id: int, action: str, admin: dict = Depends(verify_admin)):
    if action not in ["approve", "reject"]:
        raise HTTPException(status_code=400, detail="Action must be approve or reject")

    conn = get_db()
    with conn:
        deposit = conn.execute("SELECT * FROM deposits WHERE id = ?", (deposit_id,)).fetchone()
        if not deposit:
            conn.close()
            raise HTTPException(status_code=404, detail="Deposit record not found")
        if deposit["status"] != "pending":
            conn.close()
            raise HTTPException(status_code=400, detail="Deposit is already processed")

        new_status = "approved" if action == "approve" else "rejected"
        conn.execute("""
        UPDATE deposits SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?
        """, (new_status, deposit_id))

        new_balance = None
        if action == "approve":
            u = conn.execute("SELECT digits_balance FROM users WHERE id = ?", (deposit["user_id"],)).fetchone()
            new_balance = u["digits_balance"] + deposit["amount"]
            conn.execute("UPDATE users SET digits_balance = ? WHERE id = ?", (new_balance, deposit["user_id"]))

            conn.execute("""
            INSERT INTO audit_logs (admin_id, target_user_id, action, amount, reason)
            VALUES (?, ?, 'DEPOSIT_APPROVED', ?, ?)
            """, (admin["id"], deposit["user_id"], deposit["amount"], f"Approved bKash TrxID: {deposit['trx_id']}"))

    conn.close()

    if action == "approve" and new_balance is not None:
        await manager.send_to_user(deposit["user_id"], {
            "type": "BALANCE_UPDATED",
            "digits_balance": new_balance,
            "notice": f"আপনার bKash ডিপোজিট অনুমোদিত হয়েছে! ওয়ালেটে +{deposit['amount']} ডিজিট যোগ হয়েছে।"
        })

    return {"success": True, "status": new_status, "deposit_id": deposit_id}

@app.post("/api/admin/matches")
async def admin_create_match(data: AdminMatchCreate, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        cursor = conn.execute("""
        INSERT INTO matches (title, match_type, map_name, match_time, entry_fee, prize_pool, per_kill, total_slots, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'upcoming')
        """, (data.title.strip(), data.match_type, data.map_name, data.match_time,
              data.entry_fee, data.prize_pool, data.per_kill, data.total_slots))
        match_id = cursor.lastrowid
    conn.close()

    await manager.broadcast({
        "type": "NEW_MATCH_CREATED",
        "match_id": match_id,
        "title": data.title
    })

    return {"success": True, "match_id": match_id, "message": "Match created successfully"}

@app.put("/api/admin/matches/{match_id}")
async def admin_update_match(match_id: int, data: AdminMatchUpdate, admin: dict = Depends(verify_admin)):
    conn = get_db()
    fields = []
    values = []
    for k, v in data.dict(exclude_unset=True).items():
        if v is not None:
            fields.append(f"{k} = ?")
            values.append(v)

    if not fields:
        conn.close()
        return {"success": True, "message": "No changes requested"}

    values.append(match_id)
    with conn:
        conn.execute(f"UPDATE matches SET {', '.join(fields)} WHERE id = ?", values)
    conn.close()

    if data.room_id or data.room_pass:
        await manager.broadcast({
            "type": "ROOM_CREDENTIALS_RELEASED",
            "match_id": match_id,
            "message": f"Match #{match_id} Room ID & Password are now available!"
        })

    return {"success": True, "message": "Match updated successfully"}

@app.delete("/api/admin/matches/{match_id}")
def admin_delete_match(match_id: int, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        conn.execute("DELETE FROM matches WHERE id = ?", (match_id,))
    conn.close()
    return {"success": True, "message": "Match deleted"}

@app.post("/api/admin/settings")
async def admin_update_settings(data: dict, admin: dict = Depends(verify_admin)):
    conn = get_db()
    with conn:
        for k, v in data.items():
            conn.execute("""
            INSERT INTO settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """, (k, str(v)))
    conn.close()

    # Real-time WebSocket sync to all connected mobile & PC clients
    await manager.broadcast({
        "type": "SETTINGS_UPDATED",
        "notice": data.get("notice"),
        "site_title": data.get("site_title"),
        "admin_bkash": data.get("admin_bkash")
    })

    return {"success": True, "message": "Settings updated and broadcasted successfully"}

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

    success_count = 0
    fail_count = 0
    dead_ids = []

    for sub in subs:
        sub_info = {
            "endpoint": sub["endpoint"],
            "keys": {
                "p256dh": sub["p256dh"],
                "auth": sub["auth"]
            }
        }
        try:
            pywebpush.webpush(
                subscription_info=sub_info,
                data=push_payload,
                vapid_private_key=VAPID_KEYS["private_key"],
                vapid_claims={"sub": "mailto:admin@tournaments.local"},
                timeout=5
            )
            success_count += 1
        except Exception:
            fail_count += 1
            dead_ids.append(sub["id"])

    if dead_ids:
        conn = get_db()
        with conn:
            conn.executemany("DELETE FROM push_subscriptions WHERE id = ?", [(i,) for i in dead_ids])
        conn.close()

    return {
        "success": True,
        "message": f"Notice broadcasted! WebSockets: {len(manager.active_connections)}, Push Sent: {success_count}, Expired: {fail_count}"
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

    for sub in subs:
        try:
            pywebpush.webpush(
                subscription_info={"endpoint": sub["endpoint"], "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]}},
                data=push_payload,
                vapid_private_key=VAPID_KEYS["private_key"],
                vapid_claims={"sub": "mailto:admin@tournaments.local"},
                timeout=4
            )
        except Exception:
            pass

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
public_dir = os.path.join(BASE_DIR, "public")
if not os.path.exists(public_dir):
    os.makedirs(public_dir, exist_ok=True)

app.mount("/static", StaticFiles(directory=public_dir), name="static")

@app.get("/")
def serve_index():
    index_file = os.path.join(public_dir, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return {"status": "Frontend loading..."}

@app.get("/sw.js")
def serve_service_worker():
    sw_file = os.path.join(public_dir, "sw.js")
    if os.path.exists(sw_file):
        return FileResponse(sw_file, media_type="application/javascript")
    return JSONResponse(status_code=404, content={"detail": "sw.js not found"})

@app.get("/manifest.json")
def serve_manifest():
    mf_file = os.path.join(public_dir, "manifest.json")
    if os.path.exists(mf_file):
        return FileResponse(mf_file, media_type="application/json")
    return JSONResponse(status_code=404, content={"detail": "manifest.json not found"})

if __name__ == "__main__":
    import uvicorn
    print("\n========================================================")
    print("[*] FREE FIRE TOURNAMENT SERVER STARTING (HIGH PERFORMANCE)")
    print("[*] URL: http://127.0.0.1:8000")
    print("[*] Master Admin Login: username: 'admin', password: 'admin12345'")
    port = int(os.environ.get("PORT", 8000))
    print(f"[*] Port: {port}")
    uvicorn.run("app:app", host="0.0.0.0", port=port, reload=False, log_level="info")
