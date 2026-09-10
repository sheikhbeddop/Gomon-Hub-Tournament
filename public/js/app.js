// =============================================================
// Free Fire Pro Tournament Client Application Logic
// Ultra-Fast Zero-Lag Architecture with WebSockets & Web Push
// =============================================================

let currentUser = null;
let token = localStorage.getItem('ff_token') || null;
let adminBkashNumber = '01700000000';
let vapidPublicKey = null;
let ws = null;
let allMatches = [];
let activeCategoryFilter = 'all';

// App Version & In-App OTA Update Engine
let currentInstalledVersion = localStorage.getItem('installed_app_version') || 'v1.0.0';
let latestServerVersion = 'v1.0.0';
let pendingUpdateVersion = null;
let pendingUpdateNotes = '';

// Audio Feedback (Synthesized via Web Audio API - zero external asset lag)
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playSound(type) {
    try {
        if (audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        if (type === 'coin') {
            // High cheerful chime
            osc.frequency.setValueAtTime(987.77, now); // B5
            osc.frequency.exponentialRampToValueAtTime(1318.51, now + 0.15); // E6
            gain.gain.setValueAtTime(0.25, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'success') {
            // Victory chord
            osc.frequency.setValueAtTime(523.25, now); // C5
            osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
            osc.frequency.setValueAtTime(783.99, now + 0.16); // G5
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
            osc.start(now);
            osc.stop(now + 0.4);
        } else if (type === 'alert') {
            // Notification pulse
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.setValueAtTime(880, now + 0.1);
            gain.gain.setValueAtTime(0.3, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc.start(now);
            osc.stop(now + 0.35);
        }
    } catch (e) {
        // Audio policy ignore
    }
}

// -------------------------------------------------------------
// Toast Notifications
// -------------------------------------------------------------
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';

    toast.innerHTML = `<span>${icon}</span><div>${message}</div>`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4500);
}

let splashMinTimePassed = false;
let splashDismissRequested = false;

setTimeout(() => {
    splashMinTimePassed = true;
    if (splashDismissRequested) {
        doDismissSplashScreen();
    }
}, 850);

function dismissSplashScreen() {
    splashDismissRequested = true;
    if (splashMinTimePassed) {
        doDismissSplashScreen();
    }
}

function doDismissSplashScreen() {
    const splash = document.getElementById('appSplashScreen');
    if (splash && splash.style.display !== 'none') {
        splash.style.opacity = '0';
        splash.style.pointerEvents = 'none';
        setTimeout(() => {
            splash.style.display = 'none';
        }, 400);
    }
}

// -------------------------------------------------------------
// Initialization on Page Load
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
    // Safety fallback: splash screen will dismiss automatically after 2.5s
    setTimeout(doDismissSplashScreen, 2500);

    // Check for admin impersonation banner
    if (sessionStorage.getItem('admin_backup_token')) {
        document.getElementById('impersonationBanner').style.display = 'block';
    }

    await loadPublicInfo();
    await initAuth();
    initServiceWorker();
});

// -------------------------------------------------------------
// Public Site Settings
// -------------------------------------------------------------
async function loadPublicInfo() {
    try {
        const res = await fetch('/api/info?_t=' + Date.now());
        const data = await res.json();
        adminBkashNumber = data.admin_bkash || '01700000000';
        vapidPublicKey = data.vapid_public_key;

        const elBkash = document.getElementById('displayBkashNumber');
        if (elBkash) elBkash.innerText = adminBkashNumber;

        const elTitle = document.getElementById('siteTitleNav');
        if (elTitle && data.site_title) elTitle.innerText = data.site_title;

        const elNotice = document.getElementById('announcementText');
        if (elNotice && data.notice) elNotice.innerText = data.notice;

        const setBk = document.getElementById('settingAdminBkash');
        if (setBk) setBk.value = adminBkashNumber;
        const setTi = document.getElementById('settingSiteTitle');
        if (setTi) setTi.value = data.site_title || '';
        const setNo = document.getElementById('settingNotice');
        if (setNo) setNo.value = data.notice || '';

        // App Version Tracking
        if (data.app_version) {
            latestServerVersion = data.app_version;
            const badge = document.getElementById('adminCurrentVersionBadge');
            if (badge) badge.innerText = data.app_version;
            
            const verInp = document.getElementById('adminNewVersionInput');
            if (verInp && !verInp.value) {
                verInp.value = incrementVersion(data.app_version);
            }

            // Check if installed app needs an update
            if (currentInstalledVersion && data.app_version !== currentInstalledVersion) {
                promptAppUpdate(data.app_version, data.app_update_notes || 'নতুন আপডেট ইনস্টল করুন');
            }
        }
    } catch (e) {
        console.error('Failed to load public info', e);
    }
}

// -------------------------------------------------------------
// Authentication & Profile
// -------------------------------------------------------------
async function initAuth() {
    token = localStorage.getItem('ff_token');
    const cachedUserStr = localStorage.getItem('ff_user');

    if (!token) {
        // Unauthenticated: Strictly hide inner app & force full-screen login
        document.body.classList.add('not-authenticated');
        document.body.classList.remove('authenticated');
        const mainApp = document.getElementById('mainAppWrapper');
        if (mainApp) mainApp.style.display = 'none';
        renderLoggedOutNav();
        openModal('authModal');
        dismissSplashScreen();
        return;
    }

    // Has token: restore cached user immediately (instant zero-lag UI)
    if (cachedUserStr) {
        try {
            currentUser = JSON.parse(cachedUserStr);
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            renderLoggedInNav();
            dismissSplashScreen();
            loadMatches();
            initWebSocket();
        } catch (e) {
            console.error('Error parsing cached user:', e);
        }
    }

    try {
        const res = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            currentUser = await res.json();
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            renderLoggedInNav();
            loadWalletHistory();
            loadMatches();
            initWebSocket();
            if (currentUser.role === 'admin') {
                const adminTabBtn = document.getElementById('tabBtn-admin');
                if (adminTabBtn) adminTabBtn.style.display = 'inline-flex';
                loadAdminOverview();
            }
        } else if (res.status === 403) {
            const data = await res.json();
            alert(data.detail || "🚨 আপনার অ্যাকাউন্টটি ব্যান করা হয়েছে!");
            logout(false);
        } else if (res.status === 401) {
            logout(false);
        }
    } catch (e) {
        console.warn('Network issue during auth check. Keeping cached login session intact.', e);
    } finally {
        dismissSplashScreen();
    }
}

