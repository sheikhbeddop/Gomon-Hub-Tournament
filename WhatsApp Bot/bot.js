const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const http = require('http');
const https = require('https');
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
let currentQr = null;
let currentQrDataUrl = null;
let isConnected = false;
let currentPairingCode = null;

function getSessionKeyString() {
    try {
        const credsPath = path.join(__dirname, 'auth_session', 'creds.json');
        if (fs.existsSync(credsPath)) {
            const raw = fs.readFileSync(credsPath, 'utf8');
            return Buffer.from(raw).toString('base64');
        }
    } catch (_) {}
    return null;
}

function restoreSessionFromEnv() {
    const sessionDir = path.join(__dirname, 'auth_session');
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
    }
    const credsPath = path.join(sessionDir, 'creds.json');
    if (!fs.existsSync(credsPath) && process.env.WHATSAPP_SESSION_DATA) {
        try {
            const rawJson = Buffer.from(process.env.WHATSAPP_SESSION_DATA.trim(), 'base64').toString('utf8');
            fs.writeFileSync(credsPath, rawJson, 'utf8');
            console.log('\n🔑 [PERMANENT SESSION RESTORED] Loaded credentials from WHATSAPP_SESSION_DATA env variable!\n');
        } catch (e) {
            console.error('[SESSION RESTORE ERROR] Could not decode WHATSAPP_SESSION_DATA:', e.message);
        }
    }
}

function getSmartFallbackReply(userMessage) {
    const raw = (userMessage || '').trim().toLowerCase();
    const isSalam = /(?:সালাম|assalamu|salam|slm|আসসালামু)/i.test(raw);
    const asksLink = /(?:link|লিংক|ওয়েবসাইট|website|web link|ওয়েবসাইট)/i.test(raw);
    const asksJoin = /(?:kivabe khelbo|কীভাবে খেলব|খেলব কীভাবে|খেলব কেমনে|join|রেজিস্টার|রেজিস্ট্রেশন|কাস্টম|ম্যাচ কীভাবে|নিবন্ধন)/i.test(raw);
    const asksRoomId = /(?:room id|রুম আইডি|পাসওয়ার্ড|password|id pass|কখন পাব|ম্যাচ কখন|শুরু কখন)/i.test(raw);
    const asksFee = /(?:কত টাকা|ফি কত|এন্ট্রি ফি|entry fee|match fee|কতো টাকার ম্যাচ|টাকা লাগবে)/i.test(raw);
    const asksWithdraw = /(?:withdraw|উইথড্র|টাকা তুলব|ক্যাশআউট|উইথড্র কীভাবে|bkash|nagad|বিকাশ|নগদ)/i.test(raw);
    const asksRules = /(?:rules|নিয়ম|হ্যাকার|হ্যাক|hack|cheat|ব্যান)/i.test(raw);
    const isThanks = /(?:ধন্যবাদ|thanks|thx|tnx|shukriya|শুকরিয়া)/i.test(raw);
    const isHowAreYou = /(?:কেমন আছেন|kemon achen|bhalo achen|ভালো আছেন)/i.test(raw);

    if (asksLink) {
        return `অবশ্যই ভাই! আমাদের অফিসিয়াল ওয়েবসাইট লিংক:\nOur tournament website 🖇️ https://rb.gy/feuqry`;
    }
    if (asksJoin) {
        return `আমাদের ওয়েবসাইটে গিয়ে একাউন্ট খুলে ওয়ালেটে ব্যালেন্স অ্যাড করুন ভাই। এরপর পছন্দের টুর্নামেন্টে 'Join' বাটনে ক্লিক করে ইন-গেম নাম ও ইউআইডি দিলেই আপনার স্লট বুক হয়ে যাবে।\nOur tournament website 🖇️ https://rb.gy/feuqry`;
    }
    if (asksRoomId) {
        return `ম্যাচ শুরু হওয়ার ঠিক ৫ থেকে ১০ মিনিট আগে ওয়েবসাইটের ওই ম্যাচের ভেতর সরাসরি কাস্টম রুম আইডি ও পাসওয়ার্ড দেখতে পাবেন ভাই। সময়মতো গেমে ঢুকে জয়েন করে নেবেন, শুভকামনা!`;
    }
    if (asksFee) {
        return `আমাদের প্ল্যাটফর্মে নিয়মিত ফ্রি এবং ১০ টাকা, ২০ টাকা, ৩০ টাকা ও ৫০ টাকার বিভিন্ন ম্যাচ থাকে ভাই। প্রতিটি ম্যাচের প্রাইজমানি ও পার-কিল রিওয়ার্ড ওয়েবসাইটের ম্যাচ কার্ডে স্পষ্ট উল্লেখ থাকে।`;
    }
    if (asksWithdraw) {
        return `ম্যাচ শেষে আপনার উইনিং ব্যালেন্স সরাসরি বিকাশ বা নগদে উইথড্র করতে পারবেন ভাই। ওয়ালেট সেকশনে রিকোয়েস্ট দিলেই দ্রুত সময়ের মধ্যে টাকা পৌঁছে যাবে।`;
    }
    if (asksRules) {
        return `আমাদের প্ল্যাটফর্মে ১০০% ফেয়ার প্লে নিশ্চিত করা হয় ভাই। যেকোনো প্রকার হ্যাক, স্ক্রিপ্ট বা আনফেয়ার গেমপ্লে সম্পূর্ণ নিষিদ্ধ, ধরা পড়লে আইডি সরাসরি পার্মানেন্ট ব্যান করা হয়।`;
    }
    if (isThanks) {
        return `আপনাকেও অনেক ধন্যবাদ ভাই! যেকোনো প্রয়োজনে নির্দ্বিধায় মেসেজ দিন, GOMON HUB টিম সবসময় পাশে আছে।`;
    }
    if (isHowAreYou) {
        return (isSalam ? `ওয়ালাইকুম আসসালাম ভাই! ` : `আলহামদুলিল্লাহ ভাই, `) +
            `আমরা ভালো আছি। আপনি কেমন আছেন? টুর্নামেন্ট নিয়ে কোনো তথ্যে সাহায্য লাগবে?`;
    }
    if (isSalam) {
        return `ওয়ালাইকুম আসসালাম ভাই! GOMON HUB-এ আপনাকে স্বাগতম। বলুন, কীভাবে সাহায্য করতে পারি?`;
    }
    return `আসসালামু আলাইকুম ভাই! GOMON HUB সাপোর্ট টিম থেকে বলছি। কীভাবে সাহায্য করতে পারি বলুন।`;
}

