// =============================================================
// Free Fire Pro Tournament Client Application Logic
// Ultra-Fast Zero-Lag Architecture with WebSockets & Web Push
// =============================================================

let currentUser = null;
let token = localStorage.getItem('ff_token') || null;
let adminBkashNumber = '01988279285';
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

    // Show Important Notice modal immediately on app entry
    setTimeout(() => {
        openWelcomeNotice();
    }, 350);
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
        adminBkashNumber = data.admin_bkash || '01988279285';
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
        if (mainApp) mainApp.style.display = 'none';
        renderLoggedOutNav();
        setAuthMode('login');
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
        } else if (res.status === 401) {
            logout(false);
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
        if (topActionBtns) topActionBtns.style.display = 'none';

        document.querySelectorAll('.admin-only-card, .admin-only-nav').forEach(el => {
            el.style.setProperty('display', 'none', 'important');
        });
    } else if (isAdmin) {
        if (titleEl) titleEl.innerHTML = '👑 SUPER-ADMIN MASTER CONTROL';
        if (subEl) subEl.innerText = 'Complete overview of matches, players, finances, and platform settings';
        if (topActionBtns) topActionBtns.style.display = 'flex';

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
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    token = null;
    currentUser = null;
    document.body.classList.remove('authenticated');
    document.body.classList.add('not-authenticated');
    const mainApp = document.getElementById('mainAppWrapper');
    if (mainApp) mainApp.style.display = 'none';
    renderLoggedOutNav();
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
            try { openWelcomeNotice(); } catch(e) {}
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
    try { openWelcomeNotice(); } catch(e) {}
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

async function loadMatches() {
    try {
        const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
        const res = await fetch('/api/matches?_t=' + Date.now(), { headers });
        const data = await res.json();
        allMatches = Array.isArray(data) ? data : (data.matches || []);
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
    return loadMatches();
}

function filterMatches(category, btnElem) {
    activeCategoryFilter = category || 'all';

    if (btnElem) {
        document.querySelectorAll('#tab-matches .filter-pill').forEach(b => b.classList.remove('active'));
        btnElem.classList.add('active');
    } else {
        document.querySelectorAll('#tab-matches .filter-pill').forEach(b => {
            const txt = (b.innerText || '').trim().toLowerCase();
            const cat = activeCategoryFilter.toLowerCase();
            if ((cat === 'all' || cat === 'সব ম্যাচ' || cat === 'all matches') && (txt === 'all matches' || txt === 'all' || txt === 'সব ম্যাচ')) {
                b.classList.add('active');
            } else if (txt === cat) {
                b.classList.add('active');
            } else {
                b.classList.remove('active');
            }
        });
    }

    renderMatches();
}

function renderMatches() {
    const grid = document.getElementById('matchesGrid');
    if (!grid) return;

    let filtered = allMatches || [];
    if (activeCategoryFilter && activeCategoryFilter !== 'all' && activeCategoryFilter !== 'all matches' && activeCategoryFilter !== 'সব ম্যাচ') {
        filtered = (allMatches || []).filter(m => (m.match_type || '').toLowerCase().trim() === activeCategoryFilter.toLowerCase().trim());
    }

    if (!filtered || filtered.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1/-1; text-align: center; padding: 28px 16px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; margin: 10px 0;">
                <span style="font-size: 1.8rem;">⚡</span>
                <div style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800; color: #1e293b; margin: 6px 0 2px;">No Active Matches Scheduled</div>
                <div style="font-size: 0.75rem; color: #64748b;">New tournament matches will be scheduled shortly. Stay tuned!</div>
            </div>
        `;
        return;
    }

    grid.innerHTML = filtered.map(m => {
        const slotsPercent = Math.min(100, Math.round(((m.joined_count || 0) / (m.total_slots || 48)) * 100));
        const isFull = (m.joined_count || 0) >= (m.total_slots || 48);
        const hasJoined = m.has_joined;

        let actionHtml = '';
        if (hasJoined) {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0, 245, 155, 0.08); border: 1px solid rgba(0, 245, 155, 0.25); border-radius: 8px; padding: 6px 10px;">
                        <span style="font-size: 0.8rem; color: #a7f3d0; font-weight: 700;">✅ You are Registered</span>
                        <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800; color: #00f59b;">Slot #${m.my_slot || 1}</span>
                    </div>
                    <button class="btn btn-neon" style="width: 100%; padding: 8px 12px; font-size: 0.86rem; font-weight: 800; border-radius: 8px;" onclick="openMatchInnerPortal(${m.id})">
                        🔑 View Room & Players
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
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-outline" style="flex: 1; opacity: 0.75; cursor: not-allowed; border-color: #ef4444; color: #ef4444; font-size: 0.8rem; font-weight: 700;" disabled>🔒 Registration Closed</button>
                        <button class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.8rem; font-weight: 700; border-radius: 8px; border-color: #cbd5e1; color: #64748b;" onclick="openMatchInnerPortal(${m.id})">🔒 Room Details</button>
                    </div>
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
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-outline" style="flex: 1; opacity: 0.6; cursor: not-allowed; font-size: 0.8rem;" disabled>🔒 All Slots Full</button>
                        <button class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.8rem; font-weight: 700; border-radius: 8px; border-color: #cbd5e1; color: #64748b;" onclick="openMatchInnerPortal(${m.id})">🔒 Room Details</button>
                    </div>
                </div>
            `;
        } else {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #64748b; font-weight: 600;">⭕ You have not joined yet</span>
                        <span style="font-size: 0.75rem; color: #0284c7; font-weight: 700;">Fee: ${m.entry_fee} Digits</span>
                    </div>
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-neon" style="flex: 1.2; padding: 8px 6px; font-size: 0.82rem; font-weight: 800; border-radius: 8px;" onclick="openJoinMatchModal(${m.id}, '${escapeHtml(m.title)}', ${m.entry_fee})">
                            🎮 Join Match (${m.entry_fee} 🪙)
                        </button>
                        <button class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.8rem; font-weight: 700; border-radius: 8px; border-color: #cbd5e1; color: #475569;" onclick="openMatchInnerPortal(${m.id})">
                            🔒 Room Details
                        </button>
                    </div>
                </div>
            `;
        }

        return `
            <div class="match-card">
                <div class="match-card-header">
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px;">
                            <span class="match-code-badge">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                            <span class="match-category" style="margin-bottom: 0;">🔥 ${escapeHtml(m.match_type || 'Solo')}</span>
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
                        <span>Slot Booking</span>
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

function openJoinMatchModal(matchId, matchTitle, entryFee) {
    if (!currentUser) {
        showToast('Please sign in before joining a tournament match', 'info');
        openModal('authModal');
        return;
    }

    if (currentUser.digits_balance < entryFee) {
        showToast(`Insufficient balance! Your balance is ${currentUser.digits_balance} Digits. Entry fee is ${entryFee} Digits.`, 'error');
        switchTab('tab-profile');
        openWalletModal();
        return;
    }

    const mIdInput = document.getElementById('joinModalMatchId');
    if (mIdInput) mIdInput.value = matchId;
    
    const m = (allMatches || []).find(x => x.id === matchId);
    const codePrefix = (m && m.match_code) ? `[#${m.match_code}] ` : '';
    const titleEl = document.getElementById('joinModalMatchTitle');
    if (titleEl) titleEl.innerText = `${codePrefix}${matchTitle || 'Free Fire Match'}`;

    const feeEl = document.getElementById('joinModalMatchFee');
    if (feeEl) feeEl.innerText = `${entryFee} Digits`;

    const balEl = document.getElementById('joinModalUserBal');
    if (balEl) balEl.innerText = `${currentUser.digits_balance || 0} Digits`;

    const ignInput = document.getElementById('joinPlayerIgn');
    if (ignInput) ignInput.value = currentUser.ff_ign || currentUser.username || '';

    const uidInput = document.getElementById('joinPlayerUid');
    if (uidInput) uidInput.value = (currentUser.ff_uid && currentUser.ff_uid !== '0') ? currentUser.ff_uid : '';

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

    const submitBtn = document.getElementById('joinModalSubmitBtn');
    const origText = submitBtn ? submitBtn.innerText : '🎮 Confirm & Join Match';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = 'Processing registration...';
    }

    try {
        const res = await fetchWithAuth('/api/matches/join', {
            method: 'POST',
            body: JSON.stringify({
                match_id: matchId,
                player_ign: ign,
                player_uid: uid
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

    // STRICT ACCESS CONTROL: Player CANNOT enter inside if they have not joined!
    if (!m.has_joined) {
        showToast('🔒 Please register for this match to access room credentials and participant roster!', 'warning');
        if (m.status === 'open' && (m.joined_count || 0) < (m.total_slots || 48)) {
            openJoinMatchModal(m.id, m.title, m.entry_fee);
        }
        return;
    }

    // Player is joined: populate inner details and open modal
    const titleEl = document.getElementById('portalModalTitle');
    if (titleEl) titleEl.innerText = `${m.match_code ? `[#${m.match_code}] ` : ''}${m.title || 'Match Details'}`;

    const subEl = document.getElementById('portalModalSubtitle');
    if (subEl) subEl.innerText = `Match Code: #${m.match_code || ('MATCH-' + m.id)} • Type: ${m.match_type || 'Solo'} • Time: ${m.match_time || 'Upcoming'}`;

    const slotEl = document.getElementById('portalModalSlot');
    if (slotEl) slotEl.innerText = `#${m.my_slot || 1} (Fixed)`;

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
        rIdEl.innerText = isReleased ? m.room_id : 'Credentials release 10-15 minutes before match';
        rIdEl.style.color = isReleased ? '#38bdf8' : '#94a3b8';
    }
    if (rPassEl) {
        rPassEl.innerText = isReleased ? m.room_pass : 'Credentials release 10-15 minutes before match';
        rPassEl.style.color = isReleased ? '#00f59b' : '#94a3b8';
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
                        <td colspan="3" style="text-align: center; padding: 20px; color: var(--text-muted);">
                            No players have joined this match yet
                        </td>
                    </tr>
                `;
            }
        } else {
            if (tbody) {
                tbody.innerHTML = data.participants.map(p => {
                    const isSelf = p.is_self;
                    return `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.06); ${isSelf ? 'background: rgba(0, 245, 155, 0.08);' : ''}">
                            <td style="padding: 10px 6px;">
                                <span style="font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 1.05rem; color: ${isSelf ? 'var(--neon-green)' : '#f8fafc'};">
                                    #${p.slot_number}
                                </span>
                            </td>
                            <td style="padding: 10px 6px;">
                                <span style="font-weight: 700; color: ${isSelf ? '#00f59b' : '#e2e8f0'};">
                                    ${escapeHtml(p.player_ign || 'Anonymous')}
                                </span>
                                ${isSelf ? '<span style="font-size: 0.72rem; background: rgba(0, 245, 155, 0.2); color: #00f59b; padding: 2px 6px; border-radius: 4px; font-weight: 800; margin-left: 6px;">👑 You</span>' : ''}
                            </td>
                            <td style="padding: 10px 6px; text-align: right;">
                                <span class="protected-uid" oncopy="return false;" oncontextmenu="return false;" ondragstart="return false;" onselectstart="return false;" title="Protected UID - Copying disabled">
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

        return `
            <div class="match-card" style="border: 1px solid rgba(0, 245, 155, 0.35); box-shadow: 0 4px 20px rgba(0, 245, 155, 0.08);">
                <div class="match-card-header">
                    <div>
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px;">
                            <span class="match-code-badge">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                            <span class="match-category" style="background: rgba(0, 245, 155, 0.15); color: #00f59b; margin-bottom: 0;">✅ Registered</span>
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
                        <span>Slot Booking</span>
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
        showToast('Please sign in before making a deposit', 'info');
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
            showToast(data.detail || 'Deposit request failed', 'error');
        }
    } catch (e) {
        showToast('Unable to connect to server', 'error');
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
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No deposit history found</td></tr>`;
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

// Admin Users Management & Direct Digits Add/Remove
let adminUsersCache = [];
let currentActionUser = null;

async function loadAdminUsers(search = '') {
    if (!currentUser || currentUser.role !== 'admin') return;
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

        return `
        <tr class="user-table-row" onclick="openUserActionModal(${u.id})" title="Click to open full player control panel">
            <td style="font-family: monospace; font-size: 0.8rem;">${u.player_id}</td>
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
            <td onclick="event.stopPropagation()">
                <div style="display: flex; gap: 6px; flex-wrap: wrap; align-items: center;">
                    <button type="button" class="btn-action-manage" onclick="openUserActionModal(${u.id}); event.stopPropagation();" title="Open full control panel">
                        ⚙️ Control
                    </button>
                    <button type="button" class="btn btn-outline btn-sm" onclick="openAdjustDigitsModal(${u.id}, '${escapeHtml(u.username)}', ${u.digits_balance}); event.stopPropagation();" title="Adjust Balance">
                        🪙 +/-
                    </button>
                    ${u.role !== 'admin' ? `
                        <button type="button" class="btn btn-crimson btn-sm" onclick="confirmDeleteUser(${u.id}, '${escapeHtml(u.username)}'); event.stopPropagation();" title="Permanently delete player account" style="padding: 4px 8px; font-size: 0.75rem;">
                            🗑️ Delete
                        </button>
                    ` : ''}
                </div>
            </td>
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
    try {
        const res = await fetch(`/api/admin/users/${userId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        if (res.ok) {
            closeModal('adminUserActionModal');
            showToast(`Account @${data.deleted_username || username} has been permanently deleted!`, 'success');
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
            <td>${m.match_type} (${m.map_name})</td>
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
            <td>
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <button class="btn btn-neon btn-sm" onclick="openSetRoomModal(${m.id}, '${escapeHtml(m.room_id || '')}', '${escapeHtml(m.room_pass || '')}')">
                        🔑 Room ID
                    </button>
                    ${!isCompleted ? `
                        <button class="btn btn-outline btn-sm" onclick="completeMatch(${m.id}, '${escapeHtml(m.title)}')" style="color: var(--neon-green); border-color: var(--neon-green);" title="Conclude Match">
                            🏁 Conclude
                        </button>
                    ` : ''}
                    ${isAdmin ? `
                        <button class="btn btn-crimson btn-sm" onclick="deleteMatch(${m.id})" title="Delete Match">
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
            showToast('Settings saved successfully!', 'success');
            loadPublicInfo();
        }
    } catch (e) {
        showToast('Operation failed', 'error');
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
            showToast('📢 Live notice updated!', 'info');
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
    } else if (sectionId === 'players') {
        if (currentUser && currentUser.role === 'admin') loadAdminUsers();
    } else if (sectionId === 'matches') {
        if (currentUser && currentUser.role === 'moderator') {
            loadMatches();
        } else {
            loadAdminOverview();
        }
    } else if (sectionId === 'moderators') {
        if (currentUser && currentUser.role === 'admin') loadModeratorScoreboard();
    }
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
    if (phoneInp && !phoneInp.value && currentUser.phone) {
        phoneInp.value = currentUser.phone;
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
    if (!amount || amount <= 0) {
        showToast('Please specify the withdrawal amount', 'error');
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

async function openTopPlayersModal() {
    openModal('topPlayersModal');
    const body = document.getElementById('leaderboardBody');
    if (!body) return;
    body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#64748b;">Loading...</td></tr>';

    try {
        const res = await fetch('/api/leaderboard');
        const data = await res.json();
        const list = data.leaderboard || [];

        if (list.length === 0) {
            body.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:#94a3b8;">No records found</td></tr>';
            return;
        }

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
    } catch (err) {
        body.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#ef4444;">Failed to load</td></tr>';
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

        container.innerHTML = results.map(m => `
            <div class="results-card" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:12px 14px; margin-bottom:12px; box-shadow:0 2px 8px rgba(0,0,0,0.03);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span class="match-code-badge" style="font-size:0.7rem; padding:1px 6px;">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                        <span class="filter-pill" style="background:#e0f2fe; color:#0369a1; border:none; padding:2px 8px; font-size:0.68rem; font-weight:700;">🔥 ${escapeHtml(m.match_type || 'Solo')}</span>
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
        `).join('');
    } catch (err) {
        container.innerHTML = '<div style="text-align:center; color:#ef4444; padding:20px; font-size:0.8rem;">Unable to load tournament results</div>';
    }
}



// -------------------------------------------------------------
// Important Notice Popup Helpers
// -------------------------------------------------------------
function openWelcomeNotice() {
    const modal = document.getElementById('welcomeNoticeModal');
    if (modal) modal.classList.add('show');
}

function closeWelcomeNotice() {
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
    if (id === 'authModal' && !currentUser) {
        return; // Locked: Cannot close login modal without logging in
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

