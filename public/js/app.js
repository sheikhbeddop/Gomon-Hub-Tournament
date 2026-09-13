// =============================================================
// Free Fire Pro Tournament Client Application Logic
// Ultra-Fast Zero-Lag Architecture with WebSockets & Web Push
// =============================================================

let currentUser = null;
let token = localStorage.getItem('ff_token') || null;
let adminBkashNumber = '01988279285 (Personal)';
let adminWithdrawNumber = '01988279285 (Personal)';

function copyAdminBkash() {
    const raw = adminBkashNumber || '01988279285';
    const numOnly = raw.split(' ')[0].trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(numOnly);
    }
    showToast(`ডিপোজিট বিকাশ নাম্বার (${numOnly}) কপি করা হয়েছে!`, 'success');
}

function copyAdminWithdraw() {
    const raw = adminWithdrawNumber || adminBkashNumber || '01988279285';
    const numOnly = raw.split(' ')[0].trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(numOnly);
    }
    showToast(`উইথড্র নাম্বার (${numOnly}) কপি করা হয়েছে!`, 'success');
}

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
let audioCtx = null;
function getAudioContext() {
    if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('AudioContext init error:', e);
        }
    }
    return audioCtx;
}

function playSound(type) {
    try {
        const ctx = getAudioContext();
        if (!ctx) return;
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);

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

// -------------------------------------------------------------
// Universal API Request Helper
// -------------------------------------------------------------
async function apiRequest(endpoint, method = 'GET', body = null) {
    const headers = {};
    const activeToken = token || localStorage.getItem('token') || localStorage.getItem('ff_token');
    if (activeToken) {
        headers['Authorization'] = `Bearer ${activeToken}`;
    }
    if (body && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
    }

    const options = {
        method,
        headers
    };
    if (body) {
        options.body = (body instanceof FormData) ? body : JSON.stringify(body);
    }

    const res = await fetch(endpoint, options);
    let data;
    try {
        data = await res.json();
    } catch (e) {
        data = { success: res.ok, status: res.status };
    }

    if (!res.ok) {
        const errorMsg = data.detail || data.message || `Request failed (${res.status})`;
        const err = new Error(errorMsg);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
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
async function startApp() {
    setTimeout(doDismissSplashScreen, 800);

    const uInp = document.getElementById('loginUsername');
    const pInp = document.getElementById('loginPassword');
    if (uInp) uInp.addEventListener('input', clearLoginError);
    if (pInp) pInp.addEventListener('input', clearLoginError);

    const rU = document.getElementById('regUsername');
    const rP = document.getElementById('regPhone');
    const rE = document.getElementById('regEmail');
    const rPass = document.getElementById('regPassword');
    if (rU) rU.addEventListener('input', clearSignupError);
    if (rP) rP.addEventListener('input', clearSignupError);
    if (rE) rE.addEventListener('input', clearSignupError);
    if (rPass) rPass.addEventListener('input', clearSignupError);

    if (sessionStorage.getItem('admin_backup_token')) {
        const impBanner = document.getElementById('impersonationBanner');
        if (impBanner) impBanner.style.display = 'block';
    }

    await loadPublicInfo();
    await initAuth();
    initServiceWorker();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}

// -------------------------------------------------------------
// Public Site Settings
// -------------------------------------------------------------
async function loadPublicInfo() {
    try {
        const res = await fetch('/api/info?_t=' + Date.now());
        const data = await res.json();
        adminBkashNumber = data.admin_bkash || '01988279285 (Personal)';
        adminWithdrawNumber = data.admin_withdraw_number || adminBkashNumber;
        vapidPublicKey = data.vapid_public_key;

        // Update all deposit numbers in UI
        document.querySelectorAll('.displayBkashNumber, [id="displayBkashNumber"]').forEach(el => {
            el.innerText = adminBkashNumber;
        });

        // Update all withdraw numbers in UI
        document.querySelectorAll('.displayWithdrawNumber, [id="displayWithdrawNumber"]').forEach(el => {
            el.innerText = adminWithdrawNumber;
        });

        const elTitle = document.getElementById('siteTitleNav');
        if (elTitle && data.site_title) elTitle.innerText = data.site_title;

        const elNotice = document.getElementById('announcementText');
        if (elNotice && data.notice) elNotice.innerText = data.notice;

        const setBk = document.getElementById('settingAdminBkash');
        if (setBk) setBk.value = adminBkashNumber;

        const setWith = document.getElementById('settingAdminWithdraw');
        if (setWith) setWith.value = adminWithdrawNumber;

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
                promptAppUpdate(data.app_version, data.app_update_notes || 'Install the latest update');
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
        document.body.classList.add('not-authenticated');
        document.body.classList.remove('authenticated');
        const mainApp = document.getElementById('mainAppWrapper');
        if (mainApp) mainApp.style.display = 'block';
        renderLoggedOutNav();
        renderUserProfile();
        loadMatches();
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
            applyRolePermissionsUI();
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
            renderUserProfile();
            applyRolePermissionsUI();
            loadWalletHistory();
            loadMatches();
            initWebSocket();
            if (currentUser.role === 'admin') {
                loadAdminOverview();
                loadModeratorScoreboard();
            }
        } else if (res.status === 403) {
            const data = await res.json();
            alert(data.detail || "🚨 Your account has been banned from GOMON HUB!");
            logout(false);
        } else if (res.status === 401 || res.status === 404) {
            logout(false);
            setAuthMode('login');
            openModal('authModal');
        }
    } catch (e) {
        console.warn('Network issue during auth check. Keeping cached login session intact.', e);
    } finally {
        dismissSplashScreen();
    }
}

// -------------------------------------------------------------
// Global UI & Network Helper Functions
// -------------------------------------------------------------
function updateBalanceUI(balance) {
    const balNum = (balance != null ? balance : (currentUser ? currentUser.digits_balance : 0)) || 0;
    if (currentUser) {
        currentUser.digits_balance = balNum;
    }
    const navBal = document.getElementById('navDigitsBalance');
    if (navBal) navBal.innerText = balNum;

    const headerBal = document.getElementById('profHeaderBalance');
    if (headerBal) headerBal.innerText = 'BDT ' + balNum;

    const profBal = document.getElementById('profDigitsBalance');
    if (profBal) profBal.innerText = balNum;

    const withdrawBal = document.getElementById('withdrawUserBalance');
    if (withdrawBal) withdrawBal.innerText = 'BDT ' + balNum;

    const modalBal = document.getElementById('walletModalUserBalance');
    if (modalBal) modalBal.innerText = balNum + ' Digits';
}

function fetchMatches() {
    if (typeof loadMatches === 'function') {
        return loadMatches();
    }
}

async function fetchWithAuth(url, options = {}) {
    options.headers = options.headers || {};
    if (token) {
        options.headers['Authorization'] = `Bearer ${token}`;
    }
    if (options.body && typeof options.body === 'string' && !options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
    }
    return fetch(url, options);
}

function renderLoggedInNav() {
    updateBalanceUI(currentUser.digits_balance || 0);

    // Keep top navbar completely clean as requested by user: no buttons or icons beside GOMON HUB TOURNAMENT
    const container = document.getElementById('authNavContainer');
    if (container) {
        container.innerHTML = '';
        container.style.display = 'none';
    }

    const adminTabBtn = document.getElementById('tabBtn-admin');
    const tabBtnText = document.getElementById('tabBtn-admin-text');
    const tabBtnBadge = document.getElementById('tabBtn-admin-badge');
    const mAdmin = document.getElementById('mNav-admin');

    const isAdmin = (currentUser.role === 'admin');
    const isMod = (currentUser.role === 'moderator');
    const hasAdminPanel = isAdmin || isMod;

    if (hasAdminPanel) {
        if (adminTabBtn) adminTabBtn.style.display = 'inline-flex';
        if (mAdmin) mAdmin.style.display = 'flex';

        if (isMod) {
            if (tabBtnText) tabBtnText.innerText = '🛡️ Moderator';
            if (tabBtnBadge) {
                tabBtnBadge.innerText = 'MOD';
                tabBtnBadge.style.background = 'var(--neon-cyan)';
                tabBtnBadge.style.color = '#000';
            }
        } else {
            if (tabBtnText) tabBtnText.innerText = '👑 Admin';
            if (tabBtnBadge) {
                tabBtnBadge.innerText = 'MASTER';
                tabBtnBadge.style.background = '';
                tabBtnBadge.style.color = '';
            }
        }
    } else {
        if (adminTabBtn) adminTabBtn.style.display = 'none';
        if (mAdmin) mAdmin.style.display = 'none';
    }

    applyRolePermissionsUI();

    const impText = document.getElementById('impersonatedUserText');
    if (sessionStorage.getItem('admin_backup_token') && impText) {
        impText.innerText = `@${currentUser.username} (${currentUser.player_id})`;
    }
}

function applyRolePermissionsUI() {
    if (!currentUser) return;
    const isMod = (currentUser.role === 'moderator');
    const isAdmin = (currentUser.role === 'admin');

    const titleEl = document.getElementById('adminPanelTitle');
    const subEl = document.getElementById('adminPanelSubtitle');
    const topActionBtns = document.getElementById('adminMasterActionBtns');

    if (isMod) {
        if (titleEl) titleEl.innerHTML = '🛡️ MODERATOR CONTROL PANEL';
        if (subEl) subEl.innerText = 'Schedule, Room Credentials & Match Conclude Control';
        if (topActionBtns) {
            topActionBtns.innerHTML = '<span class="badge-status pending" style="font-size: 0.8rem; padding: 6px 14px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #00d2ff;"></span>🛡️ Moderator Active</span>';
            topActionBtns.style.display = 'flex';
        }

        document.querySelectorAll('.admin-only-card, .admin-only-nav').forEach(el => {
            el.style.setProperty('display', 'none', 'important');
        });
    } else if (isAdmin) {
        if (titleEl) titleEl.innerHTML = '👑 SUPER-ADMIN MASTER CONTROL';
        if (subEl) subEl.innerText = 'Complete overview of matches, players, finances, and platform settings';
        if (topActionBtns) {
            topActionBtns.innerHTML = '<span class="badge-status approved" style="font-size: 0.8rem; padding: 6px 14px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;"><span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #10b981;"></span>👑 Master Admin Active</span>';
            topActionBtns.style.display = 'flex';
        }

        document.querySelectorAll('.admin-only-card, .admin-only-nav').forEach(el => {
            el.style.removeProperty('display');
        });
    }
}

function renderLoggedOutNav() {
    currentUser = null;
    updateBalanceUI(0);
    const adminBtn = document.getElementById('tabBtn-admin');
    if (adminBtn) adminBtn.style.display = 'none';
    const mAdmin = document.getElementById('mNav-admin');
    if (mAdmin) mAdmin.style.display = 'none';
    const container = document.getElementById('authNavContainer');
    if (container) {
        container.innerHTML = '';
        container.style.display = 'none';
    }
}
function logout(manual = true) {
    sessionStorage.removeItem('welcome_notice_dismissed');
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    token = null;
    currentUser = null;
    document.body.classList.remove('authenticated');
    document.body.classList.add('not-authenticated');
    const mainApp = document.getElementById('mainAppWrapper');
    if (mainApp) mainApp.style.display = 'block';
    renderLoggedOutNav();
    renderUserProfile();
    loadMatches();
    setAuthMode('login');
    openModal('authModal');
    const saved = localStorage.getItem('saved_login_user');
    const uInp = document.getElementById('loginUsername');
    if (uInp && saved) {
        uInp.value = saved;
    }
    if (manual) showToast('Logged out successfully', 'info');
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
    clearLoginError();
    clearSignupError();

    if (mode === 'login') {
        if (loginCard) loginCard.style.display = 'block';
        if (signupCard) signupCard.style.display = 'none';
        const saved = localStorage.getItem('saved_login_user');
        const uInp = document.getElementById('loginUsername');
        if (uInp && !uInp.value && saved) {
            uInp.value = saved;
        }
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
        alert("Need help resetting your password?\n\nPlease contact GOMON HUB Admin on WhatsApp.\n\nWhatsApp: 01952851550\n24/7 dedicated support available anytime.");
    }
}

function showLoginError(msg) {
    const alertBox = document.getElementById('loginErrorAlert');
    if (alertBox) {
        alertBox.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>${msg}</span>
        `;
        alertBox.style.display = 'flex';
        alertBox.classList.remove('shake');
        void alertBox.offsetWidth;
        alertBox.classList.add('shake');
    }
    const loginCard = document.getElementById('authLoginCard');
    if (loginCard) {
        loginCard.classList.remove('shake');
        void loginCard.offsetWidth;
        loginCard.classList.add('shake');
    }
    const passInput = document.getElementById('loginPassword');
    if (passInput) {
        passInput.classList.add('input-error');
        passInput.focus();
    }
    showToast(msg, 'error');
    playSound('alert');
}

function clearLoginError() {
    const alertBox = document.getElementById('loginErrorAlert');
    if (alertBox) alertBox.style.display = 'none';
    const passInput = document.getElementById('loginPassword');
    if (passInput) passInput.classList.remove('input-error');
}

async function handleLoginSubmit(e) {
    e.preventDefault();
    clearLoginError();
    const u = document.getElementById('loginUsername').value.trim();
    const p = document.getElementById('loginPassword').value;

    if (!u) {
        showLoginError('Please enter your username, phone number, or Player ID');
        return;
    }
    if (!p) {
        showLoginError('Please enter your password');
        return;
    }

    const submitBtn = document.getElementById('loginSubmitBtn');
    const originalBtnText = submitBtn ? submitBtn.innerText : 'Sign In';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Signing in...';
    }

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
            localStorage.setItem('saved_login_user', u);
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            dismissSplashScreen();
            showToast(`Welcome back, ${currentUser.username}! Login successful.`, 'success');
            playSound('success');

            // Safe isolated post-login initialization
            sessionStorage.removeItem('welcome_notice_dismissed');
            try { openWelcomeNotice(true); } catch(e) {}
            try { renderLoggedInNav(); } catch(e) { console.error('Error in renderLoggedInNav:', e); }
            try { renderUserProfile(); } catch(e) { console.error('Error in renderUserProfile:', e); }
            try { loadMatches(); } catch(e) { console.error('Error in loadMatches:', e); }
            try { loadWalletHistory(); } catch(e) { console.error('Error in loadWalletHistory:', e); }
            try { initWebSocket(); } catch(e) { console.error('Error in initWebSocket:', e); }
            if (currentUser.role === 'admin') {
                const adminBtn = document.getElementById('tabBtn-admin');
                if (adminBtn) adminBtn.style.display = 'inline-flex';
                try { loadAdminOverview(); } catch(e) { console.error('Error in loadAdminOverview:', e); }
            }
        } else {
            const errMsg = data.detail || 'Invalid username or password. Please try again.';
            showLoginError(errMsg);
        }
    } catch (err) {
        console.error('Login network error:', err);
        showLoginError('Unable to connect to server. Please check your network connection.');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = originalBtnText;
        }
    }
}

function validatePhoneNumber(raw) {
    if (!raw) return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    let clean = raw.replace(/\s+/g, '').replace(/[-+]/g, '');
    if (clean.startsWith('8801') && clean.length === 13) {
        clean = clean.substring(2);
    }
    // 1. Must be exactly 11 digits and all numeric
    if (!/^\d{11}$/.test(clean)) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 2. Must start with a valid Bangladeshi mobile operator code: 013, 014, 015, 016, 017, 018, 019
    if (!/^01[3-9]/.test(clean)) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 3. Cannot be all 11 identical digits (e.g. 00000000000, 11111111111)
    if (/^(\d)\1{10}$/.test(clean) || new Set(clean.split('')).size === 1) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 4. Maximum consecutive identical digits cannot be 5 or more (e.g. 11111, 00000, 77777)
    if (/(\d)\1{4,}/.test(clean)) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 5. Must contain at least 4 distinct digits (rejects dummy numbers like 01909090909, 01707070707)
    if (new Set(clean.split('')).size < 4) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 6. Reject repeating 2-digit patterns repeated 3 or more times (e.g. 090909, 121212, 181818)
    if (/(\d{2})\1{2,}/.test(clean)) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 7. Reject alternating digits pattern repeated 3 or more times (e.g. 909090, 090909, 707070)
    if (/(\d)(\d)\1\2\1\2/.test(clean)) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 8. Reject repeating 3-digit pattern repeated 3 or more times (e.g. 123123123)
    if (/(\d{3})\1{2,}/.test(clean)) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    // 9. Reject sequential 6 or more digits
    const sequentialPatterns = [
        '012345', '123456', '234567', '345678', '456789', '567890',
        '098765', '987654', '876543', '765432', '654321', '543210'
    ];
    if (sequentialPatterns.some(pat => clean.includes(pat))) {
        return { valid: false, message: 'Please enter a valid 11-digit phone number' };
    }
    return { valid: true, phone: clean };
}

function showSignupError(msg, targetInputId = null) {
    const alertBox = document.getElementById('signupErrorAlert');
    if (alertBox) {
        alertBox.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <span>${msg}</span>
        `;
        alertBox.style.display = 'flex';
        alertBox.classList.remove('shake');
        void alertBox.offsetWidth;
        alertBox.classList.add('shake');
    }
    const signupCard = document.getElementById('authSignupCard');
    if (signupCard) {
        signupCard.classList.remove('shake');
        void signupCard.offsetWidth;
        signupCard.classList.add('shake');
    }
    if (targetInputId) {
        const inp = document.getElementById(targetInputId);
        if (inp) {
            inp.classList.add('input-error');
            inp.focus();
        }
    }
    showToast(msg, 'error');
    playSound('alert');
}

function validatePasswordStrength(password) {
    if (!password || password.length < 8) {
        return { valid: false, message: 'Password must be at least 8 characters long' };
    }
    if (!password.includes('@') && !password.includes('#')) {
        return { valid: false, message: 'Password must contain an @ or # symbol' };
    }
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    if (!hasLetter || !hasDigit) {
        return { valid: false, message: 'Password is too simple. Use a mix of letters, numbers, and symbols (@ or #).' };
    }
    const lower = password.toLowerCase();
    const easyWords = [
        '12345678', '123456789', '87654321', '12341234',
        'password', 'pass1234', 'admin123', 'bangladesh',
        'freefire', 'gomonhub', 'qwertyui', 'asdfghjk'
    ];
    for (let w of easyWords) {
        if (lower.includes(w)) {
            return { valid: false, message: 'Password is too predictable. Avoid sequential numbers like 1234.' };
        }
    }
    if (/(.)\1{4,}/.test(password)) {
        return { valid: false, message: 'Avoid repeating identical characters in your password.' };
    }
    return { valid: true };
}

function clearSignupError() {
    const alertBox = document.getElementById('signupErrorAlert');
    if (alertBox) alertBox.style.display = 'none';
    document.querySelectorAll('#registerForm .signup-input').forEach(inp => inp.classList.remove('input-error'));
}

async function handleRegisterSubmit(e) {
    e.preventDefault();
    clearSignupError();

    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const phoneRaw = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    const terms = document.getElementById('regTermsCheckbox');

    if (!username || username.length < 3) {
        showSignupError('Username must be at least 3 characters', 'regUsername');
        return;
    }

    // 1. Phone validation
    const phoneCheck = validatePhoneNumber(phoneRaw);
    if (!phoneCheck.valid) {
        showSignupError(phoneCheck.message, 'regPhone');
        return;
    }
    const phone = phoneCheck.phone;

    // 2. Email validation (strictly mandatory)
    if (!email) {
        showSignupError('Email address is required', 'regEmail');
        return;
    }
    if (!email.includes('@') || !email.includes('.') || email.length < 5) {
        showSignupError('Please enter a valid email address', 'regEmail');
        return;
    }

    // 3. Free Fire UID validation (strictly mandatory)
    const ffUid = document.getElementById('regFFUid') ? document.getElementById('regFFUid').value.trim() : '';
    const ffIgn = document.getElementById('regFFIgn') ? document.getElementById('regFFIgn').value.trim() : '';
    if (!ffUid) {
        showSignupError('Free Fire numeric UID is required', 'regFFUid');
        return;
    }
    if (!/^\d{6,15}$/.test(ffUid)) {
        showSignupError('Please enter a valid numeric UID (6 to 15 digits)', 'regFFUid');
        return;
    }

    // 4. Password validation (min 8 chars, @ or #, strong password)
    const passCheck = validatePasswordStrength(password);
    if (!passCheck.valid) {
        showSignupError(passCheck.message, 'regPassword');
        return;
    }

    if (terms && !terms.checked) {
        showSignupError('You must agree to the Terms & Conditions', 'regTermsCheckbox');
        return;
    }

    const submitBtn = document.getElementById('regSubmitBtn');
    const originalBtnText = submitBtn ? submitBtn.innerText : 'Create Account';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Creating account...';
    }

    let res;
    try {
        res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                phone,
                email,
                password,
                ff_ign: ffIgn || username,
                ff_uid: ffUid
            })
        });
    } catch (networkErr) {
        // ONLY triggers if the server is genuinely offline / port unreachable
        console.error('Signup network error (server is offline):', networkErr);
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = originalBtnText;
        }
        showSignupError('Unable to connect to server. Please check your network connection.');
        return;
    }

    let data = {};
    try {
        data = await res.json();
    } catch (parseErr) {
        data = {};
    }

    if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = originalBtnText;
    }

    if (!res.ok) {
        if (res.status >= 500) {
            showSignupError('Server temporary issue (HTTP ' + res.status + '). Please try again later.');
        } else {
            const errMsg = (data && data.detail) || 'Registration failed';
            let targetId = null;
            if (errMsg.toLowerCase().includes('uid') || errMsg.includes('ইউআইডি')) targetId = 'regFFUid';
            else if (errMsg.toLowerCase().includes('phone') || errMsg.includes('ফোন')) targetId = 'regPhone';
            else if (errMsg.toLowerCase().includes('username') || errMsg.includes('ইউজারনেম')) targetId = 'regUsername';
            else if (errMsg.toLowerCase().includes('password') || errMsg.includes('পাসওয়ার্ড')) targetId = 'regPassword';
            else if (errMsg.toLowerCase().includes('email') || errMsg.includes('ইমেইল')) targetId = 'regEmail';
            showSignupError(errMsg, targetId);
        }
        return;
    }

    // Registration successful - proceed into the app!
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('ff_token', token);
    localStorage.setItem('ff_user', JSON.stringify(currentUser));
    localStorage.setItem('saved_login_user', username);
    document.body.classList.remove('not-authenticated');
    document.body.classList.add('authenticated');
    const mainApp = document.getElementById('mainAppWrapper');
    if (mainApp) mainApp.style.display = 'block';
    closeModal('authModal');
    dismissSplashScreen();
    showToast(`Account created successfully! Your Player ID: ${currentUser.player_id}`, 'success');
    playSound('success');

    // Safe background UI updates
    sessionStorage.removeItem('welcome_notice_dismissed');
    try { openWelcomeNotice(true); } catch(e) {}
    try { renderLoggedInNav(); } catch(e) { console.error('Error in renderLoggedInNav:', e); }
    try { renderUserProfile(); } catch(e) { console.error('Error in renderUserProfile:', e); }
    try { loadMatches(); } catch(e) { console.error('Error in loadMatches:', e); }
    try { loadWalletHistory(); } catch(e) { console.error('Error in loadWalletHistory:', e); }
    try { initWebSocket(); } catch(e) { console.error('Error in initWebSocket:', e); }
}