// AI Customer Support Assistant Helper
async function generateAiSupportReply(userMessage, senderPhone) {
    let knowledge = {};
    try {
        const kPath = path.join(__dirname, 'ai_knowledge.json');
        if (fs.existsSync(kPath)) {
            knowledge = JSON.parse(fs.readFileSync(kPath, 'utf8'));
        }
    } catch (_) {}

    const apiKey = process.env.GEMINI_API_KEY || config.gemini_api_key || '';
    const model = process.env.GEMINI_MODEL || config.ai_model || 'gemini-3.5-flash-lite';

    if (!apiKey) {
        return getSmartFallbackReply(userMessage);
    }

    const systemPrompt = `You are the official, friendly, human customer support agent for GOMON HUB Tournament platform in Bangladesh.
Speak naturally, politely, and warmly in Bengali like a real human admin/agent (never say you are an AI or robot).
Keep replies concise, helpful, and directly to the point (1 to 3 sentences).

CRITICAL SALAM RULES (STRICT CULTURAL PROTOCOL):
- Salam is strictly for the INITIAL GREETING or when responding to a Salam. NEVER repeat Salam in ongoing questions!
- ONLY IF the user explicitly said Salam ("assalamu alaikum", "সালাম", "slm"): Respond with "ওয়ালাইকুম আসসালাম ভাই!".
- IF the user opens with a greeting without Salam (like "Hi", "Hello"): You can say "আসসালামু আলাইকুম ভাই!".
- For ongoing questions (e.g. asking about match fee, room ID, withdrawal, rules, or saying thank you): DO NOT add Salam! Just directly and politely answer their question. A real human NEVER repeats Salam in every sentence!

CRITICAL RULES ABOUT WEBSITE LINK:
- DO NOT provide or mention the website link in normal conversations, casual greetings, or general chit-chat.
- ONLY provide the website link if the player explicitly asks for the website link (e.g., "ওয়েবসাইট লিংক দেন", "ওয়েবসাইটের লিংকটা দেন তো") or asks where to join/register: Our tournament website 🖇️ https://rb.gy/feuqry
- Never spam the link unnecessarily in every message.

Platform Information:
${JSON.stringify(knowledge, null, 2)}`;

    const data = JSON.stringify({
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
        contents: [{
            parts: [{ text: userMessage }]
        }]
    });

    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const reply = json.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (reply) return resolve(reply.trim());
                } catch (_) {}
                resolve(getSmartFallbackReply(userMessage));
            });
        });
        req.on('error', () => {
            resolve(getSmartFallbackReply(userMessage));
        });
        req.write(data);
        req.end();
    });
}

