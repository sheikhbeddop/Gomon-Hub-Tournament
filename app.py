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
DEFAULT_PERMANENT_SECRET = "GOMON_HUB_TOURNAMENT_PERMANENT_SECRET_2026_PRO_KEY_849204918230912830912"
if os.path.exists(SECRET_KEY_FILE):
    try:
        with open(SECRET_KEY_FILE, "r") as f:
            SECRET_KEY = f.read().strip()
    except Exception:
        SECRET_KEY = DEFAULT_PERMANENT_SECRET
else:
    SECRET_KEY = os.environ.get("SECRET_KEY", DEFAULT_PERMANENT_SECRET)
    try:
        with open(SECRET_KEY_FILE, "w") as f:
            f.write(SECRET_KEY)
    except Exception:
        pass

if not SECRET_KEY:
    SECRET_KEY = DEFAULT_PERMANENT_SECRET

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
        "exp": int(time.time()) + (10 * 365 * 86400) # 10 years permanent token
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
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('site_title', 'GOMON HUB TOURNAMENT')")

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
CURRENT_CODE_VERSION = "v3.0.0"

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
        "admin_bkash": settings.get("admin_bkash", "01700000000"),
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
        if b_row["password_hash"] and verify_password(b_row["password_hash"], data.password):
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
@app.get("/favicon.ico")
def serve_app_icon(request: Request):
    pub_img = os.path.join(BASE_DIR, "public", "img")
    path_str = request.url.path
    if "gomon_hub_logo" in path_str:
        fpath = os.path.join(pub_img, "gomon_hub_logo.png")
    elif "192" in path_str:
        fpath = os.path.join(pub_img, "icon-192.png")
    elif "512" in path_str:
        fpath = os.path.join(pub_img, "icon-512.png")
    else:
        fpath = os.path.join(pub_img, "icon.png")

    if not os.path.exists(fpath) or os.path.getsize(fpath) in [7702, 71233] or os.path.getsize(fpath) < 10000:
        ensure_mascot_icons()

    if os.path.exists(fpath):
        return FileResponse(
            fpath,
            media_type="image/png",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
                "Expires": "0"
            }
        )
    return JSONResponse(status_code=404, content={"detail": "Icon not found"})

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
        return FileResponse(sw_file, media_type="application/javascript", headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})
    return JSONResponse(status_code=404, content={"detail": "sw.js not found"})

@app.get("/manifest.json")
def serve_manifest():
    mf_file = os.path.join(public_dir, "manifest.json")
    if os.path.exists(mf_file):
        return FileResponse(mf_file, media_type="application/json", headers={"Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0"})
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