// -------------------------------------------------------------
// -------------------------------------------------------------
// Matches & Slot Booking Engine
// -------------------------------------------------------------
activeCategoryFilter = activeCategoryFilter || 'all';

// -------------------------------------------------------------
// 6 TOURNAMENT CATEGORIES SPECIFICATIONS & BANNER SVGS
// -------------------------------------------------------------
const MATCH_CATEGORIES_CONFIG = [
    {
        id: 'solo_full_map',
        group: 'Full Map Matches',
        title: 'SOLO FULL MAP MATCH',
        shortName: 'Solo Full Map',
        tag: 'SOLO',
        matches(m) {
            const t = (m.match_type || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            if (t.includes('solo full map') || t === 'solo') {
                if (!title.includes('lone') && !title.includes('wolf') && !title.includes('survival') && !title.includes('bonus')) return true;
            }
            return false;
        }
    },
    {
        id: 'duo_full_map',
        group: 'Full Map Matches',
        title: 'DUO - FULL MAP MATCH',
        shortName: 'Duo Full Map',
        tag: 'DUO',
        matches(m) {
            const t = (m.match_type || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            if (t.includes('duo full map') || t === 'duo') {
                if (!title.includes('lone') && !title.includes('wolf') && !title.includes('2v2') && !title.includes('survival')) return true;
            }
            return false;
        }
    },
    {
        id: 'br_survival',
        group: 'Lone Wolf Matches',
        title: 'BR SURVIVAL - MATCH',
        subText: 'জোন পুশ ম্যাচ',
        shortName: 'BR Survival',
        tag: 'SURVIVAL',
        matches(m) {
            const t = (m.match_type || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            return t.includes('survival') || t.includes('zone') || t.includes('জোন') || title.includes('survival') || title.includes('zone') || title.includes('জোন');
        }
    },
    {
        id: 'lone_wolf',
        group: 'Lone Wolf Matches',
        title: '2 VS 2 LONE WOLF - MATCH',
        shortName: 'Lone Wolf',
        tag: 'LONE WOLF',
        matches(m) {
            const t = (m.match_type || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            return t.includes('lone') || t.includes('wolf') || title.includes('lone') || title.includes('wolf') || t.includes('2v2') || title.includes('2v2');
        }
    },
    {
        id: 'bonus_match',
        group: 'BONUS and Clash Squad Matches',
        title: 'BONUS MATCH',
        shortName: 'Bonus Match',
        tag: 'BONUS',
        matches(m) {
            const t = (m.match_type || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            return t.includes('bonus') || title.includes('bonus') || title.includes('বোনাস');
        }
    },
    {
        id: 'cs_4v4',
        group: 'BONUS and Clash Squad Matches',
        title: 'CLASH SQUAD',
        shortName: 'Clash Squad',
        tag: 'CLASH SQUAD',
        matches(m) {
            const t = (m.match_type || '').toLowerCase();
            const title = (m.title || '').toLowerCase();
            if (t.includes('cs') || t.includes('clash') || t.includes('4v4') || t.includes('1v1') || t.includes('2v2') || t.includes('3v3')) return true;
            if (t.includes('squad') && !title.includes('survival')) return true;
            return false;
        }
    }
];

let selectedCategory = null;

function getCategoryBannerSvg(catId) {
    if (catId === 'solo_full_map') {
        return `<svg viewBox="0 0 380 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_solo" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#450a0a"/>
      <stop offset="30%" stop-color="#9a3412"/>
      <stop offset="55%" stop-color="#f59e0b"/>
      <stop offset="85%" stop-color="#d97706"/>
      <stop offset="100%" stop-color="#2a0800"/>
    </linearGradient>
    <radialGradient id="sun_solo" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="1"/>
      <stop offset="35%" stop-color="#f59e0b" stop-opacity="0.8"/>
      <stop offset="70%" stop-color="#b45309" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.75"/>
    </radialGradient>
    <linearGradient id="gold_txt" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="25%" stop-color="#fef08a"/>
      <stop offset="65%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="shadow_solo" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect width="380" height="150" rx="14" fill="url(#bg_solo)"/>
  <rect width="380" height="150" rx="14" fill="url(#sun_solo)"/>
  <path d="M-20 150 C20 115, 60 120, 100 142 C140 110, 190 118, 230 140 C270 112, 310 120, 350 138 C380 115, 410 125, 430 150 Z" fill="#1c0700" opacity="0.88"/>
  <path d="M-10 150 C30 125, 80 128, 120 146 C160 124, 220 128, 260 146 C300 126, 360 132, 400 150 Z" fill="#0c0300" opacity="0.95"/>
  <circle cx="190" cy="32" r="18" fill="#ffffff" stroke="#1c1917" stroke-width="2" filter="url(#shadow_solo)"/>
  <circle cx="190" cy="32" r="15" fill="#fef08a"/>
  <text x="190" y="37" font-family="'Arial Black', Impact, sans-serif" font-size="16" text-anchor="middle" fill="#0f172a">🎮</text>
  <text x="190" y="74" font-family="'Rajdhani', 'Arial Black', Impact, sans-serif" font-size="21" font-weight="900" text-anchor="middle" fill="url(#gold_txt)" stroke="#450a0a" stroke-width="1.8" letter-spacing="1.2" filter="url(#shadow_solo)">SOLO FULL MAP MATCH</text>
  <text x="190" y="94" font-family="'Rajdhani', Arial, sans-serif" font-size="11.5" font-weight="800" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="0.6" letter-spacing="3.5" filter="url(#shadow_solo)">GOMON HUB</text>
  <text x="190" y="122" font-family="'Arial Black', Impact, sans-serif" font-size="20" font-weight="900" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="1.2" letter-spacing="3" filter="url(#shadow_solo)">FREE FIRE</text>
</svg>`;
    }
    if (catId === 'duo_full_map') {
        return `<svg viewBox="0 0 380 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_duo" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#431407"/>
      <stop offset="35%" stop-color="#c2410c"/>
      <stop offset="55%" stop-color="#fb923c"/>
      <stop offset="85%" stop-color="#ea580c"/>
      <stop offset="100%" stop-color="#2a0800"/>
    </linearGradient>
    <radialGradient id="sun_duo" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#ffedd5" stop-opacity="1"/>
      <stop offset="35%" stop-color="#f97316" stop-opacity="0.8"/>
      <stop offset="70%" stop-color="#c2410c" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.75"/>
    </radialGradient>
    <linearGradient id="gold_txt2" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="25%" stop-color="#fef08a"/>
      <stop offset="65%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="shadow_duo" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect width="380" height="150" rx="14" fill="url(#bg_duo)"/>
  <rect width="380" height="150" rx="14" fill="url(#sun_duo)"/>
  <path d="M-20 150 C20 115, 60 120, 100 142 C140 110, 190 118, 230 140 C270 112, 310 120, 350 138 C380 115, 410 125, 430 150 Z" fill="#1c0700" opacity="0.88"/>
  <path d="M-10 150 C30 125, 80 128, 120 146 C160 124, 220 128, 260 146 C300 126, 360 132, 400 150 Z" fill="#0c0300" opacity="0.95"/>
  <circle cx="190" cy="32" r="18" fill="#ffffff" stroke="#1c1917" stroke-width="2" filter="url(#shadow_duo)"/>
  <circle cx="190" cy="32" r="15" fill="#fed7aa"/>
  <text x="190" y="37" font-family="'Arial Black', Impact, sans-serif" font-size="16" text-anchor="middle" fill="#0f172a">👥</text>
  <text x="190" y="74" font-family="'Rajdhani', 'Arial Black', Impact, sans-serif" font-size="21" font-weight="900" text-anchor="middle" fill="url(#gold_txt2)" stroke="#431407" stroke-width="1.8" letter-spacing="1.2" filter="url(#shadow_duo)">DUO - FULL MAP MATCH</text>
  <text x="190" y="94" font-family="'Rajdhani', Arial, sans-serif" font-size="11.5" font-weight="800" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="0.6" letter-spacing="3.5" filter="url(#shadow_duo)">GOMON HUB</text>
  <text x="190" y="122" font-family="'Arial Black', Impact, sans-serif" font-size="20" font-weight="900" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="1.2" letter-spacing="3" filter="url(#shadow_duo)">FREE FIRE</text>
</svg>`;
    }
    if (catId === 'br_survival') {
        return `<svg viewBox="0 0 380 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_surv" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#064e3b"/>
      <stop offset="35%" stop-color="#047857"/>
      <stop offset="60%" stop-color="#b45309"/>
      <stop offset="85%" stop-color="#78350f"/>
      <stop offset="100%" stop-color="#1c1917"/>
    </linearGradient>
    <radialGradient id="sun_surv" cx="50%" cy="38%" r="60%">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="0.9"/>
      <stop offset="40%" stop-color="#f59e0b" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#064e3b" stop-opacity="0.8"/>
    </radialGradient>
    <linearGradient id="gold_surv" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="30%" stop-color="#fef08a"/>
      <stop offset="70%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="shadow_surv" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect width="380" height="150" rx="14" fill="url(#bg_surv)"/>
  <rect width="380" height="150" rx="14" fill="url(#sun_surv)"/>
  <circle cx="190" cy="75" r="55" fill="none" stroke="#34d399" stroke-width="0.8" opacity="0.35" stroke-dasharray="4,4"/>
  <circle cx="190" cy="75" r="95" fill="none" stroke="#34d399" stroke-width="0.8" opacity="0.25" stroke-dasharray="6,6"/>
  <rect x="18" y="22" width="48" height="24" rx="12" fill="#000000" stroke="#f59e0b" stroke-width="1.5" filter="url(#shadow_surv)"/>
  <text x="42" y="39" font-family="'Arial Black', Impact, sans-serif" font-size="13" font-weight="900" text-anchor="middle" fill="#fbbf24">BR</text>
  <rect x="314" y="22" width="48" height="24" rx="12" fill="#000000" stroke="#f59e0b" stroke-width="1.5" filter="url(#shadow_surv)"/>
  <text x="338" y="39" font-family="'Arial Black', Impact, sans-serif" font-size="13" font-weight="900" text-anchor="middle" fill="#fbbf24">BR</text>
  <circle cx="350" cy="18" r="9" fill="#10b981" stroke="#ffffff" stroke-width="1.5"/>
  <path d="M346 18 L349 21 L355 15" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round"/>
  <circle cx="190" cy="32" r="18" fill="#ffffff" stroke="#1c1917" stroke-width="2" filter="url(#shadow_surv)"/>
  <circle cx="190" cy="32" r="15" fill="#a7f3d0"/>
  <text x="190" y="37" font-family="'Arial Black', Impact, sans-serif" font-size="15" text-anchor="middle" fill="#065f46">🎯</text>
  <text x="190" y="74" font-family="'Rajdhani', 'Arial Black', Impact, sans-serif" font-size="22" font-weight="900" text-anchor="middle" fill="url(#gold_surv)" stroke="#1c1917" stroke-width="1.8" letter-spacing="1.2" filter="url(#shadow_surv)">SURVIVAL - MATCH</text>
  <text x="190" y="93" font-family="'Rajdhani', Arial, sans-serif" font-size="11" font-weight="800" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="0.6" letter-spacing="3" filter="url(#shadow_surv)">GOMON HUB</text>
  <g transform="translate(190, 122)">
    <rect x="-85" y="-14" width="170" height="26" rx="13" fill="#0f172a" stroke="#fbbf24" stroke-width="1.5" filter="url(#shadow_surv)"/>
    <circle cx="-68" cy="-1" r="7" fill="#dc2626" stroke="#ffffff" stroke-width="1"/>
    <text x="-68" y="2" font-size="8" text-anchor="middle" fill="#ffffff">🎯</text>
    <text x="8" y="4" font-family="system-ui, sans-serif" font-size="12" font-weight="800" text-anchor="middle" fill="#fef08a" letter-spacing="0.5">জোন পুশ ম্যাচ</text>
  </g>
</svg>`;
    }
    if (catId === 'lone_wolf') {
        return `<svg viewBox="0 0 380 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_wolf" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#451a03"/>
      <stop offset="35%" stop-color="#b45309"/>
      <stop offset="55%" stop-color="#f59e0b"/>
      <stop offset="85%" stop-color="#9a3412"/>
      <stop offset="100%" stop-color="#1f0700"/>
    </linearGradient>
    <radialGradient id="sun_wolf" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="1"/>
      <stop offset="40%" stop-color="#f59e0b" stop-opacity="0.8"/>
      <stop offset="80%" stop-color="#78350f" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.75"/>
    </radialGradient>
    <linearGradient id="gold_wolf" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="25%" stop-color="#fef08a"/>
      <stop offset="65%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="shadow_wolf" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect width="380" height="150" rx="14" fill="url(#bg_wolf)"/>
  <rect width="380" height="150" rx="14" fill="url(#sun_wolf)"/>
  <path d="M-20 150 C20 115, 60 120, 100 142 C140 110, 190 118, 230 140 C270 112, 310 120, 350 138 C380 115, 410 125, 430 150 Z" fill="#1c0700" opacity="0.88"/>
  <path d="M-10 150 C30 125, 80 128, 120 146 C160 124, 220 128, 260 146 C300 126, 360 132, 400 150 Z" fill="#0c0300" opacity="0.95"/>
  <rect x="22" y="24" width="70" height="25" rx="12.5" fill="#facc15" stroke="#000000" stroke-width="2" filter="url(#shadow_wolf)"/>
  <text x="57" y="41.5" font-family="'Arial Black', Impact, sans-serif" font-size="12.5" font-weight="900" text-anchor="middle" fill="#000000">2 VS 2</text>
  <rect x="288" y="24" width="70" height="25" rx="12.5" fill="#facc15" stroke="#000000" stroke-width="2" filter="url(#shadow_wolf)"/>
  <text x="323" y="41.5" font-family="'Arial Black', Impact, sans-serif" font-size="12.5" font-weight="900" text-anchor="middle" fill="#000000">2 VS 2</text>
  <circle cx="190" cy="32" r="18" fill="#ffffff" stroke="#1c1917" stroke-width="2" filter="url(#shadow_wolf)"/>
  <circle cx="190" cy="32" r="15" fill="#fef08a"/>
  <text x="190" y="37" font-family="'Arial Black', Impact, sans-serif" font-size="16" text-anchor="middle" fill="#0f172a">🐺</text>
  <text x="190" y="74" font-family="'Rajdhani', 'Arial Black', Impact, sans-serif" font-size="21" font-weight="900" text-anchor="middle" fill="url(#gold_wolf)" stroke="#451a03" stroke-width="1.8" letter-spacing="1.2" filter="url(#shadow_wolf)">LONE WOLF - MATCH</text>
  <text x="190" y="94" font-family="'Rajdhani', Arial, sans-serif" font-size="11.5" font-weight="800" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="0.6" letter-spacing="3.5" filter="url(#shadow_wolf)">GOMON HUB</text>
  <text x="190" y="122" font-family="'Arial Black', Impact, sans-serif" font-size="20" font-weight="900" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="1.2" letter-spacing="3" filter="url(#shadow_wolf)">FREE FIRE</text>
</svg>`;
    }
    if (catId === 'bonus_match') {
        return `<svg viewBox="0 0 380 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_bonus" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#4a044e"/>
      <stop offset="35%" stop-color="#831843"/>
      <stop offset="60%" stop-color="#db2777"/>
      <stop offset="85%" stop-color="#b45309"/>
      <stop offset="100%" stop-color="#18041c"/>
    </linearGradient>
    <radialGradient id="sun_bonus" cx="50%" cy="45%" r="65%">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="0.95"/>
      <stop offset="40%" stop-color="#f43f5e" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#3b0764" stop-opacity="0.8"/>
    </radialGradient>
    <linearGradient id="gold_bonus" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="25%" stop-color="#fef08a"/>
      <stop offset="65%" stop-color="#fde047"/>
      <stop offset="100%" stop-color="#ca8a04"/>
    </linearGradient>
    <filter id="shadow_bonus" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000000" flood-opacity="0.95"/>
    </filter>
  </defs>
  <rect width="380" height="150" rx="14" fill="url(#bg_bonus)"/>
  <rect width="380" height="150" rx="14" fill="url(#sun_bonus)"/>
  <circle cx="45" cy="30" r="3" fill="#38bdf8"/>
  <circle cx="70" cy="50" r="2.5" fill="#fde047"/>
  <circle cx="310" cy="35" r="3" fill="#4ade80"/>
  <circle cx="335" cy="55" r="2" fill="#fb7185"/>
  <polygon points="50,70 54,78 46,78" fill="#f43f5e"/>
  <polygon points="325,75 330,83 320,83" fill="#38bdf8"/>
  <polygon points="90,25 93,31 87,31" fill="#facc15"/>
  <polygon points="290,25 294,31 286,31" fill="#c084fc"/>
  <text x="35" y="65" font-size="22" filter="url(#shadow_bonus)">🎉</text>
  <text x="325" y="65" font-size="22" filter="url(#shadow_bonus)">🎊</text>
  <circle cx="190" cy="32" r="18" fill="#ffffff" stroke="#1c1917" stroke-width="2" filter="url(#shadow_bonus)"/>
  <circle cx="190" cy="32" r="15" fill="#fdf4ff"/>
  <text x="190" y="37" font-family="'Arial Black', Impact, sans-serif" font-size="15" text-anchor="middle" fill="#701a75">🎁</text>
  <text x="190" y="74" font-family="'Rajdhani', 'Arial Black', Impact, sans-serif" font-size="23" font-weight="900" text-anchor="middle" fill="url(#gold_bonus)" stroke="#581c87" stroke-width="1.8" letter-spacing="2" filter="url(#shadow_bonus)">BONUS MATCH</text>
  <text x="190" y="94" font-family="'Rajdhani', Arial, sans-serif" font-size="11.5" font-weight="800" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="0.6" letter-spacing="3.5" filter="url(#shadow_bonus)">GOMON HUB</text>
  <text x="190" y="122" font-family="'Arial Black', Impact, sans-serif" font-size="20" font-weight="900" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="1.2" letter-spacing="3" filter="url(#shadow_bonus)">FREE FIRE</text>
</svg>`;
    }
    if (catId === 'cs_4v4') {
        return `<svg viewBox="0 0 380 150" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg_cs" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#451a03"/>
      <stop offset="35%" stop-color="#b45309"/>
      <stop offset="55%" stop-color="#f59e0b"/>
      <stop offset="85%" stop-color="#9a3412"/>
      <stop offset="100%" stop-color="#1f0700"/>
    </linearGradient>
    <radialGradient id="sun_cs" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="#fef08a" stop-opacity="1"/>
      <stop offset="40%" stop-color="#f59e0b" stop-opacity="0.8"/>
      <stop offset="80%" stop-color="#78350f" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.75"/>
    </radialGradient>
    <linearGradient id="gold_cs" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="25%" stop-color="#fef08a"/>
      <stop offset="65%" stop-color="#f59e0b"/>
      <stop offset="100%" stop-color="#b45309"/>
    </linearGradient>
    <filter id="shadow_cs" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="2.5" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
  </defs>
  <rect width="380" height="150" rx="14" fill="url(#bg_cs)"/>
  <rect width="380" height="150" rx="14" fill="url(#sun_cs)"/>
  <path d="M-20 150 C20 115, 60 120, 100 142 C140 110, 190 118, 230 140 C270 112, 310 120, 350 138 C380 115, 410 125, 430 150 Z" fill="#1c0700" opacity="0.88"/>
  <path d="M-10 150 C30 125, 80 128, 120 146 C160 124, 220 128, 260 146 C300 126, 360 132, 400 150 Z" fill="#0c0300" opacity="0.95"/>
  <rect x="22" y="24" width="70" height="25" rx="12.5" fill="#facc15" stroke="#000000" stroke-width="2" filter="url(#shadow_cs)"/>
  <text x="57" y="41" font-family="'Arial Black', Impact, sans-serif" font-size="10.5" font-weight="900" text-anchor="middle" fill="#000000">1V1 - 4V4</text>
  <rect x="288" y="24" width="70" height="25" rx="12.5" fill="#facc15" stroke="#000000" stroke-width="2" filter="url(#shadow_cs)"/>
  <text x="323" y="41" font-family="'Arial Black', Impact, sans-serif" font-size="10.5" font-weight="900" text-anchor="middle" fill="#000000">1V1 - 4V4</text>
  <circle cx="190" cy="32" r="18" fill="#ffffff" stroke="#1c1917" stroke-width="2" filter="url(#shadow_cs)"/>
  <circle cx="190" cy="32" r="15" fill="#fef08a"/>
  <text x="190" y="37" font-family="'Arial Black', Impact, sans-serif" font-size="15" text-anchor="middle" fill="#0f172a">⚔️</text>
  <text x="190" y="74" font-family="'Rajdhani', 'Arial Black', Impact, sans-serif" font-size="23" font-weight="900" text-anchor="middle" fill="url(#gold_cs)" stroke="#451a03" stroke-width="1.8" letter-spacing="1.5" filter="url(#shadow_cs)">CLASH SQUAD</text>
  <text x="190" y="94" font-family="'Rajdhani', Arial, sans-serif" font-size="11.5" font-weight="800" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="0.6" letter-spacing="3.5" filter="url(#shadow_cs)">GOMON HUB</text>
  <text x="190" y="122" font-family="'Arial Black', Impact, sans-serif" font-size="20" font-weight="900" text-anchor="middle" fill="#ffffff" stroke="#000000" stroke-width="1.2" letter-spacing="3" filter="url(#shadow_cs)">FREE FIRE</text>
</svg>`;
    }
    return '';
}

function renderCategoryHub() {
    MATCH_CATEGORIES_CONFIG.forEach(c => {
        const box = document.getElementById('banner_' + c.id);
        if (box && !box.hasChildNodes()) {
            box.innerHTML = getCategoryBannerSvg(c.id);
        }
    });
    updateCategoryCounts();
}

function updateCategoryCounts() {
    MATCH_CATEGORIES_CONFIG.forEach(c => {
        const countEl = document.getElementById('count_' + c.id);
        if (!countEl) return;
        // Only count active / upcoming matches (concluded/completed matches are excluded from categories)
        const matchesInCat = (allMatches || []).filter(m => m.status !== 'completed' && m.status !== 'cancelled' && c.matches(m));
        const cnt = matchesInCat.length;
        if (cnt === 0) {
            countEl.innerText = 'No Matches Found';
            countEl.classList.remove('has-matches');
        } else if (cnt === 1) {
            countEl.innerText = '1 matches found';
            countEl.classList.add('has-matches');
        } else {
            countEl.innerText = `${cnt} matches found`;
            countEl.classList.add('has-matches');
        }
    });
}

async function refreshCategory(event, catId, btn) {
    if (event) {
        event.stopPropagation();
        event.preventDefault();
    }
    if (btn) {
        btn.classList.add('refreshing');
        const icon = btn.querySelector('svg');
        if (icon) icon.classList.add('spinning');
    }
    try {
        await loadMatches();
        const cat = MATCH_CATEGORIES_CONFIG.find(c => c.id === catId);
        const count = (allMatches || []).filter(m => m.status !== 'completed' && m.status !== 'cancelled' && cat && cat.matches(m)).length;
        showToast(count > 0 ? `${cat ? cat.shortName : 'ক্যাটাগরি'} রিফ্রেশ হয়েছে (${count} ম্যাচ)` : `${cat ? cat.shortName : 'ক্যাটাগরি'} রিফ্রেশ হয়েছে (০ ম্যাচ)`, 'info');
    } catch (e) {
        console.error('Refresh category failed', e);
        showToast('রিফ্রেশ ব্যর্থ হয়েছে, আবার চেষ্টা করুন', 'error');
    } finally {
        if (btn) {
            setTimeout(() => {
                btn.classList.remove('refreshing');
                const icon = btn.querySelector('svg');
                if (icon) icon.classList.remove('spinning');
            }, 600);
        }
    }
}

async function refreshActiveCategory(btn) {
    if (btn) {
        btn.disabled = true;
        const icon = btn.querySelector('svg');
        if (icon) icon.classList.add('spinning');
    }
    try {
        await loadMatches();
        if (selectedCategory) {
            selectMatchCategory(selectedCategory);
        }
        showToast('ম্যাচ তালিকা সফলভাবে রিফ্রেশ হয়েছে!', 'success');
    } catch (e) {
        console.error('Refresh active category failed', e);
        showToast('ম্যাচ রিফ্রেশ হতে সমস্যা হয়েছে', 'error');
    } finally {
        if (btn) {
            setTimeout(() => {
                btn.disabled = false;
                const icon = btn.querySelector('svg');
                if (icon) icon.classList.remove('spinning');
            }, 600);
        }
    }
}

function selectMatchCategory(catId) {
    selectedCategory = catId;
    const cat = MATCH_CATEGORIES_CONFIG.find(c => c.id === catId);
    const hubView = document.getElementById('categoryHubView');
    const matchesView = document.getElementById('categoryMatchesView');
    const headerTitle = document.getElementById('selectedCatHeaderTitle');
    const badge = document.getElementById('selectedCatMatchCountBadge');

    if (hubView) hubView.style.display = 'none';
    if (matchesView) matchesView.style.display = 'block';

    if (cat && headerTitle) {
        headerTitle.innerText = cat.title;
        const count = (allMatches || []).filter(m => m.status !== 'completed' && m.status !== 'cancelled' && cat.matches(m)).length;
        if (badge) {
            badge.innerText = count > 0 ? `${count} Active Match${count > 1 ? 'es' : ''}` : '0 Active Matches';
        }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    renderMatches();
}

function backToCategoryHub() {
    selectedCategory = null;
    const hubView = document.getElementById('categoryHubView');
    const matchesView = document.getElementById('categoryMatchesView');
    if (matchesView) matchesView.style.display = 'none';
    if (hubView) hubView.style.display = 'block';
    updateCategoryCounts();
}

function showMatchesSkeleton() {
    const grid = document.getElementById('matchesGrid');
    if (!grid || (allMatches && allMatches.length > 0)) return;
    grid.innerHTML = Array(4).fill(0).map(() => `
        <div class="skeleton-card">
            <div style="display: flex; justify-content: space-between; align-items: center;">
                <div class="skeleton-shimmer" style="width: 80px; height: 22px; border-radius: 999px;"></div>
                <div class="skeleton-shimmer" style="width: 60px; height: 18px;"></div>
            </div>
            <div class="skeleton-shimmer" style="width: 65%; height: 20px; margin-top: 4px;"></div>
            <div style="display: flex; gap: 10px; margin: 8px 0;">
                <div class="skeleton-shimmer" style="flex: 1; height: 36px; border-radius: 8px;"></div>
                <div class="skeleton-shimmer" style="flex: 1; height: 36px; border-radius: 8px;"></div>
            </div>
            <div class="skeleton-shimmer" style="width: 100%; height: 38px; border-radius: 8px;"></div>
        </div>
    `).join('');
}

async function loadMatches(silent = false) {
    if (!silent && (!allMatches || allMatches.length === 0)) {
        showMatchesSkeleton();
    }
    try {
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/matches?_t=' + Date.now(), { headers });
        const data = await res.json();
        allMatches = Array.isArray(data) ? data : (data.matches || []);
        updateCategoryCounts();
        renderMatches();
        renderMyMatches();
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator')) {
            renderAdminMatches();
        }
    } catch (e) {
        console.error('Failed to load matches', e);
    }
}

function fetchMatches() {
    if (allMatches && allMatches.length > 0) {
        renderMatches();
        return loadMatches(true);
    }
    return loadMatches(false);
}

function filterMatches(category, btnElem) {
    activeCategoryFilter = category || 'all';

    if (btnElem) {
        document.querySelectorAll('#tab-matches .filter-pill').forEach(b => b.classList.remove('active'));
        btnElem.classList.add('active');
    }

    renderMatches();
}

// -------------------------------------------------------------
// DYNAMIC MATCH FORMAT & CATEGORY DISPLAY HELPERS (FORMAT MONITOR)
// -------------------------------------------------------------
function getMatchFormatInfo(m) {
    if (!m) return { label: '1 VS 1', icon: '⚔️', cssClass: 'match-format-1v1', slotColor: '#b45309', inlineStyle: 'background: #fef08a !important; color: #854d0e !important; border: 1.5px solid #facc15 !important;' };
    const slots = parseInt(m.total_slots, 10) || 0;
    const mt = String(m.match_type || '').trim();
    const tl = String(m.title || '').trim();
    const combined = (mt + ' ' + tl).toLowerCase();
    const titleLower = tl.toLowerCase();

    // 1. Explicit format tag in title (if admin explicitly wrote 1v1, 2v2 etc. in title)
    if (/\b1\s*(?:v|vs)\s*1\b/i.test(titleLower) || titleLower.includes('1v1')) {
        return { label: '1 VS 1', icon: '⚔️', cssClass: 'match-format-1v1', slotColor: '#b45309', inlineStyle: 'background: #fef08a !important; color: #854d0e !important; border: 1.5px solid #facc15 !important;' };
    }
    if (/\b2\s*(?:v|vs)\s*2\b/i.test(titleLower) || titleLower.includes('2v2')) {
        return { label: '2 VS 2', icon: '⚔️', cssClass: 'match-format-2v2', slotColor: '#4338ca', inlineStyle: 'background: #e0e7ff !important; color: #3730a3 !important; border: 1.5px solid #818cf8 !important;' };
    }
    if (/\b3\s*(?:v|vs)\s*3\b/i.test(titleLower) || titleLower.includes('3v3')) {
        return { label: '3 VS 3', icon: '⚔️', cssClass: 'match-format-3v3', slotColor: '#be185d', inlineStyle: 'background: #fce7f3 !important; color: #9d174d !important; border: 1.5px solid #f472b6 !important;' };
    }
    if (/\b4\s*(?:v|vs)\s*4\b/i.test(titleLower) || titleLower.includes('4v4')) {
        return { label: '4 VS 4', icon: '⚔️', cssClass: 'match-format-4v4', slotColor: '#c2410c', inlineStyle: 'background: #ffedd5 !important; color: #9a3412 !important; border: 1.5px solid #fb923c !important;' };
    }

    const isCs = combined.includes('cs') || combined.includes('clash');
    const isLoneWolf = combined.includes('lone') || combined.includes('wolf');

    // 2. Slot-based identification for Clash Squad / Lone Wolf / Custom Rooms
    if (slots === 2) {
        return { label: '1 VS 1', icon: '⚔️', cssClass: 'match-format-1v1', slotColor: '#b45309', inlineStyle: 'background: #fef08a !important; color: #854d0e !important; border: 1.5px solid #facc15 !important;' };
    }
    if (slots === 4) {
        if (isCs || isLoneWolf || combined.includes('2v2')) {
            return { label: '2 VS 2', icon: '⚔️', cssClass: 'match-format-2v2', slotColor: '#4338ca', inlineStyle: 'background: #e0e7ff !important; color: #3730a3 !important; border: 1.5px solid #818cf8 !important;' };
        }
        if (combined.includes('duo')) {
            return { label: 'DUO', icon: '👥', cssClass: 'match-format-duo', slotColor: '#0369a1', inlineStyle: 'background: #e0f2fe !important; color: #075985 !important; border: 1.5px solid #38bdf8 !important;' };
        }
        return { label: '2 VS 2', icon: '⚔️', cssClass: 'match-format-2v2', slotColor: '#4338ca', inlineStyle: 'background: #e0e7ff !important; color: #3730a3 !important; border: 1.5px solid #818cf8 !important;' };
    }
    if (slots === 6) {
        return { label: '3 VS 3', icon: '⚔️', cssClass: 'match-format-3v3', slotColor: '#be185d', inlineStyle: 'background: #fce7f3 !important; color: #9d174d !important; border: 1.5px solid #f472b6 !important;' };
    }
    if (slots === 8) {
        return { label: '4 VS 4', icon: '⚔️', cssClass: 'match-format-4v4', slotColor: '#c2410c', inlineStyle: 'background: #ffedd5 !important; color: #9a3412 !important; border: 1.5px solid #fb923c !important;' };
    }

    // 3. For Clash Squad with default/unusual slots
    if (isCs) {
        if (slots <= 2) return { label: '1 VS 1', icon: '⚔️', cssClass: 'match-format-1v1', slotColor: '#b45309', inlineStyle: 'background: #fef08a !important; color: #854d0e !important; border: 1.5px solid #facc15 !important;' };
        if (slots <= 4) return { label: '2 VS 2', icon: '⚔️', cssClass: 'match-format-2v2', slotColor: '#4338ca', inlineStyle: 'background: #e0e7ff !important; color: #3730a3 !important; border: 1.5px solid #818cf8 !important;' };
        if (slots <= 6) return { label: '3 VS 3', icon: '⚔️', cssClass: 'match-format-3v3', slotColor: '#be185d', inlineStyle: 'background: #fce7f3 !important; color: #9d174d !important; border: 1.5px solid #f472b6 !important;' };
        return { label: '4 VS 4', icon: '⚔️', cssClass: 'match-format-4v4', slotColor: '#c2410c', inlineStyle: 'background: #ffedd5 !important; color: #9a3412 !important; border: 1.5px solid #fb923c !important;' };
    }

    // 4. Survival / Full Map modes
    if (combined.includes('survival') || combined.includes('zone') || combined.includes('জোন')) {
        return { label: 'SURVIVAL', icon: '🏆', cssClass: 'match-format-survival', slotColor: '#047857', inlineStyle: 'background: #ecfdf5 !important; color: #065f46 !important; border: 1.5px solid #34d399 !important;' };
    }
    if (combined.includes('duo')) {
        return { label: 'DUO', icon: '👥', cssClass: 'match-format-duo', slotColor: '#0369a1', inlineStyle: 'background: #e0f2fe !important; color: #075985 !important; border: 1.5px solid #38bdf8 !important;' };
    }
    if (combined.includes('squad')) {
        return { label: 'SQUAD', icon: '🛡️', cssClass: 'match-format-squad', slotColor: '#6d28d9', inlineStyle: 'background: #f3e8ff !important; color: #6b21a8 !important; border: 1.5px solid #c084fc !important;' };
    }
    if (combined.includes('solo') || slots <= 1) {
        return { label: 'SOLO', icon: '👤', cssClass: 'match-format-solo', slotColor: '#15803d', inlineStyle: 'background: #dcfce7 !important; color: #166534 !important; border: 1.5px solid #4ade80 !important;' };
    }

    // 5. Fallback for larger lobbies
    if (slots >= 12) {
        return { label: 'SOLO', icon: '👤', cssClass: 'match-format-solo', slotColor: '#15803d', inlineStyle: 'background: #dcfce7 !important; color: #166534 !important; border: 1.5px solid #4ade80 !important;' };
    }
    return { label: 'SOLO', icon: '👤', cssClass: 'match-format-solo', slotColor: '#15803d', inlineStyle: 'background: #dcfce7 !important; color: #166534 !important; border: 1.5px solid #4ade80 !important;' };
}

function getMatchCategoryDisplay(matchType) {
    const mt = (matchType || '').trim();
    if (!mt) return 'Clash Squad';
    const lower = mt.toLowerCase();
    if (lower === 'cs 4v4' || lower === 'clash squad' || lower.includes('clash') || lower.includes('cs')) {
        return 'Clash Squad';
    }
    return mt;
}

function renderMatches() {
    renderCategoryHub();

    const grid = document.getElementById('matchesGrid');
    if (!grid) return;

    // Filter out completed/concluded and cancelled matches:
    // Only active/upcoming matches appear in the category lists
    const activeMatches = (allMatches || []).filter(m => m.status !== 'completed' && m.status !== 'cancelled');

    let filtered = activeMatches;
    if (selectedCategory) {
        const cat = MATCH_CATEGORIES_CONFIG.find(c => c.id === selectedCategory);
        if (cat) {
            filtered = activeMatches.filter(m => cat.matches(m));
        }
    } else if (activeCategoryFilter && activeCategoryFilter !== 'all' && activeCategoryFilter !== 'all matches' && activeCategoryFilter !== 'সব ম্যাচ') {
        filtered = activeMatches.filter(m => (m.match_type || '').toLowerCase().trim() === activeCategoryFilter.toLowerCase().trim());
    }

    if (!filtered || filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 36px 16px; background: #ffffff; border-radius: 14px; border: 1px solid #e2e8f0; margin: 10px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.03);">
                <div style="font-size: 2.2rem; margin-bottom: 6px;">🎮</div>
                <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.15rem; font-weight: 800; color: #1e293b;">No Active Matches in this Category</div>
                <div style="font-size: 0.78rem; color: #64748b; margin-top: 4px; margin-bottom: 16px;">নতুন টুর্নামেন্ট ম্যাচ শীঘ্রই শিডিউল করা হবে। নতুন ম্যাচ দেখতে রিফ্রেশ করুন।</div>
                <div style="display: flex; align-items: center; justify-content: center; gap: 10px; flex-wrap: wrap;">
                    <button type="button" class="btn btn-outline btn-sm" onclick="refreshActiveCategory(this)" style="font-weight: 800; padding: 7px 16px; border-radius: 8px; display: inline-flex; align-items: center; gap: 6px; border-color: #059669; color: #059669; background: #ecfdf5;">
                        <svg class="refresh-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                        </svg>
                        ম্যাচ রিফ্রেশ করুন
                    </button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="backToCategoryHub()" style="font-weight: 800; padding: 7px 16px; border-radius: 8px;">
                        ‹ সব ক্যাটাগরি দেখুন
                    </button>
                </div>
            </div>
        `;
        return;
    }


    grid.innerHTML = filtered.map(m => {
        const slotsPercent = Math.min(100, Math.round(((m.joined_count || 0) / (m.total_slots || 48)) * 100));
        const isFull = (m.joined_count || 0) >= (m.total_slots || 48);
        const hasJoined = m.has_joined;
        const isAdminOrMod = (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator'));
        const fmt = getMatchFormatInfo(m);
        const catName = getMatchCategoryDisplay(m.match_type);

        let actionHtml = '';
        if (hasJoined) {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #ecfdf5; border: 1px solid #86efac; border-radius: 8px; padding: 6px 10px;">
                        <span style="font-size: 0.8rem; color: #166534; font-weight: 800;">✅ You are Registered</span>
                        <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800; color: #047857;">Slot #${m.my_slot || 1}</span>
                    </div>
                    <button class="btn btn-neon" style="width: 100%; padding: 8px 12px; font-size: 0.86rem; font-weight: 800; border-radius: 8px;" onclick="openMatchInnerPortal(${m.id})">
                        🔑 View Room & Players
                    </button>
                </div>
            `;
        } else if (isAdminOrMod) {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #e0f2fe; border: 1px solid #7dd3fc; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #0369a1; font-weight: 700;">🛡️ Admin/Mod Access</span>
                        <span style="font-size: 0.75rem; color: #0284c7; font-weight: 800;">${m.joined_count || 0}/${m.total_slots || 48} Players</span>
                    </div>
                    <button class="btn btn-neon" style="width: 100%; padding: 8px 12px; font-size: 0.86rem; font-weight: 800; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #0369a1);" onclick="openMatchInnerPortal(${m.id})">
                        👥 View Room & Players (UID)
                    </button>
                </div>
            `;
        } else if (m.status === 'reg_closed') {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #94a3b8; font-weight: 600;">⭕ Not Joined</span>
                        <span style="font-size: 0.75rem; color: #ef4444; font-weight: 700;">Registration Closed</span>
                    </div>
                    <button class="btn btn-outline" style="width: 100%; opacity: 0.75; cursor: not-allowed; border-color: #ef4444; color: #ef4444; font-size: 0.8rem; font-weight: 700;" disabled>🔒 Registration Closed (Join Required to View)</button>
                </div>
            `;
        } else if (m.status === 'completed') {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #94a3b8; font-weight: 600;">⭕ Not Joined</span>
                        <span style="font-size: 0.75rem; color: #10b981; font-weight: 700;">Concluded</span>
                    </div>
                    <button class="btn btn-outline" style="width: 100%; opacity: 0.75; cursor: not-allowed; border-color: #10b981; color: #10b981; font-size: 0.82rem; font-weight: 700;" disabled>🏁 Concluded</button>
                </div>
            `;
        } else if (isFull) {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #94a3b8; font-weight: 600;">⭕ Not Joined</span>
                        <span style="font-size: 0.75rem; color: #ef4444; font-weight: 700;">Slots Full</span>
                    </div>
                    <button class="btn btn-outline" style="width: 100%; opacity: 0.6; cursor: not-allowed; font-size: 0.8rem; font-weight: 700;" disabled>🔒 All Slots Full (Join Required to View)</button>
                </div>
            `;
        } else {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #64748b; font-weight: 600;">⭕ You have not joined yet</span>
                        <span style="font-size: 0.75rem; color: #0284c7; font-weight: 700;">Fee: ${m.entry_fee} Digits</span>
                    </div>
                    <button class="btn btn-neon" style="width: 100%; padding: 8px 6px; font-size: 0.86rem; font-weight: 800; border-radius: 8px;" onclick="openJoinMatchModal(${m.id}, '${escapeHtml(m.title)}', ${m.entry_fee})">
                        🎮 Join Match (${m.entry_fee} 🪙)
                    </button>
                </div>
            `;
        }


        return `
            <div class="match-card">
                <div class="match-card-header">
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px;">
                            <span class="match-code-badge">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                            <span class="match-category" style="margin-bottom: 0;">🔥 ${escapeHtml(catName)}</span>
                            <span class="match-format-monitor ${fmt.cssClass}" style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.74rem; font-weight: 800; padding: 2.5px 9px; border-radius: 999px; letter-spacing: 0.5px; text-transform: uppercase; font-family: 'Rajdhani', sans-serif; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); line-height: 1.2; ${fmt.inlineStyle}">${fmt.icon} ${fmt.label}</span>
                        </div>
                        <div class="match-title">${escapeHtml(m.title)}</div>
                        <div class="match-time-badge">⏰ ${escapeHtml(m.match_time || '')}</div>
                    </div>
                    <div class="match-map">🗺️ ${escapeHtml(m.map_name || 'Bermuda')}</div>
                </div>

                <div class="match-stats-row">
                    <div class="stat-item">
                        <span class="stat-label">Prize Pool</span>
                        <span class="stat-val prize">৳${m.prize_pool || 0}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Per Kill</span>
                        <span class="stat-val kill">৳${m.per_kill || 0}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Entry Fee</span>
                        <span class="stat-val fee">${m.entry_fee || 0}🪙</span>
                    </div>
                </div>

                <div class="slot-progress-wrapper">
                    <div class="slot-text-row">
                        <span>Slot Booking <span style="font-weight: 800; color: ${fmt.slotColor}; font-size: 0.78rem; margin-left: 2px;">(${fmt.label})</span></span>
                        <span><b>${m.joined_count || 0}</b> / ${m.total_slots || 48} players</span>
                    </div>
                    <div class="slot-bar-bg">
                        <div class="slot-bar-fill" style="width: ${slotsPercent}%;"></div>
                    </div>
                </div>

                <div class="match-card-footer" style="margin-top: 10px;">
                    ${actionHtml}
                </div>
            </div>
        `;
    }).join('');
}

let currentJoinMatch = null;
let currentJoinFeePerSlot = 0;
let currentJoinSelectedSlots = 1;

function selectJoinEntrySlots(count) {
    currentJoinSelectedSlots = count;
    const slotsInput = document.getElementById('joinModalEntrySlots');
    if (slotsInput) slotsInput.value = count;

    // Update active pill state
    document.querySelectorAll('#entryTypeSelector .entry-type-pill').forEach(btn => {
        const c = parseInt(btn.getAttribute('data-count'), 10);
        if (c === count) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Update badge
    const badgeEl = document.getElementById('entrySlotsBadge');
    if (badgeEl) {
        badgeEl.innerText = count === 1 ? '1 Player (১টি স্লট)' : `${count} Players (${count}টি স্লট)`;
    }

    // Toggle Team Name Group
    const teamGroup = document.getElementById('teamNameGroup');
    if (teamGroup) {
        teamGroup.style.display = count > 1 ? 'block' : 'none';
    }

    // Render Teammates Container
    const tmContainer = document.getElementById('teammatesContainer');
    if (tmContainer) {
        if (count > 1) {
            tmContainer.style.display = 'block';
            let tmHtml = '';
            for (let i = 2; i <= count; i++) {
                tmHtml += `
                    <div class="teammate-input-card">
                        <div class="teammate-header">
                            <span>👥 Player ${i} (Teammate)</span>
                            <span style="font-size: 0.72rem; color: #94a3b8;">Slot #${i}</span>
                        </div>
                        <div class="form-group" style="margin-bottom: 8px;">
                            <label style="display: block; font-size: 0.8rem; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
                                Player ${i} In-Game Name (IGN) *
                            </label>
                            <input type="text" class="form-input join-tm-ign" data-index="${i}" required placeholder="Enter Player ${i} Free Fire name" style="width: 100%; box-sizing: border-box;">
                        </div>
                        <div class="form-group" style="margin-bottom: 0;">
                            <label style="display: block; font-size: 0.8rem; font-weight: 700; color: #cbd5e1; margin-bottom: 4px;">
                                Player ${i} Free Fire UID *
                            </label>
                            <input type="text" class="form-input join-tm-uid" data-index="${i}" required inputmode="numeric" pattern="[0-9]{6,15}" placeholder="Enter Player ${i} numeric UID" style="width: 100%; box-sizing: border-box;">
                        </div>
                    </div>
                `;
            }
            tmContainer.innerHTML = tmHtml;
        } else {
            tmContainer.style.display = 'none';
            tmContainer.innerHTML = '';
        }
    }

    // Calculate Total Fee
    const totalFee = currentJoinFeePerSlot * count;
    const feeEl = document.getElementById('joinModalMatchFee');
    if (feeEl) {
        feeEl.innerText = count > 1 ? `${totalFee} Digits (${currentJoinFeePerSlot} × ${count})` : `${totalFee} Digits`;
    }

    // Check user balance
    const userBal = (currentUser && currentUser.digits_balance) ? currentUser.digits_balance : 0;
    const warnEl = document.getElementById('joinModalFeeWarning');
    const submitBtn = document.getElementById('joinModalSubmitBtn');

    if (userBal < totalFee) {
        if (warnEl) {
            warnEl.style.display = 'block';
            const reqEl = document.getElementById('warnRequiredFee');
            const curEl = document.getElementById('warnCurrentBal');
            if (reqEl) reqEl.innerText = totalFee;
            if (curEl) curEl.innerText = userBal;
        }
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.style.opacity = '0.5';
            submitBtn.innerText = `⚠️ Insufficient Balance (${totalFee} Digits required)`;
        }
    } else {
        if (warnEl) warnEl.style.display = 'none';
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.style.opacity = '1';
            submitBtn.innerText = count > 1 ? `🎮 Confirm & Join Team (${totalFee} Digits)` : `🎮 Confirm & Join Match (${totalFee} Digits)`;
        }
    }
}

function openJoinMatchModal(matchId, matchTitle, entryFee) {
    if (!currentUser) {
        showToast('Please sign in before joining a tournament match', 'info');
        openModal('authModal');
        return;
    }

    const m = (allMatches || []).find(x => x.id === matchId);
    currentJoinMatch = m;
    currentJoinFeePerSlot = parseInt(entryFee, 10) || 0;
    currentJoinSelectedSlots = 1;

    const mIdInput = document.getElementById('joinModalMatchId');
    if (mIdInput) mIdInput.value = matchId;

    const codePrefix = (m && m.match_code) ? `[#${m.match_code}] ` : '';
    const fmt = getMatchFormatInfo(m);
    const titleEl = document.getElementById('joinModalMatchTitle');
    if (titleEl) titleEl.innerText = `${codePrefix}${matchTitle || 'Free Fire Match'} • [${fmt.label}]`;

    const balEl = document.getElementById('joinModalUserBal');
    if (balEl) balEl.innerText = `${currentUser.digits_balance || 0} Digits`;

    const ignInput = document.getElementById('joinPlayerIgn');
    if (ignInput) ignInput.value = currentUser.ff_ign || currentUser.username || '';

    const uidInput = document.getElementById('joinPlayerUid');
    if (uidInput) uidInput.value = (currentUser.ff_uid && currentUser.ff_uid !== '0') ? currentUser.ff_uid : '';

    const teamNameInput = document.getElementById('joinTeamName');
    if (teamNameInput) teamNameInput.value = '';

    // Calculate maximum team size allowed for this match
    const totalSlots = (m && m.total_slots) ? parseInt(m.total_slots, 10) : 48;
    const joinedCount = (m && m.joined_count) ? parseInt(m.joined_count, 10) : 0;
    const remainingSlots = Math.max(0, totalSlots - joinedCount);

    let maxTeamSize = 1;
    const formatLabel = (fmt.label || '').toUpperCase();
    if (formatLabel.includes('4 VS 4') || formatLabel.includes('SQUAD')) {
        maxTeamSize = 4;
    } else if (formatLabel.includes('3 VS 3')) {
        maxTeamSize = 3;
    } else if (formatLabel.includes('2 VS 2') || formatLabel.includes('DUO')) {
        maxTeamSize = 2;
    } else if (formatLabel.includes('SURVIVAL')) {
        maxTeamSize = 4;
    } else {
        maxTeamSize = 1; // 1v1 or Solo
    }

    // Cap max team size by remaining slots in the match
    const allowedSize = Math.min(maxTeamSize, remainingSlots > 0 ? remainingSlots : 1);

    // Build entry type selector buttons
    const selectorEl = document.getElementById('entryTypeSelector');
    if (selectorEl) {
        let pillsHtml = `
            <button type="button" class="entry-type-pill active" data-count="1" onclick="selectJoinEntrySlots(1)">
                👤 Solo (১ জন)
            </button>
        `;
        if (allowedSize >= 2) {
            pillsHtml += `
                <button type="button" class="entry-type-pill" data-count="2" onclick="selectJoinEntrySlots(2)">
                    👥 Duo (২ জন)
                </button>
            `;
        }
        if (allowedSize >= 3) {
            pillsHtml += `
                <button type="button" class="entry-type-pill" data-count="3" onclick="selectJoinEntrySlots(3)">
                    ⚔️ Trio (৩ জন)
                </button>
            `;
        }
        if (allowedSize >= 4) {
            pillsHtml += `
                <button type="button" class="entry-type-pill" data-count="4" onclick="selectJoinEntrySlots(4)">
                    🛡️ Squad (৪ জন)
                </button>
            `;
        }
        selectorEl.innerHTML = pillsHtml;
    }

    // Default to 1 slot
    selectJoinEntrySlots(1);

    openModal('joinMatchModal');
}

async function handleJoinMatchFormSubmit(e) {
    e.preventDefault();
    if (!currentUser) {
        openModal('authModal');
        return;
    }

    const matchId = parseInt(document.getElementById('joinModalMatchId').value, 10);
    const ign = document.getElementById('joinPlayerIgn').value.trim();
    const uid = document.getElementById('joinPlayerUid').value.trim();
    const slotsCount = parseInt(document.getElementById('joinModalEntrySlots').value, 10) || 1;
    const teamName = (document.getElementById('joinTeamName') ? document.getElementById('joinTeamName').value : '').trim();

    if (!matchId) {
        showToast('No match selected', 'error');
        return;
    }
    if (!ign) {
        showToast('Please provide your Free Fire in-game name (IGN)', 'error');
        document.getElementById('joinPlayerIgn').focus();
        return;
    }
    if (!uid || !/^\d{6,15}$/.test(uid)) {
        showToast('Please enter a valid numeric Free Fire UID (6 to 15 digits)', 'error');
        document.getElementById('joinPlayerUid').focus();
        return;
    }

    // Collect and validate teammates
    const teammates = [];
    if (slotsCount > 1) {
        const tmIgnInputs = document.querySelectorAll('#teammatesContainer .join-tm-ign');
        const tmUidInputs = document.querySelectorAll('#teammatesContainer .join-tm-uid');
        for (let i = 0; i < tmIgnInputs.length; i++) {
            const tIgn = tmIgnInputs[i].value.trim();
            const tUid = tmUidInputs[i].value.trim();
            if (!tIgn) {
                showToast(`Please enter In-Game Name for Player ${i + 2}`, 'error');
                tmIgnInputs[i].focus();
                return;
            }
            if (!tUid || !/^\d{6,15}$/.test(tUid)) {
                showToast(`Please enter a valid numeric UID for Player ${i + 2} (6 to 15 digits)`, 'error');
                tmUidInputs[i].focus();
                return;
            }
            teammates.push({ player_ign: tIgn, player_uid: tUid });
        }
    }

    const totalFee = currentJoinFeePerSlot * slotsCount;
    if (currentUser.digits_balance < totalFee) {
        showToast(`Insufficient balance! You need ${totalFee} Digits for ${slotsCount} slot(s).`, 'error');
        return;
    }

    const submitBtn = document.getElementById('joinModalSubmitBtn');
    const origText = submitBtn ? submitBtn.innerText : '🎮 Confirm & Join Match';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Processing registration...';
    }

    try {
        const entryType = slotsCount === 4 ? 'squad' : (slotsCount === 3 ? 'trio' : (slotsCount === 2 ? 'duo' : 'solo'));
        const res = await fetchWithAuth('/api/matches/join', {
            method: 'POST',
            body: JSON.stringify({
                match_id: matchId,
                player_ign: ign,
                player_uid: uid,
                team_name: teamName,
                entry_type: entryType,
                teammates: teammates
            })
        });

        const data = await res.json();
        if (res.ok) {
            playSound('success');
            showToast(data.message, 'success');
            currentUser.digits_balance = data.new_balance;
            currentUser.ff_ign = ign;
            currentUser.ff_uid = uid;
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            updateBalanceUI(data.new_balance);
            closeModal('joinMatchModal');
            await fetchMatches();
            switchTab('tab-mymatches');
            setTimeout(() => {
                viewMatchParticipants(matchId);
            }, 300);
        } else {
            showToast(data.detail || 'Unable to join match', 'error');
        }
    } catch (err) {
        console.error('Join match error:', err);
        showToast('Unable to connect to server', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = origText;
        }
    }
}

let currentPortalRoomId = '';
let currentPortalRoomPass = '';

function copyInnerRoomInfo(type) {
    const val = (type === 'id') ? currentPortalRoomId : currentPortalRoomPass;
    if (!val || val === 'NOT RELEASED YET' || val.includes('দেওয়া হবে') || val.includes('release') || val.includes('JOIN')) {
        showToast('Room ID and Password are not released yet', 'info');
        return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(val).then(() => {
            showToast(`Copied to clipboard: ${val}`, 'success');
        }).catch(() => {
            prompt('Copy to clipboard (Ctrl+C):', val);
        });
    } else {
        prompt('Copy to clipboard (Ctrl+C):', val);
    }
}

async function openMatchInnerPortal(matchId) {
    if (!currentUser) {
        showToast('Please sign in to view match details and room credentials', 'info');
        openModal('authModal');
        return;
    }

    const m = (allMatches || []).find(x => x.id === matchId);
    if (!m) {
        showToast('Match not found', 'error');
        return;
    }

    const isAdminOrMod = (currentUser.role === 'admin' || currentUser.role === 'moderator');

    // STRICT ACCESS CONTROL: Only joined players or Admin/Moderator can access!
    if (!m.has_joined && !isAdminOrMod) {
        showToast('🔒 Only players who have joined this match, or Admins/Moderators, can view registered players and credentials!', 'warning');
        if (m.status === 'open' && (m.joined_count || 0) < (m.total_slots || 48)) {
            openJoinMatchModal(m.id, m.title, m.entry_fee);
        }
        return;
    }

    // Populate inner details and open modal
    const titleEl = document.getElementById('portalModalTitle');
    if (titleEl) titleEl.innerText = `${m.match_code ? `[#${m.match_code}] ` : ''}${m.title || 'Match Details'}`;

    const subEl = document.getElementById('portalModalSubtitle');
    if (subEl) subEl.innerText = `Match Code: #${m.match_code || ('MATCH-' + m.id)} • Type: ${m.match_type || 'Solo'} • Time: ${m.match_time || 'Upcoming'}`;

    const slotEl = document.getElementById('portalModalSlot');
    if (slotEl) {
        if (m.has_joined) {
            slotEl.innerText = `#${m.my_slot || 1} (Fixed)`;
        } else if (isAdminOrMod) {
            slotEl.innerText = currentUser.role === 'admin' ? '🛡️ Admin' : '🛡️ Moderator';
        } else {
            slotEl.innerText = '#1 (Fixed)';
        }
    }

    const prizeEl = document.getElementById('portalModalPrize');
    if (prizeEl) prizeEl.innerText = `৳${m.prize_pool || 0}`;

    const killEl = document.getElementById('portalModalKill');
    if (killEl) killEl.innerText = `৳${m.per_kill || 0}`;

    const feeEl = document.getElementById('portalModalFee');
    if (feeEl) feeEl.innerText = `${m.entry_fee || 0}🪙`;

    const mapEl = document.getElementById('portalModalMap');
    if (mapEl) mapEl.innerText = `${m.map_name || 'Bermuda'}`;

    // Room info
    currentPortalRoomId = m.room_id || '';
    currentPortalRoomPass = m.room_pass || '';

    const rIdEl = document.getElementById('portalModalRoomId');
    const rPassEl = document.getElementById('portalModalRoomPass');

    const isReleased = (m.room_id && m.room_id !== 'JOIN TO VIEW' && m.room_id !== 'NOT RELEASED YET' && !m.room_id.includes('দেওয়া হবে'));
    if (rIdEl) {
        if (isAdminOrMod) {
            rIdEl.innerText = m.room_id && m.room_id !== 'JOIN TO VIEW' ? m.room_id : 'Not set yet (Set in Admin Panel)';
            rIdEl.style.color = '#38bdf8';
        } else {
            rIdEl.innerText = isReleased ? m.room_id : 'Credentials release 10-15 minutes before match';
            rIdEl.style.color = isReleased ? '#38bdf8' : '#94a3b8';
        }
    }
    if (rPassEl) {
        if (isAdminOrMod) {
            rPassEl.innerText = m.room_pass && m.room_pass !== 'JOIN TO VIEW' ? m.room_pass : 'Not set yet (Set in Admin Panel)';
            rPassEl.style.color = '#00f59b';
        } else {
            rPassEl.innerText = isReleased ? m.room_pass : 'Credentials release 10-15 minutes before match';
            rPassEl.style.color = isReleased ? '#00f59b' : '#94a3b8';
        }
    }

    openModal('matchInnerPortalModal');

    // Load participants
    const loadingEl = document.getElementById('portalModalLoading');
    const listEl = document.getElementById('portalModalList');
    const tbody = document.getElementById('portalModalTableBody');
    const countEl = document.getElementById('portalModalPartCount');

    if (loadingEl) {
        loadingEl.style.display = 'block';
        loadingEl.innerHTML = 'Loading participant roster...';
    }
    if (listEl) listEl.style.display = 'none';
    if (tbody) tbody.innerHTML = '';
    if (countEl) countEl.innerText = `${m.joined_count || 0}`;

    try {
        const res = await fetchWithAuth(`/api/matches/${matchId}/participants`);
        const data = await res.json();

        if (!res.ok) {
            if (loadingEl) {
                loadingEl.innerHTML = `<div style="padding: 16px; color: #ef4444; font-weight: 700;">🔒 ${escapeHtml(data.detail || 'Unauthorized Access!')}</div>`;
            }
            showToast(data.detail || 'Unable to view player list', 'error');
            return;
        }

        if (countEl) countEl.innerText = `${data.joined_count || 0}`;

        if (!data.participants || data.participants.length === 0) {
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="3" style="text-align: center; padding: 24px; color: #64748b; font-weight: 600;">
                            No players have joined this match yet
                        </td>
                    </tr>
                `;
            }
        } else {
            if (tbody) {
                tbody.innerHTML = data.participants.map(p => {
                    const isSelf = p.is_self;
                    const isLeader = (p.is_leader === 1 || p.is_leader === true || p.is_leader === undefined);
                    let tagHtml = '';
                    if (isSelf && isLeader) {
                        tagHtml = '<span style="font-size: 0.7rem; background: #dcfce7; color: #166534; border: 1px solid #86efac; padding: 2px 7px; border-radius: 99px; font-weight: 800;">👑 You (Leader)</span>';
                    } else if (isSelf) {
                        tagHtml = '<span style="font-size: 0.7rem; background: #fef08a; color: #854d0e; border: 1px solid #facc15; padding: 2px 7px; border-radius: 99px; font-weight: 800;">👥 Your Teammate</span>';
                    }
                    const teamBadge = p.team_name ? `<span style="font-size: 0.68rem; background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc; padding: 1.5px 6px; border-radius: 4px; font-weight: 700;">🛡️ ${escapeHtml(p.team_name)}</span>` : '';

                    return `
                        <tr style="border-bottom: 1px solid #f1f5f9; ${isSelf ? 'background: #f0fdf4;' : 'background: #ffffff;'}">
                            <td style="padding: 10px 8px; vertical-align: middle;">
                                <span style="font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 1rem; background: ${isSelf ? '#dcfce7' : '#f1f5f9'}; color: ${isSelf ? '#15803d' : '#0f172a'}; padding: 3px 8px; border-radius: 6px; border: 1px solid ${isSelf ? '#86efac' : '#cbd5e1'}; display: inline-block;">
                                    #${p.slot_number}
                                </span>
                            </td>
                            <td style="padding: 10px 8px; vertical-align: middle;">
                                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                                    <span style="font-weight: 800; font-size: 0.92rem; color: #0f172a;">
                                        ${escapeHtml(p.player_ign || 'Anonymous')}
                                    </span>
                                    ${teamBadge}
                                    ${tagHtml}
                                </div>
                            </td>
                            <td style="padding: 10px 8px; text-align: right; vertical-align: middle;">
                                <span class="protected-uid" style="font-family: monospace; font-size: 0.92rem; font-weight: 800; background: #ecfdf5; border: 1px solid #a7f3d0; color: #047857; padding: 3px 10px; border-radius: 6px; letter-spacing: 0.5px; display: inline-block;" oncopy="return false;" oncontextmenu="return false;" ondragstart="return false;" onselectstart="return false;" title="Protected UID - Copying disabled">
                                    ${escapeHtml(p.player_uid || '------')}
                                </span>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }

        if (loadingEl) loadingEl.style.display = 'none';
        if (listEl) listEl.style.display = 'block';

    } catch (err) {
        console.error('Fetch participants error:', err);
        if (loadingEl) {
            loadingEl.innerHTML = `<div style="padding: 16px; color: #ef4444;">Unable to connect to server</div>`;
        }
    }
}


// Backward-compatibility alias
function viewMatchParticipants(matchId) {
    openMatchInnerPortal(matchId);
}

function renderMyMatches() {
    const grid = document.getElementById('myMatchesGrid');
    if (!grid) return;

    const joinedMatches = (allMatches || []).filter(m => m.has_joined);

    if (joinedMatches.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 36px 16px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; margin: 10px 0;">
                <span style="font-size: 2rem;">🎮</span>
                <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.1rem; font-weight: 800; color: #1e293b; margin: 8px 0 4px;">
                    You have not joined any tournament matches yet
                </div>
                <div style="font-size: 0.82rem; color: #64748b; margin-bottom: 16px;">
                    Browse upcoming tournaments and secure your slot to compete for exciting prizes!
                </div>
                <button class="btn btn-neon" style="padding: 8px 20px; font-size: 0.85rem; font-weight: 800;" onclick="switchTab('tab-matches')">
                    🔥 Browse Upcoming Matches
                </button>
            </div>
        `;
        return;
    }

    grid.innerHTML = joinedMatches.map(m => {
        const slotsPercent = Math.min(100, Math.round(((m.joined_count || 0) / (m.total_slots || 48)) * 100));
        const fmt = getMatchFormatInfo(m);

        return `
            <div class="match-card" style="border: 1px solid rgba(0, 245, 155, 0.35); box-shadow: 0 4px 20px rgba(0, 245, 155, 0.08);">
                <div class="match-card-header">
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px;">
                            <span class="match-code-badge">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                            <span class="match-category" style="background: rgba(0, 245, 155, 0.15); color: #00f59b; margin-bottom: 0;">✅ Registered</span>
                            <span class="match-format-monitor ${fmt.cssClass}" style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.74rem; font-weight: 800; padding: 2.5px 9px; border-radius: 999px; letter-spacing: 0.5px; text-transform: uppercase; font-family: 'Rajdhani', sans-serif; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); line-height: 1.2; ${fmt.inlineStyle}">${fmt.icon} ${fmt.label}</span>
                        </div>
                        <div class="match-title">${escapeHtml(m.title)}</div>
                        <div class="match-time-badge">⏰ ${escapeHtml(m.match_time || '')}</div>
                    </div>
                    <div class="match-map">🗺️ ${escapeHtml(m.map_name || 'Bermuda')}</div>
                </div>

                <div class="match-stats-row">
                    <div class="stat-item">
                        <span class="stat-label">Prize Pool</span>
                        <span class="stat-val prize">৳${m.prize_pool || 0}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Per Kill</span>
                        <span class="stat-val kill">৳${m.per_kill || 0}</span>
                    </div>
                    <div class="stat-item">
                        <span class="stat-label">Entry Fee</span>
                        <span class="stat-val fee">${m.entry_fee || 0}🪙</span>
                    </div>
                </div>

                <div class="slot-progress-wrapper" style="margin-bottom: 10px;">
                    <div class="slot-text-row">
                        <span>Slot Booking <span style="font-weight: 800; color: ${fmt.slotColor}; font-size: 0.78rem; margin-left: 2px;">(${fmt.label})</span></span>
                        <span><b>${m.joined_count || 0}</b> / ${m.total_slots || 48} players</span>
                    </div>
                    <div class="slot-bar-bg">
                        <div class="slot-bar-fill" style="width: ${slotsPercent}%;"></div>
                    </div>
                </div>

                <div class="match-card-footer">
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0, 245, 155, 0.08); border: 1px solid rgba(0, 245, 155, 0.25); border-radius: 8px; padding: 6px 10px;">
                            <span style="font-size: 0.8rem; color: #a7f3d0; font-weight: 700;">🎯 Your Assigned Slot:</span>
                            <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800; color: #00f59b;">#${m.my_slot || 1} (Fixed)</span>
                        </div>
                        <button class="btn btn-neon" style="width: 100%; padding: 9px 12px; font-size: 0.86rem; font-weight: 800; border-radius: 8px;" onclick="openMatchInnerPortal(${m.id})">
                            🔑 View Room & Players
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Backward-compatibility wrapper for joinMatch
function joinMatch(matchId, entryFee) {
    const m = (allMatches || []).find(x => x.id === matchId);
    openJoinMatchModal(matchId, m ? m.title : 'Free Fire Match', entryFee);
}


// -------------------------------------------------------------
// bKash Deposit Form
// -------------------------------------------------------------
async function handleDepositSubmit(e) {
    e.preventDefault();
    if (!currentUser) {
        showToast('ডিপোজিট করার আগে অনুগ্রহ করে সাইন ইন করুন', 'info');
        openModal('authModal');
        return;
    }

    const form = e.target;
    // Find inputs within the specifically submitted form
    const phoneInput = form.querySelector('[name="bkash_number"]') || 
                       form.querySelector('#modalDepSenderPhone') || 
                       form.querySelector('#shopDepSenderPhone') ||
                       form.querySelector('#depSenderPhone') ||
                       form.querySelector('input[type="text"][maxlength="11"]');
                       
    const amountInput = form.querySelector('[name="amount"]') || 
                        form.querySelector('#modalDepAmount') || 
                        form.querySelector('#shopDepAmount') ||
                        form.querySelector('#depAmount') ||
                        form.querySelector('input[type="number"]');
                        
    const trxInput = form.querySelector('[name="trx_id"]') || 
                     form.querySelector('#modalDepTrxId') || 
                     form.querySelector('#shopDepTrxId') ||
                     form.querySelector('#depTrxId') ||
                     form.querySelector('input[placeholder*="BL"]');

    const rawPhone = phoneInput ? phoneInput.value.trim().replace(/\s+/g, '').replace(/-/g, '') : '';
    const bkash_number = rawPhone.startsWith('+88') ? rawPhone.slice(3) : rawPhone;
    const amount = amountInput ? parseInt(amountInput.value) : 0;
    const trx_id = trxInput ? trxInput.value.trim().toUpperCase().replace(/\s+/g, '') : '';

    // Frontend validations with helpful Bengali feedback
    if (!bkash_number || !/^01[3-9]\d{8}$/.test(bkash_number)) {
        showToast('সঠিক ১১ ডিজিটের বিকাশ নাম্বার দিন (যেমন: 017XXXXXXXX)', 'error');
        if (phoneInput) phoneInput.focus();
        return;
    }

    if (!amount || amount < 10) {
        showToast('ডিপোজিটের জন্য সর্বনিম্ন পরিমাণ ১০ টাকা', 'error');
        if (amountInput) amountInput.focus();
        return;
    }

    if (amount > 25000) {
        showToast('একবারে সর্বোচ্চ ডিপোজিট পরিমাণ ২৫,০০০ টাকা', 'error');
        if (amountInput) amountInput.focus();
        return;
    }

    if (!trx_id || trx_id.length < 8 || trx_id.length > 16) {
        showToast('বিকাশ ট্রানজেকশন আইডি (TrxID) সাধারণত ৮ থেকে ১২ ক্যারেক্টারের হয় (যেমন: BLA491J3KP)', 'error');
        if (trxInput) trxInput.focus();
        return;
    }

    if (!/^[A-Z0-9]{8,16}$/.test(trx_id)) {
        showToast('ট্রানজেকশন আইডিতে শুধুমাত্র ইংরেজি বড় হাতের অক্ষর ও সংখ্যা দিন (কোনো স্পেস বা চিহ্ন নয়)', 'error');
        if (trxInput) trxInput.focus();
        return;
    }

    if (/^01\d{9}$/.test(trx_id)) {
        showToast('আপনি ট্রানজেকশন আইডির ঘরে ফোন নাম্বার দিয়েছেন! বিকাশ ফিরতি মেসেজ থেকে TrxID দিন।', 'error');
        if (trxInput) trxInput.focus();
        return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnContent = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '⏳ ভেরিফাই হচ্ছে...';
    }

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
            form.reset();
            // Reset both forms so inputs are clean everywhere
            document.querySelectorAll('#depositForm, #shopDepositForm, #modalDepositForm').forEach(f => {
                try { f.reset(); } catch(err) {}
            });
            loadWalletHistory();
            // Close modal if open
            if (typeof closeModal === 'function') {
                closeModal('depositModal');
            }
        } else {
            showToast(data.detail || 'ডিপোজিট রিকোয়েস্ট সম্পন্ন হয়নি', 'error');
        }
    } catch (e) {
        showToast('সার্ভারের সাথে সংযোগ করা যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnContent;
        }
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
    const targets = document.querySelectorAll('#depositHistoryBody, #modalDepositHistoryBody, .deposit-history-body');
    if (!targets || targets.length === 0) return;

    let content = '';
    if (!deposits || deposits.length === 0) {
        content = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px;">No deposit history found</td></tr>`;
    } else {
        content = deposits.map(d => `
            <tr>
                <td>${d.created_at ? d.created_at.split(' ')[0] : '-'}</td>
                <td style="font-weight: 700; color: var(--neon-amber);">${d.amount} 🪙</td>
                <td style="font-family: monospace; font-weight: 700; color: #0284c7;">${escapeHtml(d.trx_id)}</td>
                <td><span class="badge-status ${d.status}">${d.status}</span></td>
            </tr>
        `).join('');
    }

    targets.forEach(tbody => {
        tbody.innerHTML = content;
    });
}

function copyBkashNumber() {
    navigator.clipboard.writeText(adminBkashNumber.split(' ')[0]);
    showToast(`bKash number (${adminBkashNumber.split(' ')[0]}) copied!`, 'success');
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
            const statPendingWith = document.getElementById('adminStatPendingWithdrawals');
            if (statPendingWith) statPendingWith.innerText = data.pending_withdrawals || 0;
            document.getElementById('adminStatTotalMatches').innerText = data.total_matches;
            document.getElementById('adminStatCirculatingDigits').innerText = data.total_digits_circulating;

            renderPendingDeposits(data.pending_deposits_list);
            renderPendingWithdrawals(data.pending_withdrawals_list);
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
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No pending deposit requests 🎉</td></tr>`;
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

function renderPendingWithdrawals(list) {
    const tbody = document.getElementById('adminPendingWithdrawalsBody');
    if (!tbody) return;

    if (!list || list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 16px;">No pending withdrawal requests 🎉</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(w => `
        <tr>
            <td>
                <b>${escapeHtml(w.username || 'User #' + w.user_id)}</b>
                <div style="font-size: 0.72rem; color: var(--text-muted);">${w.player_id || ''}</div>
            </td>
            <td style="font-family: monospace; font-weight: 700; color: #0284c7;">${escapeHtml(w.bkash_number)}</td>
            <td style="font-weight: 800; color: #ef4444;">BDT ${w.amount}</td>
            <td>${w.created_at || '-'}</td>
            <td><span class="badge-status pending">Pending</span></td>
            <td>
                <div style="display: flex; gap: 6px;">
                    <button class="btn btn-neon btn-sm" onclick="reviewWithdrawal(${w.id}, 'approve')">✅ Approve</button>
                    <button class="btn btn-crimson btn-sm" onclick="reviewWithdrawal(${w.id}, 'reject')">❌ Reject</button>
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
            showToast(`Deposit #${depId} ${action === 'approve' ? 'approved' : 'rejected'} successfully`, 'success');
            loadAdminOverview();
        } else {
            showToast(data.detail || 'An error occurred', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
    }
}

async function reviewWithdrawal(withdrawId, action) {
    try {
        const res = await fetch(`/api/admin/withdrawals/${withdrawId}/review?action=${action}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Withdrawal #${withdrawId} ${action === 'approve' ? 'approved' : 'rejected'} successfully`, 'success');
            loadAdminOverview();
        } else {
            showToast(data.detail || 'An error occurred', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
    }
}

// Admin Users Management & Direct Digits Add/Remove
let adminUsersCache = [];
let currentActionUser = null;

async function loadAdminUsers(search = '') {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'moderator')) return;
    try {
        const url = search ? `/api/admin/users?search=${encodeURIComponent(search)}` : '/api/admin/users';
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const users = await res.json();
            adminUsersCache = users;
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
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No users found</td></tr>`;
        return;
    }

    const isMod = currentUser && currentUser.role === 'moderator';

    tbody.innerHTML = users.map(u => {
        const hasPass = u.plain_password && String(u.plain_password).trim().length > 0;
        const passDisplay = hasPass ? `
            <div style="display: inline-flex; align-items: center; gap: 5px;">
                <code id="passText_${u.id}" data-pass="${escapeHtml(u.plain_password)}" data-masked="true" style="font-family: monospace; font-size: 0.85rem; font-weight: 700; color: #00f59b; background: rgba(0, 245, 155, 0.08); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(0, 245, 155, 0.25); letter-spacing: 2px;">
                    ••••••••
                </code>
                <button type="button" id="passEyeBtn_${u.id}" class="btn btn-outline btn-xs" title="View Password" onclick="togglePassVisibility(${u.id}); event.stopPropagation();" style="padding: 2px 5px; font-size: 0.72rem;">👁️</button>
                <button type="button" class="btn btn-outline btn-xs" title="Copy" onclick="copyUserPass('${escapeHtml(u.plain_password)}'); event.stopPropagation();" style="padding: 2px 5px; font-size: 0.72rem;">📋</button>
            </div>
        ` : `
            <span style="color: var(--text-muted); font-size: 0.75rem; font-style: italic;">Login / Reset</span>
        `;

        let statusBadge = `<span class="badge-status approved">ACTIVE</span>`;
        if (u.status === 'banned') {
            statusBadge = `<span class="badge-status rejected">BANNED</span>`;
        } else if (u.is_timed_out) {
            statusBadge = `<span class="badge-status timeout">⏱️ TIMEOUT (${u.timeout_remaining_mins}m)</span>`;
        }

        const actionsHtml = isMod ? `
            <div style="display: inline-flex; gap: 4px; align-items: center; white-space: nowrap;">
                <span class="badge-status pending" style="font-size: 0.72rem; padding: 4px 8px;">🛡️ View Only</span>
            </div>
        ` : `
            <div class="user-action-btn-group" style="display: inline-flex; align-items: center; gap: 4px; background: #f8fafc; padding: 3px 6px; border-radius: 8px; border: 1px solid #e2e8f0; white-space: nowrap;">
                <button type="button" class="btn-action-manage" onclick="openUserActionModal(${u.id}); event.stopPropagation();" title="Full Control Panel (Timeout, Ban, Role, Password)" style="padding: 4px 9px; font-size: 0.75rem; font-weight: 700; border-radius: 5px; white-space: nowrap;">
                    ⚙️ Control
                </button>
                <button type="button" class="btn btn-outline btn-sm" onclick="openAdjustDigitsModal(${u.id}, '${escapeHtml(u.username)}', ${u.digits_balance}); event.stopPropagation();" title="Adjust Balance (+ / -)" style="padding: 4px 8px; font-size: 0.75rem; font-weight: 700; border-radius: 5px; border-color: #f59e0b; color: #b45309; background: #fef3c7; white-space: nowrap;">
                    🪙 +/-
                </button>
                ${u.role !== 'admin' ? `
                    <button type="button" class="btn btn-crimson btn-sm" onclick="confirmDeleteUser(${u.id}, '${escapeHtml(u.username)}'); event.stopPropagation();" title="Permanently Delete Player Account" style="padding: 4px 8px; font-size: 0.75rem; font-weight: 700; border-radius: 5px; white-space: nowrap;">
                        🗑️ Delete
                    </button>
                ` : ''}
            </div>
        `;

        return `
        <tr class="user-table-row" onclick="${isMod ? '' : `openUserActionModal(${u.id})`}" title="${isMod ? 'User Profile Information' : 'Click to open full player control panel'}">
            <td style="font-family: monospace; font-size: 0.8rem;">
                <div style="font-weight: 800; color: #0284c7; font-size: 0.88rem;">ID: #${u.id}</div>
                <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(u.player_id || '')}</div>
            </td>
            <td>
                <b style="color: #0284c7;">${escapeHtml(u.username)}</b>
                ${u.role === 'admin' ? '<span class="tab-admin-badge" style="margin-left: 4px;">ADMIN</span>' : ''}
                ${u.role === 'moderator' ? '<span class="tab-admin-badge" style="margin-left: 4px; background: var(--neon-cyan); color: #000;">MOD</span>' : ''}
            </td>
            <td>
                <div>${escapeHtml(u.ff_ign)}</div>
                <div style="font-size: 0.75rem; color: var(--text-muted); font-family: monospace;">UID: ${escapeHtml(u.ff_uid)}</div>
            </td>
            <td style="font-family: monospace;">${escapeHtml(u.phone)}</td>
            <td onclick="event.stopPropagation()">${passDisplay}</td>
            <td>
                <span style="font-family: 'Rajdhani'; font-weight: 800; font-size: 1.1rem; color: var(--neon-amber);">
                    ${u.digits_balance} 🪙
                </span>
            </td>
            <td>${statusBadge}</td>
            <td onclick="event.stopPropagation()" style="text-align: center; white-space: nowrap;">${actionsHtml}</td>
        </tr>
    `}).join('');
}

// Manual User Creation
function openCreateUserModal() {
    const uName = document.getElementById('newPlayerUsername');
    const uPhone = document.getElementById('newPlayerPhone');
    const uDigits = document.getElementById('newPlayerDigits');
    const uRole = document.getElementById('newPlayerRole');
    const uIgn = document.getElementById('newPlayerIgn');
    const uUid = document.getElementById('newPlayerUid');

    if (uName) uName.value = '';
    if (uPhone) uPhone.value = '';
    if (uDigits) uDigits.value = '0';
    if (uRole) uRole.value = 'player';
    if (uIgn) uIgn.value = '';
    if (uUid) uUid.value = '';
    generateNewPlayerPassword();
    openModal('adminCreateUserModal');
}

function generateNewPlayerPassword() {
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const passInput = document.getElementById('newPlayerPassword');
    if (passInput) {
        passInput.value = `gomon${randNum}`;
    }
}

async function handleAdminCreateUserSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('newPlayerUsername').value.trim();
    const phone = document.getElementById('newPlayerPhone').value.trim();
    const password = document.getElementById('newPlayerPassword').value.trim();
    const digits_balance = parseInt(document.getElementById('newPlayerDigits').value) || 0;
    const role = document.getElementById('newPlayerRole').value;
    const ff_ign = document.getElementById('newPlayerIgn').value.trim();
    const ff_uid = document.getElementById('newPlayerUid').value.trim();

    if (!username || username.length < 3) {
        showToast('Username must be at least 3 characters', 'error');
        return;
    }
    if (!phone || phone.length < 11) {
        showToast('Please enter a valid 11-digit phone number', 'error');
        return;
    }
    if (!password || password.length < 4) {
        showToast('Password must be at least 4 characters', 'error');
        return;
    }

    const submitBtn = document.getElementById('btnSubmitCreateUser');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Creating account...';
    }

    try {
        const res = await fetch('/api/admin/users/create', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                username,
                phone,
                password,
                digits_balance,
                role,
                ff_ign,
                ff_uid
            })
        });

        const data = await res.json();
        if (res.ok) {
            closeModal('adminCreateUserModal');
            showToast(`Player @${username} created! Password: ${password}`, 'success');
            try {
                navigator.clipboard.writeText(`Username: ${username}\nPassword: ${password}`);
            } catch (err) {}
            loadAdminUsers();
            loadAdminOverview();
        } else {
            showToast(data.detail || 'Unable to create user', 'error');
        }
    } catch (err) {
        showToast('Server error, please try again', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = '✅ Create Account';
        }
    }
}

// Interactive User Action Modal
function openUserActionModal(userId) {
    const user = adminUsersCache.find(u => u.id === userId);
    if (!user) {
        showToast('Player details not found', 'error');
        return;
    }
    currentActionUser = user;

    document.getElementById('actionTargetUserId').value = user.id;
    document.getElementById('userActionUsername').innerText = `@${user.username}`;
    document.getElementById('userActionPlayerId').innerText = user.player_id || '';
    document.getElementById('userActionBalance').innerText = `${user.digits_balance} 🪙`;
    document.getElementById('userActionPhone').innerText = user.phone || '-';

    // Role badge
    const roleBadge = document.getElementById('userActionRoleBadge');
    if (roleBadge) {
        roleBadge.innerText = (user.role || 'player').toUpperCase();
        roleBadge.style.background = user.role === 'admin' ? '#ef4444' : (user.role === 'moderator' ? '#06b6d4' : '#3b82f6');
        roleBadge.style.color = '#ffffff';
    }

    // Status badge
    const statusBox = document.getElementById('userActionStatusBadge');
    if (statusBox) {
        if (user.status === 'banned') {
            statusBox.innerHTML = `<span class="badge-status rejected">BANNED</span>`;
        } else if (user.is_timed_out) {
            statusBox.innerHTML = `<span class="badge-status timeout">TIMEOUT</span>`;
        } else {
            statusBox.innerHTML = `<span class="badge-status approved">ACTIVE</span>`;
        }
    }

    // Timeout banner
    const timeoutBanner = document.getElementById('userActionTimeoutBanner');
    const timeoutRem = document.getElementById('userActionTimeoutRem');
    if (timeoutBanner && timeoutRem) {
        if (user.is_timed_out) {
            timeoutBanner.style.display = 'flex';
            timeoutRem.innerText = user.timeout_remaining_mins || 0;
        } else {
            timeoutBanner.style.display = 'none';
        }
    }

    // Password
    const passEl = document.getElementById('userActionPassText');
    const eyeBtn = document.getElementById('userActionPassEyeBtn');
    if (passEl) {
        passEl.setAttribute('data-pass', user.plain_password || '');
        passEl.setAttribute('data-masked', 'true');
        passEl.innerText = '••••••••';
    }
    if (eyeBtn) {
        eyeBtn.innerText = '👁️';
    }

    // Digit fields
    const digitInput = document.getElementById('userActionDigitAmount');
    const reasonInput = document.getElementById('userActionDigitReason');
    if (digitInput) digitInput.value = '';
    if (reasonInput) reasonInput.value = '';

    // Timeout input
    const toInput = document.getElementById('userActionCustomTimeout');
    if (toInput) toInput.value = '';

    // Moderator toggle button
    const btnMod = document.getElementById('btnToggleModRole');
    if (btnMod) {
        if (user.role === 'admin') {
            btnMod.style.display = 'none';
        } else {
            btnMod.style.display = 'inline-block';
            if (user.role === 'moderator') {
                btnMod.innerText = '🛡️ Set Regular Player';
                btnMod.style.color = '#d97706';
                btnMod.style.borderColor = '#f59e0b';
            } else {
                btnMod.innerText = '🛡️ Promote to Moderator';
                btnMod.style.color = '#0284c7';
                btnMod.style.borderColor = '#38bdf8';
            }
        }
    }

    // Ban toggle button
    const btnBan = document.getElementById('btnToggleBanStatus');
    if (btnBan) {
        if (user.role === 'admin') {
            btnBan.style.display = 'none';
        } else {
            btnBan.style.display = 'inline-block';
            if (user.status === 'banned') {
                btnBan.innerText = '✅ Unban Account';
                btnBan.style.borderColor = '#10b981';
                btnBan.style.color = '#059669';
            } else {
                btnBan.innerText = '🚫 Ban Account';
                btnBan.style.borderColor = '#ef4444';
                btnBan.style.color = '#dc2626';
            }
        }
    }

    openModal('adminUserActionModal');
}

function toggleActionModalPass() {
    const el = document.getElementById('userActionPassText');
    const btn = document.getElementById('userActionPassEyeBtn');
    if (!el || !btn) return;
    const isMasked = el.getAttribute('data-masked') === 'true';
    if (isMasked) {
        el.innerText = el.getAttribute('data-pass') || 'No password set';
        el.setAttribute('data-masked', 'false');
        btn.innerText = '🙈';
    } else {
        el.innerText = '••••••••';
        el.setAttribute('data-masked', 'true');
        btn.innerText = '👁️';
    }
}

function copyActionModalPass() {
    const el = document.getElementById('userActionPassText');
    if (el) {
        const p = el.getAttribute('data-pass');
        if (p) {
            navigator.clipboard.writeText(p);
            showToast(`Password '${p}' copied to clipboard!`, 'success');
        } else {
            showToast('No password saved', 'info');
        }
    }
}

function setActionDigitInput(amount) {
    const input = document.getElementById('userActionDigitAmount');
    if (input) {
        input.value = amount;
    }
}

async function executeDigitAdjustment(type) {
    if (!currentActionUser) return;
    const amtInput = document.getElementById('userActionDigitAmount');
    const reasonInput = document.getElementById('userActionDigitReason');
    const val = parseInt(amtInput.value);
    if (!val || val <= 0) {
        showToast('Please enter a valid amount (e.g. 50)', 'error');
        return;
    }

    const finalAmount = type === 'subtract' ? -val : val;
    const reason = reasonInput.value.trim() || (type === 'add' ? 'Manual Digits Added' : 'Manual Digits Deducted');

    try {
        const res = await fetch('/api/admin/users/adjust-digits', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                target_user_id: currentActionUser.id,
                amount: finalAmount,
                reason: reason
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            playSound('coin');
            currentActionUser.digits_balance = data.new_balance;
            document.getElementById('userActionBalance').innerText = `${data.new_balance} 🪙`;
            amtInput.value = '';
            reasonInput.value = '';
            loadAdminUsers();
            loadAdminOverview();
        } else {
            showToast(data.detail || 'Unable to adjust balance', 'error');
        }
    } catch (e) {
        showToast('Server connection failed', 'error');
    }
}

async function applyQuickTimeout(minutes) {
    if (!currentActionUser) return;
    if (currentActionUser.role === 'admin') {
        showToast('Cannot timeout Master Admin account', 'error');
        return;
    }
    if (!confirm(`Are you sure you want to timeout @${currentActionUser.username} for ${minutes} minutes?`)) return;
    await setUserTimeout(currentActionUser.id, minutes);
}

async function applyCustomTimeout() {
    if (!currentActionUser) return;
    const mins = parseInt(document.getElementById('userActionCustomTimeout').value);
    if (!mins || mins <= 0) {
        showToast('Please enter valid minutes', 'error');
        return;
    }
    if (currentActionUser.role === 'admin') {
        showToast('Cannot timeout Master Admin account', 'error');
        return;
    }
    await setUserTimeout(currentActionUser.id, mins);
}

async function clearUserTimeoutFromModal() {
    if (!currentActionUser) return;
    await setUserTimeout(currentActionUser.id, 0);
}

async function setUserTimeout(userId, minutes) {
    try {
        const res = await fetch(`/api/admin/users/${userId}/timeout`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                duration_minutes: minutes,
                reason: minutes > 0 ? `Suspended for ${minutes} mins by Admin` : 'Timeout lifted'
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'info');
            await loadAdminUsers();
            openUserActionModal(userId);
        } else {
            showToast(data.detail || 'Unable to update timeout', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
    }
}

async function toggleBanFromActionModal() {
    if (!currentActionUser) return;
    if (currentActionUser.role === 'admin') {
        showToast('Cannot ban Master Admin account', 'error');
        return;
    }
    const isBanning = currentActionUser.status !== 'banned';
    const msg = isBanning ? 
        `Are you sure you want to ban @${currentActionUser.username}? This account will be blocked from accessing the platform.` :
        `Do you want to unban @${currentActionUser.username}?`;
    if (!confirm(msg)) return;

    try {
        const res = await fetch(`/api/admin/users/${currentActionUser.id}/toggle-status`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Status updated: ${data.new_status}`, 'info');
            await loadAdminUsers();
            openUserActionModal(currentActionUser.id);
        } else {
            showToast(data.detail || 'Operation failed', 'error');
        }
    } catch (e) {
        showToast('Server error', 'error');
    }
}

async function toggleModRoleFromModal() {
    if (!currentActionUser) return;
    if (currentActionUser.role === 'admin') {
        showToast('Master Admin role cannot be changed', 'error');
        return;
    }
    const newRole = currentActionUser.role === 'moderator' ? 'player' : 'moderator';
    const msg = newRole === 'moderator' ?
        `Do you want to appoint @${currentActionUser.username} as Moderator?` :
        `Do you want to revoke Moderator role from @${currentActionUser.username}?`;
    if (!confirm(msg)) return;

    try {
        const res = await fetch(`/api/admin/users/${currentActionUser.id}/set-role`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ role: newRole })
        });
        const data = await res.json();
        if (res.ok) {
            showToast(data.message, 'success');
            await loadAdminUsers();
            openUserActionModal(currentActionUser.id);
        } else {
            showToast(data.detail || 'Unable to update role', 'error');
        }
    } catch (e) {
        showToast('Server error', 'error');
    }
}

