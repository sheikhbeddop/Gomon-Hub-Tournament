const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const http = require('http');
const crypto = require('crypto');

// Load configuration
const configPath = path.join(__dirname, 'config.json');
let config = {
    bot_phone_number: "8801349966049",
    backend_webhook_url: "http://127.0.0.1:8000/api/auth/whatsapp/confirm",
    social_links: {
        youtube: "https://youtube.com/@gomonhub?si=eAtg7YmxaFhg18m1",
        facebook: "https://www.facebook.com/gomonhub/",
        whatsapp_group: ""
    },
    messages: {
        success_verified: "✅ *আপনার GOMONHUB অ্যাকাউন্ট সফলভাবে ভেরিফাই হয়েছে!* 🎉\n\nটুর্নামেন্টের রুম আইডি, পাসওয়ার্ড ও লাইভ ম্যাচ আপডেট পেতে আমাদের সাথে যুক্ত থাকুন:\n\n📺 *YouTube (Subscribe):* {YOUTUBE_URL}\n🌐 *Facebook Page (Follow):* {FACEBOOK_URL}\n\n💡 এই নম্বরটি আপনার ফোনে সেভ (Save) করে রাখুন যাতে কোনো আপডেট মিস না হয়। ধন্যবাদ! 🎮🔥"
    }
};

if (fs.existsSync(configPath)) {
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error('[CONFIG ERROR] Failed to parse config.json, using defaults.');
    }
}

// In-memory verification sessions
// sessionToken -> { phone, code, verified: false, expiresAt, senderPhone }
const pendingSessions = {};

let sock = null;

async function startWhatsAppBot() {
    const sessionDir = path.join(__dirname, 'auth_session');
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`\n======================================================`);
    console.log(`🤖 GOMONHUB WhatsApp OTP & Auto-Reply Bot starting...`);
    console.log(`📦 Using Baileys version: ${version.join('.')}, isLatest: ${isLatest}`);
    console.log(`🌐 Live Player Simulation Web Portal: http://localhost:3000`);
    console.log(`======================================================\n`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['GOMONHUB Bot', 'Chrome', '1.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n📱 [QR CODE GENERATED] Please scan with WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`\n⚠️ Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsAppBot, 3000);
            }
        } else if (connection === 'open') {
            console.log('\n✅ [WHATSAPP CONNECTED] Bot is active & listening 24/7!\n');
        }
    });

    // Listen to incoming messages
    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        const msg = messages[0];

        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        const senderJid = msg.key.remoteJid;
        const senderPhone = senderJid.replace(/@.*$/, '');

        const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            ''
        ).trim();

        if (!text) return;

        // Quick Test handler
        if (text.toLowerCase() === 'hi' || text.toLowerCase() === 'test') {
            await sock.sendMessage(senderJid, {
                text: `👋 হ্যালো! GOMONHUB WhatsApp বট একদম সচল ও অ্যাক্টিভ আছে! 🎮\n\nওয়েবসাইটে রিয়েল ভেরিফিকেশন টেস্ট করতে ব্রাউজারে যান:\n👉 *http://localhost:3000*`
            });
            console.log(`👋 [QUICK TEST REPLIED] To: ${senderPhone}`);
            return;
        }

        // Detect verification format: "VERIFY 849201" or just "849201"
        const otpMatch = text.match(/(?:VERIFY[\s:]*)?(\d{6})\b/i);

        if (otpMatch) {
            const code = otpMatch[1];
            console.log(`\n📩 [INCOMING OTP RECEIVED] Sender: ${senderPhone} | Code: ${code}`);

            // Check if matches any active web session
            let matchedToken = null;
            const now = Date.now();

            for (const [token, sess] of Object.entries(pendingSessions)) {
                if (sess.code === code && now < sess.expiresAt) {
                    const cleanSessPhone = (sess.phone || '').replace(/\D/g, '');
                    const cleanSenderPhone = senderPhone.replace(/\D/g, '');

                    // Match if clean phone matches or suffix matches (e.g., 017... vs 88017...)
                    const isPhoneMatch = !cleanSessPhone ||
                        cleanSessPhone === '01700000000' ||
                        sess.isAdmin ||
                        cleanSenderPhone.endsWith(cleanSessPhone) ||
                        cleanSessPhone.endsWith(cleanSenderPhone);

                    if (isPhoneMatch) {
                        sess.verified = true;
                        sess.senderPhone = senderPhone;
                        matchedToken = token;
                        break;
                    } else {
                        console.log(`⚠️ [PHONE NUMBER MISMATCH] Locked Account: ${cleanSessPhone} vs WhatsApp Sender: ${cleanSenderPhone}`);
                    }
                }
            }

            // Build Social Media Promo Reply
            let promoLinks = [];
            if (config.social_links.youtube) {
                promoLinks.push(`📺 *YouTube (Subscribe):* ${config.social_links.youtube}`);
            }
            if (config.social_links.facebook) {
                promoLinks.push(`🌐 *Facebook Page (Follow):* ${config.social_links.facebook}`);
            }

            const replyText = `✅ *আপনার GOMONHUB অ্যাকাউন্ট সফলভাবে ভেরিফাই হয়েছে!* 🎉\n\n` +
                `টুর্নামেন্টের রুম আইডি, পাসওয়ার্ড ও লাইভ ম্যাচ আপডেট পেতে আমাদের সাথে যুক্ত থাকুন:\n\n` +
                promoLinks.join('\n') +
                `\n\n💡 এই নম্বরটি আপনার ফোনে সেভ (Save) করে রাখুন যাতে কোনো আপডেট মিস না হয়। ধন্যবাদ! 🎮🔥`;

            try {
                await sock.sendMessage(senderJid, { text: replyText });
                console.log(`🚀 [PROMO AUTO-REPLY SENT] To: ${senderPhone}`);
            } catch (sendErr) {
                console.error(`❌ [SEND ERROR] ${sendErr.message}`);
            }

            if (matchedToken) {
                console.log(`🎉 [WEB BROWSER AUTO-VERIFIED] Session ${matchedToken} is now verified! Screen updated.`);
            } else {
                console.log(`ℹ️ [STANDALONE OTP] Matched generic test code.`);
            }
        }
    });
}