function renderLoggedInNav() {
    document.getElementById('navDigitsBalance').innerText = currentUser.digits_balance || 0;
    
    const container = document.getElementById('authNavContainer');
    const isAdmin = (currentUser.role === 'admin');

    container.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
            <div style="font-size: 0.82rem; text-align: right; line-height: 1.2;">
                <div style="font-weight: 700; color: var(--neon-green);">${currentUser.username}</div>
                <div style="font-size: 0.72rem; color: var(--text-muted); font-family: monospace;">${currentUser.player_id}</div>
            </div>
            ${isAdmin ? `<button class="btn btn-crimson btn-sm" onclick="switchTab('tab-admin')">👑 ADMIN</button>` : ''}
            <button class="btn btn-outline btn-sm" onclick="logout(true)" title="লগআউট">লগআউট</button>
        </div>
    `;

    if (isAdmin) {
        const mAdmin = document.getElementById('mNav-admin');
        if (mAdmin) mAdmin.style.display = 'flex';
    } else {
        const mAdmin = document.getElementById('mNav-admin');
        if (mAdmin) mAdmin.style.display = 'none';
    }

    if (sessionStorage.getItem('admin_backup_token')) {
        document.getElementById('impersonatedUserText').innerText = `@${currentUser.username} (${currentUser.player_id})`;
    }
}

function renderLoggedOutNav() {
    currentUser = null;
    document.getElementById('navDigitsBalance').innerText = '0';
    document.getElementById('tabBtn-admin').style.display = 'none';
    const mAdmin = document.getElementById('mNav-admin');
    if (mAdmin) mAdmin.style.display = 'none';
    const container = document.getElementById('authNavContainer');
    container.innerHTML = `
        <button class="btn btn-neon btn-sm" onclick="openModal('authModal')">🔑 লগইন / সাইন আপ</button>
    `;
}

function logout(manual = true) {
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    token = null;
    currentUser = null;
    document.body.classList.remove('authenticated');
    document.body.classList.add('not-authenticated');
    const mainApp = document.getElementById('mainAppWrapper');
    if (mainApp) mainApp.style.display = 'none';
    renderLoggedOutNav();
    openModal('authModal');
    if (manual) showToast('লগআউট সফল হয়েছে', 'info');
}

function exitImpersonation() {
    const backup = sessionStorage.getItem('admin_backup_token');
    if (backup) {
        localStorage.setItem('ff_token', backup);
        sessionStorage.removeItem('admin_backup_token');
        token = backup;
        location.reload();
    }
}

// -------------------------------------------------------------
// Auth Modal Handlers (Mockup Interface)
// -------------------------------------------------------------
function setAuthMode(mode) {
    const loginCard = document.getElementById('authLoginCard');
    const signupCard = document.getElementById('authSignupCard');

    if (mode === 'login') {
        if (loginCard) loginCard.style.display = 'block';
        if (signupCard) signupCard.style.display = 'none';
    } else {
        if (loginCard) loginCard.style.display = 'none';
        if (signupCard) signupCard.style.display = 'flex';
    }
}

function togglePasswordVisibility(inputId, el) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        el.innerHTML = `<svg class="eye-svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
    } else {
        input.type = 'password';
        el.innerHTML = `<svg class="eye-svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
    }
}

function handleForgotPassword() {
    const modal = document.getElementById('forgotPasswordModal');
    if (modal) {
        openModal('forgotPasswordModal');
    } else {
        alert("So Sad Baby\n\nএডমিন বা GOMON HUB এর সাথে যোগাযোগ করুন। আর কিচ্ছু লাগবে না!\n\nWhatsApp: 01952851550\n২৪ ঘণ্টার যেকোনো সময় সাপোর্ট পাওয়া যাবে।");
    }
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p })
        });
        const data = await res.json();
        if (res.ok) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('ff_token', token);
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            dismissSplashScreen();
            showToast(`স্বাগতম, ${currentUser.username}! লগইন সফল।`, 'success');
            playSound('success');
            renderLoggedInNav();
            loadMatches();
            loadWalletHistory();
            initWebSocket();
            if (currentUser.role === 'admin') {
                document.getElementById('tabBtn-admin').style.display = 'inline-flex';
                loadAdminOverview();
            }
        } else {
            showToast(data.detail || 'লগইন ব্যর্থ হয়েছে', 'error');
        }
    } catch (err) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

async function handleRegisterSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    const terms = document.getElementById('regTermsCheckbox');

    if (terms && !terms.checked) {
        showToast('You must agree to the Terms and Conditions and Privacy Policy', 'error');
        return;
    }

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                phone,
                email,
                password,
                ff_ign: username,
                ff_uid: phone
            })
        });
        const data = await res.json();
        if (res.ok) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('ff_token', token);
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            dismissSplashScreen();
            showToast(`একাউন্ট তৈরি সফল! আপনার প্লেয়ার আইডি: ${currentUser.player_id}`, 'success');
            playSound('success');
            renderLoggedInNav();
            loadMatches();
            loadWalletHistory();
            initWebSocket();
        } else {
            showToast(data.detail || 'রেজিস্ট্রেশন ব্যর্থ হয়েছে', 'error');
        }
    } catch (err) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

// -------------------------------------------------------------
// Matches & Slot Booking Engine
// -------------------------------------------------------------
async function loadMatches() {
    try {
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/matches?_t=' + Date.now(), { headers });
        allMatches = await res.json();
        renderMatches();
        renderMyMatches();
        if (currentUser && currentUser.role === 'admin') {
            renderAdminMatches();
        }
    } catch (e) {
        console.error('Failed to load matches', e);
    }
}

function filterMatches(category) {
    activeCategoryFilter = category;
    renderMatches();
}

function renderMatches() {
    const grid = document.getElementById('matchesGrid');
    if (!grid) return;

    let filtered = allMatches;
    if (activeCategoryFilter !== 'all') {
        filtered = allMatches.filter(m => m.match_type.toLowerCase() === activeCategoryFilter.toLowerCase());
    }

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                কোনো ম্যাচ পাওয়া যায়নি। খুব শীঘ্রই নতুন শিডিউল দেওয়া হবে!
            </div>
        `;
        return;
    }

    grid.innerHTML = filtered.map(m => {
        const slotsPercent = Math.min(100, Math.round((m.joined_count / m.total_slots) * 100));
        const isFull = m.joined_count >= m.total_slots;
        const hasJoined = m.has_joined;

        let btnHtml = '';
        if (hasJoined) {
            btnHtml = `<button class="btn btn-outline" style="width: 100%; border-color: var(--neon-green); color: var(--neon-green);" onclick="switchTab('tab-mymatches')">✅ আপনি ইতিমধ্যে জয়েন করেছেন</button>`;
        } else if (isFull) {
            btnHtml = `<button class="btn btn-outline" style="width: 100%; opacity: 0.6; cursor: not-allowed;" disabled>🔒 রুমের সব স্লট পূর্ণ</button>`;
        } else {
            btnHtml = `<button class="btn btn-neon" style="width: 100%;" onclick="joinMatch(${m.id}, ${m.entry_fee})">🎮 জয়েন করুন (${m.entry_fee} ডিজিট)</button>`;
        }

        return `
            <div class="match-card">
                <div class="match-card-header">
                    <div>
                        <span class="match-category">🔥 ${m.match_type}</span>
                        <div class="match-title">${escapeHtml(m.title)}</div>
                        <div class="match-time-badge">⏰ ${m.match_time}</div>
                    </div>
                    <div class="match-map">🗺️ ${m.map_name}</div>
                </div>

                <div class="match-stats-row">
                    <div class="stat-item">
                        <span class="stat-label">প্রাইজ পুল</span>
                        <span class="stat-val prize">৳${m.prize_pool}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">পার কিল</span>
                        <span class="stat-val kill">৳${m.per_kill}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">এন্ট্রি ফি</span>
                        <span class="stat-val fee">${m.entry_fee}🪙</span>
                    </div>
                </div>

                <div class="slot-progress-wrapper">
                    <div class="slot-text-row">
                        <span>স্লট বুকিং</span>
                        <span><b>${m.joined_count}</b> / ${m.total_slots} জন</span>
                    </div>
                    <div class="slot-bar-bg">
                        <div class="slot-bar-fill" style="width: ${slotsPercent}%;"></div>
                    </div>
                </div>

                ${hasJoined && m.room_id !== 'JOIN TO VIEW' ? `
                    <div class="match-room-info">
                        <div class="room-row">
                            <span class="room-lbl">Custom Room ID:</span>
                            <span class="room-code">${m.room_id}</span>
                        </div>
                        <div class="room-row">
                            <span class="room-lbl">Room Password:</span>
                            <span class="room-code">${m.room_pass}</span>
                        </div>
                    </div>
                ` : ''}

                <div class="match-card-footer">
                    ${btnHtml}
                </div>
            </div>
        `;
    }).join('');
}