async function deleteUserFromActionModal() {
    if (!currentActionUser) return;
    confirmDeleteUser(currentActionUser.id, currentActionUser.username);
}

async function confirmDeleteUser(userId, username) {
    if (!confirm(`🚨 WARNING: Are you sure you want to permanently delete @${username}?\n\nAll player data, tournament records, and wallet balances will be permanently deleted and cannot be recovered!`)) {
        return;
    }
    showToast(`Deleting @${username}...`, 'info');
    try {
        const res = await fetch(`/api/admin/users/${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            closeModal('adminUserActionModal');
            showToast(`Account @${data.deleted_username || username} has been permanently deleted!`, 'success');
            playSound('alert');
            loadAdminUsers();
            loadAdminOverview();
        } else {
            showToast(data.detail || 'Unable to delete account', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
    }
}

function openResetPasswordFromActionModal() {
    if (!currentActionUser) return;
    openResetPasswordModal(currentActionUser.id, currentActionUser.username, currentActionUser.player_id);
}

function impersonateFromActionModal() {
    if (!currentActionUser) return;
    impersonateUser(currentActionUser.id);
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
        btn.title = 'Hide Password';
    } else {
        el.innerText = '••••••••';
        el.style.letterSpacing = '2px';
        el.setAttribute('data-masked', 'true');
        btn.innerText = '👁️';
        btn.title = 'View Password';
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
        showToast(`Password '${passInput.value}' copied to clipboard!`, 'success');
    }
}

function copyUserPass(pass) {
    if (pass) {
        navigator.clipboard.writeText(pass);
        showToast(`Password '${pass}' copied to clipboard!`, 'success');
    }
}

async function handleResetPasswordSubmit(e) {
    e.preventDefault();
    const target_user_id = parseInt(document.getElementById('resetTargetUserId').value);
    const new_password = document.getElementById('resetNewPassword').value.trim();

    if (!new_password || new_password.length < 4) {
        showToast('Password must be at least 4 characters long', 'error');
        return;
    }

    const submitBtn = document.getElementById('btnSubmitResetPass');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Updating...';
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
            showToast(`Password updated successfully! New password: ${new_password}`, 'success');
            try {
                navigator.clipboard.writeText(new_password);
            } catch (err) {}
            loadAdminUsers();
        } else {
            showToast(data.detail || 'Password reset failed', 'error');
        }
    } catch (err) {
        showToast('Server error, please try again', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = 'Save Password';
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
            showToast(data.detail || 'Unable to adjust balance', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
    }
}

async function impersonateUser(targetUserId) {
    if (!confirm('Do you want to impersonate this player and view the platform as them?')) return;
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
            showToast(`Viewing platform as @${data.user.username}!`, 'success');
            location.reload();
        }
    } catch (e) {
        showToast('Unable to impersonate user', 'error');
    }
}

async function toggleUserStatus(targetUserId) {
    if (!confirm('Confirm account status change?')) return;
    try {
        const res = await fetch(`/api/admin/users/${targetUserId}/toggle-status`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            showToast(`Status for @${data.username} updated to: ${data.new_status}`, 'info');
            loadAdminUsers();
        }
    } catch (e) {
        showToast('Operation failed', 'error');
    }
}

// Admin & Moderator Match Controls
function renderAdminMatches() {
    const tbody = document.getElementById('adminMatchesTableBody');
    if (!tbody) return;

    const isAdmin = (currentUser && currentUser.role === 'admin');

    tbody.innerHTML = allMatches.map(m => {
        const isCompleted = (m.status === 'completed');
        const fmt = getMatchFormatInfo(m);
        const catName = getMatchCategoryDisplay(m.match_type);
        const updaterInfo = m.room_updated_by_name ? `
            <div style="font-size: 0.78rem; color: var(--neon-cyan);">
                <b>🛡️ ${escapeHtml(m.room_updated_by_name)}</b>
                <div style="font-size: 0.68rem; color: var(--text-muted);">${m.room_updated_at ? m.room_updated_at.substring(5, 16) : ''}</div>
                ${m.completed_by_name ? `<div style="font-size: 0.7rem; color: var(--neon-green); margin-top: 2px;">🏁 Concluded by: ${escapeHtml(m.completed_by_name)}</div>` : ''}
            </div>
        ` : `<span style="font-size: 0.75rem; color: var(--text-muted);">Not updated yet</span>`;

        return `
        <tr>
            <td>
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span class="match-code-badge" style="font-size: 0.72rem; padding: 2px 6px;">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                    <b>${escapeHtml(m.title)}</b>
                    ${isCompleted ? '<span class="badge-status approved" style="margin-left: 4px; font-size: 0.65rem;">Concluded</span>' : ''}
                </div>
            </td>
            <td>
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    <span>${escapeHtml(catName)} (${escapeHtml(m.map_name || 'Bermuda')})</span>
                    <span class="match-format-monitor ${fmt.cssClass}" style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.68rem; font-weight: 800; padding: 1px 6px; border-radius: 999px; letter-spacing: 0.5px; text-transform: uppercase; font-family: 'Rajdhani', sans-serif; margin-left: 4px; ${fmt.inlineStyle}">${fmt.icon} ${fmt.label}</span>
                </div>
            </td>
            <td style="font-size: 0.8rem;">${m.match_time}</td>
            <td>${m.entry_fee} 🪙 / ৳${m.prize_pool}</td>
            <td>${m.joined_count} / ${m.total_slots}</td>
            <td>
                <div style="font-family: monospace; font-size: 0.82rem;">
                    <div>ID: <b style="color: var(--neon-green);">${m.room_id || 'Not set'}</b></div>
                    <div>Pass: <b style="color: var(--neon-cyan);">${m.room_pass || 'Not set'}</b></div>
                </div>
            </td>
            <td>${updaterInfo}</td>
            <td style="white-space: nowrap; text-align: center;">
                <div style="display: inline-flex; align-items: center; gap: 8px; flex-wrap: nowrap; justify-content: center;">
                    <button type="button" onclick="openMatchInnerPortal(${m.id})" 
                        style="background: #ecfdf5; color: #047857; border: 1.5px solid #6ee7b7; font-weight: 800; font-size: 0.82rem; padding: 7px 13px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); transition: all 0.2s ease; white-space: nowrap;"
                        onmouseover="this.style.background='#10b981';this.style.color='#ffffff';this.style.borderColor='#10b981';this.style.boxShadow='0 3px 8px rgba(16,185,129,0.3)';"
                        onmouseout="this.style.background='#ecfdf5';this.style.color='#047857';this.style.borderColor='#6ee7b7';this.style.boxShadow='0 1px 3px rgba(0,0,0,0.06)';"
                        title="View Registered Players & UIDs">
                        <span style="font-size: 0.95rem;">👥</span> Players (${m.joined_count})
                    </button>
                    <button type="button" onclick="openSetRoomModal(${m.id}, '${escapeHtml(m.room_id || '')}', '${escapeHtml(m.room_pass || '')}')"
                        style="background: linear-gradient(135deg, #059669, #10b981); color: #ffffff; border: 1px solid #047857; font-weight: 800; font-size: 0.82rem; padding: 7px 14px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 6px rgba(5,150,105,0.28); transition: all 0.2s ease; white-space: nowrap;"
                        onmouseover="this.style.filter='brightness(1.1)';this.style.transform='translateY(-1px)';this.style.boxShadow='0 4px 10px rgba(5,150,105,0.4)';"
                        onmouseout="this.style.filter='none';this.style.transform='translateY(0)';this.style.boxShadow='0 2px 6px rgba(5,150,105,0.28)';"
                        title="Set / Update Room ID & Password">
                        <span style="font-size: 0.95rem;">🔑</span> Room ID
                    </button>

                    ${!isCompleted ? `
                        <button type="button" onclick="completeMatch(${m.id}, '${escapeHtml(m.title)}')"
                            style="background: #fffbeb; color: #b45309; border: 1.5px solid #fcd34d; font-weight: 800; font-size: 0.82rem; padding: 7px 13px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); transition: all 0.2s ease; white-space: nowrap;"
                            onmouseover="this.style.background='#f59e0b';this.style.color='#ffffff';this.style.borderColor='#f59e0b';this.style.boxShadow='0 3px 8px rgba(245,158,11,0.3)';"
                            onmouseout="this.style.background='#fffbeb';this.style.color='#b45309';this.style.borderColor='#fcd34d';this.style.boxShadow='0 1px 3px rgba(0,0,0,0.06)';"
                            title="Conclude Tournament & Distribute Prizes">
                            <span style="font-size: 0.95rem;">🏁</span> Conclude
                        </button>
                    ` : ''}
                    ${isAdmin ? `
                        <button type="button" onclick="deleteMatch(${m.id})"
                            style="background: #fef2f2; color: #dc2626; border: 1.5px solid #fca5a5; font-weight: 700; font-size: 0.92rem; width: 35px; height: 35px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); transition: all 0.2s ease; flex-shrink: 0;"
                            onmouseover="this.style.background='#ef4444';this.style.color='#ffffff';this.style.borderColor='#ef4444';this.style.boxShadow='0 3px 8px rgba(239,68,68,0.3)';"
                            onmouseout="this.style.background='#fef2f2';this.style.color='#dc2626';this.style.borderColor='#fca5a5';this.style.boxShadow='0 1px 3px rgba(0,0,0,0.06)';"
                            title="Delete Match">
                            🗑️
                        </button>
                    ` : ''}
                </div>
            </td>
        </tr>
    `}).join('');
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
            showToast('Room ID and Password published successfully!', 'success');
            playSound('alert');
            loadMatches();
            if (currentUser && currentUser.role === 'admin') {
                loadModeratorScoreboard();
            }
        } else {
            const err = await res.json();
            showToast(err.detail || 'Operation failed', 'error');
        }
    } catch (e) {
        showToast('Operation failed', 'error');
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
            showToast('New tournament match created successfully!', 'success');
            loadMatches();
            loadAdminOverview();
        }
    } catch (e) {
        showToast('Operation failed', 'error');
    }
}

async function deleteMatch(matchId) {
    if (!confirm('Are you sure you want to delete this match?')) return;
    try {
        const res = await fetch(`/api/admin/matches/${matchId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            showToast('Match deleted successfully', 'info');
            loadMatches();
            loadAdminOverview();
        }
    } catch (e) {
        showToast('Operation failed', 'error');
    }
}

async function completeMatch(matchId, title) {
    if (!confirm(`Are you sure "${title}" has completed and you want to mark it concluded?`)) return;
    try {
        const res = await fetch(`/api/admin/matches/${matchId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ status: 'completed' })
        });
        if (res.ok) {
            showToast(`Match "${title}" concluded successfully!`, 'success');
            playSound('alert');
            loadMatches();
            if (currentUser && currentUser.role === 'admin') {
                loadModeratorScoreboard();
            }
        } else {
            const err = await res.json();
            showToast(err.detail || 'Operation failed', 'error');
        }
    } catch (e) {
        showToast('Server error', 'error');
    }
}

// Moderator Scoreboard & Management (Master Admin Only)
async function loadModeratorScoreboard() {
    if (!token || !currentUser || currentUser.role !== 'admin') return;
    try {
        const res = await fetch('/api/admin/moderators', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const mods = await res.json();
            renderModeratorScoreboard(mods);
        }
    } catch (e) {
        console.error('Failed to load moderator scoreboard:', e);
    }
}

function renderModeratorScoreboard(mods) {
    const tbody = document.getElementById('adminModeratorsTableBody');
    if (!tbody) return;

    if (!mods || mods.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No moderators currently assigned. Enter a Player User ID below or click "🛡️ Promote to Moderator" from the Player List.</td></tr>`;
        return;
    }

    tbody.innerHTML = mods.map(m => {
        const recentAction = m.recent_actions && m.recent_actions.length > 0 
            ? `<div style="font-size: 0.75rem; color: var(--text-secondary); max-width: 220px;">
                <b>${escapeHtml(m.recent_actions[0].action)}</b>
                <div style="font-size: 0.68rem; color: var(--text-muted);">${m.recent_actions[0].timestamp ? m.recent_actions[0].timestamp.substring(5, 16) : ''}</div>
               </div>`
            : `<span style="color: var(--text-muted); font-size: 0.75rem;">No actions recorded yet</span>`;

        return `
            <tr>
                <td style="font-family: monospace; font-weight: 700; color: var(--neon-cyan);">${m.player_id}</td>
                <td>
                    <b>${escapeHtml(m.username)}</b>
                    <div style="font-size: 0.72rem; color: var(--text-muted);">IGN: ${escapeHtml(m.ff_ign || 'N/A')}</div>
                </td>
                <td style="font-family: monospace;">${escapeHtml(m.phone || 'N/A')}</td>
                <td>
                    <span style="font-family: 'Rajdhani'; font-weight: 800; font-size: 1.15rem; color: var(--neon-green); background: rgba(0, 245, 155, 0.1); padding: 2px 10px; border-radius: 6px; border: 1px solid rgba(0, 245, 155, 0.2);">
                        ${m.rooms_released_count} Matches
                    </span>
                </td>
                <td>
                    <span style="font-family: 'Rajdhani'; font-weight: 800; font-size: 1.15rem; color: var(--neon-amber); background: rgba(255, 183, 3, 0.1); padding: 2px 10px; border-radius: 6px; border: 1px solid rgba(255, 183, 3, 0.2);">
                        ${m.completed_matches_count} Matches
                    </span>
                </td>
                <td>${recentAction}</td>
                <td>
                    <button class="btn btn-crimson btn-sm" onclick="setUserRole(${m.id}, 'player')" title="Revoke moderator privileges">
                        🛡️ Remove Mod
                    </button>
                </td>
            </tr>
        `;
    }).join('');
}

async function promoteModeratorFromInput() {
    const input = document.getElementById('promoteModUserIdInput');
    const userId = input ? parseInt(input.value) : null;
    if (!userId || isNaN(userId)) {
        showToast('Please enter a valid Player User ID', 'error');
        return;
    }
    await setUserRole(userId, 'moderator');
    if (input) input.value = '';
}

async function setUserRole(targetUserId, newRole) {
    const roleName = newRole === 'moderator' ? 'Moderator' : 'Regular Player';
    if (!confirm(`Are you sure you want to set this user role to "${roleName}"?`)) return;

    try {
        const res = await fetch(`/api/admin/users/${targetUserId}/set-role`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ role: newRole })
        });
        if (res.ok) {
            const data = await res.json();
            showToast(data.message || `Role successfully updated to ${roleName}!`, 'success');
            playSound('alert');
            loadAdminUsers();
            loadModeratorScoreboard();
        } else {
            const err = await res.json();
            showToast(err.detail || 'Role update failed', 'error');
        }
    } catch (e) {
        showToast('Server error', 'error');
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
        showToast('Failed to broadcast notice', 'error');
    }
}