async function startWhatsAppBot() {
    const sessionDir = path.join(__dirname, 'auth_session');
    restoreSessionFromEnv();
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
        browser: Browsers.ubuntu('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQr = qr;
            isConnected = false;
            try {
                currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8 });
            } catch (err) {
                console.error('[QR ERROR]', err.message);
            }
            console.log('\n📱 [QR CODE GENERATED] Please scan with WhatsApp or open web portal /qr:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
            console.log(`\n⚠️ Connection closed: ${lastDisconnect?.error?.message || 'Unknown'}. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startWhatsAppBot, 3000);
            }
        } else if (connection === 'open') {
            isConnected = true;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;
            const sk = getSessionKeyString();
            console.log('\n✅ [WHATSAPP CONNECTED] Bot is active & listening 24/7!\n');
            if (sk) {
                console.log(`🔑 [PERMANENT SESSION KEY]: ${sk}\n`);
            }
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
                    sess.verified = true;
                    sess.senderPhone = senderPhone;
                    matchedToken = token;
                    console.log(`🎉 [SESSION MATCHED] Code ${code} verified for user ${sess.phone || 'Player'} (Sender: ${senderPhone})`);
                    break;
                }
            }

            if (matchedToken) {
                const replyText = `✅ *ভেরিফিকেশন সফল হয়েছে!*\n\n` +
                    `『 GOMON ARMY 』অফিসিয়াল সোশ্যাল লিংক:\n\n` +
                    `• TikTok: https://www.tiktok.com/@gomon_hub\n` +
                    `• Facebook: https://www.facebook.com/gomonhub\n` +
                    `• Instagram: https://www.instagram.com/gomon_gamer\n` +
                    `• Threads: https://www.threads.net/@gomon_hub\n` +
                    `• YouTube: https://www.youtube.com/@gomonhub\n` +
                    `• 2nd Channel: https://www.youtube.com/@mrgomonhub`;

                try {
                    await sock.sendMessage(senderJid, { text: replyText });
                    console.log(`🚀 [SUCCESS CONFIRMATION SENT] To: ${senderPhone}`);
                } catch (sendErr) {
                    console.error(`❌ [SEND ERROR] ${sendErr.message}`);
                }
                console.log(`🎉 [WEB BROWSER AUTO-VERIFIED] Session ${matchedToken} is now verified! Screen updated.`);
            } else {
                // Invalid or Expired Code Alert
                const invalidReplyText = `❌ *ভুল বা মেয়াদোত্তীর্ণ কোড!*\n\n` +
                    `দুঃখিত! আপনার পাঠানো ভেরিফিকেশন কোডটি সঠিক নয় অথবা এর মেয়াদ (২ মিনিট) শেষ হয়ে গেছে।\n\n` +
                    `💡 অনুগ্রহ করে ওয়েবসাইট থেকে ফ্রেশ নতুন কোড নিয়ে পুনরায় পাঠান। ধন্যবাদ! 🎮`;

                try {
                    await sock.sendMessage(senderJid, { text: invalidReplyText });
                    console.log(`⚠️ [INVALID OTP ALERT SENT] To: ${senderPhone} (Code: ${code})`);
                } catch (sendErr) {
                    console.error(`❌ [SEND ERROR] ${sendErr.message}`);
                }
            }
        } else {
            // General conversation, greetings & queries handled by AI Support Agent
            console.log(`💬 [GENERAL MESSAGE RECEIVED] From: ${senderPhone} | Text: "${text}"`);
            try {
                const aiReply = await generateAiSupportReply(text, senderPhone);
                await sock.sendMessage(senderJid, { text: aiReply });
                console.log(`🤖 [AI SUPPORT REPLIED] To: ${senderPhone}`);
            } catch (aiErr) {
                console.error(`❌ [AI SUPPORT ERROR] ${aiErr.message}`);
                await sock.sendMessage(senderJid, {
                    text: `স্বাগতম GOMON HUB-এ।\nআপনার স্কিলই আপনার পরিচয়। সেরাদের সাথে লড়াই করে তৈরি করুন নিজের অবস্থান。\n\nOur tournament website 🖇️ https://rb.gy/feuqry`
                });
            }
        }
    });
}