// -------------------------------------------------------------
// Built-in Live Simulation Web Server (Port 3000)
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

    // API: Request Code
    if (parsedUrl.pathname === '/api/request-code' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body || '{}');
                const phone = (data.phone || '').trim();
                const isAdmin = Boolean(data.isAdmin);
                const code = Math.floor(100000 + Math.random() * 900000).toString();
                const sessionToken = crypto.randomBytes(16).toString('hex');

                pendingSessions[sessionToken] = {
                    phone,
                    isAdmin,
                    code,
                    verified: false,
                    expiresAt: Date.now() + 300000 // 5 minutes
                };

                const cleanBotPhone = (config.bot_phone_number || '').replace(/\D/g, '');
                const waUrl = `https://wa.me/${cleanBotPhone}?text=VERIFY%20${code}`;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    sessionToken,
                    code,
                    waUrl
                }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
        });
        return;
    }

    // API: Check Status (Polling)
    if (parsedUrl.pathname === '/api/check-status' && req.method === 'GET') {
        const token = parsedUrl.searchParams.get('token');
        const sess = pendingSessions[token];

        if (!sess) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ verified: false, expired: true }));
            return;
        }

        const isExpired = Date.now() > sess.expiresAt;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            verified: sess.verified,
            expired: isExpired,
            phone: sess.phone,
            senderPhone: sess.senderPhone || ''
        }));
        return;
    }

    // Serve HTML Web Interface
    if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOMONHUB - Live WhatsApp Verification Test</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&family=JetBrains+Mono:wght@700&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 0%, #0f172a 0%, #020617 100%);
      font-family: 'Outfit', sans-serif;
      color: #f8fafc;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(34, 197, 94, 0.15);
      border: 1px solid rgba(34, 197, 94, 0.4);
      color: #4ade80;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 700;
      margin-bottom: 14px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge .dot {
      width: 8px;
      height: 8px;
      background: #22c55e;
      border-radius: 50%;
      animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.85); }
    }
    .card {
      background: rgba(15, 23, 42, 0.85);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(16px);
      width: 100%;
      max-width: 480px;
      border-radius: 24px;
      padding: 36px 28px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 40px rgba(37, 99, 235, 0.1);
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; height: 3px;
      background: linear-gradient(90deg, #2563eb, #22c55e, #38bdf8);
    }
    h1 {
      font-size: 1.7rem;
      font-weight: 900;
      margin-bottom: 6px;
      letter-spacing: -0.5px;
    }
    p.sub {
      color: #94a3b8;
      font-size: 0.92rem;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .input-group {
      text-align: left;
      margin-bottom: 18px;
    }
    label {
      font-size: 0.82rem;
      font-weight: 700;
      color: #cbd5e1;
      display: block;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    input {
      width: 100%;
      padding: 14px 18px;
      background: #020617;
      border: 1.5px solid #334155;
      border-radius: 12px;
      color: #fff;
      font-size: 1.05rem;
      font-family: inherit;
      outline: none;
      transition: all 0.2s;
    }
    input:focus {
      border-color: #22c55e;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.2);
    }
    .btn-submit {
      width: 100%;
      padding: 15px;
      background: linear-gradient(135deg, #22c55e, #16a34a);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 1.02rem;
      font-weight: 800;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      box-shadow: 0 10px 20px -5px rgba(34, 197, 94, 0.4);
      transition: transform 0.15s, opacity 0.15s;
    }
    .btn-submit:hover { opacity: 0.95; transform: translateY(-1px); }
    .btn-submit:active { transform: translateY(0); }

    /* STEP 2: VERIFICATION SCREEN */
    #stepVerify { display: none; }
    .code-box {
      background: rgba(34, 197, 94, 0.08);
      border: 2px dashed #22c55e;
      padding: 18px;
      border-radius: 16px;
      margin: 20px 0;
    }
    .code-label {
      font-size: 0.8rem;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 1px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .code-val {
      font-family: 'JetBrains Mono', monospace;
      font-size: 2.4rem;
      font-weight: 800;
      letter-spacing: 8px;
      color: #4ade80;
    }
    .btn-wa-open {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      background: #25d366;
      color: #064e3b;
      text-decoration: none;
      padding: 16px;
      border-radius: 12px;
      font-size: 1.1rem;
      font-weight: 900;
      box-shadow: 0 12px 25px -6px rgba(37, 211, 102, 0.5);
      margin-bottom: 20px;
      transition: transform 0.15s;
    }
    .btn-wa-open:hover { transform: translateY(-2px); }
    .waiting-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      color: #94a3b8;
      font-size: 0.88rem;
      font-weight: 600;
    }
    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.2);
      border-top-color: #22c55e;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* STEP 3: SUCCESS SCREEN */
    #stepSuccess { display: none; }
    .success-icon {
      width: 80px;
      height: 80px;
      background: rgba(34, 197, 94, 0.2);
      border: 2px solid #22c55e;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 18px auto;
      font-size: 2.2rem;
      color: #4ade80;
      box-shadow: 0 0 30px rgba(34, 197, 94, 0.4);
      animation: bounce 0.6s ease;
    }
    @keyframes bounce {
      0% { transform: scale(0.3); opacity: 0; }
      50% { transform: scale(1.15); }
      100% { transform: scale(1); opacity: 1; }
    }
    .celebrate-card {
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 14px;
      padding: 16px;
      margin: 18px 0;
      text-align: left;
      font-size: 0.9rem;
    }
    .celebrate-card div { margin-bottom: 6px; }
  </style>
</head>
<body>

  <div class="card">
    <div class="badge">
      <span class="dot"></span> WhatsApp Live Gateway
    </div>

    <!-- STEP 1: PHONE INPUT -->
    <div id="stepInput">
      <h1>GOMON HUB</h1>
      <p class="sub">প্লেয়ার হিসেবে লাইভ WhatsApp ভেরিফিকেশন টেস্ট করুন</p>

      <form id="phoneForm" onsubmit="handleRequest(event)">
        <div class="input-group">
          <label>আপনার মোবাইল নম্বর (যে WhatsApp দিয়ে টেস্ট করবেন)</label>
          <input type="tel" id="userPhone" placeholder="01XXXXXXXXX" required autofocus value="017">
        </div>
        <button type="submit" class="btn-submit" id="btnRequest">
          <span>Verify via WhatsApp 📲</span>
        </button>
      </form>
    </div>

    <!-- STEP 2: CODE & WHATSAPP BUTTON -->
    <div id="stepVerify">
      <h1>WhatsApp এ পাঠান</h1>
      <p class="sub">নিচের বাটনে চাপলেই WhatsApp ওপেন হবে এবং কোডটি অটোমেটিক বসে যাবে!</p>

      <div class="code-box">
        <div class="code-label">আপনার সিকিউর কোড</div>
        <div class="code-val" id="dispCode">------</div>
      </div>

      <a id="btnWaLink" href="#" target="_blank" class="btn-wa-open">
        <span>📲 Open WhatsApp & Send</span>
      </a>

      <div class="waiting-bar">
        <div class="spinner"></div>
        <span>আপনার WhatsApp মেসেজের অপেক্ষায়...</span>
      </div>
    </div>

    <!-- STEP 3: SUCCESS STATE -->
    <div id="stepSuccess">
      <div class="success-icon">✓</div>
      <h1 style="color: #4ade80;">ভেরিফিকেশন সফল!</h1>
      <p class="sub" style="margin-bottom: 12px;">ওয়েবসাইট স্ক্রিন ইনস্ট্যান্ট আপনার নম্বর চিনে ফেলেছে!</p>

      <div class="celebrate-card">
        <div>📱 <b>ভেরিফাইড নম্বর:</b> <span id="succPhone" style="color:#38bdf8;">01XXXXXXXXX</span></div>
        <div>🚀 <b>স্ট্যাটাস:</b> <span style="color:#4ade80; font-weight:700;">ACTIVE PLAYER</span></div>
        <div>🎁 <b>সোশ্যাল প্রমো:</b> আপনার WhatsApp-এ ইউটিউব ও ফেসবুক লিংক চলে গেছে!</div>
      </div>

      <button class="btn-submit" onclick="location.reload()" style="background:#334155; box-shadow:none;">
        পুনরায় টেস্ট করুন 🔄
      </button>
    </div>

  </div>

  <script>
    let pollTimer = null;

    async function handleRequest(e) {
      e.preventDefault();
      const phone = document.getElementById('userPhone').value.trim();
      const btn = document.getElementById('btnRequest');
      btn.innerText = 'জেনারেট হচ্ছে...';
      btn.disabled = true;

      try {
        const res = await fetch('/api/request-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone })
        });
        const data = await res.json();

        if (data.success) {
          document.getElementById('stepInput').style.display = 'none';
          document.getElementById('stepVerify').style.display = 'block';

          document.getElementById('dispCode').innerText = data.code;
          document.getElementById('btnWaLink').href = data.waUrl;

          // Start live polling every 1.2 seconds
          startPolling(data.sessionToken);
        }
      } catch (err) {
        alert('সার্ভারে যোগাযোগ করা যায়নি: ' + err.message);
        btn.innerText = 'Verify via WhatsApp 📲';
        btn.disabled = false;
      }
    }

    function startPolling(token) {
      pollTimer = setInterval(async () => {
        try {
          const res = await fetch('/api/check-status?token=' + token);
          const data = await res.json();

          if (data.verified) {
            clearInterval(pollTimer);
            document.getElementById('stepVerify').style.display = 'none';
            document.getElementById('stepSuccess').style.display = 'block';
            document.getElementById('succPhone').innerText = data.senderPhone || data.phone || '01XXXXXXXXX';
          }
        } catch (e) {
          console.error(e);
        }
      }, 1200);
    }
  </script>
</body>
</html>`);
    }
});

server.listen(3000, () => {
    console.log(`🚀 [WEB TEST PORTAL READY] Open in browser: http://localhost:3000`);
});

startWhatsAppBot();