async function handleSettingsSubmit(e) {
    e.preventDefault();
    const admin_bkash = (document.getElementById('settingAdminBkash') ? document.getElementById('settingAdminBkash').value : '').trim();
    const admin_withdraw_number = (document.getElementById('settingAdminWithdraw') ? document.getElementById('settingAdminWithdraw').value : '').trim();
    const site_title = (document.getElementById('settingSiteTitle') ? document.getElementById('settingSiteTitle').value : '').trim();
    const notice = (document.getElementById('settingNotice') ? document.getElementById('settingNotice').value : '').trim();

    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ admin_bkash, admin_withdraw_number, site_title, notice })
        });
        if (res.ok) {
            showToast('সব সেটিংস সফলভাবে সেভ হয়েছে!', 'success');
            loadPublicInfo();
        } else {
            showToast('সেটিংস সেভ করতে সমস্যা হয়েছে', 'error');
        }
    } catch (e) {
        showToast('Operation failed', 'error');
    }
}

async function quickUpdateDepositNumber() {
    const el = document.getElementById('settingAdminBkash');
    const admin_bkash = el ? el.value.trim() : '';
    if (!admin_bkash) {
        showToast('ডিপোজিট বিকাশ নাম্বার প্রদান করুন', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ admin_bkash })
        });
        if (res.ok) {
            showToast(`ডিপোজিট নাম্বার আপডেট হয়েছে: ${admin_bkash}`, 'success');
            loadPublicInfo();
        } else {
            showToast('ডিপোজিট নাম্বার আপডেট ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে সমস্যা হয়েছে', 'error');
    }
}