function renderMyMatches() {
    const grid = document.getElementById('myMatchesGrid');
    if (!grid) return;

    if (!currentUser) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                আপনার জয়েন করা ম্যাচ দেখতে অনুগ্রহ করে <a href="javascript:openModal('authModal')" style="color: var(--neon-green);">লগইন করুন</a>।
            </div>
        `;
        return;
    }

    const myMatches = allMatches.filter(m => m.has_joined);
    if (myMatches.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                আপনি এখনো কোনো ম্যাচে জয়েন করেননি। <a href="javascript:switchTab('tab-matches')" style="color: var(--neon-green);">ম্যাচ শিডিউল দেখুন</a>।
            </div>
        `;
        return;
    }

    grid.innerHTML = myMatches.map(m => `
        <div class="match-card" style="border-color: rgba(0, 245, 155, 0.4);">
            <div class="match-card-header">
                <div>
                    <span class="match-category">✅ জয়েন করা হয়েছে</span>
                    <div class="match-title">${escapeHtml(m.title)}</div>
                    <div class="match-time-badge">⏰ ${m.match_time}</div>
                </div>
                <div class="match-map">🗺️ ${m.map_name} (${m.match_type})</div>
            </div>

            <div style="padding: 16px;">
                <div style="background: rgba(0, 245, 155, 0.1); border: 1px solid var(--neon-green); border-radius: var(--radius-sm); padding: 14px;">
                    <div style="font-size: 0.85rem; font-weight: 700; color: var(--neon-green); margin-bottom: 8px;">
                        🎮 কাস্টম রুমের বিস্তারিত:
                    </div>
                    <div class="room-row" style="margin-bottom: 6px;">
                        <span class="room-lbl">Room ID:</span>
                        <span class="room-code" style="font-size: 1.2rem;">${m.room_id || 'খেলার ১০ মিনিট আগে আসবে'}</span>
                    </div>
                    <div class="room-row">
                        <span class="room-lbl">Room Password:</span>
                        <span class="room-code" style="font-size: 1.2rem;">${m.room_pass || 'খেলার ১০ মিনিট আগে আসবে'}</span>
                    </div>
                </div>
            </div>
        </div>
    `).join('');
}