// -------------------------------------------------------------
// Built-in Live Simulation Web Server (Port 3000)
// -------------------------------------------------------------
const server = http.createServer(async (req, res) => {
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
                    expiresAt: Date.now() + 120000 // 2 minutes (120 seconds)
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

    // API: Bot Connection Status & Live QR
    if (parsedUrl.pathname === '/api/bot-status' && req.method === 'GET') {
        const sessionKey = getSessionKeyString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            connected: isConnected,
            hasQr: !!currentQrDataUrl,
            qrImage: currentQrDataUrl || null,
            pairingCode: currentPairingCode,
            sessionKey: isConnected ? sessionKey : null,
            botPhone: config.bot_phone_number
        }));
        return;
    }

    // API: Logout / Reset Session (Change Number)
    if (parsedUrl.pathname === '/api/bot-logout' && req.method === 'POST') {
        try {
            console.log('🔄 [LOGOUT REQUESTED] Clearing WhatsApp session for new number link...');
            if (sock) {
                try { await sock.logout(); } catch (_) { try { sock.end(); } catch (__) {} }
            }
            isConnected = false;
            currentQr = null;
            currentQrDataUrl = null;
            currentPairingCode = null;

            const sessionDir = path.join(__dirname, 'auth_session');
            if (fs.existsSync(sessionDir)) {
                fs.rmSync(sessionDir, { recursive: true, force: true });
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Logged out. New QR code generating...' }));

            setTimeout(() => {
                startWhatsAppBot();
            }, 1500);
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: err.message }));
        }
        return;
    }

    // API: Request Pairing Code (Alternative to camera QR scan)
    if (parsedUrl.pathname === '/api/request-pairing' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                let phone = (data.phone || config.bot_phone_number || '').replace(/\D/g, '');
                if (!phone.startsWith('88') && phone.startsWith('01')) {
                    phone = '88' + phone;
                }
                if (sock && !isConnected) {
                    const code = await sock.requestPairingCode(phone);
                    currentPairingCode = code;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, pairingCode: code }));
                } else {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        message: isConnected ? 'WhatsApp is already connected!' : 'Bot socket not ready yet. Please wait a few seconds.'
                    }));
                }
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
        });
        return;
    }

    // Dedicated QR Code & Pairing Web Interface
    if (parsedUrl.pathname === '/qr') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GOMONHUB - WhatsApp Bot Link & Pairing</title>
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
    .card {
      background: rgba(15, 23, 42, 0.9);
      border: 1px solid rgba(255, 255, 255, 0.1);
      backdrop-filter: blur(16px);
      width: 100%;
      max-width: 480px;
      border-radius: 24px;
      padding: 32px 24px;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
      text-align: center;
    }
    h1 { font-size: 1.5rem; font-weight: 800; margin-bottom: 8px; }
    p.sub { color: #94a3b8; font-size: 0.9rem; margin-bottom: 20px; line-height: 1.4; }
    .qr-container {
      background: #ffffff;
      padding: 16px;
      border-radius: 16px;
      display: inline-block;
      margin: 10px 0 16px 0;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    }
    .qr-container img {
      width: 240px;
      height: 240px;
      display: block;
    }
    .instructions {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 14px;
      text-align: left;
      font-size: 0.85rem;
      color: #cbd5e1;
      margin-top: 14px;
      line-height: 1.6;
    }
    .instructions ol { padding-left: 20px; }
    .instructions li { margin-bottom: 4px; }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 14px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 700;
      margin-bottom: 14px;
    }
    .badge.waiting { background: rgba(234, 179, 8, 0.15); border: 1px solid rgba(234, 179, 8, 0.4); color: #facc15; }
    .badge.connected { background: rgba(34, 197, 94, 0.15); border: 1px solid rgba(34, 197, 94, 0.4); color: #4ade80; }
    .btn-action {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #2563eb, #1d4ed8);
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 0.95rem;
      font-weight: 700;
      cursor: pointer;
      margin-top: 12px;
      transition: opacity 0.15s;
    }
    .btn-action:hover { opacity: 0.9; }
    .pairing-box {
      background: rgba(37, 99, 235, 0.1);
      border: 1px dashed #3b82f6;
      border-radius: 12px;
      padding: 14px;
      margin-top: 14px;
    }
    .pairing-code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 1.8rem;
      font-weight: 900;
      letter-spacing: 4px;
      color: #60a5fa;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="statusBadge" class="badge waiting">
      <span>●</span> অপেক্ষমাণ: ডিভাইস লিংক করুন
    </div>

    <!-- CONNECTED SCREEN -->
    <div id="viewConnected" style="display: none;">
      <div style="font-size: 3rem; margin-bottom: 10px;">✅</div>
      <h1 style="color: #4ade80;">WhatsApp বট সংযুক্ত!</h1>
      <p class="sub">বট এখন ২৪/৭ চালু আছে এবং উইথড্র ভেরিফিকেশন মেসেজ হ্যান্ডেল করতে প্রস্তুত।</p>
      <div class="instructions" style="text-align: center; margin-bottom: 16px;">
        📱 <b>বট নম্বর:</b> <span style="color: #38bdf8; font-weight: 800;">${config.bot_phone_number}</span><br>
        🚀 <b>সার্ভার স্ট্যাটাস:</b> ONLINE & 24/7 ACTIVE
      </div>

      <!-- PERMANENT AUTO-LOGIN KEY BOX -->
      <div style="background: rgba(34, 197, 94, 0.08); border: 1.5px dashed #22c55e; border-radius: 14px; padding: 16px; text-align: left; margin-bottom: 16px;">
        <div style="font-size: 0.85rem; color: #4ade80; font-weight: 800; display: flex; align-items: center; gap: 6px; margin-bottom: 6px;">
          <span>🔑</span> পার্মানেন্ট অটো-লগইন কি (Permanent Session Key)
        </div>
        <div style="font-size: 0.78rem; color: #94a3b8; line-height: 1.45; margin-bottom: 10px;">
          সার্ভার রিস্টার্ট হলেও যেন আর কখনো স্ক্যান না করতে হয়, তার জন্য নিচের কি-টি কপি করে Render-এর Environment-এ <b>WHATSAPP_SESSION_DATA</b> নামে বসিয়ে দিন।
        </div>
        <div style="display: flex; gap: 8px;">
          <input type="text" id="sessionKeyBox" readonly style="flex: 1; background: #020617; border: 1px solid #334155; color: #38bdf8; font-family: monospace; font-size: 0.82rem; padding: 10px 12px; border-radius: 8px; outline: none;">
          <button onclick="copySessionKey()" id="btnCopyKey" style="background: #22c55e; color: #052e16; font-weight: 800; font-size: 0.85rem; border: none; padding: 10px 16px; border-radius: 8px; cursor: pointer;">কপি 📋</button>
        </div>
        <div id="copyAlert" style="display: none; color: #4ade80; font-size: 0.8rem; font-weight: 700; margin-top: 6px;">✓ Session Key কপি করা হয়েছে!</div>
      </div>

      <!-- CHANGE NUMBER / LOGOUT BUTTON -->
      <button onclick="changeNumberLogout()" id="btnLogout" style="width: 100%; padding: 12px; background: rgba(239, 68, 68, 0.12); border: 1.5px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 12px; font-size: 0.9rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
        <span>🔄</span> নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)
      </button>
    </div>

    <!-- NOT CONNECTED SCREEN -->
    <div id="viewScan">
      <h1>WhatsApp কানেক্ট করুন</h1>
      <p class="sub">আপনার <b>${config.bot_phone_number}</b> নম্বরের ফোন দিয়ে নিচের QR কোডটি স্ক্যান করুন:</p>

      <div class="qr-container">
        <img id="qrImage" src="" alt="WhatsApp QR Code">
      </div>

      <div class="instructions">
        <ol>
          <li>আপনার ফোনে WhatsApp ওপেন করুন।</li>
          <li>উপরের ৩টি ডট বা <b>Settings</b>-এ যান।</li>
          <li><b>Linked Devices</b> (লিংক করা ডিভাইস)-এ চাপ দিন।</li>
          <li><b>Link a Device</b> চাপ দিয়ে উপরের QR কোডটি স্ক্যান করুন।</li>
        </ol>
      </div>

      <div class="pairing-box">
        <div style="font-size: 0.85rem; color: #94a3b8; font-weight: 600;">অথবা ক্যামেরা স্ক্যান ছাড়া কোড দিয়ে লিংক করুন:</div>
        <button class="btn-action" onclick="getPairingCode()" id="btnPair">Pairing Code তৈরি করুন 🔑</button>
        <div id="pairingCodeDisplay" class="pairing-code" style="display: none;">------</div>
        <div id="pairingHelp" style="display: none; font-size: 0.78rem; color: #94a3b8; margin-top: 6px;">
          ফোনে "Link with phone number instead" সিলেক্ট করে এই কোডটি লিখুন।
        </div>
      </div>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/api/bot-status');
        const data = await res.json();
        if (data.connected) {
          document.getElementById('viewScan').style.display = 'none';
          document.getElementById('viewConnected').style.display = 'block';
          const b = document.getElementById('statusBadge');
          b.className = 'badge connected';
          b.innerHTML = '● WhatsApp কানেক্টেড';
          if (data.sessionKey) {
            document.getElementById('sessionKeyBox').value = data.sessionKey;
          }
        } else {
          document.getElementById('viewScan').style.display = 'block';
          document.getElementById('viewConnected').style.display = 'none';
          if (data.qrImage) {
            document.getElementById('qrImage').src = data.qrImage;
          }
          if (data.pairingCode) {
            document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
            document.getElementById('pairingCodeDisplay').style.display = 'block';
            document.getElementById('pairingHelp').style.display = 'block';
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    function copySessionKey() {
      const box = document.getElementById('sessionKeyBox');
      box.select();
      navigator.clipboard.writeText(box.value).then(() => {
        document.getElementById('copyAlert').style.display = 'block';
        setTimeout(() => { document.getElementById('copyAlert').style.display = 'none'; }, 3000);
      });
    }

    async function changeNumberLogout() {
      if (!confirm('আপনি কি নিশ্চিত যে বর্তমান WhatsApp নম্বরটি ডিসকানেক্ট করে নতুন নম্বর দিয়ে স্ক্যান করতে চান?')) return;
      const btn = document.getElementById('btnLogout');
      btn.innerText = 'লগআউট হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/bot-logout', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          alert('সেশন ক্লিয়ার হয়েছে! এখন নতুন নম্বর দিয়ে স্ক্যান করতে পারবেন।');
          location.reload();
        } else {
          alert('এরর: ' + data.message);
          btn.innerText = '🔄 নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)';
          btn.disabled = false;
        }
      } catch (e) {
        alert('সার্ভার এরর: ' + e.message);
        btn.innerText = '🔄 নম্বর পরিবর্তন করুন (Change WhatsApp Number / Logout)';
        btn.disabled = false;
      }
    }

    async function getPairingCode() {
      const btn = document.getElementById('btnPair');
      btn.innerText = 'কোড তৈরি হচ্ছে...';
      btn.disabled = true;
      try {
        const res = await fetch('/api/request-pairing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: '${config.bot_phone_number}' })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('pairingCodeDisplay').innerText = data.pairingCode;
          document.getElementById('pairingCodeDisplay').style.display = 'block';
          document.getElementById('pairingHelp').style.display = 'block';
          btn.innerText = 'নতুন কোড পান 🔄';
          btn.disabled = false;
        } else {
          alert(data.message || 'Error');
          btn.innerText = 'Pairing Code তৈরি করুন 🔑';
          btn.disabled = false;
        }
      } catch (err) {
        alert('এরর: ' + err.message);
        btn.innerText = 'Pairing Code তৈরি করুন 🔑';
        btn.disabled = false;
      }
    }

    checkStatus();
    setInterval(checkStatus, 2500);
  </script>
</body>
</html>`);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [WEB TEST PORTAL READY] Open in browser: http://localhost:${PORT}`);
    console.log(`🔗 [QR LINK & PAIRING PAGE]: http://localhost:${PORT}/qr`);
});

startWhatsAppBot();