async function quickUpdateWithdrawNumber() {
    const el = document.getElementById('settingAdminWithdraw');
    const admin_withdraw_number = el ? el.value.trim() : '';
    if (!admin_withdraw_number) {
        showToast('উইথড্র নাম্বার প্রদান করুন', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/admin/settings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ admin_withdraw_number })
        });
        if (res.ok) {
            showToast(`উইথড্র নাম্বার আপডেট হয়েছে: ${admin_withdraw_number}`, 'success');
            loadPublicInfo();
        } else {
            showToast('উইথড্র নাম্বার আপডেট ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        showToast('সার্ভারে সমস্যা হয়েছে', 'error');
    }
}

async function handleAdminChangePassword(e) {
    if (e) e.preventDefault();
    const currPass = (document.getElementById('adminCurrentPassword') ? document.getElementById('adminCurrentPassword').value : '').trim();
    const newPass = (document.getElementById('adminNewPassword') ? document.getElementById('adminNewPassword').value : '').trim();
    const confPass = (document.getElementById('adminConfirmPassword') ? document.getElementById('adminConfirmPassword').value : '').trim();

    if (newPass.length < 4) {
        showToast('নতুন পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে', 'warning');
        return;
    }
    if (confPass && newPass !== confPass) {
        showToast('নতুন পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না!', 'error');
        return;
    }

    const btn = document.getElementById('btnAdminChangePass');
    if (btn) btn.disabled = true;

    try {
        const res = await apiRequest('/api/admin/change-password', 'POST', {
            current_password: currPass,
            new_password: newPass,
            confirm_password: confPass
        });

        if (res && res.success) {
            showToast(res.message || 'এডমিন পাসওয়ার্ড সফলভাবে পরিবর্তিত হয়েছে!', 'success');
            if (res.token) {
                token = res.token;
                localStorage.setItem('token', res.token);
                localStorage.setItem('ff_token', res.token);
            }
            const form = document.getElementById('adminChangePasswordForm');
            if (form) form.reset();
        } else {
            showToast((res && (res.detail || res.message)) || 'পাসওয়ার্ড পরিবর্তন ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        console.error('Admin password change error', e);
        showToast(e.message || 'পাসওয়ার্ড পরিবর্তন করতে সমস্যা হয়েছে', 'error');
    } finally {
        if (btn) btn.disabled = false;
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
            updateBalanceUI(data.digits_balance);
            renderUserProfile();
            playSound('coin');
            if (data.notice) {
                showToast(data.notice, 'success');
            }
        }
    } else if (data.type === 'WIN_POINTS_UPDATED') {
        if (currentUser) {
            currentUser.win_points = data.win_points;
            renderUserProfile();
            playSound('bell');
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
    } else if (data.type === 'NEW_MATCH_CREATED' || data.type === 'ROOM_CREDENTIALS_RELEASED' || data.type === 'MATCH_RESULTS_PUBLISHED' || data.type === 'MATCH_STATUS_UPDATED') {
        loadMatches();
        if (typeof renderResults === 'function') {
            renderResults();
        }
        if (data.type === 'MATCH_RESULTS_PUBLISHED' && data.match_title) {
            showToast(`🏆 ${data.match_title} ম্যাচ সমাপ্ত হয়েছে ও ফলাফল প্রকাশিত হয়েছে!`, 'success');
        } else if (data.message) {
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
            showToast('📢 Live notice updated!', 'info');
        }
        if (data.site_title) {
            const titleNav = document.getElementById('siteTitleNav');
            if (titleNav) titleNav.innerText = data.site_title;
        }
        if (data.admin_bkash) {
            adminBkashNumber = data.admin_bkash;
            document.querySelectorAll('.displayBkashNumber, [id="displayBkashNumber"]').forEach(el => el.innerText = data.admin_bkash);
            const setBk = document.getElementById('settingAdminBkash');
            if (setBk) setBk.value = data.admin_bkash;
        }
        if (data.admin_withdraw_number) {
            adminWithdrawNumber = data.admin_withdraw_number;
            document.querySelectorAll('.displayWithdrawNumber, [id="displayWithdrawNumber"]').forEach(el => el.innerText = data.admin_withdraw_number);
            const setWith = document.getElementById('settingAdminWithdraw');
            if (setWith) setWith.value = data.admin_withdraw_number;
        }
    } else if (data.type === 'ADMIN_DASHBOARD_UPDATE') {
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator')) {
            loadAdminOverview();
        }
    } else if (data.type === 'APP_UPDATE_AVAILABLE') {
        playSound('alert');
        latestServerVersion = data.version;
        promptAppUpdate(data.version, data.notes);
    } else if (data.type === 'USER_BANNED_ALERT') {
        playSound('alert');
        showBanAlertToast(data.username);
    } else if (data.type === 'ACCOUNT_DELETED_KICK') {
        logout(false);
        showToast('⚠️ ' + (data.message || 'আপনার অ্যাকাউন্টটি ডিলিট করা হয়েছে।'), 'error');
        alert('⚠️ আপনার অ্যাকাউন্টটি অ্যাডমিন দ্বারা সম্পূর্ণ ডিলিট করা হয়েছে।');
    } else if (data.type === 'ACCOUNT_BANNED_KICK') {
        logout(false);
        showToast('🚨 ' + data.message, 'error');
        alert('🚨 Your account has been banned from GOMON HUB.');
    } else if (data.type === 'ACCOUNT_SECURITY_LOGOUT') {
        logout(false);
        showToast('🔒 ' + (data.message || 'Your password was updated for security.'), 'info');
        alert('🔒 Admin updated your password for account security. Please contact Admin to get your new credentials and sign in again.');
    } else if (data.type === 'ROLE_UPDATED') {
        if (currentUser) {
            currentUser.role = data.new_role;
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            renderLoggedInNav();
            applyRolePermissionsUI();
            if (data.new_role === 'moderator') {
                showToast('🛡️ Congratulations! You have been appointed as Moderator!', 'success');
                playSound('alert');
            } else {
                showToast('🛡️ Your moderator status was changed.', 'info');
            }
        }
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
                    ⛔ Banned due to violation of GOMON HUB fair play rules.
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
    showToast('🔄 Syncing live data from server...', 'info');
    await loadPublicInfo();
    await loadMatches();
    showToast('✅ Live data synced successfully!', 'success');
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
        showToast('Your browser does not support push notifications', 'error');
        return;
    }

    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            showToast('Push notifications enabled successfully!', 'success');
            document.getElementById('notifBadge').style.display = 'none';
            await subscribeUserToPush();
        } else {
            showToast('Notification permission was not granted', 'info');
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
// Admin Section Category Switching
// -------------------------------------------------------------
function switchAdminSection(sectionId) {
    // Hide all admin sections
    document.querySelectorAll('.admin-section').forEach(el => {
        el.style.display = 'none';
        el.classList.remove('active');
    });

    // Remove active state from all sidebar category buttons
    document.querySelectorAll('.admin-nav-item').forEach(el => el.classList.remove('active'));

    // Activate the targeted category button
    const navBtn = document.getElementById('adminNav-' + sectionId);
    if (navBtn) navBtn.classList.add('active');

    // Display the targeted category section
    const targetSection = document.getElementById('adminSection-' + sectionId);
    if (targetSection) {
        targetSection.style.display = 'block';
        targetSection.classList.add('active');
    }

    // Dynamic data loading for the opened section
    if (sectionId === 'dashboard') {
        if (currentUser && currentUser.role === 'admin') loadAdminOverview();
    } else if (sectionId === 'payments') {
        if (currentUser && currentUser.role === 'admin') loadAdminOverview();
    } else if (sectionId === 'withdrawals') {
        if (currentUser && currentUser.role === 'admin') loadAdminOverview();
    } else if (sectionId === 'players') {
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator')) loadAdminUsers();
    } else if (sectionId === 'matches') {
        if (currentUser && currentUser.role === 'moderator') {
            loadMatches();
        } else {
            loadAdminOverview();
        }
    } else if (sectionId === 'moderators') {
        if (currentUser && currentUser.role === 'admin') loadModeratorScoreboard();
    } else if (sectionId === 'history') {
        loadAdminMatchHistory();
    }
}

// -------------------------------------------------------------
// Admin Match History Management (15 Days Auto-Purge & 6 Categories)
// -------------------------------------------------------------
let adminMatchHistoryData = [];
let activeHistoryCatFilter = 'all';

async function loadAdminMatchHistory(btn) {
    if (btn) {
        btn.disabled = true;
        const icon = btn.querySelector('.refresh-icon') || btn.querySelector('svg');
        if (icon) icon.classList.add('spinning');
    }

    const container = document.getElementById('adminMatchHistoryContainer');
    if (container && (!adminMatchHistoryData || adminMatchHistoryData.length === 0)) {
        container.innerHTML = `
            <div style="text-align: center; padding: 40px 16px; color: var(--text-muted);">
                <div class="spinner" style="margin: 0 auto 12px auto;"></div>
                ১৫ দিনের ম্যাচ হিস্টোরি লোড হচ্ছে...
            </div>
        `;
    }

    try {
        const res = await apiRequest('/api/admin/matches/history');
        if (res && res.success && Array.isArray(res.matches)) {
            adminMatchHistoryData = res.matches;
            updateHistoryCategoryCounters();
            renderAdminMatchHistory();
            if (btn) showToast(`ম্যাচ হিস্টোরি সফলভাবে আপডেট হয়েছে (${adminMatchHistoryData.length} রেকর্ড)`, 'info');
        } else {
            throw new Error((res && res.detail) || 'Failed to load history');
        }
    } catch (e) {
        console.error('Failed to load admin match history', e);
        if (container) {
            container.innerHTML = `
                <div style="text-align: center; padding: 36px 16px; background: rgba(239, 68, 68, 0.08); border-radius: 12px; border: 1px solid rgba(239, 68, 68, 0.2);">
                    <div style="font-size: 1.5rem; margin-bottom: 8px;">⚠️</div>
                    <div style="color: #f87171; font-weight: 700; margin-bottom: 8px;">ম্যাচ হিস্টোরি লোড করতে সমস্যা হয়েছে</div>
                    <button class="btn btn-outline btn-sm" onclick="loadAdminMatchHistory(this)">🔄 পুনরায় চেষ্টা করুন</button>
                </div>
            `;
        }
    } finally {
        if (btn) {
            setTimeout(() => {
                btn.disabled = false;
                const icon = btn.querySelector('.refresh-icon') || btn.querySelector('svg');
                if (icon) icon.classList.remove('spinning');
            }, 600);
        }
    }
}

function updateHistoryCategoryCounters() {
    const counts = {
        all: adminMatchHistoryData.length,
        solo_full_map: 0,
        duo_full_map: 0,
        br_survival: 0,
        lone_wolf: 0,
        bonus_match: 0,
        cs_4v4: 0
    };

    adminMatchHistoryData.forEach(m => {
        const k = m.category_key || 'solo_full_map';
        if (counts[k] !== undefined) {
            counts[k]++;
        }
    });

    Object.keys(counts).forEach(k => {
        const el = document.getElementById('histCount-' + k);
        if (el) el.innerText = counts[k];
    });
}

function filterAdminHistoryCategory(catKey) {
    activeHistoryCatFilter = catKey;
    document.querySelectorAll('.admin-cat-pill').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.getElementById('histCat-' + catKey);
    if (activeBtn) activeBtn.classList.add('active');
    renderAdminMatchHistory();
}

function renderAdminMatchHistory() {
    const container = document.getElementById('adminMatchHistoryContainer');
    if (!container) return;

    let filtered = adminMatchHistoryData;
    if (activeHistoryCatFilter && activeHistoryCatFilter !== 'all') {
        filtered = adminMatchHistoryData.filter(m => m.category_key === activeHistoryCatFilter);
    }

    if (!filtered || filtered.length === 0) {
        const catLabels = {
            all: 'সব ক্যাটাগরি',
            solo_full_map: 'Solo Full Map',
            duo_full_map: 'Duo Full Map',
            br_survival: 'BR Survival',
            lone_wolf: 'Lone Wolf',
            bonus_match: 'Bonus Match',
            cs_4v4: 'Clash Squad'
        };
        const curLabel = catLabels[activeHistoryCatFilter] || 'এই ক্যাটাগরি';

        container.innerHTML = `
            <div style="text-align: center; padding: 48px 16px; background: rgba(255, 255, 255, 0.02); border-radius: 12px; border: 1px dashed rgba(255, 255, 255, 0.1); margin: 10px 0;">
                <div style="font-size: 2.4rem; margin-bottom: 10px;">📜</div>
                <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.25rem; font-weight: 800; color: #ffffff;">
                    ${curLabel}-তে বিগত ১৫ দিনে কোনো সমাপ্ত ম্যাচ রেকর্ড নেই
                </div>
                <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; margin-bottom: 18px; max-width: 480px; margin-left: auto; margin-right: auto;">
                    ম্যাচের রেজাল্ট পাবলিশ করার সাথে সাথে সম্পূর্ণ রেকর্ড এখানে চলে আসবে। এবং প্রতিটি রেকর্ড ১৫ দিন পর ডাটাবেজ থেকে স্থায়ীভাবে স্বয়ংক্রিয়ভাবে মুছে যাবে।
                </div>
                <button type="button" class="btn btn-outline btn-sm" onclick="loadAdminMatchHistory(this)" style="display: inline-flex; align-items: center; gap: 6px;">
                    🔄 হিস্টোরি রিফ্রেশ করুন
                </button>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(m => {
        const catBadges = {
            solo_full_map: '<span class="admin-history-badge admin-history-badge-solo">⚔️ Solo Full Map</span>',
            duo_full_map: '<span class="admin-history-badge admin-history-badge-duo">👥 Duo Full Map</span>',
            br_survival: '<span class="admin-history-badge admin-history-badge-survival">🛡️ BR Survival</span>',
            lone_wolf: '<span class="admin-history-badge admin-history-badge-lone">🐺 Lone Wolf</span>',
            bonus_match: '<span class="admin-history-badge admin-history-badge-bonus">🎁 Bonus Match</span>',
            cs_4v4: '<span class="admin-history-badge admin-history-badge-cs">🔥 Clash Squad</span>'
        };
        const badgeHtml = catBadges[m.category_key] || `<span class="admin-history-badge admin-history-badge-solo">${escapeHtml(m.category_name || m.match_type)}</span>`;

        // Calculate 15-day auto purge deadline
        const completedTime = m.completed_at || m.created_at;
        let retentionText = '১৫ দিনের জন্য সংরক্ষিত';
        if (completedTime) {
            try {
                const compDate = new Date(completedTime.replace(' ', 'T') + 'Z');
                const purgeDate = new Date(compDate.getTime() + (15 * 24 * 60 * 60 * 1000));
                const now = new Date();
                const daysLeft = Math.max(0, Math.ceil((purgeDate - now) / (1000 * 60 * 60 * 24)));
                retentionText = `অটো ডিলিট হবে: ${daysLeft} দিন পর (${purgeDate.toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' })})`;
            } catch (e) {
                retentionText = '১৫ দিন পর অটো ডিলিট';
            }
        }

        const participants = m.participants || [];
        let rowsHtml = '';
        if (participants.length === 0) {
            rowsHtml = `<tr><td colspan="9" style="text-align: center; padding: 20px; color: var(--text-muted);">কোনো খেলোয়াড় জয়েন রেকর্ড পাওয়া যায়নি</td></tr>`;
        } else {
            rowsHtml = participants.map((p, idx) => {
                const rankDisplay = p.rank_position === 1 ? '🥇 1st' :
                                    p.rank_position === 2 ? '🥈 2nd' :
                                    p.rank_position === 3 ? '🥉 3rd' :
                                    (p.rank_position > 0 ? `#${p.rank_position}` : '-');

                return `
                    <tr style="border-bottom: 1px solid rgba(255,255,255,0.04);">
                        <td style="font-weight: 800; color: ${p.rank_position <= 3 && p.rank_position > 0 ? 'var(--neon-green)' : 'var(--text-secondary)'};">
                            ${rankDisplay}
                        </td>
                        <td style="font-weight: 700; color: #fff;">#${p.slot_number || (idx + 1)}</td>
                        <td>
                            <div style="font-weight: 800; color: #ffffff;">${escapeHtml(p.player_ign || 'Player')}</div>
                            <div style="font-size: 0.72rem; color: var(--neon-cyan);">UID: ${escapeHtml(p.player_uid || 'N/A')}</div>
                        </td>
                        <td>
                            <div style="font-size: 0.78rem; color: var(--text-secondary);">${escapeHtml(p.username || '')}</div>
                            <div style="font-size: 0.72rem; color: var(--text-muted);">${escapeHtml(p.phone || '')}</div>
                        </td>
                        <td style="text-align: center; font-weight: 800; color: #fff;">${p.kills || 0}</td>
                        <td style="text-align: right; color: var(--neon-cyan);">৳${p.kill_prize || 0}</td>
                        <td style="text-align: right; color: var(--neon-cyan);">৳${p.rank_prize || 0}</td>
                        <td style="text-align: right; font-weight: 800; color: var(--neon-green);">৳${p.total_prize || 0}</td>
                        <td style="text-align: center;">
                            <span style="font-size: 0.72rem; font-weight: 800; color: #00f59b; background: rgba(0, 245, 155, 0.1); padding: 2px 7px; border-radius: 4px;">
                                ✅ প্রাইজ পেইড
                            </span>
                        </td>
                    </tr>
                `;
            }).join('');
        }

        return `
            <div class="admin-history-card">
                <div class="admin-history-card-header">
                    <div class="admin-history-card-title">
                        <span>#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                        <span style="color: rgba(255,255,255,0.85); font-size: 1.05rem;">${escapeHtml(m.title)}</span>
                        ${badgeHtml}
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                        <span class="admin-history-retention-notice">
                            ⏳ ${retentionText}
                        </span>
                        <span style="font-size: 0.76rem; color: var(--text-muted);">
                            সম্পন্ন: ${m.completed_at ? m.completed_at.substring(0, 16) : (m.created_at ? m.created_at.substring(0, 16) : '')}
                        </span>
                    </div>
                </div>

                <div class="admin-history-meta-grid">
                    <div class="admin-history-meta-item">
                        ম্যাপ ও টাইপ
                        <b>🗺️ ${escapeHtml(m.map_name || 'Bermuda')} (${escapeHtml(m.match_type || 'Solo')})</b>
                    </div>
                    <div class="admin-history-meta-item">
                        এন্ট্রি ফি / প্রাইজ পুল
                        <b>৳${m.entry_fee} / ৳${m.prize_pool}</b>
                    </div>
                    <div class="admin-history-meta-item">
                        প্রতি কিল প্রাইজ
                        <b>৳${m.per_kill || 0}</b>
                    </div>
                    <div class="admin-history-meta-item">
                        প্লেয়ার জয়েন
                        <b style="color: var(--neon-cyan);">${participants.length} / ${m.total_slots || 48} খেলোয়াড়</b>
                    </div>
                    <div class="admin-history-meta-item">
                        মোট প্রদানকৃত প্রাইজ
                        <b style="color: var(--neon-green);">৳${m.total_payout || 0}</b>
                    </div>
                    <div class="admin-history-meta-item">
                        রুম ক্রেডেনশিয়াল
                        <b style="font-family: monospace; font-size: 0.82rem; color: #cbd5e1;">ID: ${escapeHtml(m.room_id || 'N/A')}</b>
                    </div>
                </div>

                <div class="table-wrapper" style="margin: 0; border: none; border-radius: 0;">
                    <table class="custom-table" style="font-size: 0.8rem;">
                        <thead>
                            <tr style="background: rgba(0,0,0,0.25);">
                                <th style="width: 70px;">র‍্যাংক</th>
                                <th style="width: 60px;">স্লট</th>
                                <th>খেলোয়াড় (IGN / UID)</th>
                                <th>ইউজার / ফোন</th>
                                <th style="text-align: center; width: 60px;">কিল</th>
                                <th style="text-align: right; width: 85px;">কিল প্রাইজ</th>
                                <th style="text-align: right; width: 85px;">র‍্যাংক প্রাইজ</th>
                                <th style="text-align: right; width: 95px;">মোট জয়ী</th>
                                <th style="text-align: center; width: 100px;">স্ট্যাটাস</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('');
}

// -------------------------------------------------------------
// Player Profile & Categories (Details & Deposit)
// -------------------------------------------------------------
function switchProfileCategory(category) {
    const secDetails = document.getElementById('profileSec-details');
    const secDeposit = document.getElementById('profileSec-deposit');
    const btnDetails = document.getElementById('btnProfileCat-details');
    const btnDeposit = document.getElementById('btnProfileCat-deposit');

    if (category === 'deposit') {
        if (secDetails) secDetails.style.display = 'none';
        if (secDeposit) secDeposit.style.display = 'block';
        if (btnDetails) btnDetails.classList.remove('active');
        if (btnDeposit) btnDeposit.classList.add('active');
        loadWalletHistory();
    } else {
        if (secDetails) secDetails.style.display = 'block';
        if (secDeposit) secDeposit.style.display = 'none';
        if (btnDetails) btnDetails.classList.add('active');
        if (btnDeposit) btnDeposit.classList.remove('active');
        renderUserProfile();
    }
}

function renderUserProfile() {
    const notAuthCard = document.getElementById('notAuthProfileCard') || document.getElementById('profileNotAuthCard');
    const authContent = document.getElementById('authProfileContainer') || document.getElementById('profileAuthContent');

    if (!currentUser) {
        if (notAuthCard) notAuthCard.style.display = 'block';
        if (authContent) authContent.style.display = 'none';
        return;
    }

    if (notAuthCard) notAuthCard.style.display = 'none';
    if (authContent) authContent.style.display = 'block';

    // 1. Reference Screenshot Header Card stats
    const headerUser = document.getElementById('profHeaderUsername');
    if (headerUser) headerUser.innerText = currentUser.username || 'player';

    const headerMatches = document.getElementById('profHeaderMatches');
    if (headerMatches) headerMatches.innerText = currentUser.matches_joined != null ? currentUser.matches_joined : 0;

    const headerBalance = document.getElementById('profHeaderBalance');
    if (headerBalance) headerBalance.innerText = 'BDT ' + (currentUser.digits_balance != null ? currentUser.digits_balance : 0);

    const headerWon = document.getElementById('profHeaderWon');
    if (headerWon) headerWon.innerText = (currentUser.win_points != null ? currentUser.win_points : (currentUser.matches_won || 0));

    // 2. Admin Menu Row visibility in profile
    const adminRow = document.getElementById('profAdminMenuRow');
    if (adminRow) {
        if (currentUser.role === 'admin' || currentUser.role === 'moderator') {
            adminRow.style.display = 'flex';
        } else {
            adminRow.style.display = 'none';
        }
    }

    // 3. Detailed Profile Modal & Legacy element references
    const elUser = document.getElementById('profUsername');
    if (elUser) elUser.innerText = currentUser.username || 'Player';

    const elPid = document.getElementById('profPlayerId');
    if (elPid) elPid.innerText = currentUser.player_id || 'ID N/A';

    const elPhone = document.getElementById('profPhone');
    if (elPhone) elPhone.innerText = currentUser.phone || 'Not provided';

    const elEmail = document.getElementById('profEmail');
    if (elEmail) elEmail.innerText = currentUser.email || 'Not provided';

    const elBal = document.getElementById('profDigitsBalance');
    if (elBal) elBal.innerText = currentUser.digits_balance != null ? currentUser.digits_balance : 0;

    const elPts = document.getElementById('profWinPoints');
    if (elPts) elPts.innerText = currentUser.win_points != null ? currentUser.win_points : 0;

    const elJoined = document.getElementById('profMatchesJoined');
    if (elJoined) elJoined.innerText = currentUser.matches_joined != null ? currentUser.matches_joined : 0;

    const elWon = document.getElementById('profMatchesWon');
    if (elWon) elWon.innerText = currentUser.matches_won != null ? currentUser.matches_won : 0;

    const elRole = document.getElementById('profRoleBadge');
    if (elRole) {
        elRole.innerText = (currentUser.role || 'PLAYER').toUpperCase();
        elRole.className = 'badge-status ' + (currentUser.role === 'admin' ? 'approved' : (currentUser.role === 'moderator' ? 'timeout' : 'pending'));
    }

    const elIgn = document.getElementById('profFFIgn');
    if (elIgn) elIgn.innerText = currentUser.ff_ign || 'Not set';

    const elUid = document.getElementById('profFFUid');
    if (elUid) elUid.innerText = currentUser.ff_uid || 'Not set';

    const elCreated = document.getElementById('profCreatedAt');
    if (elCreated) elCreated.innerText = currentUser.created_at ? currentUser.created_at.split(' ')[0] : 'Recent';

    // 4. Withdraw Modal balance display
    const withdrawBal = document.getElementById('withdrawUserBalance');
    if (withdrawBal) withdrawBal.innerText = 'BDT ' + (currentUser.digits_balance != null ? currentUser.digits_balance : 0);
}


function copyProfilePlayerId() {
    if (currentUser && currentUser.player_id) {
        navigator.clipboard.writeText(currentUser.player_id);
        showToast(`Player ID (${currentUser.player_id}) copied to clipboard!`, 'success');
    }
}

// -------------------------------------------------------------
// Tab Switching & Modal Helpers
// -------------------------------------------------------------
function switchTab(tabId) {
    if (tabId === 'tab-recharge' || tabId === 'tab-shop') {
        switchTab('tab-profile');
        openWalletModal();
        return;
    }

    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));

    const targetTab = document.getElementById(tabId);
    if (targetTab) targetTab.classList.add('active');

    const cleanName = tabId.replace('tab-', '');
    const btn = document.getElementById('tabBtn-' + cleanName);
    if (btn) btn.classList.add('active');

    const mBtn = document.getElementById('mNav-' + cleanName);
    if (mBtn) mBtn.classList.add('active');

    if (tabId === 'tab-profile') {
        renderUserProfile();
    } else if (tabId === 'tab-shop') {
        loadWalletHistory();
    } else if (tabId === 'tab-results') {
        loadCompletedResults();
    } else if (tabId === 'tab-matches') {
        fetchMatches();
    } else if (tabId === 'tab-mymatches') {
        renderMyMatches();
    } else if (tabId === 'tab-admin') {
        applyRolePermissionsUI();
        if (currentUser && currentUser.role === 'moderator') {
            switchAdminSection('matches');
        } else {
            switchAdminSection('dashboard');
        }
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// -------------------------------------------------------------
// Interactive Modals for User Reference Profile
// -------------------------------------------------------------
function openWalletModal() {
    if (!currentUser) {
        showToast('Please sign in before making a deposit', 'info');
        openModal('authModal');
        return;
    }
    const modalBal = document.getElementById('walletModalUserBalance');
    if (modalBal) modalBal.innerText = (currentUser.digits_balance || 0) + ' Digits';
    openModal('walletModal');
    loadWalletHistory();
}

function openWithdrawModal() {
    if (!currentUser) {
        openModal('authModal');
        return;
    }
    const balEl = document.getElementById('withdrawUserBalance');
    if (balEl) balEl.innerText = 'BDT ' + (currentUser.digits_balance || 0);
    const phoneInp = document.getElementById('withdrawPhone');
    if (phoneInp) {
        phoneInp.value = '';
    }
    openModal('withdrawModal');
    loadWithdrawHistory();
}

async function submitWithdrawForm(e) {
    if (e) e.preventDefault();
    if (!currentUser) {
        openModal('authModal');
        return;
    }

    const phone = document.getElementById('withdrawPhone').value.trim();
    const amount = parseInt(document.getElementById('withdrawAmount').value, 10);

    if (!phone || phone.length < 11) {
        showToast('Please enter a valid 11-digit bKash number', 'error');
        return;
    }
    if (!amount || amount < 50) {
        showToast('উইথড্র করার জন্য সর্বনিম্ন ৫০ টাকা প্রয়োজন (Minimum withdrawal amount is 50 BDT)', 'error');
        return;
    }
    if (amount > (currentUser.digits_balance || 0)) {
        showToast(`Insufficient balance! Your balance is ${currentUser.digits_balance || 0} BDT`, 'error');
        return;
    }

    try {
        const res = await fetchWithAuth('/api/wallet/withdraw', {
            method: 'POST',
            body: JSON.stringify({ amount, bkash_number: phone })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Withdrawal request failed');

        showToast(data.message || 'Withdrawal request submitted successfully!', 'success');
        document.getElementById('withdrawForm').reset();
        
        // Refresh balance
        if (data.new_balance != null) {
            currentUser.digits_balance = data.new_balance;
            updateBalanceUI(data.new_balance);
            renderUserProfile();
        }
        loadWithdrawHistory();
    } catch (err) {
        showToast(err.message, 'error');
    }
}

async function loadWithdrawHistory() {
    const body = document.getElementById('withdrawHistoryBody');
    if (!body) return;

    try {
        const res = await fetchWithAuth('/api/wallet/withdraw/history');
        if (!res.ok) return;
        const data = await res.json();
        const list = data.withdrawals || [];

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#94a3b8; padding:16px;">No withdrawal records found</td></tr>';
            return;
        }

        body.innerHTML = list.map(w => {
            const statusClass = w.status === 'approved' ? 'approved' : (w.status === 'rejected' ? 'rejected' : 'pending');
            const statusText = w.status === 'approved' ? 'Approved' : (w.status === 'rejected' ? 'Rejected' : 'Pending');
            return `
                <tr>
                    <td><b>BDT ${w.amount}</b></td>
                    <td>${w.bkash_number}</td>
                    <td><span class="badge-status ${statusClass}">${statusText}</span></td>
                    <td style="font-size:0.75rem; color:#64748b;">${(w.created_at || '').split(' ')[0]}</td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Error loading withdraw history:', err);
    }
}

function openMyProfileModal() {
    if (!currentUser) {
        openModal('authModal');
        return;
    }
    renderUserProfile();
    openModal('myProfileDetailsModal');
}

function openRulesModal() {
    openModal('allRulesModal');
}

let cachedLeaderboardList = null;

function renderLeaderboardRows(list, body) {
    body.innerHTML = list.map((p, idx) => {
        let rankBadge = `${idx + 1}`;
        if (idx === 0) rankBadge = '🥇';
        else if (idx === 1) rankBadge = '🥈';
        else if (idx === 2) rankBadge = '🥉';

        return `
            <tr style="${idx < 3 ? 'background: rgba(245, 158, 11, 0.05); font-weight:700;' : ''}">
                <td style="font-size: 1.1rem; text-align: center;">${rankBadge}</td>
                <td><b>${escapeHtml(p.username)}</b> <span style="font-size:0.75rem; color:#64748b;">(${p.player_id})</span></td>
                <td style="color: #2563eb; font-weight: 800;">${p.win_points || 0}</td>
                <td style="color: #16a34a; font-weight: 700;">${p.matches_won || 0}</td>
            </tr>
        `;
    }).join('');
}

async function openTopPlayersModal() {
    openModal('topPlayersModal');
    const body = document.getElementById('leaderboardBody');
    if (!body) return;

    if (cachedLeaderboardList && cachedLeaderboardList.length > 0) {
        renderLeaderboardRows(cachedLeaderboardList, body);
    } else {
        body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#64748b;">Loading...</td></tr>';
    }

    try {
        const res = await fetch('/api/leaderboard');
        const data = await res.json();
        const list = data.leaderboard || [];
        cachedLeaderboardList = list;

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#94a3b8;">No records found</td></tr>';
            return;
        }

        renderLeaderboardRows(list, body);
    } catch (err) {
        if (!cachedLeaderboardList) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#ef4444;">Failed to load</td></tr>';
        }
    }
}