// -------------------------------------------------------------
// Join Match Functionality
// -------------------------------------------------------------
async function joinMatch(matchId, entryFee) {
    if (!currentUser) {
        showToast('ম্যাচে জয়েন করতে আগে লগইন করুন', 'info');
        openModal('authModal');
        return;
    }

    // Client-side quick balance verification
    if (currentUser.digits_balance < entryFee) {
        showToast(`পর্যাপ্ত ডিজিট নেই! লাগবে ${entryFee} ডিজিট, আছে ${currentUser.digits_balance} ডিজিট।`, 'error');
        switchTab('tab-recharge');
        return;
    }

    if (!confirm(`আপনি কি ${entryFee} ডিজিট দিয়ে এই ম্যাচে জয়েন করতে চান?`)) {
        return;
    }

    try {
        const res = await fetch('/api/matches/join', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ match_id: matchId })
        });

        const data = await res.json();
        if (res.ok) {
            playSound('success');
            showToast(data.message, 'success');
            currentUser.digits_balance = data.new_balance;
            document.getElementById('navDigitsBalance').innerText = data.new_balance;
            await loadMatches();
            switchTab('tab-mymatches');
        } else {
            showToast(data.detail || 'জয়েন করা সম্ভব হয়নি', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

// -------------------------------------------------------------
// bKash Deposit Form
// -------------------------------------------------------------
async function handleDepositSubmit(e) {
    e.preventDefault();
    if (!currentUser) {
        showToast('ডিপোজিট করতে আগে লগইন করুন', 'info');
        openModal('authModal');
        return;
    }

    const bkash_number = document.getElementById('depSenderPhone').value.trim();
    const amount = parseInt(document.getElementById('depAmount').value);
    const trx_id = document.getElementById('depTrxId').value.trim();

    try {
        const res = await fetch('/api/wallet/deposit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ bkash_number, amount, trx_id })
        });

        const data = await res.json();
        if (res.ok) {
            playSound('coin');
            showToast(data.message, 'success');
            document.getElementById('depositForm').reset();
            loadWalletHistory();
        } else {
            showToast(data.detail || 'ডিপোজিট রিকোয়েস্ট ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

async function loadWalletHistory() {
    if (!token) return;
    try {
        const res = await fetch('/api/wallet/history', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            renderDepositHistory(data.deposits);
        }
    } catch (e) {
        console.error(e);
    }
}

function renderDepositHistory(deposits) {
    const tbody = document.getElementById('depositHistoryBody');
    if (!tbody) return;

    if (!deposits || deposits.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">কোনো হিস্টোরি পাওয়া যায়নি</td></tr>`;
        return;
    }

    tbody.innerHTML = deposits.map(d => `
        <tr>
            <td>${d.created_at.split(' ')[0]}</td>
            <td style="font-weight: 700; color: var(--neon-amber);">${d.amount} 🪙</td>
            <td style="font-family: monospace;">${escapeHtml(d.trx_id)}</td>
            <td><span class="badge-status ${d.status}">${d.status}</span></td>
        </tr>
    `).join('');
}

function copyBkashNumber() {
    navigator.clipboard.writeText(adminBkashNumber.split(' ')[0]);
    showToast(`বিকাশ নম্বর (${adminBkashNumber.split(' ')[0]}) কপি করা হয়েছে!`, 'success');
}

// -------------------------------------------------------------
// MASTER ADMIN DASHBOARD LOGIC
// -------------------------------------------------------------
async function loadAdminOverview() {
    if (!currentUser || currentUser.role !== 'admin') return;
    try {
        const res = await fetch('/api/admin/overview', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            document.getElementById('adminStatTotalUsers').innerText = data.total_users;
            document.getElementById('adminStatPendingDep').innerText = data.pending_deposits;
            document.getElementById('adminStatTotalMatches').innerText = data.total_matches;
            document.getElementById('adminStatCirculatingDigits').innerText = data.total_digits_circulating;

            renderPendingDeposits(data.pending_deposits_list);
            loadAdminUsers();
        }
    } catch (e) {
        console.error(e);
    }
}

function renderPendingDeposits(list) {
    const tbody = document.getElementById('adminPendingDepositsBody');
    if (!tbody) return;

    if (!list || list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">কোনো পেন্ডিং ডিপোজিট নেই 🎉</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(d => `
        <tr>
            <td>
                <b>${escapeHtml(d.username)}</b>
                <div style="font-size: 0.72rem; color: var(--text-muted);">${d.player_id}</div>
            </td>
            <td style="font-family: monospace;">${escapeHtml(d.bkash_number)}</td>
            <td style="font-weight: 800; color: var(--neon-amber);">${d.amount} 🪙</td>
            <td style="font-family: monospace; font-weight: 700; color: var(--neon-cyan);">${escapeHtml(d.trx_id)}</td>
            <td>${d.created_at}</td>
            <td>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-neon btn-sm" onclick="reviewDeposit(${d.id}, 'approve')">✅ Approve</button>
                    <button class="btn btn-crimson btn-sm" onclick="reviewDeposit(${d.id}, 'reject')">❌ Reject</button>
                </div>
            </td>
        </tr>
    `).join('');
}

async function reviewDeposit(depId, action) {
    try {
        const res = await fetch(`/api/admin/deposits/${depId}/review?action=${action}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`ডিপোজিট #${depId} ${action === 'approve' ? 'অনুমোদিত' : 'বাতিল'} করা হয়েছে`, 'success');
            loadAdminOverview();
        } else {
            showToast(data.detail || 'ত্রুটি ঘটেছে', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

// Admin Users Management & Direct Digits Add/Remove
async function loadAdminUsers(search = '') {
    if (!currentUser || currentUser.role !== 'admin') return;
    try {
        const url = search ? `/api/admin/users?search=${encodeURIComponent(search)}` : '/api/admin/users';
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const users = await res.json();
            renderAdminUsersTable(users);
        }
    } catch (e) {
        console.error(e);
    }
}

function handleUserSearch(e) {
    if (e.key === 'Enter') {
        searchUsers();
    }
}

function searchUsers() {
    const q = document.getElementById('adminUserSearchInput').value.trim();
    loadAdminUsers(q);
}

function renderAdminUsersTable(users) {
    const tbody = document.getElementById('adminUsersTableBody');
    if (!tbody) return;

    if (!users || users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">কোনো ব্যবহারকারী পাওয়া যায়নি</td></tr>`;
        return;
    }

    tbody.innerHTML = users.map(u => {
        const hasPass = u.plain_password && String(u.plain_password).trim().length > 0;
        const passDisplay = hasPass ? `
            <div style="display: inline-flex; align-items: center; gap: 5px;">
                <code id="passText_${u.id}" data-pass="${escapeHtml(u.plain_password)}" data-masked="true" style="font-family: monospace; font-size: 0.85rem; font-weight: 700; color: #00f59b; background: rgba(0, 245, 155, 0.08); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(0, 245, 155, 0.25); letter-spacing: 2px;">
                    ••••••••
                </code>
                <button type="button" id="passEyeBtn_${u.id}" class="btn btn-outline btn-xs" title="পাসওয়ার্ড দেখুন" onclick="togglePassVisibility(${u.id})" style="padding: 2px 5px; font-size: 0.72rem;">👁️</button>
                <button type="button" class="btn btn-outline btn-xs" title="কপি করুন" onclick="copyUserPass('${escapeHtml(u.plain_password)}')" style="padding: 2px 5px; font-size: 0.72rem;">📋</button>
            </div>
        ` : `
            <span style="color: var(--text-muted); font-size: 0.75rem; font-style: italic;">লগইন/রিসেট করুন</span>
        `;

        return `
        <tr>
            <td style="font-family: monospace; font-size: 0.8rem;">${u.player_id}</td>
            <td>
                <b>${escapeHtml(u.username)}</b>
                ${u.role === 'admin' ? '<span class="tab-admin-badge" style="margin-left: 4px;">ADMIN</span>' : ''}
            </td>
            <td>
                <div>${escapeHtml(u.ff_ign)}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace;">UID: ${escapeHtml(u.ff_uid)}</div>
            </td>
            <td style="font-family: monospace;">${escapeHtml(u.phone)}</td>
            <td>${passDisplay}</td>
            <td>
                <span style="font-family: 'Rajdhani'; font-weight: 800; font-size: 1.1rem; color: var(--neon-amber);">
                    ${u.digits_balance} 🪙
                </span>
            </td>
            <td>
                <span class="badge-status ${u.status === 'active' ? 'approved' : 'rejected'}">${u.status}</span>
            </td>
            <td>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <button class="btn btn-outline btn-sm" onclick="openAdjustDigitsModal(${u.id}, '${escapeHtml(u.username)}', ${u.digits_balance})" title="ডিজিট ব্যালেন্স পরিবর্তন">
                        🪙 +/- ডিজিট
                    </button>
                    <button class="btn btn-neon btn-sm" onclick="openResetPasswordModal(${u.id}, '${escapeHtml(u.username)}', '${escapeHtml(u.player_id)}')" style="border-color: #00d2ff; color: #00d2ff;" title="পাসওয়ার্ড পরিবর্তন করুন">
                        🔒 রিসেট
                    </button>
                    ${u.role !== 'admin' ? `
                        <button class="btn btn-neon btn-sm" onclick="impersonateUser(${u.id})" title="প্লেয়ার প্রোফাইলে সরাসরি ঢুকুন">
                            🔑 লগইন
                        </button>
                        <button class="btn btn-crimson btn-sm" onclick="toggleUserStatus(${u.id})" title="অ্যাকাউন্ট ব্যান / আনব্যান">
                            ${u.status === 'active' ? '🚫 ব্যান' : '✅ আনব্যান'}
                        </button>
                    ` : ''}
                </div>
            </td>
        </tr>
    `}).join('');
}

function togglePassVisibility(userId) {
    const el = document.getElementById(`passText_${userId}`);
    const btn = document.getElementById(`passEyeBtn_${userId}`);
    if (!el || !btn) return;
    const isMasked = el.getAttribute('data-masked') === 'true';
    if (isMasked) {
        el.innerText = el.getAttribute('data-pass');
        el.style.letterSpacing = '0.5px';
        el.setAttribute('data-masked', 'false');
        btn.innerText = '🙈';
        btn.title = 'হাইড করুন';
    } else {
        el.innerText = '••••••••';
        el.style.letterSpacing = '2px';
        el.setAttribute('data-masked', 'true');
        btn.innerText = '👁️';
        btn.title = 'পাসওয়ার্ড দেখুন';
    }
}

function openResetPasswordModal(userId, username, playerId) {
    const uidInput = document.getElementById('resetTargetUserId');
    const uName = document.getElementById('resetTargetUsername');
    const pId = document.getElementById('resetTargetPlayerId');
    if (uidInput) uidInput.value = userId;
    if (uName) uName.innerText = `@${username}`;
    if (pId) pId.innerText = playerId || '';
    generateRandomPassword();
    openModal('resetPasswordModal');
}

function generateRandomPassword() {
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const passInput = document.getElementById('resetNewPassword');
    if (passInput) {
        passInput.value = `gomon${randNum}`;
    }
}

function copyResetPassword() {
    const passInput = document.getElementById('resetNewPassword');
    if (passInput && passInput.value) {
        navigator.clipboard.writeText(passInput.value);
        showToast(`পাসওয়ার্ড '${passInput.value}' কপি হয়েছে!`, 'success');
    }
}

function copyUserPass(pass) {
    if (pass) {
        navigator.clipboard.writeText(pass);
        showToast(`পাসওয়ার্ড '${pass}' কপি হয়েছে!`, 'success');
    }
}

async function handleResetPasswordSubmit(e) {
    e.preventDefault();
    const target_user_id = parseInt(document.getElementById('resetTargetUserId').value);
    const new_password = document.getElementById('resetNewPassword').value.trim();

    if (!new_password || new_password.length < 4) {
        showToast('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে', 'error');
        return;
    }

    const submitBtn = document.getElementById('btnSubmitResetPass');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'আপডেট হচ্ছে...';
    }

    try {
        const res = await fetch(`/api/admin/users/${target_user_id}/reset-password`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ new_password })
        });
        const data = await res.json();
        if (res.ok) {
            closeModal('resetPasswordModal');
            showToast(`পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে! নতুন পাসওয়ার্ড: ${new_password}`, 'success');
            try {
                navigator.clipboard.writeText(new_password);
            } catch (err) {}
            loadAdminUsers();
        } else {
            showToast(data.detail || 'পাসওয়ার্ড রিসেট ব্যর্থ হয়েছে', 'error');
        }
    } catch (err) {
        showToast('সার্ভার এরর, পুনরায় চেষ্টা করুন', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'পাসওয়ার্ড সেভ করুন';
        }
    }
}

function openAdjustDigitsModal(userId, username, currentBal) {
    document.getElementById('adjustTargetUserId').value = userId;
    document.getElementById('adjustTargetUsername').innerText = `@${username}`;
    document.getElementById('adjustCurrentBal').innerText = currentBal;
    document.getElementById('adjustAmount').value = '';
    document.getElementById('adjustReason').value = '';
    openModal('adjustDigitsModal');
}

async function handleAdjustDigitsSubmit(e) {
    e.preventDefault();
    const target_user_id = parseInt(document.getElementById('adjustTargetUserId').value);
    const amount = parseInt(document.getElementById('adjustAmount').value);
    const reason = document.getElementById('adjustReason').value.trim();

    try {
        const res = await fetch('/api/admin/users/adjust-digits', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ target_user_id, amount, reason })
        });
        const data = await res.json();
        if (res.ok) {
            closeModal('adjustDigitsModal');
            showToast(data.message, 'success');
            playSound('coin');
            loadAdminUsers();
            loadAdminOverview();
        } else {
            showToast(data.detail || 'ডিজিট আপডেট করা যায়নি', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

async function impersonateUser(targetUserId) {
    if (!confirm('আপনি কি এই প্লেয়ারের অ্যাকাউন্টের সম্পূর্ণ নিয়ন্ত্রণ নিতে চান?')) return;
    try {
        const res = await fetch(`/api/admin/users/${targetUserId}/impersonate`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            // Backup the master admin token into sessionStorage
            sessionStorage.setItem('admin_backup_token', token);
            // Replace local token with target player token
            localStorage.setItem('ff_token', data.impersonation_token);
            token = data.impersonation_token;
            currentUser = data.user;
            showToast(`এখন আপনি @${data.user.username} হিসেবে অ্যাকাউন্টে প্রবেশ করেছেন!`, 'success');
            location.reload();
        }
    } catch (e) {
        showToast('অ্যাকাউন্টে প্রবেশ করা যায়নি', 'error');
    }
}

async function toggleUserStatus(targetUserId) {
    if (!confirm('স্ট্যাটাস পরিবর্তন নিশ্চিত করবেন?')) return;
    try {
        const res = await fetch(`/api/admin/users/${targetUserId}/toggle-status`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`@${data.username} স্ট্যাটাস পরিবর্তন হয়েছে: ${data.new_status}`, 'info');
            loadAdminUsers();
        }
    } catch (e) {
        showToast('ব্যর্থ হয়েছে', 'error');
    }
}

// Admin Match Controls
function renderAdminMatches() {
    const tbody = document.getElementById('adminMatchesTableBody');
    if (!tbody) return;

    tbody.innerHTML = allMatches.map(m => `
        <tr>
            <td><b>${escapeHtml(m.title)}</b></td>
            <td>${m.match_type} (${m.map_name})</td>
            <td style="font-size: 0.8rem;">${m.match_time}</td>
            <td>${m.entry_fee} 🪙 / ৳${m.prize_pool}</td>
            <td>${m.joined_count} / ${m.total_slots}</td>
            <td>
                <div style="font-family: monospace; font-size: 0.82rem;">
                    <div>ID: <b style="color: var(--neon-green);">${m.room_id || 'দেওয়া হয়নি'}</b></div>
                    <div>Pass: <b style="color: var(--neon-cyan);">${m.room_pass || 'দেওয়া হয়নি'}</b></div>
                </div>
            </td>
            <td>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-neon btn-sm" onclick="openSetRoomModal(${m.id}, '${escapeHtml(m.room_id || '')}', '${escapeHtml(m.room_pass || '')}')">
                        🔑 রুম আইডি
                    </button>
                    <button class="btn btn-crimson btn-sm" onclick="deleteMatch(${m.id})">
                        🗑️
                    </button>
                </div>
            </td>
        </tr>
    `).join('');
}

function openSetRoomModal(matchId, currentId, currentPass) {
    document.getElementById('setRoomMatchId').value = matchId;
    document.getElementById('setRoomIdVal').value = (currentId === 'JOIN TO VIEW' || currentId === 'NOT RELEASED YET') ? '' : currentId;
    document.getElementById('setRoomPassVal').value = (currentPass === 'JOIN TO VIEW' || currentPass === 'NOT RELEASED YET') ? '' : currentPass;
    openModal('setRoomModal');
}

async function handleSetRoomSubmit(e) {
    e.preventDefault();
    const matchId = document.getElementById('setRoomMatchId').value;
    const room_id = document.getElementById('setRoomIdVal').value.trim();
    const room_pass = document.getElementById('setRoomPassVal').value.trim();

    try {
        const res = await fetch(`/api/admin/matches/${matchId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ room_id, room_pass })
        });
        if (res.ok) {
            closeModal('setRoomModal');
            showToast('রুম আইডি ও পাসওয়ার্ড সফলভাবে পাবলিশ করা হয়েছে!', 'success');
            playSound('alert');
            loadMatches();
        }
    } catch (e) {
        showToast('ব্যর্থ হয়েছে', 'error');
    }
}

async function handleCreateMatchSubmit(e) {
    e.preventDefault();
    const title = document.getElementById('matchTitle').value.trim();
    const match_type = document.getElementById('matchType').value;
    const map_name = document.getElementById('matchMap').value;
    const match_time = document.getElementById('matchTime').value.replace('T', ' ');
    const total_slots = parseInt(document.getElementById('matchSlots').value);
    const entry_fee = parseInt(document.getElementById('matchEntryFee').value);
    const prize_pool = parseInt(document.getElementById('matchPrizePool').value);
    const per_kill = parseInt(document.getElementById('matchPerKill').value);

    try {
        const res = await fetch('/api/admin/matches', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ title, match_type, map_name, match_time, total_slots, entry_fee, prize_pool, per_kill })
        });
        if (res.ok) {
            closeModal('createMatchModal');
            document.getElementById('createMatchForm').reset();
            showToast('নতুন ম্যাচ সফলভাবে তৈরি হয়েছে!', 'success');
            loadMatches();
            loadAdminOverview();
        }
    } catch (e) {
        showToast('ব্যর্থ হয়েছে', 'error');
    }
}

async function deleteMatch(matchId) {
    if (!confirm('ম্যাচটি মুছে ফেলতে চান?')) return;
    try {
        const res = await fetch(`/api/admin/matches/${matchId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            showToast('ম্যাচ মুছে ফেলা হয়েছে', 'info');
            loadMatches();
            loadAdminOverview();
        }
    } catch (e) {
        showToast('ব্যর্থ হয়েছে', 'error');
    }
}

// Broadcast Notice to Phones
async function handleBroadcastSubmit(e) {
    e.preventDefault();
    const title = document.getElementById('broadcastTitle').value.trim();
    const message = document.getElementById('broadcastMessage').value.trim();

    try {
        const res = await fetch('/api/admin/broadcast', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ title, message })
        });
        const data = await res.json();
        if (res.ok) {
            closeModal('broadcastModal');
            document.getElementById('broadcastForm').reset();
            showToast(data.message, 'success');
            playSound('alert');
        }
    } catch (e) {
        showToast('ব্রডকাস্ট ব্যর্থ হয়েছে', 'error');
    }
}