function openDevProfileModal() {
    openModal('devProfileModal');
}

function openSupportModal() {
    openModal('supportModal');
}

let currentResultsCategory = 'all';

async function loadCompletedResults(category, btnElem) {
    if (category) currentResultsCategory = category;
    
    if (btnElem) {
        document.querySelectorAll('#tab-results .filter-pill').forEach(b => b.classList.remove('active'));
        btnElem.classList.add('active');
    }

    const container = document.getElementById('completedMatchesList');
    if (!container) return;

    container.innerHTML = '<div style="text-align:center; padding:30px; color:#64748b; font-size:0.85rem;">Loading results...</div>';

    try {
        const catParam = currentResultsCategory !== 'all' ? `?category=${encodeURIComponent(currentResultsCategory)}` : '';
        const res = await fetchWithAuth(`/api/matches/results${catParam}`);
        const data = await res.json();
        const results = data.results || [];

        if (data.not_logged_in) {
            container.innerHTML = `
                <div style="text-align:center; padding:24px 16px; background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; margin:10px 0; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                    <span style="font-size:1.8rem;">🔒</span>
                    <h4 style="font-family:'Rajdhani',sans-serif; font-size:0.95rem; font-weight:800; margin:6px 0 2px; color:#1e293b;">Sign in to view your match results</h4>
                    <p style="color:#64748b; font-size:0.75rem; margin-bottom:12px;">Sign in to track your scores, rankings, and prize earnings across tournament matches.</p>
                    <button class="btn btn-neon btn-sm" onclick="openModal('authModal')" style="padding:5px 14px; font-size:0.78rem;">Sign In / Register</button>
                </div>
            `;
            return;
        }

        if (results.length === 0) {
            container.innerHTML = `
                <div style="text-align:center; padding:24px 16px; background:#ffffff; border-radius:12px; border:1px solid #e2e8f0; margin:10px 0; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                    <span style="font-size:1.8rem;">🏆</span>
                    <h4 style="font-family:'Rajdhani',sans-serif; font-size:0.95rem; font-weight:800; margin:6px 0 2px; color:#1e293b;">No match results found yet</h4>
                    <p style="color:#64748b; font-size:0.75rem; margin:0; line-height:1.35;">Results and prize payouts will appear here after matches conclude.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = results.map(m => {
            const fmt = getMatchFormatInfo(m);
            const catName = getMatchCategoryDisplay(m.match_type);
            return `
            <div class="results-card" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:12px 14px; margin-bottom:12px; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
                        <span class="match-code-badge" style="font-size:0.7rem; padding:1px 6px;">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                        <span class="filter-pill" style="background:#e0f2fe; color:#0369a1; border:none; padding:2px 8px; font-size:0.68rem; font-weight:700;">🔥 ${escapeHtml(catName)}</span>
                        <span class="match-format-monitor ${fmt.cssClass}" style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.68rem; font-weight: 800; padding: 1px 6px; border-radius: 999px; letter-spacing: 0.5px; text-transform: uppercase; font-family: 'Rajdhani', sans-serif; ${fmt.inlineStyle}">${fmt.icon} ${fmt.label}</span>
                    </div>
                    <span style="font-size:0.72rem; color:#64748b;">Concluded: ${(m.completed_at || m.match_time || '').split(' ')[0]}</span>
                </div>
                <h3 style="font-family:'Rajdhani',sans-serif; font-size:0.98rem; font-weight:800; color:#0f172a; margin:0 0 8px 0;">
                    ${escapeHtml(m.title)}
                </h3>
                
                ${data.is_personal ? `
                    <!-- Personalized Player Result Box -->
                    <div style="background: linear-gradient(135deg, #0f766e 0%, #115e59 100%); color:white; border-radius:10px; padding:10px 12px; margin-bottom:10px; box-shadow: 0 3px 10px rgba(15, 118, 110, 0.2);">
                        <div style="font-size:0.68rem; color:#a7f3d0; font-weight:700; text-transform:uppercase; margin-bottom:3px;">🎯 Your Match Result</div>
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div>
                                <div style="font-size:0.82rem; font-weight:700;">Rank: ${m.my_rank ? '#' + m.my_rank : 'Participant'} • Kills: ${m.my_kills || 0}</div>
                                <div style="font-size:0.7rem; color:#e6fffa; margin-top:1px;">(Kill Bounty: ৳${m.my_kill_prize || 0} + Rank Prize: ৳${m.my_rank_prize || 0})</div>
                            </div>
                            <div style="text-align:right;">
                                <div style="font-size:0.65rem; color:#a7f3d0;">Total Prize Earned</div>
                                <div style="font-family:'Rajdhani',sans-serif; font-size:1.15rem; font-weight:800; color:#ffffff;">+৳${m.my_total_prize || 0}</div>
                            </div>
                        </div>
                    </div>
                ` : ''}

                <!-- Match Top Winners / Scoreboard -->
                ${m.winners && m.winners.length > 0 ? `
                    <div style="background:#f8fafc; border:1px solid #f1f5f9; border-radius:8px; padding:8px 10px;">
                        <div style="font-size:0.7rem; font-weight:700; color:#475569; margin-bottom:4px;">🏆 Top Winners:</div>
                        <div style="display:flex; flex-direction:column; gap:3px;">
                            ${m.winners.map(w => `
                                <div style="display:flex; justify-content:space-between; font-size:0.72rem; color:#334155;">
                                    <span>${w.rank_position ? '#' + w.rank_position : '🎖️'} <b>${escapeHtml(w.ff_ign || w.username)}</b> (${w.kills} Kills)</span>
                                    <span style="font-weight:700; color:#059669;">৳${w.total_prize}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : `
                    <div style="font-size:0.72rem; color:#64748b; background:#f8fafc; padding:6px 10px; border-radius:6px; text-align:center;">
                        Match concluded (Prizes distributed)
                    </div>
                `}
            </div>
        `;
    }).join('');
    } catch (err) {
        container.innerHTML = '<div style="text-align:center; color:#ef4444; padding:20px; font-size:0.8rem;">Unable to load tournament results</div>';
    }
}



// -------------------------------------------------------------
// Important Notice Popup Helpers
// -------------------------------------------------------------
function openWelcomeNotice(force = false) {
    // If not forced and already dismissed in this session, don't show (e.g. on page refresh)
    if (!force && sessionStorage.getItem('welcome_notice_dismissed')) {
        return;
    }
    const modal = document.getElementById('welcomeNoticeModal');
    if (modal) {
        modal.classList.add('show');
        // Once shown in this session, mark so page refreshes will not show it again
        sessionStorage.setItem('welcome_notice_dismissed', 'true');
    }
}

function closeWelcomeNotice() {
    sessionStorage.setItem('welcome_notice_dismissed', 'true');
    const modal = document.getElementById('welcomeNoticeModal');
    if (modal) modal.classList.remove('show');
}

function closeWelcomeNoticeOnBackdrop(e) {
    if (e && e.target && e.target.id === 'welcomeNoticeModal') {
        closeWelcomeNotice();
    }
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('show');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.remove('show');
}

window.onclick = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
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
            showToast('Thank you! Installing tournament app to your device...', 'success');
            playSound('success');
            const banner = document.getElementById('pwaInstallBanner');
            if (banner) banner.style.display = 'none';
        }
        deferredPwaPrompt = null;
    } else {
        // Fallback for browsers without direct prompt
        showToast('Tap browser menu (⋮) and select "Install app" or "Add to Home screen"', 'info');
    }
}

window.addEventListener('appinstalled', () => {
    showToast('App installed successfully! Launch from your home screen.', 'success');
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
    if (notesEl) notesEl.innerText = notes || 'Performance optimizations, bug fixes, and new tournament features added.';

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
            statusEl.innerText = 'Preparing new update files...';
        } else if (p === 100 && statusEl) {
            statusEl.innerText = 'Update successful! Loading new interface...';
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
            showToast(data.detail || 'Failed to release update', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
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




// =============================================================

// =============================================================
// ADMIN RESULT PUBLISHING & AUTO-PRIZE LOGIC (ENHANCED)
// =============================================================
let adminAllMatchesCache = [];
let currentAdminResultFilter = 'all';
let currentAdminResultMatchData = null;

async function openPublishResultModal(preselectedMatchId = null) {
    if (!currentUser || (currentUser.role !== 'admin' && currentUser.role !== 'moderator')) {
        showToast('This action is restricted to Admins only!', 'error');
        return;
    }
    
    openModal('publishResultModal');
    
    try {
        const res = await fetchWithAuth('/api/admin/matches');
        const data = await res.json();
        adminAllMatchesCache = data.matches || allMatches || [];
    } catch (e) {
        adminAllMatchesCache = allMatches || [];
    }

    filterAdminResultMatches('all');

    if (preselectedMatchId) {
        const select = document.getElementById('adminResultMatchSelect');
        if (select) {
            select.value = preselectedMatchId;
            onAdminSelectResultMatch();
        }
    }
}

function openPublishResultModalForMatch(matchId) {
    openPublishResultModal(matchId);
}

function filterAdminResultMatches(category, btnElem) {
    currentAdminResultFilter = category || 'all';
    
    if (btnElem) {
        document.querySelectorAll('#publishResultModal .filter-pill').forEach(b => b.classList.remove('active'));
        btnElem.classList.add('active');
    } else {
        document.querySelectorAll('#publishResultModal .filter-pill').forEach(b => {
            b.classList.toggle('active', b.id === `adminResCat-${category}`);
        });
    }

    const select = document.getElementById('adminResultMatchSelect');
    if (!select) return;

    let filtered = adminAllMatchesCache;
    if (currentAdminResultFilter !== 'all') {
        filtered = adminAllMatchesCache.filter(m => (m.match_type || '').toLowerCase().trim() === currentAdminResultFilter.toLowerCase().trim());
    }

    if (filtered.length === 0) {
        select.innerHTML = `<option value="">-- No matches found in [${currentAdminResultFilter.toUpperCase()}] category --</option>`;
    } else {
        select.innerHTML = '<option value="">-- Select a tournament match --</option>' + 
            filtered.map(m => {
                const statusTxt = m.status === 'completed' ? '🏁 Concluded' : (m.status === 'reg_closed' ? '🔒 Closed' : '🟢 Open');
                const codeTag = m.match_code ? `[#${m.match_code}]` : `#${m.id}`;
                return `<option value="${m.id}">${codeTag} [${m.match_type}] ${escapeHtml(m.title)} (${statusTxt})</option>`;
            }).join('');
    }

    // Hide details until a match is explicitly selected
    document.getElementById('adminSelectedMatchInfo').style.display = 'none';
    document.getElementById('adminResultParticipantsContainer').style.display = 'none';
    document.getElementById('adminPublishBtnWrapper').style.display = 'none';
}