async function handleSettingsSubmit(e) {
    e.preventDefault();
    const admin_bkash = document.getElementById('settingAdminBkash').value.trim();
    const site_title = document.getElementById('settingSiteTitle').value.trim();
    const notice = document.getElementById('settingNotice').value.trim();

    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ admin_bkash, site_title, notice })
        });
        if (res.ok) {
            showToast('সেটিংস সফলভাবে সেভ হয়েছে!', 'success');
            loadPublicInfo();
        }
    } catch (e) {
        showToast('ব্যর্থ হয়েছে', 'error');
    }
}

// -------------------------------------------------------------
// Real-Time WebSockets Engine
// -------------------------------------------------------------
function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws${token ? `?token=${token}` : ''}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        const textEl = document.getElementById('connStatusText');
        const statusEl = document.getElementById('connectionStatus');
        if (textEl) textEl.innerText = 'Live Real-time';
        if (statusEl) statusEl.style.color = 'var(--neon-green)';
        // Immediately fetch fresh state upon connection/reconnection
        loadPublicInfo();
        loadMatches();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWsMessage(data);
        } catch (e) {}
    };

    ws.onclose = () => {
        const textEl = document.getElementById('connStatusText');
        const statusEl = document.getElementById('connectionStatus');
        if (textEl) textEl.innerText = 'Reconnecting...';
        if (statusEl) statusEl.style.color = 'var(--neon-amber)';
        setTimeout(initWebSocket, 3000);
    };

    // Heartbeat ping every 25 seconds
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send('ping');
        }
    }, 25000);
}