async function onAdminSelectResultMatch() {
    const select = document.getElementById('adminResultMatchSelect');
    const matchId = select.value;
    if (!matchId) {
        document.getElementById('adminSelectedMatchInfo').style.display = 'none';
        document.getElementById('adminResultParticipantsContainer').style.display = 'none';
        document.getElementById('adminPublishBtnWrapper').style.display = 'none';
        return;
    }

    try {
        const res = await fetchWithAuth(`/api/admin/matches/${matchId}/participants`);
        const data = await res.json();
        if (!res.ok) {
            showToast(data.detail || 'Data not found', 'error');
            return;
        }

        currentAdminResultMatchData = data;
        const m = data.match;
        const participants = data.participants || [];

        // Show banner
        const codeBanner = m.match_code ? `[#${m.match_code}] ` : `#${m.id} - `;
        document.getElementById('resMatchTitleText').innerText = `${codeBanner}${m.title}`;
        document.getElementById('resMatchTypeText').innerText = m.match_type;
        document.getElementById('resPerKillRate').innerText = m.per_kill || 0;
        document.getElementById('resPrizePool').innerText = m.prize_pool || 0;
        document.getElementById('resJoinedCount').innerText = participants.length;
        document.getElementById('adminSelectedMatchInfo').style.display = 'block';

        const tbody = document.getElementById('adminResultTableBody');
        if (participants.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:16px; color:#64748b;">No players have joined this match yet</td></tr>';
            document.getElementById('adminResultParticipantsContainer').style.display = 'block';
            document.getElementById('adminPublishBtnWrapper').style.display = 'none';
            return;
        }

        tbody.innerHTML = participants.map((p, idx) => {
            const kills = p.kills || 0;
            const rankPos = p.rank_position || '';
            const rankPrize = p.rank_prize || 0;
            const killPrize = kills * (m.per_kill || 0);
            const totalPrize = p.total_prize || (killPrize + rankPrize);

            return `
                <tr id="resRow_${p.user_id}" style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:6px 8px; font-weight:700; color:#64748b;">#${p.slot_number || (idx + 1)}</td>
                    <td style="padding:6px 8px;">
                        <div style="font-weight:700; color:#0f172a;">${escapeHtml(p.ff_ign || p.username)}</div>
                        <div style="font-size:0.68rem; color:#64748b;">@${escapeHtml(p.username)} • UID: ${escapeHtml(p.ff_uid || 'N/A')}</div>
                    </td>
                    <td style="padding:6px 8px;">
                        <input type="number" id="resRank_${p.user_id}" class="input-glow" value="${rankPos}" min="0" max="50" placeholder="Rank" style="width:100%; padding:4px 6px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;" oninput="calcRowPrize(${p.user_id})">
                    </td>
                    <td style="padding:6px 8px;">
                        <input type="number" id="resKills_${p.user_id}" class="input-glow" value="${kills}" min="0" max="99" placeholder="0" style="width:100%; padding:4px 6px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;" oninput="calcRowPrize(${p.user_id})">
                    </td>
                    <td style="padding:6px 8px;">
                        <input type="number" id="resRankPrize_${p.user_id}" class="input-glow" value="${rankPrize}" min="0" placeholder="0" style="width:100%; padding:4px 6px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;" oninput="calcRowPrize(${p.user_id})">
                    </td>
                    <td style="padding:6px 8px; text-align:right;">
                        <span id="resTotalPrizeText_${p.user_id}" style="font-family:'Rajdhani',sans-serif; font-size:0.95rem; font-weight:800; color:#059669;">৳${totalPrize}</span>
                    </td>
                </tr>
            `;
        }).join('');

        document.getElementById('adminResultParticipantsContainer').style.display = 'block';
        document.getElementById('adminPublishBtnWrapper').style.display = 'block';

    } catch (err) {
        showToast('Failed to load match details', 'error');
    }
}

function calcRowPrize(userId) {
    if (!currentAdminResultMatchData || !currentAdminResultMatchData.match) return;
    const perKill = currentAdminResultMatchData.match.per_kill || 0;
    
    const killsInput = document.getElementById(`resKills_${userId}`);
    const rankPrizeInput = document.getElementById(`resRankPrize_${userId}`);
    const totalSpan = document.getElementById(`resTotalPrizeText_${userId}`);

    const kills = parseInt(killsInput ? killsInput.value : 0) || 0;
    const rankPrize = parseInt(rankPrizeInput ? rankPrizeInput.value : 0) || 0;
    const total = (kills * perKill) + rankPrize;

    if (totalSpan) {
        totalSpan.innerText = '৳' + total;
    }
}

async function submitMatchResultsPublish() {
    if (!currentAdminResultMatchData || !currentAdminResultMatchData.match) {
        showToast('Please select a tournament match', 'error');
        return;
    }

    const matchId = currentAdminResultMatchData.match.id;
    const participants = currentAdminResultMatchData.participants || [];

    const results = [];
    for (const p of participants) {
        const rankInput = document.getElementById(`resRank_${p.user_id}`);
        const killsInput = document.getElementById(`resKills_${p.user_id}`);
        const rankPrizeInput = document.getElementById(`resRankPrize_${p.user_id}`);

        const rankPos = parseInt(rankInput ? rankInput.value : 0) || 0;
        const kills = parseInt(killsInput ? killsInput.value : 0) || 0;
        const rankPrize = parseInt(rankPrizeInput ? rankPrizeInput.value : 0) || 0;

        results.push({
            user_id: p.user_id,
            rank_position: rankPos,
            kills: kills,
            rank_prize: rankPrize
        });
    }

    try {
        const res = await fetchWithAuth(`/api/admin/matches/${matchId}/publish-results`, {
            method: 'POST',
            body: JSON.stringify({
                match_id: matchId,
                results: results
            })
        });

        const data = await res.json();
        if (res.ok) {
            showToast(data.message || 'Results and prizes published successfully!', 'success');
            closeModal('publishResultModal');
            fetchMatches();
            loadCompletedResults();
            if (typeof renderAdminMatches === 'function') {
                renderAdminMatches();
            }
        } else {
            showToast(data.detail || 'Failed to publish results', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
    }
}

// Global Anti-Copy Protection for Free Fire UIDs
document.addEventListener('copy', function(e) {
    if (e.target && (e.target.closest('#matchInnerPortalModal .participants-table') || e.target.closest('#matchParticipantsModal .participants-table') || e.target.closest('.protected-uid') || e.target.closest('.participants-table'))) {
        e.preventDefault();
        showToast('⚠️ Copying player Free Fire UIDs is strictly prohibited!', 'warning');
    }
});

document.addEventListener('contextmenu', function(e) {
    if (e.target && (e.target.closest('.protected-uid') || e.target.closest('.participants-table'))) {
        e.preventDefault();
        showToast('⚠️ Copying or selecting player Free Fire UIDs is strictly prohibited!', 'warning');
    }
});