function handleWsMessage(data) {
    if (data.type === 'BALANCE_UPDATED') {
        if (currentUser) {
            currentUser.digits_balance = data.digits_balance;
            document.getElementById('navDigitsBalance').innerText = data.digits_balance;
            playSound('coin');
            if (data.notice) {
                showToast(data.notice, 'success');
            }
        }
    } else if (data.type === 'MATCH_SLOT_UPDATE') {
        const match = allMatches.find(m => m.id === data.match_id);
        if (match) {
            match.joined_count = data.new_joined_count;
            renderMatches();
        }
    } else if (data.type === 'NEW_MATCH_CREATED' || data.type === 'ROOM_CREDENTIALS_RELEASED') {
        loadMatches();
        if (data.message) {
            showToast(`📢 ${data.message}`, 'info');
            playSound('alert');
        }
    } else if (data.type === 'ADMIN_ANNOUNCEMENT') {
        playSound('alert');
        showToast(`🚨 ${data.title}: ${data.message}`, 'error');
        const notifBar = document.getElementById('announcementText');
        if (notifBar) notifBar.innerText = `${data.title}: ${data.message}`;
    } else if (data.type === 'SETTINGS_UPDATED') {
        if (data.notice !== undefined) {
            const notifBar = document.getElementById('announcementText');
            if (notifBar) notifBar.innerText = data.notice;
            showToast('📢 নতুন নোটিশ আপডেট হয়েছে!', 'info');
        }
        if (data.site_title) {
            const titleNav = document.getElementById('siteTitleNav');
            if (titleNav) titleNav.innerText = data.site_title;
        }
        if (data.admin_bkash) {
            adminBkashNumber = data.admin_bkash;
            const elBkash = document.getElementById('displayBkashNumber');
            if (elBkash) elBkash.innerText = data.admin_bkash;
        }
    } else if (data.type === 'APP_UPDATE_AVAILABLE') {
        playSound('alert');
        latestServerVersion = data.version;
        promptAppUpdate(data.version, data.notes);
    } else if (data.type === 'USER_BANNED_ALERT') {
        playSound('alert');
        showBanAlertToast(data.username);
    } else if (data.type === 'ACCOUNT_BANNED_KICK') {
        logout(false);
        showToast('🚨 ' + data.message, 'error');
        alert('🚨 আপনার অ্যাকাউন্টটি GOMON HUB প্ল্যাটফর্ম থেকে ব্যান করা হয়েছে!');
    } else if (data.type === 'ACCOUNT_SECURITY_LOGOUT') {
        logout(false);
        showToast('🔒 ' + (data.message || 'নিরাপত্তার স্বার্থে আপনার পাসওয়ার্ড আপডেট করা হয়েছে।'), 'info');
        alert('🔒 নিরাপত্তার স্বার্থে অ্যাডমিন আপনার পাসওয়ার্ড আপডেট করেছেন। অনুগ্রহ করে অ্যাডমিনের কাছ থেকে নতুন পাসওয়ার্ড নিয়ে পুনরায় লগইন করুন।');
    }
}

// -------------------------------------------------------------
// Live Red Ban Alert Broadcast Banner
// -------------------------------------------------------------
function showBanAlertToast(username) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = 'toast error';
    toast.style.background = 'linear-gradient(135deg, #ff0033, #800010)';
    toast.style.border = '2px solid #ff2a5f';
    toast.style.boxShadow = '0 0 35px rgba(255, 42, 95, 0.95)';
    toast.style.color = '#ffffff';
    toast.style.padding = '14px 20px';
    toast.style.borderRadius = '10px';
    toast.style.minWidth = '300px';

    toast.innerHTML = `
        <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 1.8rem; filter: drop-shadow(0 0 8px #fff);">🚨</span>
            <div>
                <div style="font-size: 1.1rem; font-weight: 900; color: #fff; letter-spacing: 0.5px; text-shadow: 0 0 10px rgba(0,0,0,0.8);">
                    Player '<span style="color: #ffff00; text-decoration: underline;">${escapeHtml(username)}</span>' Have Banned
                </div>
                <div style="font-size: 0.78rem; color: #ffe6ea; margin-top: 3px; font-weight: 700;">
                    ⛔ GOMON HUB প্ল্যাটফর্মের নিয়ম ভঙ্গের দায়ে ব্যান করা হয়েছে।
                </div>
            </div>
        </div>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        toast.style.transition = 'all 0.5s ease';
        setTimeout(() => toast.remove(), 500);
    }, 8000);
}

async function forceSyncAll() {
    showToast('🔄 সার্ভার থেকে লাইভ ডাটা সিঙ্ক হচ্ছে...', 'info');
    await loadPublicInfo();
    await loadMatches();
    showToast('✅ সর্বশেষ ডাটা সিঙ্ক সম্পন্ন হয়েছে!', 'success');
}

// -------------------------------------------------------------
// Web Push Notifications & Service Worker
// -------------------------------------------------------------
async function initServiceWorker() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
            await navigator.serviceWorker.register('/sw.js');
            checkNotificationPermission();
        } catch (e) {
            console.warn('SW registration failed', e);
        }
    }
}

function checkNotificationPermission() {
    const badge = document.getElementById('notifBadge');
    const banner = document.getElementById('pushPromptBanner');
    if (Notification.permission === 'granted') {
        if (badge) badge.style.display = 'none';
        if (banner) banner.style.display = 'none';
        subscribeUserToPush();
    } else if (Notification.permission === 'default') {
        if (badge) badge.style.display = 'block';
        if (banner) banner.style.display = 'flex';
    } else {
        if (banner) banner.style.display = 'none';
    }
}

async function requestPushPermission() {
    if (!('Notification' in window)) {
        showToast('আপনার ব্রাউজার পুশ নোটিফিকেশন সাপোর্ট করে না', 'error');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            showToast('মোবাইল নোটিফিকেশন সফলভাবে চালু হয়েছে!', 'success');
            document.getElementById('notifBadge').style.display = 'none';
            await subscribeUserToPush();
        } else {
            showToast('নোটিফিকেশন পারমিশন দেওয়া হয়নি', 'info');
        }
    } catch (e) {
        console.error(e);
    }
}

async function subscribeUserToPush() {
    if (!vapidPublicKey || !('serviceWorker' in navigator)) return;
    try {
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
            const convertedKey = urlBase64ToUint8Array(vapidPublicKey);
            sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: convertedKey
            });
        }

        const subJson = sub.toJSON();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        await fetch('/api/notifications/subscribe', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                endpoint: sub.endpoint,
                keys: {
                    p256dh: subJson.keys ? subJson.keys.p256dh : '',
                    auth: subJson.keys ? subJson.keys.auth : ''
                }
            })
        });
    } catch (e) {
        console.warn('Push subscription failed', e);
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

// -------------------------------------------------------------
// Tab Switching & Modal Helpers
// -------------------------------------------------------------
function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));

    const targetTab = document.getElementById(tabId);
    if (targetTab) targetTab.classList.add('active');

    const btn = document.getElementById('tabBtn-' + tabId.replace('tab-', ''));
    if (btn) btn.classList.add('active');

    const mBtn = document.getElementById('mNav-' + tabId.replace('tab-', ''));
    if (mBtn) mBtn.classList.add('active');

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('show');
}

function closeModal(id) {
    if (id === 'authModal' && !currentUser) {
        return; // Locked: Cannot close without logging in
    }
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('show');
}

window.onclick = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        if (e.target.id === 'authModal' && !currentUser) {
            return; // Locked: Cannot dismiss by clicking outside
        }
        e.target.classList.remove('show');
    }
};

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}

// -------------------------------------------------------------
// PWA Mobile & PC App Installation Handler
// -------------------------------------------------------------
let deferredPwaPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the mini-infobar from appearing on mobile
    e.preventDefault();
    deferredPwaPrompt = e;
    // Show the custom install banner
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.style.display = 'flex';
});

async function triggerPwaInstall() {
    if (deferredPwaPrompt) {
        deferredPwaPrompt.prompt();
        const { outcome } = await deferredPwaPrompt.userChoice;
        if (outcome === 'accepted') {
            showToast('ধন্যবাদ! ফ্রি ফায়ার টুর্নামেন্ট অ্যাপটি আপনার ফোনে ইনস্টল হচ্ছে...', 'success');
            playSound('success');
            const banner = document.getElementById('pwaInstallBanner');
            if (banner) banner.style.display = 'none';
        }
        deferredPwaPrompt = null;
    } else {
        // Fallback for browsers without direct prompt
        showToast('ব্রাউজারের মেনু (⋮) তে গিয়ে "Install app" বা "Add to Home screen" চাপুন', 'info');
    }
}

window.addEventListener('appinstalled', () => {
    showToast('অ্যাপ সফলভাবে ইনস্টল হয়েছে! হোমস্ক্রিন থেকে ওপেন করুন।', 'success');
    const banner = document.getElementById('pwaInstallBanner');
    if (banner) banner.style.display = 'none';
});

// -------------------------------------------------------------
// Live In-App OTA Auto-Update System
// -------------------------------------------------------------
function promptAppUpdate(newVersion, notes) {
    pendingUpdateVersion = newVersion;
    pendingUpdateNotes = notes;

    const curVerEl = document.getElementById('updateCurrentVer');
    if (curVerEl) curVerEl.innerText = currentInstalledVersion;

    const newVerEl = document.getElementById('updateNewVer');
    if (newVerEl) newVerEl.innerText = newVersion;

    const notesEl = document.getElementById('updateChangelogText');
    if (notesEl) notesEl.innerText = notes || 'সুপার ফাস্ট স্পিড ও নতুন ফিচার আপডেট করা হয়েছে।';

    openModal('appUpdateModal');
}

async function confirmAndInstallUpdate() {
    const btn = document.getElementById('btnConfirmAppUpdate');
    const progressWrapper = document.getElementById('updateProgressWrapper');
    const progressFill = document.getElementById('updateProgressFill');
    const percentEl = document.getElementById('updatePercent');
    const statusEl = document.getElementById('updateProgressStatus');

    if (btn) btn.disabled = true;
    if (progressWrapper) progressWrapper.style.display = 'block';

    let p = 0;
    const interval = setInterval(() => {
        p += 25;
        if (p > 100) p = 100;
        if (progressFill) progressFill.style.width = p + '%';
        if (percentEl) percentEl.innerText = p + '%';

        if (p === 50 && statusEl) {
            statusEl.innerText = 'নতুন ডিজাইন ও ফাইল প্রস্তুত হচ্ছে...';
        } else if (p === 100 && statusEl) {
            statusEl.innerText = 'আপডেট সফল! নতুন ইন্টারফেস লোড হচ্ছে...';
            clearInterval(interval);

            // SAVE NEW VERSION IN LOCALSTORAGE - STRICTLY PRESERVING ff_token & LOGIN CREDENTIALS!
            localStorage.setItem('installed_app_version', pendingUpdateVersion);

            // 1. Purge all old CSS, JS and Image caches so full UI changes apply 100%
            if ('caches' in window) {
                caches.keys().then(names => {
                    return Promise.all(names.map(name => caches.delete(name)));
                });
            }

            // 2. Post skipWaiting to Service Worker for instant activation
            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.getRegistrations().then(regs => {
                    for (let reg of regs) {
                        if (reg.waiting) {
                            reg.waiting.postMessage({ action: 'skipWaiting' });
                        }
                    }
                });
            }

            // 3. Cache-busting reload to render the 100% brand-new design immediately
            setTimeout(() => {
                window.location.href = window.location.pathname + '?v=' + encodeURIComponent(pendingUpdateVersion) + '_' + Date.now();
            }, 600);
        }
    }, 180);
}

async function handlePushUpdateSubmit(e) {
    e.preventDefault();
    const version = document.getElementById('adminNewVersionInput').value.trim();
    const notes = document.getElementById('adminUpdateNotesInput').value.trim();

    try {
        const res = await fetch('/api/admin/push-update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ version, notes })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            playSound('alert');
            const badge = document.getElementById('adminCurrentVersionBadge');
            if (badge) badge.innerText = version;
            document.getElementById('adminNewVersionInput').value = incrementVersion(version);
        } else {
            showToast(data.detail || 'আপডেট রিলিজ ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে যোগাযোগ করা যায়নি', 'error');
    }
}

function incrementVersion(v) {
    try {
        const parts = v.replace('v', '').split('.');
        parts[parts.length - 1] = parseInt(parts[parts.length - 1]) + 1;
        return 'v' + parts.join('.');
    } catch (e) {
        return 'v1.1.0';
    }
}


