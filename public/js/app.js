// =============================================================
// Free Fire Pro Tournament Client Application Logic
// Ultra-Fast Zero-Lag Architecture with WebSockets & Web Push
// =============================================================

let currentUser = null;
let token = localStorage.getItem('ff_token') || null;
let adminBkashNumber = 'লোড হচ্ছে...';
let adminWithdrawNumber = 'লোড হচ্ছে...';

function copyAdminBkash() {
    if (!currentUser) {
        showToast('বিকাশ নাম্বার দেখতে বা কপি করতে অনুগ্রহ করে আগে লগইন করুন!', 'warning');
        openModal('authModal');
        return;
    }
    const raw = adminBkashNumber || '';
    if (!raw || raw.includes('লগইন') || raw === 'লোড হচ্ছে...') {
        loadPublicInfo();
        showToast('বিকাশ নাম্বার রিফ্রেশ করা হচ্ছে, অনুগ্রহ করে কয়েক সেকেন্ড পর আবার চাপ দিন...', 'info');
        return;
    }
    const numOnly = raw.split(' ')[0].trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(numOnly);
    }
    showToast(`ডিপোজিট বিকাশ নাম্বার (${numOnly}) কপি করা হয়েছে!`, 'success');
}

function copyAdminWithdraw() {
    if (!currentUser) {
        showToast('উইথড্র নাম্বার দেখতে বা কপি করতে অনুগ্রহ করে আগে লগইন করুন!', 'warning');
        openModal('authModal');
        return;
    }
    const raw = adminWithdrawNumber || adminBkashNumber || '';
    if (!raw || raw.includes('লগইন') || raw === 'লোড হচ্ছে...') {
        loadPublicInfo();
        showToast('উইথড্র নাম্বার রিফ্রেশ করা হচ্ছে, অনুগ্রহ করে কয়েক সেকেন্ড পর আবার চাপ দিন...', 'info');
        return;
    }
    const numOnly = raw.split(' ')[0].trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(numOnly);
    }
    showToast(`উইথড্র নাম্বার (${numOnly}) কপি করা হয়েছে!`, 'success');
}

let vapidPublicKey = null;
let ws = null;
let wsPingInterval = null;
const adminUserPassMap = new Map();
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
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let icon = 'ℹ️';
    if (type === 'success') icon = '✅';
    if (type === 'error') icon = '❌';

    const iconSpan = document.createElement('span');
    iconSpan.textContent = icon;
    const msgDiv = document.createElement('div');
    msgDiv.textContent = message;

    toast.appendChild(iconSpan);
    toast.appendChild(msgDiv);
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
        if (res.status === 401 && activeToken && !endpoint.includes('/api/auth/login')) {
            console.warn('Session revoked or password changed on another device. Auto logging out.');
            if (typeof logout === 'function') {
                logout(false);
            }
        }
        const errorMsg = data.detail || data.message || `Request failed (${res.status})`;
        const err = new Error(errorMsg);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    return data;
}

let splashMinTimePassed = true;
let splashDismissRequested = true;

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
    try {
        if (sessionStorage.getItem('current_active_modal') === 'myProfileDetailsModal') {
            sessionStorage.removeItem('current_active_modal');
        }
        const initialProfModal = document.getElementById('myProfileDetailsModal');
        if (initialProfModal) {
            initialProfModal.classList.remove('show');
            initialProfModal.style.removeProperty('display');
        }
    } catch (_) {}

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

    initTheme();
    initAppNavigationBarrier();
    await initAuth();
    loadPublicInfo();
    initServiceWorker();
    setTimeout(() => {
        try { checkAndTriggerDeepLinks(); } catch (e) { console.error('DeepLink init error:', e); }
    }, 400);
}

// -------------------------------------------------------------
// Dark / Light Theme Management
// -------------------------------------------------------------
function initTheme() {
    const saved = localStorage.getItem('gomon_theme');
    const icon = document.getElementById('themeToggleIcon');
    if (saved === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        if (icon) icon.innerText = '☀️';
    } else {
        document.documentElement.removeAttribute('data-theme');
        if (icon) icon.innerText = '🌙';
    }
}

function toggleTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const newTheme = isDark ? 'light' : 'dark';
    const icon = document.getElementById('themeToggleIcon');

    if (newTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
        localStorage.setItem('gomon_theme', 'dark');
        if (icon) icon.innerText = '☀️';
        showToast('Dark mode enabled 🌙', 'info');
    } else {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('gomon_theme', 'light');
        if (icon) icon.innerText = '🌙';
        showToast('Light mode enabled ☀️', 'info');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startApp);
} else {
    startApp();
}

// -------------------------------------------------------------
// Public Site Settings
// -------------------------------------------------------------
function updateNoticeTicker(noticeText, noticeEnText) {
    if (!noticeText) return;
    document.querySelectorAll('#announcementText, .notice-text-bn').forEach(el => {
        el.innerText = noticeText;
    });

    let enText = (noticeEnText !== undefined && noticeEnText !== null && String(noticeEnText).trim() !== '')
        ? String(noticeEnText).trim()
        : '';

    // If admin provided a specific English / secondary notice, use it.
    // If not provided, repeat the custom notice text so the marquee flows seamlessly with user's exact text!
    if (!enText) {
        enText = noticeText;
    }

    document.querySelectorAll('.notice-text-en').forEach(el => {
        el.innerText = enText;
    });
}

async function loadPublicInfo() {
    try {
        const activeToken = token || localStorage.getItem('token') || localStorage.getItem('ff_token');
        const fetchHeaders = activeToken ? { 'Authorization': `Bearer ${activeToken}` } : {};
        const res = await fetch('/api/info?_t=' + Date.now(), { headers: fetchHeaders });
        const data = await res.json();
        
        if (data.admin_bkash && !data.admin_bkash.includes('লগইন')) {
            adminBkashNumber = data.admin_bkash;
        } else if (!adminBkashNumber || adminBkashNumber === 'লোড হচ্ছে...' || adminBkashNumber.includes('লগইন')) {
            adminBkashNumber = (data.admin_bkash && !data.admin_bkash.includes('লগইন')) ? data.admin_bkash : '01988279285 (Personal)';
        }

        if (data.admin_withdraw_number && !data.admin_withdraw_number.includes('লগইন')) {
            adminWithdrawNumber = data.admin_withdraw_number;
        } else if (!adminWithdrawNumber || adminWithdrawNumber === 'লোড হচ্ছে...' || adminWithdrawNumber.includes('লগইন')) {
            adminWithdrawNumber = (data.admin_withdraw_number && !data.admin_withdraw_number.includes('লগইন')) ? data.admin_withdraw_number : '01952851550';
        }
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

        if (data.notice) {
            updateNoticeTicker(data.notice, data.notice_en);
        }

        const setBk = document.getElementById('settingAdminBkash');
        if (setBk && adminBkashNumber && !adminBkashNumber.includes('লগইন') && adminBkashNumber !== 'লোড হচ্ছে...') {
            setBk.value = adminBkashNumber;
        }

        const setWith = document.getElementById('settingAdminWithdraw');
        if (setWith && adminWithdrawNumber && !adminWithdrawNumber.includes('লগইন') && adminWithdrawNumber !== 'লোড হচ্ছে...') {
            setWith.value = adminWithdrawNumber;
        }

        const setTi = document.getElementById('settingSiteTitle');
        if (setTi) setTi.value = data.site_title || '';
        const setNo = document.getElementById('settingNotice');
        if (setNo) setNo.value = data.notice || '';
        const setNoEn = document.getElementById('settingNoticeEn');
        if (setNoEn) setNoEn.value = data.notice_en || '';

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
            const installedVer = localStorage.getItem('installed_app_version') || currentInstalledVersion || 'v1.0.0';
            if (data.app_version && installedVer !== data.app_version) {
                setTimeout(() => {
                    promptAppUpdate(data.app_version, data.app_update_notes || 'Install the latest update');
                }, 800);
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
        document.documentElement.classList.add('not-authenticated');
        document.documentElement.classList.remove('authenticated');
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
            document.documentElement.classList.remove('not-authenticated');
            document.documentElement.classList.add('authenticated');
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            renderLoggedInNav();
            applyRolePermissionsUI();
            dismissSplashScreen();
            if (typeof restoreLastActiveView === 'function') {
                restoreLastActiveView(true);
            } else {
                loadMatches();
            }
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
            document.documentElement.classList.remove('not-authenticated');
            document.documentElement.classList.add('authenticated');
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            renderLoggedInNav();
            renderUserProfile();
            applyRolePermissionsUI();
            if (typeof restoreLastActiveView === 'function') {
                restoreLastActiveView(false);
            } else {
                loadWalletHistory();
                loadMatches();
            }
            initWebSocket();
            if (currentUser.role === 'admin') {
                loadAdminOverview();
                loadModeratorScoreboard();
            }
            try { loadPublicInfo(); } catch (_) {}
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
    const activeToken = token || localStorage.getItem('ff_token') || localStorage.getItem('token');
    if (activeToken) {
        if (!token) token = activeToken;
        options.headers['Authorization'] = `Bearer ${activeToken}`;
    }
    if (typeof getOrCreateDeviceId === 'function') {
        options.headers['X-Device-Id'] = getOrCreateDeviceId();
    }
    if (options.body && typeof options.body === 'string' && !options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, options);
    if (response.status === 401) {
        try {
            const clone = response.clone();
            const data = await clone.json();
            if (data && data.detail && (typeof data.detail === 'string') && data.detail.startsWith('SESSION_REVOKED:')) {
                const msg = data.detail.replace('SESSION_REVOKED:', '').trim();
                showToast(msg || 'আপনার অ্যাকাউন্টটি অন্য ডিভাইসে লগইন করায় এই ডিভাইস থেকে লগআউট করা হয়েছে।', 'error');
                if (typeof logout === 'function') {
                    logout(false);
                }
            }
        } catch (e) {}
    }
    return response;
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
    if (ws) {
        try {
            ws.onclose = null;
            ws.close();
        } catch (e) {}
        ws = null;
    }
    sessionStorage.removeItem('welcome_notice_dismissed');
    sessionStorage.removeItem('current_active_tab');
    sessionStorage.removeItem('current_admin_section');
    sessionStorage.removeItem('current_active_modal');
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
    localStorage.removeItem('ff_token');
    localStorage.removeItem('ff_user');
    token = null;
    currentUser = null;
    document.documentElement.classList.remove('authenticated');
    document.documentElement.classList.add('not-authenticated');
    document.body.classList.remove('authenticated');
    document.body.classList.add('not-authenticated');
    const mainApp = document.getElementById('mainAppWrapper');
    if (mainApp) mainApp.style.display = 'none';
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
    const otpCard = document.getElementById('authOtpCard');
    const forgotReqCard = document.getElementById('authForgotRequestCard');
    const forgotOtpCard = document.getElementById('authForgotOtpCard');
    const forgotNewPassCard = document.getElementById('authForgotNewPassCard');

    clearLoginError();
    clearSignupError();
    if (typeof clearOtpError === 'function') clearOtpError();
    if (typeof clearForgotRequestError === 'function') clearForgotRequestError();
    if (typeof clearForgotOtpError === 'function') clearForgotOtpError();
    if (typeof clearForgotNewPassError === 'function') clearForgotNewPassError();

    if (loginCard) loginCard.style.display = 'none';
    if (signupCard) signupCard.style.display = 'none';
    if (otpCard) otpCard.style.display = 'none';
    if (forgotReqCard) forgotReqCard.style.display = 'none';
    if (forgotOtpCard) forgotOtpCard.style.display = 'none';
    if (forgotNewPassCard) forgotNewPassCard.style.display = 'none';

    if (mode === 'login') {
        if (loginCard) loginCard.style.display = 'block';
        const saved = localStorage.getItem('saved_login_user');
        const uInp = document.getElementById('loginUsername');
        if (uInp && !uInp.value && saved) {
            uInp.value = saved;
        }
    } else if (mode === 'otp') {
        if (otpCard) otpCard.style.display = 'block';
    } else if (mode === 'forgot-request') {
        if (forgotReqCard) forgotReqCard.style.display = 'block';
        setTimeout(() => {
            const fi = document.getElementById('forgotIdentifier');
            if (fi) fi.focus();
        }, 100);
    } else if (mode === 'forgot-otp') {
        if (forgotOtpCard) forgotOtpCard.style.display = 'block';
    } else if (mode === 'forgot-newpass') {
        if (forgotNewPassCard) forgotNewPassCard.style.display = 'block';
        setTimeout(() => {
            const fp = document.getElementById('forgotNewPassword');
            if (fp) fp.focus();
        }, 100);
    } else {
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
        modal.style.removeProperty('display');
        openModal('forgotPasswordModal');
    } else {
        alert("Need help resetting your password?\n\nPlease contact GOMON HUB Admin on WhatsApp.\n\nWhatsApp: 01952851550\n24/7 dedicated support available anytime.");
    }
}

// -------------------------------------------------------------
// Forgot Password Flow (High-Security Email OTP)
// -------------------------------------------------------------
let currentForgotResetToken = null;
let currentForgotChangeToken = null;
let forgotCountdownTimerInterval = null;

function startEmailForgotPasswordFlow() {
    const fpModal = document.getElementById('forgotPasswordModal');
    if (fpModal) {
        fpModal.classList.remove('show');
        fpModal.style.display = 'none';
    }
    const authModal = document.getElementById('authModal');
    if (authModal) {
        authModal.classList.add('show');
        authModal.style.display = 'flex';
    }
    setAuthMode('forgot-request');
}
window.startEmailForgotPasswordFlow = startEmailForgotPasswordFlow;

function clearForgotRequestError() {
    const alertBox = document.getElementById('forgotRequestErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'none';
        alertBox.innerText = '';
    }
}

function showForgotRequestError(msg) {
    const alertBox = document.getElementById('forgotRequestErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.innerText = msg;
    }
    showToast(msg, 'error');
    playSound('alert');
}

function clearForgotOtpError() {
    const alertBox = document.getElementById('forgotOtpErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'none';
        alertBox.innerText = '';
    }
}

function showForgotOtpError(msg) {
    const alertBox = document.getElementById('forgotOtpErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.innerText = msg;
    }
    showToast(msg, 'error');
    playSound('alert');
}

function clearForgotNewPassError() {
    const alertBox = document.getElementById('forgotNewPassErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'none';
        alertBox.innerText = '';
    }
}

function showForgotNewPassError(msg) {
    const alertBox = document.getElementById('forgotNewPassErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.innerText = msg;
    }
    showToast(msg, 'error');
    playSound('alert');
}

async function handleForgotRequestSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    clearForgotRequestError();

    const idInput = document.getElementById('forgotIdentifier');
    const identifier = idInput ? idInput.value.trim() : '';

    if (!identifier) {
        showForgotRequestError('অনুগ্রহ করে ইউজারনেম অথবা মোবাইল নম্বর দিন');
        return;
    }

    const btn = document.getElementById('forgotRequestSubmitBtn');
    const origText = btn ? btn.innerText : 'Send Verification Code';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Sending Code...';
    }

    try {
        const deviceId = getOrCreateDeviceId();
        const res = await fetch('/api/auth/forgot-password/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: identifier, device_id: deviceId })
        });
        const data = await res.json();
        if (res.ok) {
            currentForgotResetToken = data.reset_token;
            const maskEl = document.getElementById('forgotMaskedEmail');
            if (maskEl) maskEl.innerText = data.masked_email || 'আপনার ইমেইলে';
            setAuthMode('forgot-otp');
            initForgotOtpInputs();
            startForgotOtpCountdown(180);
            showToast(data.message || 'পাসওয়ার্ড রিসেট কোড আপনার ইমেইলে পাঠানো হয়েছে।', 'success');
            playSound('success');
        } else {
            showForgotRequestError(data.detail || 'কোড পাঠানো সম্ভব হয়নি!');
        }
    } catch (err) {
        console.error('Forgot Request Error:', err);
        showForgotRequestError('সার্ভারে সংযোগ করা সম্ভব হয়নি। ইন্টারনেট কানেকশন চেক করুন।');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = origText;
        }
    }
}

function initForgotOtpInputs() {
    clearForgotOtpError();
    const boxes = document.querySelectorAll('#forgotOtpForm .forgot-otp-box');
    boxes.forEach((box, idx) => {
        box.value = '';
        box.oninput = (e) => {
            const val = e.target.value.replace(/[^0-9]/g, '');
            e.target.value = val ? val[val.length - 1] : '';
            if (val && idx < boxes.length - 1) {
                boxes[idx + 1].focus();
            }
            checkAutoSubmitForgotOtp();
        };
        box.onkeydown = (e) => {
            if (e.key === 'Backspace' && !box.value && idx > 0) {
                boxes[idx - 1].focus();
            }
        };
        box.onpaste = (e) => {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData('text').trim().replace(/[^0-9]/g, '');
            if (pasteData) {
                for (let i = 0; i < boxes.length; i++) {
                    boxes[i].value = pasteData[i] || '';
                }
                const focusIdx = Math.min(pasteData.length, boxes.length - 1);
                boxes[focusIdx].focus();
                checkAutoSubmitForgotOtp();
            }
        };
    });
    setTimeout(() => {
        if (boxes[0]) boxes[0].focus();
    }, 100);
}

function checkAutoSubmitForgotOtp() {
    const boxes = document.querySelectorAll('#forgotOtpForm .forgot-otp-box');
    let code = '';
    boxes.forEach(b => code += b.value.trim());
    if (code.length === 6) {
        handleForgotOtpSubmit();
    }
}

function startForgotOtpCountdown(seconds) {
    if (forgotCountdownTimerInterval) clearInterval(forgotCountdownTimerInterval);
    const timerWrap = document.getElementById('forgotTimerWrap');
    const timerEl = document.getElementById('forgotCountdownTimer');
    const resendBtn = document.getElementById('forgotResendBtn');
    if (timerWrap) timerWrap.style.display = 'inline';
    if (resendBtn) resendBtn.style.display = 'none';

    let rem = seconds;
    const update = () => {
        const m = Math.floor(rem / 60).toString().padStart(2, '0');
        const s = (rem % 60).toString().padStart(2, '0');
        if (timerEl) timerEl.innerText = `${m}:${s}`;
        if (rem <= 0) {
            clearInterval(forgotCountdownTimerInterval);
            if (timerWrap) timerWrap.style.display = 'none';
            if (resendBtn) resendBtn.style.display = 'inline-block';
        }
        rem--;
    };
    update();
    forgotCountdownTimerInterval = setInterval(update, 1000);
}

async function triggerForgotResendOtp() {
    if (!currentForgotResetToken) {
        showForgotOtpError('ওটিপি সেশনের মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে পুনরায় শুরু করুন।');
        return;
    }
    const btn = document.getElementById('forgotResendBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Sending...';
    }
    clearForgotOtpError();
    try {
        const res = await fetch('/api/auth/forgot-password/resend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reset_token: currentForgotResetToken })
        });
        const data = await res.json();
        if (res.ok) {
            startForgotOtpCountdown(180);
            showToast(data.message || 'নতুন ওটিপি কোড আপনার ইমেইলে পাঠানো হয়েছে।', 'success');
            playSound('success');
            const boxes = document.querySelectorAll('#forgotOtpForm .forgot-otp-box');
            boxes.forEach(b => b.value = '');
            if (boxes[0]) boxes[0].focus();
        } else {
            showForgotOtpError(data.detail || 'নতুন কোড পাঠানো যায়নি।');
        }
    } catch (err) {
        showForgotOtpError('নেটওয়ার্ক সমস্যা! অনুগ্রহ করে পুনরায় চেষ্টা করুন।');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Resend Code';
        }
    }
}

async function handleForgotOtpSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    clearForgotOtpError();

    const boxes = document.querySelectorAll('#forgotOtpForm .forgot-otp-box');
    let code = '';
    boxes.forEach(b => code += b.value.trim());

    if (code.length < 6) {
        showForgotOtpError('অনুগ্রহ করে ৬ ডিজিটের সম্পূর্ণ ওটিপি কোড দিন');
        return;
    }
    if (!currentForgotResetToken) {
        showForgotOtpError('ওটিপি সেশনের মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে পুনরায় শুরু করুন।');
        setAuthMode('forgot-request');
        return;
    }

    const btn = document.getElementById('forgotOtpSubmitBtn');
    const origText = btn ? btn.innerText : 'Verify & Proceed';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Verifying...';
    }

    try {
        const deviceId = getOrCreateDeviceId();
        const res = await fetch('/api/auth/forgot-password/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reset_token: currentForgotResetToken,
                otp_code: code,
                device_id: deviceId
            })
        });
        const data = await res.json();
        if (res.ok) {
            currentForgotChangeToken = data.change_token;
            if (forgotCountdownTimerInterval) clearInterval(forgotCountdownTimerInterval);
            setAuthMode('forgot-newpass');
            showToast(data.message || 'ওটিপি যাচাই হয়েছে! এবার নতুন পাসওয়ার্ড সেট করুন।', 'success');
            playSound('success');
        } else {
            showForgotOtpError(data.detail || 'ভুল ওটিপি কোড! অনুগ্রহ করে আবার চেষ্টা করুন।');
        }
    } catch (err) {
        console.error('Forgot Verify OTP Error:', err);
        showForgotOtpError('সার্ভারে সংযোগ করা সম্ভব হয়নি। ইন্টারনেট কানেকশন চেক করুন।');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = origText;
        }
    }
}

async function handleForgotNewPassSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    clearForgotNewPassError();

    const passInput = document.getElementById('forgotNewPassword');
    const confInput = document.getElementById('forgotConfirmPassword');
    const p1 = passInput ? passInput.value : '';
    const p2 = confInput ? confInput.value : '';

    if (!p1 || !p2) {
        showForgotNewPassError('উভয় ঘরে পাসওয়ার্ড প্রদান করুন');
        return;
    }
    if (p1 !== p2) {
        showForgotNewPassError('পাসওয়ার্ড দুটি মেলেনি! উভয় ঘরে একই পাসওয়ার্ড দিন।');
        return;
    }
    if (p1.length < 8) {
        showForgotNewPassError('পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে (কমপক্ষে ১টি অক্ষর এবং ১টি সংখ্যা)!');
        return;
    }
    if (!currentForgotChangeToken) {
        showForgotNewPassError('সেশনের মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে প্রথম থেকে আবার শুরু করুন।');
        setAuthMode('forgot-request');
        return;
    }

    const btn = document.getElementById('forgotNewPassSubmitBtn');
    const origText = btn ? btn.innerText : 'Save Password & Sign In';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Saving Password...';
    }

    try {
        const res = await fetch('/api/auth/forgot-password/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                change_token: currentForgotChangeToken,
                new_password: p1,
                confirm_password: p2
            })
        });
        const data = await res.json();
        if (res.ok) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('ff_token', token);
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            document.documentElement.classList.remove('not-authenticated');
            document.documentElement.classList.add('authenticated');
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            dismissSplashScreen();
            showToast('পাসওয়ার্ড সফলভাবে পরিবর্তিত হয়েছে! আপনাকে স্বাগতম।', 'success');
            playSound('success');

            sessionStorage.removeItem('welcome_notice_dismissed');
            try { openWelcomeNotice(true); } catch(err) {}
            try { renderLoggedInNav(); } catch(err) {}
            try { renderUserProfile(); } catch(err) {}
            try { loadMatches(); } catch(err) {}
            try { loadWalletHistory(); } catch(err) {}
            try { initWebSocket(); } catch(err) {}
            try { loadPublicInfo(); } catch(err) {}
            if (currentUser.role === 'admin') {
                const adminBtn = document.getElementById('tabBtn-admin');
                if (adminBtn) adminBtn.style.display = 'inline-flex';
                try { loadAdminOverview(); } catch(err) {}
            }
        } else {
            showForgotNewPassError(data.detail || 'পাসওয়ার্ড পরিবর্তন করা সম্ভব হয়নি!');
        }
    } catch (err) {
        console.error('Forgot New Pass Error:', err);
        showForgotNewPassError('সার্ভারে সংযোগ করা সম্ভব হয়নি। ইন্টারনেট কানেকশন চেক করুন।');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = origText;
        }
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

// Device ID & OTP State Management
function getOrCreateDeviceId() {
    let devId = localStorage.getItem('gomon_hub_device_id');
    if (!devId) {
        devId = 'dev_' + Math.random().toString(36).substring(2, 10) + '_' + Date.now().toString(36);
        localStorage.setItem('gomon_hub_device_id', devId);
    }
    return devId;
}

let currentOtpTempToken = null;
let otpCountdownTimerInterval = null;

function clearOtpError() {
    const alertBox = document.getElementById('otpErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'none';
        alertBox.innerText = '';
    }
}

function showOtpError(msg) {
    const alertBox = document.getElementById('otpErrorAlert');
    if (alertBox) {
        alertBox.style.display = 'block';
        alertBox.innerText = msg;
    }
    showToast(msg, 'error');
    playSound('alert');
}

function initOtpInputs() {
    clearOtpError();
    const boxes = document.querySelectorAll('#otpForm .otp-box-input');
    boxes.forEach((box, idx) => {
        box.value = '';
        box.oninput = (e) => {
            const val = e.target.value.replace(/[^0-9]/g, '');
            e.target.value = val ? val[val.length - 1] : '';
            if (val && idx < boxes.length - 1) {
                boxes[idx + 1].focus();
            }
            checkAutoSubmitOtp();
        };
        box.onkeydown = (e) => {
            if (e.key === 'Backspace' && !box.value && idx > 0) {
                boxes[idx - 1].focus();
            }
        };
        box.onpaste = (e) => {
            e.preventDefault();
            const pasteData = (e.clipboardData || window.clipboardData).getData('text').trim().replace(/[^0-9]/g, '');
            if (pasteData) {
                for (let i = 0; i < boxes.length; i++) {
                    boxes[i].value = pasteData[i] || '';
                }
                const focusIdx = Math.min(pasteData.length, boxes.length - 1);
                boxes[focusIdx].focus();
                checkAutoSubmitOtp();
            }
        };
    });
    setTimeout(() => {
        if (boxes[0]) boxes[0].focus();
    }, 100);
}

function checkAutoSubmitOtp() {
    const boxes = document.querySelectorAll('#otpForm .otp-box-input');
    let code = '';
    boxes.forEach(b => code += b.value.trim());
    if (code.length === 6) {
        handleVerifyOtpSubmit();
    }
}

function startOtpCountdown(seconds) {
    if (otpCountdownTimerInterval) clearInterval(otpCountdownTimerInterval);
    const timerWrap = document.getElementById('otpTimerWrap');
    const timerEl = document.getElementById('otpCountdownTimer');
    const resendBtn = document.getElementById('otpResendBtn');
    if (timerWrap) timerWrap.style.display = 'inline';
    if (resendBtn) resendBtn.style.display = 'none';

    let rem = seconds;
    const update = () => {
        const m = Math.floor(rem / 60).toString().padStart(2, '0');
        const s = (rem % 60).toString().padStart(2, '0');
        if (timerEl) timerEl.innerText = `${m}:${s}`;
        if (rem <= 0) {
            clearInterval(otpCountdownTimerInterval);
            if (timerWrap) timerWrap.style.display = 'none';
            if (resendBtn) resendBtn.style.display = 'inline-block';
        }
        rem--;
    };
    update();
    otpCountdownTimerInterval = setInterval(update, 1000);
}

async function handleVerifyOtpSubmit(e) {
    if (e && e.preventDefault) e.preventDefault();
    clearOtpError();
    const boxes = document.querySelectorAll('#otpForm .otp-box-input');
    let code = '';
    boxes.forEach(b => code += b.value.trim());
    if (code.length < 6) {
        showOtpError('অনুগ্রহ করে ৬ ডিজিটের সম্পূর্ণ ওটিপি কোড দিন');
        return;
    }
    if (!currentOtpTempToken) {
        showOtpError('সেশনের মেয়াদ শেষ হয়ে গেছে! অনুগ্রহ করে পুনরায় লগইন করুন।');
        setAuthMode('login');
        return;
    }

    const btn = document.getElementById('otpVerifySubmitBtn');
    const origText = btn ? btn.innerText : 'Verify & Continue';
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Verifying...';
    }

    try {
        const deviceId = getOrCreateDeviceId();
        const res = await fetch('/api/auth/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                temp_token: currentOtpTempToken,
                otp_code: code,
                device_id: deviceId
            })
        });
        const data = await res.json();
        if (res.ok) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('ff_token', token);
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            document.documentElement.classList.remove('not-authenticated');
            document.documentElement.classList.add('authenticated');
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            dismissSplashScreen();
            showToast(`Welcome, ${currentUser.username}! Device verified successfully.`, 'success');
            playSound('success');

            sessionStorage.removeItem('welcome_notice_dismissed');
            try { openWelcomeNotice(true); } catch(err) {}
            try { renderLoggedInNav(); } catch(err) {}
            try { renderUserProfile(); } catch(err) {}
            try { loadMatches(); } catch(err) {}
            try { loadWalletHistory(); } catch(err) {}
            try { initWebSocket(); } catch(err) {}
            try { loadPublicInfo(); } catch(err) {}
            if (currentUser.role === 'admin') {
                const adminBtn = document.getElementById('tabBtn-admin');
                if (adminBtn) adminBtn.style.display = 'inline-flex';
                try { loadAdminOverview(); } catch(err) {}
            }
        } else {
            showOtpError(data.detail || 'ভুল ওটিপি কোড! অনুগ্রহ করে আবার চেষ্টা করুন।');
            playSound('alert');
        }
    } catch (err) {
        console.error('Verify OTP network error:', err);
        showOtpError('সার্ভারে সংযোগ করা সম্ভব হয়নি। ইন্টারনেট কানেকশন চেক করুন।');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = origText;
        }
    }
}

async function triggerResendOtp() {
    if (!currentOtpTempToken) return;
    const btn = document.getElementById('otpResendBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Sending...';
    }
    clearOtpError();
    try {
        const res = await fetch('/api/auth/resend-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ temp_token: currentOtpTempToken })
        });
        const data = await res.json();
        if (res.ok) {
            startOtpCountdown(180);
            if (data.dev_otp) {
                console.log('%c[GOMON HUB NEW OTP]: ' + data.dev_otp, 'color: #00f59b; font-size: 16px; font-weight: bold;');
                showToast(`[Dev Mode] নতুন ওটিপি কোড: ${data.dev_otp}`, 'info');
            } else {
                showToast(data.message || 'নতুন ওটিপি কোড আপনার ইমেইলে পাঠানো হয়েছে।', 'success');
            }
            const boxes = document.querySelectorAll('#otpForm .otp-box-input');
            boxes.forEach(b => b.value = '');
            if (boxes[0]) boxes[0].focus();
        } else {
            showOtpError(data.detail || 'নতুন কোড পাঠানো যায়নি। অনুগ্রহ করে কিছুক্ষণ পর চেষ্টা করুন।');
        }
    } catch (err) {
        showOtpError('নেটওয়ার্ক সমস্যা! অনুগ্রহ করে পুনরায় চেষ্টা করুন।');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Resend Code';
        }
    }
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
        const pinInput = document.getElementById('loginAdminPin');
        const pinVal = pinInput ? pinInput.value.trim() : '';
        const deviceId = getOrCreateDeviceId();

        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: u, password: p, admin_pin: pinVal, device_id: deviceId })
        });
        const data = await res.json();
        if (res.ok) {
            // Check if New Device Verification OTP is required
            if (data.otp_required) {
                currentOtpTempToken = data.temp_token;
                const emailEl = document.getElementById('otpMaskedEmail');
                if (emailEl) emailEl.innerText = data.masked_email || 'your email';
                setAuthMode('otp');
                initOtpInputs();
                startOtpCountdown(180);
                if (data.dev_otp) {
                    console.log('%c[GOMON HUB OTP TEST CODE]: ' + data.dev_otp, 'color: #00f59b; font-size: 16px; font-weight: bold;');
                    showToast(`[Dev Mode] আপনার ওটিপি কোড: ${data.dev_otp}`, 'info');
                } else {
                    showToast(data.message || 'নতুন ডিভাইস শনাক্ত হয়েছে! ইমেইলে ওটিপি পাঠানো হয়েছে।', 'info');
                }
                return;
            }

            token = data.token;
            currentUser = data.user;
            localStorage.setItem('ff_token', token);
            localStorage.setItem('ff_user', JSON.stringify(currentUser));
            localStorage.setItem('saved_login_user', u);
            document.documentElement.classList.remove('not-authenticated');
            document.documentElement.classList.add('authenticated');
            document.body.classList.remove('not-authenticated');
            document.body.classList.add('authenticated');
            const mainApp = document.getElementById('mainAppWrapper');
            if (mainApp) mainApp.style.display = 'block';
            closeModal('authModal');
            dismissSplashScreen();
            showToast(`Welcome back, ${currentUser.username}! Login successful.`, 'success');
            playSound('success');

            // Reset admin PIN field if visible
            const pinGrp = document.getElementById('loginAdminPinGroup');
            if (pinGrp) pinGrp.style.display = 'none';
            if (pinInput) pinInput.value = '';

            // Safe isolated post-login initialization
            sessionStorage.removeItem('welcome_notice_dismissed');
            try { openWelcomeNotice(true); } catch(e) {}
            try { renderLoggedInNav(); } catch(e) { console.error('Error in renderLoggedInNav:', e); }
            try { renderUserProfile(); } catch(e) { console.error('Error in renderUserProfile:', e); }
            try { loadPublicInfo(); } catch(e) {}
            try { loadMatches(); } catch(e) { console.error('Error in loadMatches:', e); }
            try { loadWalletHistory(); } catch(e) { console.error('Error in loadWalletHistory:', e); }
            try { initWebSocket(); } catch(e) { console.error('Error in initWebSocket:', e); }
            if (currentUser.role === 'admin') {
                const adminBtn = document.getElementById('tabBtn-admin');
                if (adminBtn) adminBtn.style.display = 'inline-flex';
                try { loadAdminOverview(); } catch(e) { console.error('Error in loadAdminOverview:', e); }
            }
            try { checkAndTriggerDeepLinks(); } catch(e) {}
        } else {
            let errMsg = data.detail || 'Invalid username or password. Please try again.';
            if (errMsg.startsWith("ADMIN_PIN_REQUIRED:")) {
                const pinGrp = document.getElementById('loginAdminPinGroup');
                const pinHint = document.getElementById('loginAdminPinHint');
                if (pinGrp) {
                    pinGrp.style.display = 'flex';
                    if (pinHint) pinHint.style.display = 'block';
                    if (pinInput) pinInput.focus();
                }
                errMsg = errMsg.replace("ADMIN_PIN_REQUIRED:", "");
            }
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

    const promoCode = document.getElementById('regPromoCode') ? document.getElementById('regPromoCode').value.trim() : '';

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
                ff_uid: ffUid,
                promo_code: promoCode,
                device_id: typeof getOrCreateDeviceId === 'function' ? getOrCreateDeviceId() : ''
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
    document.documentElement.classList.remove('not-authenticated');
    document.documentElement.classList.add('authenticated');
    document.body.classList.remove('not-authenticated');
    document.body.classList.add('authenticated');
    const mainApp = document.getElementById('mainAppWrapper');
    if (mainApp) mainApp.style.display = 'block';
    closeModal('authModal');
    dismissSplashScreen();
    showToast(`Account created successfully! Your Player ID: ${currentUser.player_id}`, 'success');
    if (data.bonus_received && data.bonus_received > 0) {
        setTimeout(() => {
            showToast(`🎉 স্বাগতম! প্রোমো কোড ব্যবহারের জন্য আপনি ${data.bonus_received} টাকা বোনাস পেয়েছেন!`, 'success');
        }, 800);
    }
    playSound('success');

    // Safe background UI updates
    sessionStorage.removeItem('welcome_notice_dismissed');
    try { openWelcomeNotice(true); } catch(e) {}
    try { renderLoggedInNav(); } catch(e) { console.error('Error in renderLoggedInNav:', e); }
    try { renderUserProfile(); } catch(e) { console.error('Error in renderUserProfile:', e); }
    try { loadMatches(); } catch(e) { console.error('Error in loadMatches:', e); }
    try { loadWalletHistory(); } catch(e) { console.error('Error in loadWalletHistory:', e); }
    try { initWebSocket(); } catch(e) { console.error('Error in initWebSocket:', e); }
    try { loadPublicInfo(); } catch(e) {}
    try { checkAndTriggerDeepLinks(); } catch(e) {}
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

// Check if a match is open & joinable in the public lobby (not started, not completed)
function isMatchOpenInLobby(m) {
    if (!m) return false;
    if (m.status === 'completed' || m.status === 'cancelled' || m.status === 'reg_closed' || m.status === 'live' || m.status === 'started') {
        return false;
    }
    const targetTime = parseMatchTimestamp(m.match_time);
    if (targetTime && targetTime <= Date.now()) {
        return false; // Match start time arrived/passed! Auto-remove from public lobby
    }
    return true;
}

function updateCategoryCounts() {
    MATCH_CATEGORIES_CONFIG.forEach(c => {
        const countEl = document.getElementById('count_' + c.id);
        if (!countEl) return;
        // Only count active / upcoming matches whose start time has NOT passed
        const matchesInCat = (allMatches || []).filter(m => isMatchOpenInLobby(m) && c.matches(m));
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

let isMatchesFetching = false;
let lastMatchesFetchTimestamp = 0;

async function loadMatches(silent = false) {
    const now = Date.now();
    // Prevent multiple rapid overlapping calls within 1200ms if matches are already loaded
    if (!silent && now - lastMatchesFetchTimestamp < 1200 && allMatches && allMatches.length > 0) {
        return;
    }
    if (isMatchesFetching) return;
    isMatchesFetching = true;
    lastMatchesFetchTimestamp = now;

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
    } finally {
        isMatchesFetching = false;
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

// -------------------------------------------------------------
// Live Real-Time Match Countdown Ticker & Formatter
// -------------------------------------------------------------
let matchCountdownTimerId = null;

// Convert 24-hour match time (e.g. 2026-09-19 22:59) into 12-hour AM/PM format (e.g. 19 Sep 2026, 10:59 PM)
function formatMatchTime12Hour(timeStr) {
    if (!timeStr) return 'Upcoming';
    const str = String(timeStr).trim();
    if (!str || str.toLowerCase() === 'upcoming') return 'Upcoming';

    // If already contains AM/PM, return as-is
    if (/\b(AM|PM)\b/i.test(str)) {
        return str;
    }

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Match YYYY-MM-DD HH:mm(:ss)? or YYYY/MM/DD
    const match = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (match) {
        const year = match[1];
        const monthNum = parseInt(match[2], 10);
        const day = parseInt(match[3], 10);
        let hour = parseInt(match[4], 10);
        const min = String(parseInt(match[5], 10)).padStart(2, '0');

        const ampm = hour >= 12 ? 'PM' : 'AM';
        hour = hour % 12;
        if (hour === 0) hour = 12;
        const hourStr = String(hour).padStart(2, '0');
        const monthName = months[monthNum - 1] || match[2];

        return `${day} ${monthName} ${year}, ${hourStr}:${min} ${ampm}`;
    }

    // Fallback to standard Date parsing
    const d = new Date(str.replace(' ', 'T'));
    if (!isNaN(d.getTime())) {
        const year = d.getFullYear();
        const monthName = months[d.getMonth()];
        const day = d.getDate();
        let hour = d.getHours();
        const min = String(d.getMinutes()).padStart(2, '0');
        const ampm = hour >= 12 ? 'PM' : 'AM';
        hour = hour % 12;
        if (hour === 0) hour = 12;
        const hourStr = String(hour).padStart(2, '0');
        return `${day} ${monthName} ${year}, ${hourStr}:${min} ${ampm}`;
    }

    return str;
}
window.formatMatchTime12Hour = formatMatchTime12Hour;

function parseMatchTimestamp(timeStr) {
    if (!timeStr) return null;
    const str = String(timeStr).trim();
    if (!str) return null;

    // 1. Manual regex parse for YYYY-MM-DD HH:mm(:ss)? with optional AM/PM
    const matchYMD = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*(AM|PM))?/i);
    if (matchYMD) {
        const year = parseInt(matchYMD[1], 10);
        const month = parseInt(matchYMD[2], 10) - 1;
        const day = parseInt(matchYMD[3], 10);
        let hour = parseInt(matchYMD[4], 10);
        const min = parseInt(matchYMD[5], 10);
        const sec = matchYMD[6] ? parseInt(matchYMD[6], 10) : 0;
        const ampm = matchYMD[7] ? matchYMD[7].toUpperCase() : null;
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
        const d = new Date(year, month, day, hour, min, sec);
        if (!isNaN(d.getTime())) return d.getTime();
    }

    // 2. Parse "DD Mon YYYY, hh:mm AM/PM" (e.g. "19 Sep 2026, 10:59 PM")
    const matchDMY = str.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4}),?\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\s*(AM|PM))?/i);
    if (matchDMY) {
        const day = parseInt(matchDMY[1], 10);
        const monthStr = matchDMY[2].toLowerCase().slice(0, 3);
        const year = parseInt(matchDMY[3], 10);
        let hour = parseInt(matchDMY[4], 10);
        const min = parseInt(matchDMY[5], 10);
        const sec = matchDMY[6] ? parseInt(matchDMY[6], 10) : 0;
        const ampm = matchDMY[7] ? matchDMY[7].toUpperCase() : null;
        if (ampm === 'PM' && hour < 12) hour += 12;
        if (ampm === 'AM' && hour === 12) hour = 0;
        const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const monthIdx = monthNames.indexOf(monthStr);
        if (monthIdx !== -1) {
            const d = new Date(year, monthIdx, day, hour, min, sec);
            if (!isNaN(d.getTime())) return d.getTime();
        }
    }

    // 3. Fallback to standard ISO / Date parsing
    const isoStr = str.replace(' ', 'T');
    const d = new Date(isoStr);
    if (!isNaN(d.getTime())) return d.getTime();
    const dDirect = new Date(str);
    return isNaN(dDirect.getTime()) ? null : dDirect.getTime();
}

function formatCountdown(targetTime, status) {
    const s = String(status || '').toLowerCase();
    if (s === 'completed' || s === 'concluded') {
        return {
            text: '🏁 Match Finished',
            state: 'completed'
        };
    }
    if (s === 'cancelled') {
        return {
            text: '❌ Match Cancelled',
            state: 'completed'
        };
    }
    if (!targetTime) {
        return {
            text: '⏰ Upcoming Match',
            state: 'upcoming'
        };
    }

    const now = Date.now();
    const diff = targetTime - now;

    if (diff <= 0) {
        return {
            text: '🔴 Match Live / Started',
            state: 'live'
        };
    }

    const totalSecs = Math.floor(diff / 1000);
    const days = Math.floor(totalSecs / 86400);
    const hours = Math.floor((totalSecs % 86400) / 3600);
    const minutes = Math.floor((totalSecs % 3600) / 60);
    const seconds = totalSecs % 60;

    const pad = (n) => String(n).padStart(2, '0');

    let timeFormatted = '';
    if (days > 0) {
        timeFormatted = `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    } else {
        timeFormatted = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
    }

    const isUrgent = diff <= 15 * 60 * 1000; // 15 mins or less
    return {
        text: `⏰ Starts in: ${timeFormatted}`,
        state: isUrgent ? 'urgent' : 'upcoming'
    };
}

function updateAllMatchCountdowns() {
    const pills = document.querySelectorAll('.match-countdown-pill');
    if (!pills || pills.length === 0) return;

    let needLobbyRefresh = false;
    pills.forEach(pill => {
        const timeStr = pill.getAttribute('data-match-time');
        const status = pill.getAttribute('data-match-status') || 'upcoming';
        const targetTime = parseMatchTimestamp(timeStr);
        const result = formatCountdown(targetTime, status);

        // Auto-remove started matches in real-time from the public lobby grid:
        if (targetTime && (targetTime <= Date.now()) && pill.closest('#matchesGrid')) {
            needLobbyRefresh = true;
        }

        const textEl = pill.querySelector('.countdown-timer-text');
        if (textEl && textEl.textContent !== result.text) {
            textEl.textContent = result.text;
        }

        const validClasses = ['state-upcoming', 'state-urgent', 'state-live', 'state-completed'];
        validClasses.forEach(cls => {
            if (cls === `state-${result.state}`) {
                if (!pill.classList.contains(cls)) pill.classList.add(cls);
            } else {
                if (pill.classList.contains(cls)) pill.classList.remove(cls);
            }
        });
    });

    if (needLobbyRefresh) {
        renderMatches();
        updateCategoryCounts();
    }
}

function startMatchCountdownTicker() {
    if (matchCountdownTimerId) {
        clearInterval(matchCountdownTimerId);
        matchCountdownTimerId = null;
    }
    updateAllMatchCountdowns();
    matchCountdownTimerId = setInterval(updateAllMatchCountdowns, 1000);
}

function renderMatches() {
    renderCategoryHub();

    const grid = document.getElementById('matchesGrid');
    if (!grid) return;

    // Filter out completed/concluded, cancelled, and already started matches:
    // Only open upcoming matches whose start time has NOT passed appear in the user lobby
    const activeMatches = (allMatches || []).filter(m => isMatchOpenInLobby(m));

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

        const isRoomReleased = !!(m.room_id && m.room_id !== 'JOIN TO VIEW' && m.room_id !== 'NOT RELEASED YET' && !m.room_id.includes('দেওয়া হবে') && !m.room_id.includes('মিনিট আগে'));
        const safeRoomId = escapeHtml(m.room_id || '');
        const safeRoomPass = escapeHtml(m.room_pass || '');
        const jsRoomId = String(m.room_id || '').replace(/'/g, "\\'");
        const jsRoomPass = String(m.room_pass || '').replace(/'/g, "\\'");

        let actionHtml = '';
        if (hasJoined) {
            if (isRoomReleased) {
                actionHtml = `
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; background: #ecfdf5; border: 1.5px solid #10b981; border-radius: 8px; padding: 6px 10px; box-shadow: 0 0 10px rgba(16,185,129,0.15);">
                            <span style="font-size: 0.8rem; color: #047857; font-weight: 800; display: inline-flex; align-items: center; gap: 6px;">
                                <span class="room-pulse-green"></span>
                                Room ID Released!
                            </span>
                            <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 900; color: #065f46; background: #dcfce7; padding: 1px 8px; border-radius: 5px; border: 1px solid #86efac;">
                                Slot #${m.my_slot || 1}
                            </span>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button type="button" class="btn btn-neon" style="flex: 2; padding: 8px 10px; font-size: 0.86rem; font-weight: 900; border-radius: 8px; background: linear-gradient(135deg, #059669, #10b981); box-shadow: 0 2px 10px rgba(16, 185, 129, 0.35); display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="openRoomBottomSheet(${m.id})">
                                🔑 Room ID
                            </button>
                            <button type="button" class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 800; border-color: #cbd5e1; color: #334155; border-radius: 8px;" onclick="openMatchInnerPortal(${m.id})" title="View Registered Players">
                                👥 Players
                            </button>
                            <button type="button" class="btn btn-outline" style="padding: 8px 10px; font-size: 0.78rem; font-weight: 800; border-color: #f59e0b; color: #f59e0b; border-radius: 8px;" onclick="openPrizeBreakdownModal(${m.id})" title="View Prize Breakdown">
                                🏆
                            </button>
                        </div>
                    </div>
                `;
            } else {
                actionHtml = `
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; background: #ecfdf5; border: 1px solid #86efac; border-radius: 8px; padding: 6px 10px;">
                            <span style="font-size: 0.8rem; color: #166534; font-weight: 800;">✅ You are Registered</span>
                            <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800; color: #047857;">Slot #${m.my_slot || 1} (Fixed)</span>
                        </div>
                        <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 6px 10px; font-size: 0.74rem; color: #92400e; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                            <span>⏳</span>
                            <span>রুম আইডি ও পাসওয়ার্ড খেলা শুরুর ১০-১৫ মিনিট আগে দেওয়া হবে</span>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button type="button" class="btn btn-outline" style="flex: 2; padding: 8px 10px; font-size: 0.82rem; font-weight: 800; border-color: #cbd5e1; color: #334155; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="openMatchInnerPortal(${m.id})">
                                👥 View Players (${m.joined_count})
                            </button>
                            <button type="button" class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 700; border-color: #f59e0b; color: #b45309; background: #fffbeb; border-radius: 8px;" onclick="openPrizeBreakdownModal(${m.id})">
                                🏆 Prize
                            </button>
                        </div>
                    </div>
                `;
            }
        } else if (isAdminOrMod) {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #e0f2fe; border: 1px solid #7dd3fc; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #0369a1; font-weight: 700;">🛡️ Admin/Mod Access</span>
                        <span style="font-size: 0.75rem; color: #0284c7; font-weight: 800;">${m.joined_count || 0}/${m.total_slots || 48} Players</span>
                    </div>
                    ${isRoomReleased ? `
                    <div style="background: #0f172a; border: 1px solid #38bdf8; border-radius: 8px; padding: 7px 10px; color: #fff; font-size: 0.78rem; margin-bottom: 2px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                            <span>ID: <b style="color: #38bdf8; font-family: monospace;">${safeRoomId}</b></span>
                            <button type="button" style="background: #0284c7; border: none; color: #fff; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.72rem; font-weight: 700;" onclick="copyTextDirect('${jsRoomId}', 'Room ID')">📋 Copy</button>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span>Pass: <b style="color: #00f59b; font-family: monospace;">${safeRoomPass}</b></span>
                            <button type="button" style="background: #059669; border: none; color: #fff; padding: 2px 8px; border-radius: 4px; cursor: pointer; font-size: 0.72rem; font-weight: 700;" onclick="copyTextDirect('${jsRoomPass}', 'Password')">📋 Copy</button>
                        </div>
                    </div>` : ''}
                    <div style="display: flex; gap: 6px;">
                        <button class="btn btn-neon" style="flex: 2; padding: 8px 12px; font-size: 0.86rem; font-weight: 800; border-radius: 8px; background: linear-gradient(135deg, #0284c7, #0369a1);" onclick="openMatchInnerPortal(${m.id})">
                            👥 View Room & Players
                        </button>
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 700; border-color: #f59e0b; color: #b45309; background: #fffbeb; border-radius: 8px;" onclick="openPrizeBreakdownModal(${m.id})">
                            🏆 Prize
                        </button>
                    </div>
                </div>
            `;
        } else if (m.status === 'reg_closed') {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #94a3b8; font-weight: 600;">⭕ Not Joined</span>
                        <span style="font-size: 0.75rem; color: #ef4444; font-weight: 700;">Registration Closed</span>
                    </div>
                    <button class="btn btn-outline" style="width: 100%; opacity: 0.75; cursor: not-allowed; border-color: #ef4444; color: #ef4444; font-size: 0.8rem; font-weight: 700;" disabled>🔒 Registration Closed</button>
                    <div style="display: flex; gap: 6px;">
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; font-weight: 700; border-radius: 7px; color: #475569; border-color: #cbd5e1;" onclick="openMatchInnerPortal(${m.id})">
                            🔑 Room Details ∨
                        </button>
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; font-weight: 700; border-radius: 7px; color: #b45309; border-color: #fde68a; background: #fffbeb;" onclick="openPrizeBreakdownModal(${m.id})">
                            🏆 Prize Details ∨
                        </button>
                    </div>
                </div>
            `;
        } else if (m.status === 'completed') {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #94a3b8; font-weight: 600;">⭕ Finished</span>
                        <span style="font-size: 0.75rem; color: #10b981; font-weight: 700;">Completed</span>
                    </div>
                    <button class="btn btn-outline" style="width: 100%; border-color: #10b981; color: #10b981; font-size: 0.82rem; font-weight: 700;" onclick="openPrizeBreakdownModal(${m.id})">🏁 View Results & Prizes</button>
                </div>
            `;
        } else if (isFull) {
            actionHtml = `
                <div style="display: flex; flex-direction: column; gap: 6px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 5px 10px;">
                        <span style="font-size: 0.78rem; color: #94a3b8; font-weight: 600;">⭕ Not Joined</span>
                        <span style="font-size: 0.75rem; color: #ef4444; font-weight: 700;">Slots Full (${m.joined_count || m.total_slots || 48}/${m.total_slots || 48})</span>
                    </div>
                    <button class="btn btn-outline" style="width: 100%; opacity: 0.7; cursor: not-allowed; font-size: 0.84rem; font-weight: 800; border-color: #cbd5e1; color: #64748b;" disabled>🔒 Match Full</button>
                    <div style="display: flex; gap: 6px;">
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; font-weight: 700; border-radius: 7px; color: #475569; border-color: #cbd5e1;" onclick="openMatchInnerPortal(${m.id})">
                            🔑 Room Details ∨
                        </button>
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; font-weight: 700; border-radius: 7px; color: #b45309; border-color: #fde68a; background: #fffbeb;" onclick="openPrizeBreakdownModal(${m.id})">
                            🏆 Prize Details ∨
                        </button>
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
                    <button class="btn btn-neon" style="width: 100%; padding: 9px 6px; font-size: 0.88rem; font-weight: 800; border-radius: 8px;" onclick="openJoinMatchModal(${m.id}, '${escapeHtml(m.title)}', ${m.entry_fee})">
                        🎮 Join Match (${m.entry_fee} 🪙)
                    </button>
                    <div style="display: flex; gap: 6px;">
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; font-weight: 700; border-radius: 7px; color: #334155; border-color: #cbd5e1; background: #f8fafc; display: flex; align-items: center; justify-content: center; gap: 4px;" onclick="openMatchInnerPortal(${m.id})">
                            🔑 Room Details ∨
                        </button>
                        <button type="button" class="btn btn-outline" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; font-weight: 700; border-radius: 7px; color: #b45309; border-color: #fde68a; background: #fffbeb; display: flex; align-items: center; justify-content: center; gap: 4px;" onclick="openPrizeBreakdownModal(${m.id})">
                            🏆 Prize Details ∨
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
                            <span class="match-category" style="margin-bottom: 0;">🔥 ${escapeHtml(catName)}</span>
                            <span class="match-format-monitor ${fmt.cssClass}" style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.74rem; font-weight: 800; padding: 2.5px 9px; border-radius: 999px; letter-spacing: 0.5px; text-transform: uppercase; font-family: 'Rajdhani', sans-serif; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05); line-height: 1.2; ${fmt.inlineStyle}">${fmt.icon} ${fmt.label}</span>
                        </div>
                        <div class="match-title">${escapeHtml(m.title)}</div>
                        <div class="match-time-badge">⏰ ${escapeHtml(formatMatchTime12Hour(m.match_time))}</div>
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

                <div class="match-card-footer" style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;">
                    ${actionHtml}
                    <div class="match-countdown-pill" data-match-time="${escapeHtml(m.match_time || '')}" data-match-status="${escapeHtml(m.status || '')}">
                        <span class="countdown-pulse-dot"></span>
                        <span class="countdown-timer-text">⏰ Starts in: calculating...</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    startMatchCountdownTicker();
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

    // Calculate and display dynamic Win Prize for selected slots
    const winPrizeEl = document.getElementById('joinModalWinPrize');
    const winPrizeRow = document.getElementById('joinModalWinPrizeRow');
    if (winPrizeEl && winPrizeRow && currentJoinMatch) {
        const m = currentJoinMatch;
        const winnerPrize = (m.prize_breakdown && m.prize_breakdown.winner) ? parseInt(m.prize_breakdown.winner, 10) : (parseInt(m.prize_pool, 10) || 0);
        const totalSlots = parseInt(m.total_slots, 10) || 48;
        const isTeamMatch = (totalSlots <= 8) || (m.match_type || '').toLowerCase().includes('clash') || (m.match_type || '').toLowerCase().includes('cs') || (m.match_type || '').toLowerCase().includes('lone');
        const teamSlots = isTeamMatch ? Math.max(1, Math.round(totalSlots / 2)) : (totalSlots > 8 ? 1 : Math.max(1, Math.round(totalSlots / 2)));
        const perSlotPrize = Math.round(winnerPrize / teamSlots);
        const myWinShare = perSlotPrize * count;
        if (myWinShare > 0) {
            winPrizeRow.style.display = 'flex';
            winPrizeEl.innerText = count > 1 ? `৳${myWinShare} (${count}টি স্লট)` : `৳${myWinShare}`;
        } else {
            winPrizeRow.style.display = 'none';
        }
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

function copyTextDirect(val, label = 'Copied!') {
    if (!val || val === 'NOT RELEASED YET' || val.includes('দেওয়া হবে') || val.includes('release') || val.includes('JOIN')) {
        showToast('Room ID & Password are not released yet', 'info');
        return;
    }
    const clean = String(val).trim();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(clean).then(() => {
            showToast(`✅ ${label}: ${clean}`, 'success');
            try { playSound('success'); } catch(e) {}
        }).catch(() => {
            prompt('Copy to clipboard (Ctrl+C):', clean);
        });
    } else {
        prompt('Copy to clipboard (Ctrl+C):', clean);
    }
}

let currentBsMatch = null;
let currentPortalMatchId = null;

function openPortalAdminSetRoom() {
    if (!currentPortalMatchId) return;
    openSetRoomModal(currentPortalMatchId, currentPortalRoomId, currentPortalRoomPass);
}
window.openPortalAdminSetRoom = openPortalAdminSetRoom;

function openRoomBottomSheet(matchId) {
    const m = (allMatches || []).find(x => x.id === matchId);
    if (!m) {
        showToast('Match not found', 'error');
        return;
    }
    currentBsMatch = m;

    const overlay = document.getElementById('roomBottomSheetModal');
    if (!overlay) return;

    const titleEl = document.getElementById('bsMatchTitle');
    const subtitleEl = document.getElementById('bsMatchSubtitle');
    const slotEl = document.getElementById('bsSlotNumber');
    const idEl = document.getElementById('bsRoomIdVal');
    const passEl = document.getElementById('bsRoomPassVal');

    if (titleEl) titleEl.innerText = `${m.match_code ? `[#${m.match_code}] ` : ''}${m.title || 'Tournament Match'}`;
    if (subtitleEl) subtitleEl.innerText = `Type: ${m.match_type || 'Solo'} • Time: ${formatMatchTime12Hour(m.match_time)}`;
    
    if (slotEl) {
        if (m.has_joined) {
            slotEl.innerText = `Slot #${m.my_slot || 1} (Fixed)`;
        } else if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator')) {
            slotEl.innerText = currentUser.role === 'admin' ? '🛡️ Admin' : '🛡️ Moderator';
        } else {
            slotEl.innerText = '#1 (Fixed)';
        }
    }

    const roomId = m.room_id || 'Not set yet';
    const roomPass = m.room_pass || 'Not set yet';

    if (idEl) idEl.innerText = roomId;
    if (passEl) passEl.innerText = roomPass;

    overlay.style.display = 'flex';
    setTimeout(() => {
        overlay.classList.add('active');
    }, 10);
}
window.openRoomBottomSheet = openRoomBottomSheet;

function closeRoomBottomSheet() {
    const overlay = document.getElementById('roomBottomSheetModal');
    if (!overlay) return;
    overlay.classList.remove('active');
    setTimeout(() => {
        overlay.style.display = 'none';
    }, 280);
}
window.closeRoomBottomSheet = closeRoomBottomSheet;

function copyBottomSheetText(type) {
    if (!currentBsMatch) return;
    const rId = (currentBsMatch.room_id || '').trim();
    const rPass = (currentBsMatch.room_pass || '').trim();

    if (type === 'id') {
        copyTextDirect(rId, 'Room ID');
    } else if (type === 'pass') {
        copyTextDirect(rPass, 'Password');
    } else if (type === 'both') {
        copyTextDirect(`ID: ${rId} Pass: ${rPass}`, 'Room ID & Password');
    }
}
window.copyBottomSheetText = copyBottomSheetText;

let currentPrizeModalMatchId = null;
let isPrizeEditMode = false;

function calcTotalPrizePool() {
    const w = parseInt(document.getElementById('matchPrizeWinner')?.value, 10) || 0;
    const s = parseInt(document.getElementById('matchPrizeSecond')?.value, 10) || 0;
    const t = parseInt(document.getElementById('matchPrizeThird')?.value, 10) || 0;
    const totalEl = document.getElementById('matchPrizePool');
    if (totalEl) {
        totalEl.value = w + s + t;
    }
}

function applyCsPerPlayerPrize() {
    const input = document.getElementById('csPerPlayerPrizeInput');
    const perPlayer = parseInt(input ? input.value : 0, 10) || 0;
    const slotsEl = document.getElementById('matchSlots');
    const totalSlots = parseInt(slotsEl ? slotsEl.value : 8, 10) || 8;
    const winningPlayers = Math.max(1, Math.round(totalSlots / 2));
    const totalWinnerPrize = perPlayer * winningPlayers;

    const wInput = document.getElementById('matchPrizeWinner');
    const sInput = document.getElementById('matchPrizeSecond');
    const tInput = document.getElementById('matchPrizeThird');
    const killInput = document.getElementById('matchPerKill');

    if (wInput) wInput.value = totalWinnerPrize;
    if (sInput) sInput.value = 0;
    if (tInput) tInput.value = 0;
    if (killInput && (killInput.value === '12' || !killInput.value)) killInput.value = 0;

    calcTotalPrizePool();

    const helperText = document.getElementById('csHelperText');
    if (helperText) {
        helperText.innerText = perPlayer > 0 
            ? `✅ উইনার দলের ${winningPlayers} জন × ৳${perPlayer} = মোট ৳${totalWinnerPrize} অটো-সেট করা হয়েছে।`
            : `এখানে লিখলে পুরো টিমের প্রাইজ স্বয়ংক্রিয়ভাবে হিসাব হয়ে যাবে।`;
    }
}
window.applyCsPerPlayerPrize = applyCsPerPlayerPrize;

function openPrizeBreakdownModal(matchId) {
    currentPrizeModalMatchId = matchId;
    isPrizeEditMode = false;
    const m = (allMatches || []).find(x => x.id === matchId);
    if (!m) return;
    const sub = document.getElementById('prizeModalSubtitle');
    if (sub) sub.innerText = `${m.title || 'Free Fire Match'} (#${m.match_code || ('MATCH-' + m.id)})`;

    const isAdminOrMod = (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator'));
    const btnEdit = document.getElementById('btnAdminEditPrize');
    if (btnEdit) {
        btnEdit.style.display = isAdminOrMod ? 'inline-block' : 'none';
        btnEdit.innerText = '✏️ Edit Prize';
        btnEdit.style.background = '#fffbeb';
        btnEdit.style.color = '#b45309';
        btnEdit.style.borderColor = '#f59e0b';
    }

    renderPrizeBreakdownView(m);
    openModal('prizeBreakdownModal');
}

function renderPrizeBreakdownView(m) {
    const list = document.getElementById('prizeBreakdownList');
    if (!list) return;

    const pool = parseInt(m.prize_pool, 10) || 0;
    const kill = parseInt(m.per_kill, 10) || 0;

    let winner = 0, second = 0, third = 0;
    if (m.prize_breakdown) {
        winner = parseInt(m.prize_breakdown.winner, 10) || 0;
        second = parseInt(m.prize_breakdown.second, 10) || 0;
        third = parseInt(m.prize_breakdown.third, 10) || 0;
    } else {
        winner = Math.round(pool * 0.5) || pool || 90;
        second = Math.round(pool * 0.3) || Math.round(winner * 0.55);
        third = Math.round(pool * 0.2) || Math.round(winner * 0.25);
    }

    list.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; background: #fefce8; border: 1.5px solid #fef08a; border-radius: 10px; padding: 10px 14px;">
            <span style="font-weight: 800; color: #854d0e; font-size: 0.88rem; display: flex; align-items: center; gap: 6px;">👑 Winner (1st Position)</span>
            <span style="font-family: 'Rajdhani', sans-serif; font-size: 1.15rem; font-weight: 900; color: #b45309;">৳${winner}</span>
        </div>
        ${second > 0 ? `
        <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px;">
            <span style="font-weight: 800; color: #475569; font-size: 0.86rem; display: flex; align-items: center; gap: 6px;">🥈 2nd Position</span>
            <span style="font-family: 'Rajdhani', sans-serif; font-size: 1.05rem; font-weight: 800; color: #1e293b;">৳${second}</span>
        </div>` : ''}
        ${third > 0 ? `
        <div style="display: flex; align-items: center; justify-content: space-between; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px;">
            <span style="font-weight: 800; color: #78350f; font-size: 0.86rem; display: flex; align-items: center; gap: 6px;">🥉 3rd Position</span>
            <span style="font-family: 'Rajdhani', sans-serif; font-size: 1.05rem; font-weight: 800; color: #1e293b;">৳${third}</span>
        </div>` : ''}
        <div style="display: flex; align-items: center; justify-content: space-between; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 10px 14px;">
            <span style="font-weight: 800; color: #1e40af; font-size: 0.86rem; display: flex; align-items: center; gap: 6px;">🎖️ Per Kill Bounty</span>
            <span style="font-family: 'Rajdhani', sans-serif; font-size: 1.05rem; font-weight: 800; color: #1d4ed8;">৳${kill}</span>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; background: #fdf2f8; border: 1px solid #fbcfe8; border-radius: 10px; padding: 10px 14px;">
            <span style="font-weight: 800; color: #9d174d; font-size: 0.86rem; display: flex; align-items: center; gap: 6px;">🪙 Total Prize Pool</span>
            <span style="font-family: 'Rajdhani', sans-serif; font-size: 1.1rem; font-weight: 900; color: #be185d;">৳${pool}</span>
        </div>
    `;
}

function toggleAdminPrizeEdit() {
    if (!currentPrizeModalMatchId) return;
    const m = (allMatches || []).find(x => x.id === currentPrizeModalMatchId);
    if (!m) return;

    const list = document.getElementById('prizeBreakdownList');
    const btnEdit = document.getElementById('btnAdminEditPrize');
    if (!list || !btnEdit) return;

    if (!isPrizeEditMode) {
        // Enter edit mode
        isPrizeEditMode = true;
        btnEdit.innerText = '💾 Save Prize';
        btnEdit.style.background = '#10b981';
        btnEdit.style.color = '#ffffff';
        btnEdit.style.borderColor = '#059669';

        const pool = parseInt(m.prize_pool, 10) || 0;
        const kill = parseInt(m.per_kill, 10) || 0;
        let winner = 0, second = 0, third = 0;
        if (m.prize_breakdown) {
            winner = parseInt(m.prize_breakdown.winner, 10) || 0;
            second = parseInt(m.prize_breakdown.second, 10) || 0;
            third = parseInt(m.prize_breakdown.third, 10) || 0;
        } else {
            winner = Math.round(pool * 0.5) || pool || 90;
            second = Math.round(pool * 0.3) || Math.round(winner * 0.55);
            third = Math.round(pool * 0.2) || Math.round(winner * 0.25);
        }

        list.innerHTML = `
            <div style="background: #f8fafc; border: 1.5px dashed #cbd5e1; border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px;">
                <div style="font-size: 0.78rem; font-weight: 800; color: #0f172a;">🛠️ Edit Prizes for Match #${m.match_code || m.id}</div>
                <div>
                    <label style="font-size: 0.72rem; color: #b45309; font-weight: 800;">👑 1st (Winner) [BDT]</label>
                    <input type="number" id="editPrizeWinner" class="form-input" value="${winner}" style="padding: 6px 10px; font-size: 0.85rem; font-weight: 800;">
                </div>
                <div>
                    <label style="font-size: 0.72rem; color: #475569; font-weight: 700;">🥈 2nd Position [BDT]</label>
                    <input type="number" id="editPrizeSecond" class="form-input" value="${second}" style="padding: 6px 10px; font-size: 0.85rem;">
                </div>
                <div>
                    <label style="font-size: 0.72rem; color: #78350f; font-weight: 700;">🥉 3rd Position [BDT]</label>
                    <input type="number" id="editPrizeThird" class="form-input" value="${third}" style="padding: 6px 10px; font-size: 0.85rem;">
                </div>
                <div>
                    <label style="font-size: 0.72rem; color: #1d4ed8; font-weight: 700;">🎖️ Per Kill Bounty [BDT]</label>
                    <input type="number" id="editPrizePerKill" class="form-input" value="${kill}" style="padding: 6px 10px; font-size: 0.85rem;">
                </div>
                <div>
                    <label style="font-size: 0.72rem; color: #9d174d; font-weight: 800;">🪙 Total Prize Pool [BDT]</label>
                    <input type="number" id="editPrizePool" class="form-input" value="${pool}" style="padding: 6px 10px; font-size: 0.85rem; font-weight: 800;">
                </div>
            </div>
        `;
    } else {
        saveAdminPrizeEdit(m);
    }
}

async function saveAdminPrizeEdit(m) {
    const winner = parseInt(document.getElementById('editPrizeWinner')?.value, 10) || 0;
    const second = parseInt(document.getElementById('editPrizeSecond')?.value, 10) || 0;
    const third = parseInt(document.getElementById('editPrizeThird')?.value, 10) || 0;
    const per_kill = parseInt(document.getElementById('editPrizePerKill')?.value, 10) || 0;
    const prize_pool = parseInt(document.getElementById('editPrizePool')?.value, 10) || 0;

    try {
        const res = await fetchWithAuth(`/api/admin/matches/${m.id}/prize-breakdown`, {
            method: 'PUT',
            body: JSON.stringify({
                winner,
                second,
                third,
                per_kill,
                prize_pool
            })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Prize details updated successfully!', 'success');
            m.prize_breakdown = data.breakdown;
            m.per_kill = per_kill;
            m.prize_pool = prize_pool;
            isPrizeEditMode = false;
            const btnEdit = document.getElementById('btnAdminEditPrize');
            if (btnEdit) {
                btnEdit.innerText = '✏️ Edit Prize';
                btnEdit.style.background = '#fffbeb';
                btnEdit.style.color = '#b45309';
                btnEdit.style.borderColor = '#f59e0b';
            }
            renderPrizeBreakdownView(m);
            renderMatches();
            renderMyMatches();
        } else {
            showToast(data.detail || 'Update failed', 'error');
        }
    } catch (e) {
        showToast('Network error while updating prize', 'error');
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
    if (subEl) subEl.innerText = `Match Code: #${m.match_code || ('MATCH-' + m.id)} • Type: ${m.match_type || 'Solo'} • Time: ${formatMatchTime12Hour(m.match_time)}`;

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
    currentPortalMatchId = m.id;
    currentPortalRoomId = m.room_id || '';
    currentPortalRoomPass = m.room_pass || '';

    const adminActionEl = document.getElementById('portalAdminRoomAction');
    if (adminActionEl) {
        adminActionEl.style.display = isAdminOrMod ? 'flex' : 'none';
    }

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

        const adminTh = document.getElementById('portalAdminActionTh');
        if (adminTh) {
            adminTh.style.display = isAdminOrMod ? 'table-cell' : 'none';
        }

        if (!data.participants || data.participants.length === 0) {
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="${isAdminOrMod ? 4 : 3}" style="text-align: center; padding: 24px; color: #64748b; font-weight: 600;">
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

                    const adminActionTd = isAdminOrMod ? `
                        <td style="padding: 10px 8px; text-align: center; vertical-align: middle; white-space: nowrap;">
                            <div style="display: inline-flex; align-items: center; gap: 6px; justify-content: center;">
                                <button type="button" onclick="adminKickParticipant(${matchId}, ${p.slot_number}, '${escapeHtml(p.player_ign || 'Player')}', ${p.user_id || 0})" 
                                    style="background: #fef2f2; color: #dc2626; border: 1.5px solid #fca5a5; font-size: 0.76rem; font-weight: 800; padding: 4px 9px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;"
                                    onmouseover="this.style.background='#ef4444';this.style.color='#fff';"
                                    onmouseout="this.style.background='#fef2f2';this.style.color='#dc2626';"
                                    title="Kick player and 100% refund entry fee">
                                    👢 Kick
                                </button>
                                <button type="button" onclick="openAdminReplaceModal(${matchId}, ${p.slot_number}, '${escapeHtml(p.player_ign || '')}', '${escapeHtml(p.player_uid || '')}', '${escapeHtml(p.team_name || '')}', '${escapeHtml(p.username || '')}')" 
                                    style="background: #eff6ff; color: #1d4ed8; border: 1.5px solid #93c5fd; font-size: 0.76rem; font-weight: 800; padding: 4px 9px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: all 0.2s;"
                                    onmouseover="this.style.background='#2563eb';this.style.color='#fff';"
                                    onmouseout="this.style.background='#eff6ff';this.style.color='#1d4ed8';"
                                    title="Replace player & keep match full">
                                    🔄 Replace
                                </button>
                            </div>
                        </td>
                    ` : '';

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
                            ${adminActionTd}
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

// -------------------------------------------------------------
// Admin Participant Management (Kick with 100% Refund & Replace)
// -------------------------------------------------------------
async function adminKickParticipant(matchId, slotNumber, playerIgn, userId) {
    if (!confirm(`🚨 আপনি কি নিশ্চিতভাবে #${slotNumber} (${playerIgn}) কে এই ম্যাচ থেকে কিক করতে চান?\n\n• প্লেয়ারের ওয়ালেটে ১০০% এন্ট্রি ফি রিফান্ড হয়ে যাবে।\n• স্লটটি আবার খালি হবে যাতে নতুন প্লেয়ার জয়েন করতে পারে।`)) {
        return;
    }

    try {
        const res = await fetchWithAuth(`/api/admin/matches/${matchId}/participants/${slotNumber}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.detail || 'Failed to kick player', 'error');
            return;
        }

        showToast(data.message || 'Player kicked and entry fee refunded!', 'success');
        playSound('alert');
        loadMatches();
        openMatchInnerPortal(matchId);
    } catch (err) {
        showToast('Network error while kicking player', 'error');
    }
}

function openAdminReplaceModal(matchId, slotNumber, currentIgn, currentUid, currentTeam, currentUsername) {
    document.getElementById('replaceMatchId').value = matchId;
    document.getElementById('replaceSlotNumber').value = slotNumber;
    document.getElementById('replaceModalTitle').innerText = `Replace Player • Slot #${slotNumber}`;
    
    const banner = document.getElementById('replaceCurrentBanner');
    if (banner) {
        banner.innerHTML = `
            <div style="font-weight: 800; margin-bottom: 2px;">Current Player: <b style="color: #0f172a;">${escapeHtml(currentIgn || 'N/A')}</b></div>
            <div>UID: <span style="font-family: monospace; font-weight: 700;">${escapeHtml(currentUid || 'N/A')}</span> ${currentUsername ? `• User: @${escapeHtml(currentUsername)}` : ''}</div>
        `;
    }

    document.getElementById('replaceNewIgn').value = '';
    document.getElementById('replaceNewUid').value = '';
    document.getElementById('replaceNewTeam').value = currentTeam || '';
    document.getElementById('replaceNewUsername').value = '';
    document.getElementById('replaceRefundPrev').checked = true;

    openModal('adminReplacePlayerModal');
}

async function submitAdminReplacePlayer(e) {
    e.preventDefault();
    const matchId = document.getElementById('replaceMatchId').value;
    const slotNumber = document.getElementById('replaceSlotNumber').value;
    const new_player_ign = document.getElementById('replaceNewIgn').value.trim();
    const new_player_uid = document.getElementById('replaceNewUid').value.trim();
    const new_team_name = document.getElementById('replaceNewTeam').value.trim();
    const new_username = document.getElementById('replaceNewUsername').value.trim();
    const refund_previous_player = document.getElementById('replaceRefundPrev').checked;

    if (!new_player_ign) {
        showToast('New player IGN is required', 'warning');
        return;
    }
    if (!new_player_uid || isNaN(new_player_uid) || new_player_uid.length < 6) {
        showToast('Valid 6+ digit Free Fire UID is required', 'warning');
        return;
    }

    const btn = document.getElementById('replaceSubmitBtn');
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Replacing...';
    }

    try {
        const res = await fetchWithAuth(`/api/admin/matches/${matchId}/participants/${slotNumber}/replace`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                new_player_ign,
                new_player_uid,
                new_team_name,
                new_username,
                refund_previous_player
            })
        });
        const data = await res.json();
        if (!res.ok) {
            showToast(data.detail || 'Failed to replace player', 'error');
            return;
        }

        closeModal('adminReplacePlayerModal');
        showToast(data.message || 'Player replaced successfully! Match remains FULL.', 'success');
        playSound('success');
        loadMatches();
        openMatchInnerPortal(parseInt(matchId));
    } catch (err) {
        showToast('Network error while replacing player', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Confirm Replace';
        }
    }
}

function renderMyMatches() {
    const grid = document.getElementById('myMatchesGrid');
    if (!grid) return;

    // In My Matches, show joined matches that are upcoming or ongoing (hide once concluded/cancelled)
    const joinedMatches = (allMatches || []).filter(m => m.has_joined && m.status !== 'completed' && m.status !== 'cancelled');

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
        const isRoomReleased = !!(m.room_id && m.room_id !== 'JOIN TO VIEW' && m.room_id !== 'NOT RELEASED YET' && !m.room_id.includes('দেওয়া হবে') && !m.room_id.includes('মিনিট আগে'));
        const safeRoomId = escapeHtml(m.room_id || '');
        const safeRoomPass = escapeHtml(m.room_pass || '');
        const jsRoomId = String(m.room_id || '').replace(/'/g, "\\'");
        const jsRoomPass = String(m.room_pass || '').replace(/'/g, "\\'");

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
                        <div class="match-time-badge">⏰ ${escapeHtml(formatMatchTime12Hour(m.match_time))}</div>
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

                <div class="match-card-footer" style="display: flex; flex-direction: column; gap: 6px;">
                    ${isRoomReleased ? `
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; background: #ecfdf5; border: 1.5px solid #10b981; border-radius: 8px; padding: 6px 10px; box-shadow: 0 0 10px rgba(16,185,129,0.15);">
                            <span style="font-size: 0.8rem; color: #047857; font-weight: 800; display: inline-flex; align-items: center; gap: 6px;">
                                <span class="room-pulse-green"></span>
                                Room ID Released!
                            </span>
                            <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 900; color: #065f46; background: #dcfce7; padding: 1px 8px; border-radius: 5px; border: 1px solid #86efac;">
                                Slot #${m.my_slot || 1}
                            </span>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button type="button" class="btn btn-neon" style="flex: 2; padding: 8px 10px; font-size: 0.86rem; font-weight: 900; border-radius: 8px; background: linear-gradient(135deg, #059669, #10b981); box-shadow: 0 2px 10px rgba(16, 185, 129, 0.35); display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="openRoomBottomSheet(${m.id})">
                                🔑 Room ID
                            </button>
                            <button type="button" class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 800; border-color: #cbd5e1; color: #334155; border-radius: 8px;" onclick="openMatchInnerPortal(${m.id})" title="View Registered Players">
                                👥 Players
                            </button>
                            <button type="button" class="btn btn-outline" style="padding: 8px 10px; font-size: 0.78rem; font-weight: 800; border-color: #f59e0b; color: #f59e0b; border-radius: 8px;" onclick="openPrizeBreakdownModal(${m.id})" title="View Prize Breakdown">
                                🏆
                            </button>
                        </div>
                    </div>` : `
                    <div style="display: flex; flex-direction: column; gap: 6px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(0, 245, 155, 0.08); border: 1px solid rgba(0, 245, 155, 0.25); border-radius: 8px; padding: 6px 10px;">
                            <span style="font-size: 0.8rem; color: #a7f3d0; font-weight: 700;">🎯 Your Assigned Slot:</span>
                            <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 800; color: #00f59b;">#${m.my_slot || 1} (Fixed)</span>
                        </div>
                        <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 6px 10px; font-size: 0.74rem; color: #92400e; font-weight: 700; display: flex; align-items: center; gap: 6px;">
                            <span>⏳</span>
                            <span>রুম আইডি ও পাসওয়ার্ড খেলা শুরুর ১০-১৫ মিনিট আগে দেওয়া হবে</span>
                        </div>
                        <div style="display: flex; gap: 6px;">
                            <button type="button" class="btn btn-outline" style="flex: 2; padding: 8px 10px; font-size: 0.82rem; font-weight: 800; border-color: #cbd5e1; color: #334155; border-radius: 8px; display: flex; align-items: center; justify-content: center; gap: 6px;" onclick="openMatchInnerPortal(${m.id})">
                                👥 View Players (${m.joined_count})
                            </button>
                            <button type="button" class="btn btn-outline" style="flex: 1; padding: 8px 6px; font-size: 0.78rem; font-weight: 700; border-color: #f59e0b; color: #b45309; background: #fffbeb; border-radius: 8px;" onclick="openPrizeBreakdownModal(${m.id})">
                                🏆 Prize
                            </button>
                        </div>
                    </div>`}
                    <div class="match-countdown-pill" data-match-time="${escapeHtml(m.match_time || '')}" data-match-status="${escapeHtml(m.status || '')}">
                        <span class="countdown-pulse-dot"></span>
                        <span class="countdown-timer-text">⏰ Starts in: calculating...</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    startMatchCountdownTicker();
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
        content = deposits.map(d => {
            let statusBadge = '';
            if (d.status === 'approved') {
                if (d.reviewed_by_name === 'AUTO_BOT') {
                    statusBadge = `<span class="badge-status approved" style="background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">⚡ Auto Approved</span>`;
                } else {
                    statusBadge = `<span class="badge-status approved" style="font-weight: 700;">✅ Approved</span>`;
                }
            } else if (d.status === 'rejected') {
                statusBadge = `<span class="badge-status rejected" style="font-weight: 700;">❌ Rejected</span>`;
            } else {
                statusBadge = `<span class="badge-status pending" style="font-weight: 700;">⏳ Pending</span>`;
            }

            return `
            <tr>
                <td>${d.created_at ? d.created_at.split(' ')[0] : '-'}</td>
                <td style="font-weight: 700; color: var(--neon-amber);">${d.amount} 🪙</td>
                <td style="font-family: monospace; font-weight: 700; color: #0284c7;">${escapeHtml(d.trx_id)}</td>
                <td>${statusBadge}</td>
            </tr>
            `;
        }).join('');
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
            const statPendingChal = document.getElementById('adminStatPendingChallenges');
            if (statPendingChal) statPendingChal.innerText = data.pending_challenges || 0;

            renderPendingDeposits(data.pending_deposits_list);
            renderPendingWithdrawals(data.pending_withdrawals_list);
            loadAdminUsers();
            loadAdminIncomingPayments();
            try { loadAdminTotpStatus(); } catch(e) {}

            // Master Admin Exclusive Net Profit Stats
            if (currentUser && currentUser.role === 'admin') {
                const profitCard = document.getElementById('adminProfitStatCard');
                if (profitCard) profitCard.style.display = 'flex';
                try { loadAdminProfitStat(); } catch(e) {}
            } else {
                const profitCard = document.getElementById('adminProfitStatCard');
                if (profitCard) profitCard.style.display = 'none';
            }
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
        adminUserPassMap.set(Number(u.id), u.plain_password || '');
        const hasPass = u.plain_password && String(u.plain_password).trim().length > 0;
        const passDisplay = hasPass ? `
            <div style="display: inline-flex; align-items: center; gap: 5px;">
                <code id="passText_${u.id}" data-masked="true" style="font-family: monospace; font-size: 0.85rem; font-weight: 700; color: #00f59b; background: rgba(0, 245, 155, 0.08); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(0, 245, 155, 0.25); letter-spacing: 2px;">
                    ••••••••
                </code>
                <button type="button" id="passEyeBtn_${u.id}" class="btn btn-outline btn-xs" title="View Password" onclick="togglePassVisibility(${u.id}); event.stopPropagation();" style="padding: 2px 5px; font-size: 0.72rem;">👁️</button>
                <button type="button" class="btn btn-outline btn-xs" title="Copy" onclick="copyUserPass(${u.id}); event.stopPropagation();" style="padding: 2px 5px; font-size: 0.72rem;">📋</button>
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
        passEl.removeAttribute('data-pass');
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
        const plain = (currentActionUser && currentActionUser.plain_password) || (currentActionUser && adminUserPassMap.get(Number(currentActionUser.id))) || 'No password set';
        el.innerText = plain;
        el.setAttribute('data-masked', 'false');
        btn.innerText = '🙈';
    } else {
        el.innerText = '••••••••';
        el.setAttribute('data-masked', 'true');
        btn.innerText = '👁️';
    }
}

function copyActionModalPass() {
    const plain = (currentActionUser && currentActionUser.plain_password) || (currentActionUser && adminUserPassMap.get(Number(currentActionUser.id)));
    if (plain) {
        navigator.clipboard.writeText(plain);
        showToast(`Password '${plain}' copied to clipboard!`, 'success');
    } else {
        showToast('No password saved', 'info');
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

// ----------------------------------------------------
// ADMIN AUDIT LOGS VIEWER
// ----------------------------------------------------
let currentAuditUserId = null;
let currentAuditTargetName = null;
let auditLogsCache = [];

function viewAuditLogsForCurrentUser() {
    if (!currentActionUser) return;
    openAdminAuditLogsModal(currentActionUser.id, currentActionUser.username);
}

let currentAuditQuickFilter = 'all';
let auditSearchDebounceTimer = null;

const AUDIT_ACTION_MAP = {
    'MATCH_CREATED': { icon: '🎮', label: 'Match Created', cls: 'audit-badge-match-created' },
    'MATCH_AUTO_CANCEL_DELETED': { icon: '🗑️', label: 'Auto Cancelled', cls: 'audit-badge-cancel-deleted' },
    'MATCH_DELETED': { icon: '🗑️', label: 'Match Deleted', cls: 'audit-badge-cancel-deleted' },
    'MATCH_UPDATED': { icon: '✏️', label: 'Match Updated', cls: 'audit-badge-match-created' },
    'MATCH_RESULT_UPDATED': { icon: '🏅', label: 'Result Published', cls: 'audit-badge-prize' },
    'MATCH_CANCEL_REFUND': { icon: '🔄', label: 'Match Refund', cls: 'audit-badge-refund' },
    'PARTICIPANT_KICKED_REFUND': { icon: '🔄', label: 'Slot Refund', cls: 'audit-badge-refund' },
    'MATCH_ENTRY_FEE': { icon: '🎟️', label: 'Entry Fee', cls: 'audit-badge-entry-fee' },
    'MATCH_PRIZE_DISTRIBUTED': { icon: '🏆', label: 'Prize Sent', cls: 'audit-badge-prize' },
    'DEPOSIT_APPROVED': { icon: '💳', label: 'Deposit Approved', cls: 'audit-badge-deposit' },
    'DEPOSIT_AUTO_APPROVED': { icon: '🤖', label: 'Auto Deposit', cls: 'audit-badge-deposit' },
    'WITHDRAW_REQUESTED': { icon: '⏳', label: 'Withdraw Request', cls: 'audit-badge-withdraw' },
    'WITHDRAW_APPROVED': { icon: '💸', label: 'Withdraw Approved', cls: 'audit-badge-withdraw' },
    'WITHDRAW_REJECTED': { icon: '⛔', label: 'Withdraw Rejected', cls: 'audit-badge-cancel-deleted' },
    'ADMIN_ADJUST_DIGITS': { icon: '⚙️', label: 'Balance Adjust', cls: 'audit-badge-adjust' },
    'ADMIN_BAN_USER': { icon: '🚫', label: 'User Banned', cls: 'audit-badge-cancel-deleted' },
    'ADMIN_UNBAN_USER': { icon: '🔓', label: 'User Unbanned', cls: 'audit-badge-refund' },
    'ADMIN_RESET_PASSWORD': { icon: '🔑', label: 'Pass Reset', cls: 'audit-badge-match-created' },
    'ADMIN_DELETE_USER': { icon: '⚠️', label: 'User Deleted', cls: 'audit-badge-cancel-deleted' }
};

function formatAuditActionBadge(actionStr) {
    if (!actionStr) return '<span class="audit-badge audit-badge-generic">System</span>';
    const key = String(actionStr).trim();
    if (AUDIT_ACTION_MAP[key]) {
        const item = AUDIT_ACTION_MAP[key];
        return `<span class="audit-badge ${item.cls}">${item.icon} ${item.label}</span>`;
    }
    if (key.includes('REFUND')) return '<span class="audit-badge audit-badge-refund">🔄 Refund</span>';
    if (key.includes('PRIZE')) return '<span class="audit-badge audit-badge-prize">🏆 Prize</span>';
    if (key.includes('ENTRY_FEE')) return '<span class="audit-badge audit-badge-entry-fee">🎟️ Entry Fee</span>';
    if (key.includes('DEPOSIT')) return '<span class="audit-badge audit-badge-deposit">💳 Deposit</span>';
    if (key.includes('WITHDRAW')) return '<span class="audit-badge audit-badge-withdraw">💸 Withdraw</span>';
    if (key.includes('ADJUST')) return '<span class="audit-badge audit-badge-adjust">⚙️ Adjust</span>';
    if (key.includes('DELETE') || key.includes('CANCEL')) return '<span class="audit-badge audit-badge-cancel-deleted">🗑️ Cancelled</span>';

    const pretty = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    return `<span class="audit-badge audit-badge-generic">${escapeHtml(pretty)}</span>`;
}

function formatAuditTimestamp(timeStr) {
    if (!timeStr || timeStr === '-') return '<span class="audit-time-clock">-</span>';
    const parts = timeStr.trim().split(/[T ]/);
    if (parts.length >= 2) {
        const datePart = parts[0];
        const timePart = parts[1].split('.')[0];
        const dSub = datePart.split('-');
        let formattedDate = datePart;
        if (dSub.length === 3) {
            const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
            const mIdx = parseInt(dSub[1], 10) - 1;
            if (mIdx >= 0 && mIdx < 12) {
                formattedDate = `${parseInt(dSub[2], 10)} ${months[mIdx]}, ${dSub[0]}`;
            }
        }
        return `
            <div class="audit-time-cell">
                <span class="audit-time-date">${escapeHtml(formattedDate)}</span>
                <span class="audit-time-clock">🕒 ${escapeHtml(timePart)} BST</span>
            </div>
        `;
    }
    return `<div class="audit-time-cell"><span class="audit-time-clock">${escapeHtml(timeStr)}</span></div>`;
}

function formatAuditReasonText(reason) {
    if (!reason || reason === '-') return '<span style="color: #94a3b8;">-</span>';
    let safe = escapeHtml(reason);
    safe = safe.replace(/#([A-Za-z0-9\-_]+)/g, '<code class="audit-match-chip">#$1</code>');
    return `<div class="audit-note-cell">${safe}</div>`;
}

function openAdminAuditLogsModal(userId = null, targetName = null) {
    currentAuditUserId = userId;
    currentAuditTargetName = targetName;
    currentAuditQuickFilter = 'all';

    const subtitle = document.getElementById('auditLogsSubtitle');
    if (subtitle) {
        if (userId && targetName) {
            subtitle.innerHTML = `
                <span>Showing balance records for: <b style="color: #6366f1;">@${escapeHtml(targetName)}</b></span>
                <button type="button" class="btn btn-outline btn-xs" onclick="resetAdminAuditFilters(true)" style="padding: 2px 8px; font-size: 0.72rem; border-color: #6366f1; color: #6366f1; margin-left: 6px; border-radius: 4px; cursor: pointer;">Clear Player Filter</button>
            `;
        } else {
            subtitle.innerHTML = `<span>Real-time records of balance transactions, refunds, entry fees, prizes & admin actions.</span>`;
        }
    }

    const searchInput = document.getElementById('adminAuditSearchInput');
    if (searchInput) searchInput.value = '';
    const searchClear = document.getElementById('adminAuditSearchClear');
    if (searchClear) searchClear.style.display = 'none';

    const actionFilter = document.getElementById('adminAuditActionFilter');
    if (actionFilter) actionFilter.value = '';

    updateAuditChipsUI('all');
    openModal('adminAuditLogsModal');
    loadAdminAuditLogs();
}

function updateAuditChipsUI(activeType) {
    currentAuditQuickFilter = activeType;
    const chips = ['all', 'matches', 'finance', 'system'];
    chips.forEach(chip => {
        const el = document.getElementById(`auditChip_${chip}`);
        if (el) {
            if (chip === activeType) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        }
    });
}

function applyAuditQuickFilter(type) {
    updateAuditChipsUI(type);
    const actionFilter = document.getElementById('adminAuditActionFilter');

    if (type === 'all') {
        if (actionFilter) actionFilter.value = '';
        loadAdminAuditLogs();
    } else if (type === 'matches') {
        if (actionFilter) actionFilter.value = 'MATCH_CREATED';
        loadAdminAuditLogs();
    } else if (type === 'finance') {
        if (actionFilter) actionFilter.value = '';
        loadAdminAuditLogs();
    } else if (type === 'system') {
        if (actionFilter) actionFilter.value = 'MATCH_AUTO_CANCEL_DELETED';
        loadAdminAuditLogs();
    }
}

function handleAuditSearchInput(input) {
    const clearBtn = document.getElementById('adminAuditSearchClear');
    if (clearBtn) {
        clearBtn.style.display = input.value.trim() ? 'block' : 'none';
    }
    clearTimeout(auditSearchDebounceTimer);
    auditSearchDebounceTimer = setTimeout(() => {
        loadAdminAuditLogs();
    }, 350);
}

function clearAuditSearch() {
    const searchInput = document.getElementById('adminAuditSearchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('adminAuditSearchClear');
    if (clearBtn) clearBtn.style.display = 'none';
    loadAdminAuditLogs();
}

async function loadAdminAuditLogs() {
    const tbody = document.getElementById('adminAuditLogsTableBody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 35px;"><span class="audit-pulse-dot" style="display:inline-block; margin-right:6px;"></span> Fetching real-time audit records...</td></tr>`;
    }

    const searchInput = document.getElementById('adminAuditSearchInput');
    const actionFilter = document.getElementById('adminAuditActionFilter');

    const search = searchInput ? searchInput.value.trim() : '';
    const action = actionFilter ? actionFilter.value : '';

    const params = new URLSearchParams();
    if (currentAuditUserId) params.append('user_id', currentAuditUserId);
    if (action) params.append('action', action);
    if (search) params.append('search', search);
    params.append('limit', '100');

    try {
        const res = await fetch(`/api/admin/audit-logs?${params.toString()}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            let logs = data.logs || [];

            // Quick client refinement for finance or system if selected
            if (currentAuditQuickFilter === 'finance') {
                logs = logs.filter(l => Number(l.amount) !== 0 || (l.action && (l.action.includes('REFUND') || l.action.includes('DEPOSIT') || l.action.includes('WITHDRAW') || l.action.includes('FEE') || l.action.includes('PRIZE') || l.action.includes('ADJUST'))));
            } else if (currentAuditQuickFilter === 'system' && !action) {
                logs = logs.filter(l => !l.target_username || l.admin_id === null || l.admin_id === 0);
            }

            auditLogsCache = logs;
            renderAdminAuditLogs(auditLogsCache);
        } else {
            if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 24px;">Failed to load audit logs.</td></tr>`;
        }
    } catch (e) {
        console.error(e);
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ef4444; padding: 24px;">Error connecting to server.</td></tr>`;
    }
}

function handleAuditSearchKey(e) {
    if (e.key === 'Enter') {
        clearTimeout(auditSearchDebounceTimer);
        loadAdminAuditLogs();
    }
}

function filterAdminAuditLogs() {
    clearTimeout(auditSearchDebounceTimer);
    loadAdminAuditLogs();
}

function resetAdminAuditFilters(clearUser = false) {
    if (clearUser) {
        currentAuditUserId = null;
        currentAuditTargetName = null;
        const subtitle = document.getElementById('auditLogsSubtitle');
        if (subtitle) {
            subtitle.innerHTML = `<span>Real-time records of balance transactions, refunds, entry fees, prizes & admin actions.</span>`;
        }
    }
    const searchInput = document.getElementById('adminAuditSearchInput');
    if (searchInput) searchInput.value = '';
    const clearBtn = document.getElementById('adminAuditSearchClear');
    if (clearBtn) clearBtn.style.display = 'none';

    const actionFilter = document.getElementById('adminAuditActionFilter');
    if (actionFilter) actionFilter.value = '';

    updateAuditChipsUI('all');
    loadAdminAuditLogs();
}

function renderAdminAuditLogs(logs) {
    const tbody = document.getElementById('adminAuditLogsTableBody');
    const countSummary = document.getElementById('auditLogsCountSummary');
    const scrollContainer = document.getElementById('adminAuditTableScroll');
    if (scrollContainer) {
        scrollContainer.scrollLeft = 0;
        scrollContainer.scrollTop = 0;
    }
    if (!tbody) return;

    if (!logs || logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 36px;">No audit records found matching criteria.</td></tr>`;
        if (countSummary) countSummary.innerText = 'Showing 0 logs';
        return;
    }

    if (countSummary) countSummary.innerText = `Showing ${logs.length} log(s) • Realtime Feed`;

    tbody.innerHTML = logs.map(log => {
        // Amount formatted cleanly
        let amountHtml = '<span class="audit-amt-zero">—</span>';
        const numAmt = Number(log.amount) || 0;
        if (numAmt > 0) {
            amountHtml = `<span class="audit-amt-pos">+৳${numAmt.toLocaleString('en-US')}</span>`;
        } else if (numAmt < 0) {
            amountHtml = `<span class="audit-amt-neg">-৳${Math.abs(numAmt).toLocaleString('en-US')}</span>`;
        }

        // Action Badge
        const actionBadge = formatAuditActionBadge(log.action);

        // Performed by
        let performedBy = '<span class="audit-by-system">⚡ System</span>';
        if (log.admin_id === 0) {
            performedBy = '<span class="audit-by-bot">🤖 AutoBot</span>';
        } else if (log.admin_username) {
            performedBy = `<span class="audit-by-admin">🛡️ @${escapeHtml(log.admin_username)}</span>`;
        }

        // Target user
        let userDisplay = '<span class="audit-system-wide"><span style="color: #6366f1;">🌐</span> System-wide</span>';
        if (log.target_username) {
            userDisplay = `
                <div class="audit-player-cell">
                    <span class="audit-player-user">@${escapeHtml(log.target_username)}</span>
                    ${log.target_player_id ? `<span class="audit-player-uid">ID: ${escapeHtml(log.target_player_id)}</span>` : ''}
                </div>
            `;
        }

        // Formatted timestamp
        const timeHtml = formatAuditTimestamp(log.created_at);

        // Formatted note/reason
        const noteHtml = formatAuditReasonText(log.reason);

        return `
            <tr>
                <td>${timeHtml}</td>
                <td>${userDisplay}</td>
                <td>${actionBadge}</td>
                <td style="text-align: right;">${amountHtml}</td>
                <td>${noteHtml}</td>
                <td>${performedBy}</td>
            </tr>
        `;
    }).join('');
}

// ----------------------------------------------------
// 💰 MASTER ADMIN 30-DAY PROFIT ANALYTICS ENGINE
// ----------------------------------------------------
let currentProfitSelectedDate = null;
let currentProfitActiveTab = 'breakdown';

async function loadAdminProfitStat() {
    if (!currentUser || currentUser.role !== 'admin') return;
    try {
        const res = await fetch('/api/admin/profit-analytics', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            const statProfit = document.getElementById('adminStatTodayProfit');
            if (statProfit && data.summary) {
                const net = Number(data.summary.net_profit) || 0;
                if (net > 0) {
                    statProfit.innerText = `+৳${net.toLocaleString('en-US')}`;
                    statProfit.style.color = '#10b981';
                } else if (net < 0) {
                    statProfit.innerText = `-৳${Math.abs(net).toLocaleString('en-US')}`;
                    statProfit.style.color = '#ef4444';
                } else {
                    statProfit.innerText = `৳0`;
                    statProfit.style.color = '#10b981';
                }
            }
        }
    } catch (e) {
        console.error('Error loading admin profit stat:', e);
    }
}

async function openAdminProfitModal(selectedDate = null) {
    if (!currentUser || currentUser.role !== 'admin') return;
    
    openModal('adminProfitModal');
    switchProfitTab('breakdown');

    // Default to today in local client if none passed
    if (!selectedDate) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        selectedDate = `${year}-${month}-${day}`;
    }

    currentProfitSelectedDate = selectedDate;
    const datePicker = document.getElementById('adminProfitDatePicker');
    if (datePicker) datePicker.value = selectedDate;

    updateProfitChipStates(selectedDate);
    await fetchAndRenderProfitData(selectedDate);
}

function updateProfitChipStates(selectedDate) {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    const yestStr = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`;

    const chipToday = document.getElementById('profitChipToday');
    const chipYest = document.getElementById('profitChipYesterday');

    if (chipToday) {
        if (selectedDate === todayStr) chipToday.classList.add('active');
        else chipToday.classList.remove('active');
    }
    if (chipYest) {
        if (selectedDate === yestStr) chipYest.classList.add('active');
        else chipYest.classList.remove('active');
    }
}

function handleProfitDateChange(val) {
    if (!val) return;
    currentProfitSelectedDate = val;
    updateProfitChipStates(val);
    fetchAndRenderProfitData(val);
}

function setProfitQuickDate(type) {
    const now = new Date();
    if (type === 'yesterday') {
        now.setDate(now.getDate() - 1);
    }
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    
    currentProfitSelectedDate = dateStr;
    const datePicker = document.getElementById('adminProfitDatePicker');
    if (datePicker) datePicker.value = dateStr;

    updateProfitChipStates(dateStr);
    fetchAndRenderProfitData(dateStr);
}

function switchProfitTab(tabName) {
    currentProfitActiveTab = tabName;
    const tabBreakdown = document.getElementById('profitTabBreakdown');
    const tabHistory = document.getElementById('profitTabHistory');
    const btnBreakdown = document.getElementById('profitTabBtnBreakdown');
    const btnHistory = document.getElementById('profitTabBtnHistory');

    if (tabName === 'breakdown') {
        if (tabBreakdown) tabBreakdown.style.display = 'block';
        if (tabHistory) tabHistory.style.display = 'none';
        if (btnBreakdown) btnBreakdown.classList.add('active');
        if (btnHistory) btnHistory.classList.remove('active');
    } else {
        if (tabBreakdown) tabBreakdown.style.display = 'none';
        if (tabHistory) tabHistory.style.display = 'block';
        if (btnBreakdown) btnBreakdown.classList.remove('active');
        if (btnHistory) btnHistory.classList.add('active');
    }
}

function refreshAdminProfitData() {
    if (currentProfitSelectedDate) {
        fetchAndRenderProfitData(currentProfitSelectedDate);
    }
}

async function fetchAndRenderProfitData(dateStr) {
    const breakdownBody = document.getElementById('profitMatchBreakdownBody');
    if (breakdownBody) {
        breakdownBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: var(--text-muted);"><span class="audit-pulse-dot" style="display:inline-block; margin-right:6px;"></span> Calculating live financial profit...</td></tr>`;
    }

    try {
        const res = await fetch(`/api/admin/profit-analytics?date=${dateStr}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            renderAdminProfitModalData(data);
        } else {
            if (breakdownBody) breakdownBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: #ef4444;">Failed to load profit analytics.</td></tr>`;
        }
    } catch (e) {
        console.error('Error fetching profit analytics:', e);
        if (breakdownBody) breakdownBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 24px; color: #ef4444;">Server connection error.</td></tr>`;
    }
}

function renderAdminProfitModalData(data) {
    const summary = data.summary || {};
    const breakdown = data.breakdown || [];
    const history = data.monthly_history || [];

    // KPI: Net Pure Profit
    const kpiNet = document.getElementById('kpiNetProfit');
    const net = Number(summary.net_profit) || 0;
    if (kpiNet) {
        if (net > 0) {
            kpiNet.innerText = `+৳${net.toLocaleString('en-US')}`;
            kpiNet.style.color = '#059669';
        } else if (net < 0) {
            kpiNet.innerText = `-৳${Math.abs(net).toLocaleString('en-US')}`;
            kpiNet.style.color = '#dc2626';
        } else {
            kpiNet.innerText = `৳0`;
            kpiNet.style.color = '#10b981';
        }
    }

    // KPI: Target Date label
    const dateLabel = document.getElementById('kpiTargetDateLabel');
    if (dateLabel) {
        dateLabel.innerText = data.is_today ? `Today (${data.target_date})` : data.target_date;
    }

    // KPI: Entry Fees
    const kpiEntry = document.getElementById('kpiEntryFees');
    if (kpiEntry) kpiEntry.innerText = `৳${(Number(summary.tournament_entry_fees) || 0).toLocaleString('en-US')}`;

    // KPI: Prizes Given
    const kpiPrizes = document.getElementById('kpiPrizesGiven');
    if (kpiPrizes) kpiPrizes.innerText = `৳${(Number(summary.tournament_prizes) || 0).toLocaleString('en-US')}`;

    // KPI: Completed Matches
    const kpiMatches = document.getElementById('kpiCompletedMatches');
    if (kpiMatches) kpiMatches.innerText = `${summary.total_completed_events || 0}`;

    // KPI: 30-Day Cumulative Total
    const kpiMonthly = document.getElementById('kpiMonthlyTotal');
    const cum = Number(summary.cumulative_30d_profit) || 0;
    if (kpiMonthly) {
        kpiMonthly.innerText = cum >= 0 ? `+৳${cum.toLocaleString('en-US')}` : `-৳${Math.abs(cum).toLocaleString('en-US')}`;
    }

    // Badges
    const badgeCount = document.getElementById('profitMatchCountBadge');
    if (badgeCount) badgeCount.innerText = `${breakdown.length}`;
    const badgeHistory = document.getElementById('profitHistoryDaysBadge');
    if (badgeHistory) badgeHistory.innerText = `${history.length}`;

    // 1. Render Daily Match Breakdown Table
    const breakdownBody = document.getElementById('profitMatchBreakdownBody');
    if (breakdownBody) {
        if (breakdown.length === 0) {
            breakdownBody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 28px; color: var(--text-muted);">No completed matches or challenges found for <b>${escapeHtml(data.target_date)}</b>.</td></tr>`;
        } else {
            breakdownBody.innerHTML = breakdown.map(item => {
                const profitNum = Number(item.profit) || 0;
                let profitBadge = `<b style="color: #94a3b8;">৳0</b>`;
                if (profitNum > 0) {
                    profitBadge = `<b style="color: #059669; font-size: 0.85rem;">+৳${profitNum.toLocaleString('en-US')}</b>`;
                } else if (profitNum < 0) {
                    profitBadge = `<b style="color: #dc2626; font-size: 0.85rem;">-৳${Math.abs(profitNum).toLocaleString('en-US')}</b>`;
                }

                const compTime = item.completed_at ? item.completed_at.split(' ')[1] || item.completed_at : '-';

                return `
                    <tr>
                        <td><code class="audit-match-chip">${escapeHtml(item.code)}</code></td>
                        <td>
                            <b>${escapeHtml(item.title)}</b>
                            <div style="font-size: 0.7rem; color: var(--text-muted);">${escapeHtml(item.match_type || '')}</div>
                        </td>
                        <td style="font-family: monospace; font-size: 0.72rem; color: var(--text-muted);">🕒 ${escapeHtml(compTime)}</td>
                        <td style="text-align: center;"><span style="font-weight: 700; color: #6366f1;">${item.joined_players}</span></td>
                        <td style="text-align: right; color: var(--text-muted);">৳${Number(item.entry_fee || 0).toLocaleString('en-US')}</td>
                        <td style="text-align: right; font-weight: 700;">৳${Number(item.collected || 0).toLocaleString('en-US')}</td>
                        <td style="text-align: right; color: #dc2626;">৳${Number(item.prizes || 0).toLocaleString('en-US')}</td>
                        <td style="text-align: right;">${profitBadge}</td>
                    </tr>
                `;
            }).join('');
        }
    }

    // 2. Render 30-Day Monthly History Table
    const historyBody = document.getElementById('profitMonthlyHistoryBody');
    if (historyBody) {
        if (history.length === 0) {
            historyBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 28px; color: var(--text-muted);">No 30-day profit records archived yet. Records will log daily.</td></tr>`;
        } else {
            historyBody.innerHTML = history.map(h => {
                const netDay = Number(h.net_profit) || 0;
                let netBadge = `<b style="color: #94a3b8;">৳0</b>`;
                if (netDay > 0) {
                    netBadge = `<span style="color: #059669; font-weight: 800; font-size: 0.88rem;">+৳${netDay.toLocaleString('en-US')}</span>`;
                } else if (netDay < 0) {
                    netBadge = `<span style="color: #dc2626; font-weight: 800; font-size: 0.88rem;">-৳${Math.abs(netDay).toLocaleString('en-US')}</span>`;
                }

                const totalMatches = (Number(h.tournament_matches) || 0) + (Number(h.challenge_matches) || 0);
                const isSelected = (h.profit_date === data.target_date);

                return `
                    <tr style="${isSelected ? 'background: rgba(16, 185, 129, 0.08); font-weight: 700;' : ''}">
                        <td>
                            <b>${escapeHtml(h.profit_date)}</b>
                            ${h.profit_date === data.target_date ? '<span style="font-size:0.65rem; background:#10b981; color:#fff; padding:1px 5px; border-radius:3px; margin-left:4px;">ACTIVE</span>' : ''}
                        </td>
                        <td style="text-align: center;">${totalMatches}</td>
                        <td style="text-align: right;">৳${Number(h.tournament_entry_fees || 0).toLocaleString('en-US')}</td>
                        <td style="text-align: right; color: #dc2626;">৳${Number(h.tournament_prizes || 0).toLocaleString('en-US')}</td>
                        <td style="text-align: right;">${netBadge}</td>
                        <td style="text-align: center;">
                            <button type="button" class="btn btn-outline btn-xs" onclick="openAdminProfitModal('${h.profit_date}')" style="padding: 2px 8px; font-size: 0.7rem; border-color: #10b981; color: #059669; cursor: pointer;">
                                👁️ View Day
                            </button>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    }
}

function togglePassVisibility(userId) {
    const el = document.getElementById(`passText_${userId}`);
    const btn = document.getElementById(`passEyeBtn_${userId}`);
    if (!el || !btn) return;
    const isMasked = el.getAttribute('data-masked') === 'true';
    if (isMasked) {
        const plain = adminUserPassMap.get(Number(userId)) || 'No password';
        el.innerText = plain;
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

function copyUserPass(target) {
    let pass = target;
    if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target))) {
        pass = adminUserPassMap.get(Number(target));
    }
    if (pass) {
        navigator.clipboard.writeText(pass);
        showToast(`Password '${pass}' copied to clipboard!`, 'success');
    } else {
        showToast('No password saved', 'info');
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

    // Only show active, upcoming, live, and reg_closed matches here.
    // Concluded matches are exclusively managed in 'Match History' (📜 Match History).
    const activeAdminMatches = (allMatches || []).filter(m => m.status !== 'completed');

    if (activeAdminMatches.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; padding: 32px 16px; color: var(--text-muted); font-size: 0.88rem;">
            🎮 বর্তমানে কোনো আসন্ন বা চলমান (Upcoming/Live) টুর্নামেন্ট ম্যাচ নেই।<br>
            <span style="font-size: 0.78rem; color: #64748b; margin-top: 4px; display: inline-block;">সকল সম্পন্ন ম্যাচের সম্পূর্ণ বিবরণ ও রেকর্ড দেখতে বামপাশের মেনু থেকে <b>📜 Match History</b> দেখুন।</span>
        </td></tr>`;
        return;
    }

    tbody.innerHTML = activeAdminMatches.map(m => {
        const isCompleted = (m.status === 'completed');
        const targetTime = parseMatchTimestamp(m.match_time);
        const isStarted = !isCompleted && targetTime && (targetTime <= Date.now());
        const fmt = getMatchFormatInfo(m);
        const catName = getMatchCategoryDisplay(m.match_type);
        const updaterInfo = m.room_updated_by_name ? `
            <span style="font-size: 0.72rem; white-space: nowrap; color: #0284c7;" title="${m.completed_by_name ? 'Finished by: ' + escapeHtml(m.completed_by_name) : ''}">
                🛡️ <b>${escapeHtml(m.room_updated_by_name)}</b> <span style="font-size: 0.65rem; color: #64748b;">(${m.room_updated_at ? m.room_updated_at.substring(5, 16) : ''})</span>
            </span>
        ` : `<span style="font-size: 0.72rem; color: #94a3b8; white-space: nowrap;">Not updated</span>`;

        let statusBadge = '';
        if (isCompleted) {
            statusBadge = '<span class="badge-status approved" style="margin-left: 2px; font-size: 0.62rem; padding: 1px 5px; white-space: nowrap;">Finished</span>';
        } else if (isStarted) {
            statusBadge = '<span style="background: #fee2e2; color: #dc2626; border: 1px solid #f87171; border-radius: 4px; font-size: 0.62rem; font-weight: 800; padding: 1px 5px; margin-left: 2px; display: inline-flex; align-items: center; gap: 2px; white-space: nowrap;">🔴 Started</span>';
        } else if (m.status === 'reg_closed') {
            statusBadge = '<span style="background: #fef3c7; color: #b45309; border: 1px solid #fcd34d; border-radius: 4px; font-size: 0.62rem; font-weight: 800; padding: 1px 5px; margin-left: 2px; white-space: nowrap;">🔒 Closed</span>';
        } else {
            statusBadge = '<span style="background: #ecfdf5; color: #047857; border: 1px solid #6ee7b7; border-radius: 4px; font-size: 0.62rem; font-weight: 800; padding: 1px 5px; margin-left: 2px; white-space: nowrap;">⏳ Upcoming</span>';
        }

        return `
        <tr>
            <td style="white-space: nowrap;">
                <div style="display: flex; align-items: center; gap: 4px; white-space: nowrap;">
                    <span class="match-code-badge" style="font-size: 0.68rem; padding: 1px 5px; font-weight: 700;">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                    <b style="font-size: 0.8rem; color: #0f172a; white-space: nowrap;">${escapeHtml(m.title)}</b>
                    ${statusBadge}
                </div>
            </td>
            <td style="white-space: nowrap;">
                <div style="display: flex; align-items: center; gap: 4px; white-space: nowrap; font-size: 0.76rem;">
                    <span>${escapeHtml(catName)} (${escapeHtml(m.map_name || 'Bermuda')})</span>
                    <span class="match-format-monitor ${fmt.cssClass}" style="display: inline-flex; align-items: center; gap: 3px; font-size: 0.62rem; font-weight: 800; padding: 1px 5px; border-radius: 999px; letter-spacing: 0.3px; text-transform: uppercase; font-family: 'Rajdhani', sans-serif; margin-left: 2px; ${fmt.inlineStyle}">${fmt.icon} ${fmt.label}</span>
                </div>
            </td>
            <td style="font-size: 0.76rem; font-weight: 700; color: #1e293b; white-space: nowrap;">${formatMatchTime12Hour(m.match_time)}</td>
            <td style="white-space: nowrap; font-size: 0.76rem; font-weight: 600;">${m.entry_fee} 🪙 / ৳${m.prize_pool}</td>
            <td style="white-space: nowrap; font-size: 0.76rem; font-weight: 700; text-align: center;">${m.joined_count} / ${m.total_slots}</td>
            <td style="white-space: nowrap;">
                <div style="font-family: monospace; font-size: 0.72rem; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px;">
                    <span>ID: <b style="color: #059669;">${escapeHtml(m.room_id || 'Not set')}</b></span>
                    <span style="color: #cbd5e1;">|</span>
                    <span>Pass: <b style="color: #0284c7;">${escapeHtml(m.room_pass || 'Not set')}</b></span>
                </div>
            </td>
            <td style="white-space: nowrap;">${updaterInfo}</td>
            <td style="white-space: nowrap; text-align: center;">
                <div style="display: inline-flex; align-items: center; gap: 5px; flex-wrap: nowrap; justify-content: center;">
                    <button type="button" onclick="openMatchInnerPortal(${m.id})" 
                        style="background: #ecfdf5; color: #047857; border: 1.2px solid #6ee7b7; font-weight: 700; font-size: 0.72rem; padding: 4px 8px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); transition: all 0.2s ease; white-space: nowrap;"
                        onmouseover="this.style.background='#10b981';this.style.color='#ffffff';this.style.borderColor='#10b981';"
                        onmouseout="this.style.background='#ecfdf5';this.style.color='#047857';this.style.borderColor='#6ee7b7';"
                        title="View Registered Players & UIDs">
                        <span>👥</span> Players (${m.joined_count})
                    </button>
                    <button type="button" onclick="openSetRoomModal(${m.id}, '${escapeHtml(m.room_id || '')}', '${escapeHtml(m.room_pass || '')}')"
                        style="background: linear-gradient(135deg, #059669, #10b981); color: #ffffff; border: 1px solid #047857; font-weight: 700; font-size: 0.72rem; padding: 4px 8px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 3px rgba(5,150,105,0.2); transition: all 0.2s ease; white-space: nowrap;"
                        onmouseover="this.style.filter='brightness(1.1)';"
                        onmouseout="this.style.filter='none';"
                        title="Set / Update Room ID & Password">
                        <span>🔑</span> Room ID
                    </button>

                    ${!isCompleted ? `
                        <button type="button" onclick="completeMatch(${m.id}, '${escapeHtml(m.title)}')"
                            style="${isStarted ? 'background: linear-gradient(135deg, #ea580c, #f97316); color: #ffffff; border: 1px solid #c2410c;' : 'background: #fffbeb; color: #b45309; border: 1px solid #fcd34d;'} font-weight: 700; font-size: 0.72rem; padding: 4px 8px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); transition: all 0.2s ease; white-space: nowrap;"
                            onmouseover="this.style.filter='brightness(1.1)';"
                            onmouseout="this.style.filter='none';"
                            title="Finish Tournament & Distribute Prizes">
                            <span>🏁</span> ${isStarted ? 'Result' : 'Finish'}
                        </button>
                    ` : ''}
                    ${isAdmin ? `
                        <button type="button" onclick="deleteMatch(${m.id})"
                            style="background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5; font-weight: 700; font-size: 0.75rem; width: 26px; height: 26px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; box-shadow: 0 1px 2px rgba(0,0,0,0.04); transition: all 0.2s ease; flex-shrink: 0;"
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
            if (currentPortalMatchId == matchId) {
                currentPortalRoomId = room_id;
                currentPortalRoomPass = room_pass;
                const rIdEl = document.getElementById('portalModalRoomId');
                const rPassEl = document.getElementById('portalModalRoomPass');
                if (rIdEl) rIdEl.innerText = room_id || 'Not set yet (Set in Admin Panel)';
                if (rPassEl) rPassEl.innerText = room_pass || 'Not set yet (Set in Admin Panel)';
            }
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

function toggleBulkScheduleMode() {
    const toggle = document.getElementById('bulkScheduleToggle');
    if (!toggle) return;
    toggle.checked = !toggle.checked;
    handleBulkScheduleToggleChange(toggle.checked);
}
window.toggleBulkScheduleMode = toggleBulkScheduleMode;

function handleBulkScheduleToggleChange(isChecked) {
    const fields = document.getElementById('bulkScheduleFields');
    const badge = document.getElementById('bulkBadge');
    if (fields) {
        fields.style.display = isChecked ? 'block' : 'none';
    }
    if (badge) {
        badge.textContent = isChecked ? 'সক্রিয়' : 'ঐচ্ছিক';
        badge.style.background = isChecked ? '#dcfce7' : '#f1f5f9';
        badge.style.color = isChecked ? '#15803d' : '#475569';
        badge.style.border = isChecked ? '1px solid #86efac' : '1px solid #cbd5e1';
    }
    updateBulkPreview();
}
window.handleBulkScheduleToggleChange = handleBulkScheduleToggleChange;

function updateBulkPreview() {
    const preview = document.getElementById('bulkSchedulePreview');
    const countInput = document.getElementById('bulkMatchCount');
    const intervalInput = document.getElementById('bulkMatchInterval');
    const timeInput = document.getElementById('matchTime');
    if (!preview || !countInput || !intervalInput) return;

    preview.style.color = '#065f46';
    preview.style.background = '#ecfdf5';
    preview.style.border = '1px solid #a7f3d0';

    const count = Math.max(1, Math.min(parseInt(countInput.value, 10) || 1, 50));
    const interval = Math.max(5, Math.min(parseInt(intervalInput.value, 10) || 30, 1440));
    const rawTime = timeInput ? timeInput.value : '';

    if (rawTime) {
        const startDt = new Date(rawTime);
        if (!isNaN(startDt.getTime())) {
            const endDt = new Date(startDt.getTime() + (count - 1) * interval * 60000);
            const formatTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            preview.innerHTML = `💡 ১ম ম্যাচ: <b>${formatTime(startDt)}</b> | শেষ ম্যাচ (#${count}): <b>${formatTime(endDt)}</b> (প্রতি ${interval} মিনিট ব্যবধানে, মোট ${count}টি ম্যাচ)`;
            return;
        }
    }
    preview.innerHTML = `💡 প্রথম ম্যাচ নির্ধারিত সময়ে শুরু হবে, পরবর্তী ম্যাচগুলো প্রতি ${interval} মিনিট পর পর শিডিউল হবে (মোট ${count}টি ম্যাচ)।`;
}
window.updateBulkPreview = updateBulkPreview;

async function handleCreateMatchSubmit(e) {
    e.preventDefault();
    const title = document.getElementById('matchTitle').value.trim();
    const match_type = document.getElementById('matchType').value;
    const map_name = document.getElementById('matchMap').value;
    const match_time = document.getElementById('matchTime').value.replace('T', ' ');
    const total_slots = parseInt(document.getElementById('matchSlots').value, 10);
    const entry_fee = parseInt(document.getElementById('matchEntryFee').value, 10);
    const prize_pool = parseInt(document.getElementById('matchPrizePool').value, 10);
    const per_kill = parseInt(document.getElementById('matchPerKill').value, 10);

    const winner_prize = parseInt(document.getElementById('matchPrizeWinner')?.value, 10) || 0;
    const second_prize = parseInt(document.getElementById('matchPrizeSecond')?.value, 10) || 0;
    const third_prize = parseInt(document.getElementById('matchPrizeThird')?.value, 10) || 0;

    const isBulk = document.getElementById('bulkScheduleToggle')?.checked || false;
    let match_count = 1;
    let interval_minutes = 30;
    if (isBulk) {
        match_count = Math.max(1, Math.min(parseInt(document.getElementById('bulkMatchCount')?.value, 10) || 1, 50));
        interval_minutes = Math.max(5, Math.min(parseInt(document.getElementById('bulkMatchInterval')?.value, 10) || 30, 1440));
    }

    const submitBtn = document.getElementById('publishMatchSubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = isBulk ? `Scheduling ${match_count} Matches...` : 'Publishing Match...';
    }

    try {
        const res = await fetch('/api/admin/matches', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                title,
                match_type,
                map_name,
                match_time,
                total_slots,
                entry_fee,
                prize_pool,
                per_kill,
                winner_prize,
                second_prize,
                third_prize,
                match_count,
                interval_minutes
            })
        });
        if (res.ok) {
            const data = await res.json();
            closeModal('createMatchModal');
            document.getElementById('createMatchForm').reset();
            const bulkFields = document.getElementById('bulkScheduleFields');
            if (bulkFields) bulkFields.style.display = 'none';
            const toggle = document.getElementById('bulkScheduleToggle');
            if (toggle) toggle.checked = false;
            const badge = document.getElementById('bulkBadge');
            if (badge) {
                badge.textContent = 'ঐচ্ছিক';
                badge.style.background = '#f1f5f9';
                badge.style.color = '#475569';
                badge.style.border = '1px solid #cbd5e1';
            }
            showToast(data.message || (isBulk ? `${match_count}টি ম্যাচ সফলভাবে শিডিউল হয়েছে!` : 'New tournament match created successfully!'), 'success');
            loadMatches();
            loadAdminOverview();
        } else {
            const err = await res.json();
            showToast(err.detail || 'Match creation failed', 'error');
        }
    } catch (e) {
        showToast('Operation failed', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Publish Match';
        }
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
    if (!confirm(`Are you sure "${title}" has completed and you want to mark it finished?`)) return;
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
            showToast(`Match "${title}" finished successfully!`, 'success');
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
    const notice_en = (document.getElementById('settingNoticeEn') ? document.getElementById('settingNoticeEn').value : '').trim();

    if (admin_bkash.includes('লগইন') || admin_bkash.includes('লোড')) {
        showToast('অনুগ্রহ করে সঠিক বিকাশ ডিপোজিট নাম্বার টাইপ করুন', 'warning');
        return;
    }
    if (admin_withdraw_number.includes('লগইন') || admin_withdraw_number.includes('লোড')) {
        showToast('অনুগ্রহ করে সঠিক উইথড্র নাম্বার টাইপ করুন', 'warning');
        return;
    }

    try {
        const res = await fetchWithAuth('/api/admin/settings', {
            method: 'POST',
            body: JSON.stringify({ admin_bkash, admin_withdraw_number, site_title, notice, notice_en })
        });
        if (res.ok) {
            showToast('সব সেটিংস সফলভাবে সেভ হয়েছে!', 'success');
            await loadPublicInfo();
        } else {
            let errText = 'সেটিংস সেভ করতে সমস্যা হয়েছে';
            try { const errData = await res.json(); if (errData && errData.detail) errText = errData.detail; } catch(_) {}
            showToast(errText, 'error');
        }
    } catch (e) {
        showToast('Operation failed: ' + (e.message || ''), 'error');
    }
}

async function quickUpdateDepositNumber() {
    const el = document.getElementById('settingAdminBkash');
    const admin_bkash = el ? el.value.trim() : '';
    if (!admin_bkash || admin_bkash.includes('লগইন') || admin_bkash.includes('লোড')) {
        showToast('অনুগ্রহ করে সঠিক ডিপোজিট বিকাশ নাম্বার প্রদান করুন', 'warning');
        return;
    }
    try {
        const res = await fetchWithAuth('/api/admin/settings', {
            method: 'POST',
            body: JSON.stringify({ admin_bkash })
        });
        if (res.ok) {
            showToast(`ডিপোজিট নাম্বার আপডেট হয়েছে: ${admin_bkash}`, 'success');
            await loadPublicInfo();
        } else {
            let errText = 'ডিপোজিট নাম্বার আপডেট ব্যর্থ হয়েছে';
            try { const errData = await res.json(); if (errData && errData.detail) errText = errData.detail; } catch(_) {}
            showToast(errText, 'error');
        }
    } catch (e) {
        showToast('সার্ভারে সমস্যা হয়েছে: ' + (e.message || ''), 'error');
    }
}

async function quickUpdateWithdrawNumber() {
    const el = document.getElementById('settingAdminWithdraw');
    const admin_withdraw_number = el ? el.value.trim() : '';
    if (!admin_withdraw_number || admin_withdraw_number.includes('লগইন') || admin_withdraw_number.includes('লোড')) {
        showToast('অনুগ্রহ করে সঠিক উইথড্র নাম্বার প্রদান করুন', 'warning');
        return;
    }
    try {
        const res = await fetchWithAuth('/api/admin/settings', {
            method: 'POST',
            body: JSON.stringify({ admin_withdraw_number })
        });
        if (res.ok) {
            showToast(`উইথড্র নাম্বার আপডেট হয়েছে: ${admin_withdraw_number}`, 'success');
            await loadPublicInfo();
        } else {
            let errText = 'উইথড্র নাম্বার আপডেট ব্যর্থ হয়েছে';
            try { const errData = await res.json(); if (errData && errData.detail) errText = errData.detail; } catch(_) {}
            showToast(errText, 'error');
        }
    } catch (e) {
        showToast('সার্ভারে সমস্যা হয়েছে: ' + (e.message || ''), 'error');
    }
}

async function quickUpdateNotice() {
    const elNotice = document.getElementById('settingNotice');
    const elNoticeEn = document.getElementById('settingNoticeEn');
    const notice = elNotice ? elNotice.value.trim() : '';
    const notice_en = elNoticeEn ? elNoticeEn.value.trim() : '';
    if (!notice) {
        showToast('ব্যানার নোটিশ টেক্সট লিখুন', 'warning');
        return;
    }
    try {
        const res = await fetchWithAuth('/api/admin/settings', {
            method: 'POST',
            body: JSON.stringify({ notice, notice_en })
        });
        if (res.ok) {
            showToast('ব্যানার নোটিশ সফলভাবে আপডেট হয়েছে! 🎉', 'success');
            await loadPublicInfo();
        } else {
            let errText = 'নোটিশ আপডেট ব্যর্থ হয়েছে';
            try { const errData = await res.json(); if (errData && errData.detail) errText = errData.detail; } catch(_) {}
            showToast(errText, 'error');
        }
    } catch (e) {
        showToast('সার্ভারে সমস্যা হয়েছে: ' + (e.message || ''), 'error');
    }
}

async function handleAdminChangePassword(e) {
    if (e) e.preventDefault();
    const currPass = (document.getElementById('adminCurrentPassword') ? document.getElementById('adminCurrentPassword').value : '').trim();
    const newUsername = (document.getElementById('adminNewUsername') ? document.getElementById('adminNewUsername').value : '').trim();
    const newPass = (document.getElementById('adminNewPassword') ? document.getElementById('adminNewPassword').value : '').trim();
    const confPass = (document.getElementById('adminConfirmPassword') ? document.getElementById('adminConfirmPassword').value : '').trim();
    const newPin = (document.getElementById('adminNewPin') ? document.getElementById('adminNewPin').value : '').trim();

    if (!newUsername && !newPass && !newPin) {
        showToast('পরিবর্তনের জন্য অন্তত নতুন ইউজারনেম, পাসওয়ার্ড বা ৬ ডিজিটের পিন দিন', 'warning');
        return;
    }

    if (newPass && newPass.length < 4) {
        showToast('নতুন পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে', 'warning');
        return;
    }
    if (newPass && confPass && newPass !== confPass) {
        showToast('নতুন পাসওয়ার্ড এবং কনফার্ম পাসওয়ার্ড মিলছে না!', 'error');
        return;
    }

    if (newPin && newPin.length !== 6) {
        showToast('সিকিউরিটি পিন অবশ্যই ৬ ডিজিটের হতে হবে!', 'warning');
        return;
    }

    const btn = document.getElementById('btnAdminChangePass');
    if (btn) btn.disabled = true;

    try {
        const res = await apiRequest('/api/admin/change-password', 'POST', {
            current_password: currPass,
            new_username: newUsername || undefined,
            new_password: newPass || undefined,
            confirm_password: confPass || undefined,
            new_admin_pin: newPin || undefined
        });

        if (res && res.success) {
            showToast(res.message || 'এডমিন সিকিউরিটি সফলভাবে আপডেট হয়েছে!', 'success');
            if (res.new_username && currentUser) {
                currentUser.username = res.new_username;
                localStorage.setItem('ff_user', JSON.stringify(currentUser));
                const badge = document.getElementById('adminMasterIdBadge');
                if (badge) badge.innerText = `Master ID: @${res.new_username}`;
            }
            if (res.token) {
                token = res.token;
                localStorage.setItem('token', res.token);
                localStorage.setItem('ff_token', res.token);
            }
            const form = document.getElementById('adminChangePasswordForm');
            if (form) form.reset();
        } else {
            showToast((res && (res.detail || res.message)) || 'সিকিউরিটি আপডেট ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        console.error('Admin password change error', e);
        showToast(e.message || 'সিকিউরিটি আপডেট করতে সমস্যা হয়েছে', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// -------------------------------------------------------------
// Google Authenticator (TOTP 2FA) Engine
// -------------------------------------------------------------
let currentPendingTotpSecret = '';

async function loadAdminTotpStatus() {
    if (!token || !currentUser || currentUser.role !== 'admin') return;
    try {
        const res = await apiRequest('/api/admin/totp/status', 'GET');
        const badge = document.getElementById('adminTotpStatusBadge');
        const btn = document.getElementById('btnAdminTotpAction');
        if (!badge || !btn) return;

        if (res && res.enabled) {
            badge.className = 'pro-chip pro-chip-claimed';
            badge.innerHTML = '<span class="pro-chip-dot"></span>ACTIVE';
            badge.style.background = 'rgba(16, 185, 129, 0.12)';
            badge.style.color = '#34d399';
            btn.className = 'btn btn-secondary btn-sm';
            btn.innerText = '❌ নিষ্ক্রিয় করুন';
            btn.onclick = promptDisableAdminTotp;
        } else {
            badge.className = 'pro-chip';
            badge.innerText = 'NOT SET';
            badge.style.background = 'rgba(148, 163, 184, 0.15)';
            badge.style.color = '#94a3b8';
            btn.className = 'btn btn-neon btn-sm';
            btn.innerText = '⚡ সেটআপ করুন';
            btn.onclick = openAdminTotpModal;
        }
    } catch (e) {
        console.error('Error checking TOTP status', e);
    }
}

async function openAdminTotpModal() {
    try {
        const res = await apiRequest('/api/admin/totp/generate', 'POST');
        if (res && res.success) {
            currentPendingTotpSecret = res.secret;
            const secretEl = document.getElementById('totpSecretText');
            if (secretEl) secretEl.innerText = res.secret;

            const qrImg = document.getElementById('totpQrImage');
            if (qrImg) {
                qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(res.otpauth_url)}`;
            }
            const modal = document.getElementById('adminTotpModal');
            if (modal) modal.style.display = 'flex';
            const inp = document.getElementById('totpVerifyInput');
            if (inp) {
                inp.value = '';
                inp.focus();
            }
        }
    } catch (e) {
        showToast('Google Authenticator জেনারেট করা যায়নি।', 'error');
    }
}

function closeAdminTotpModal() {
    const modal = document.getElementById('adminTotpModal');
    if (modal) modal.style.display = 'none';
}

function copyTotpSecretText() {
    const txt = document.getElementById('totpSecretText') ? document.getElementById('totpSecretText').innerText : '';
    if (txt) {
        navigator.clipboard.writeText(txt);
        showToast('সিক্রেট কি ক্লিপবোর্ডে কপি করা হয়েছে!', 'info');
    }
}

async function verifyAndActivateAdminTotp() {
    const code = (document.getElementById('totpVerifyInput') ? document.getElementById('totpVerifyInput').value : '').trim();
    if (!code || code.length !== 6) {
        showToast('Google Authenticator অ্যাপের ৬ ডিজিটের কোড দিন!', 'warning');
        return;
    }
    try {
        const res = await apiRequest('/api/admin/totp/verify-activate', 'POST', { code });
        if (res && res.success) {
            showToast(res.message || 'Google Authenticator সফলভাবে অ্যাক্টিভ হয়েছে!', 'success');
            closeAdminTotpModal();
            loadAdminTotpStatus();
        } else {
            showToast(res.detail || 'ভুল কোড! সঠিক কোড দিন।', 'error');
        }
    } catch (e) {
        showToast(e.message || 'ভেরিফাই করতে ব্যর্থ হয়েছে।', 'error');
    }
}

async function promptDisableAdminTotp() {
    const pin = prompt('Google Authenticator নিষ্ক্রিয় করতে আপনার ৬ ডিজিটের মাস্টার পিন দিন:');
    if (!pin) return;
    try {
        const res = await apiRequest('/api/admin/totp/disable', 'POST', { master_pin: pin.trim() });
        if (res && res.success) {
            showToast(res.message || 'Google Authenticator নিষ্ক্রিয় করা হয়েছে।', 'info');
            loadAdminTotpStatus();
        } else {
            showToast(res.detail || 'ভুল মাস্টার পিন!', 'error');
        }
    } catch (e) {
        showToast(e.message || 'নিষ্ক্রিয় করা যায়নি।', 'error');
    }
}

function toggleAllSettingsAccordions(open) {
    const accordions = document.querySelectorAll('#adminSection-settings .pro-settings-accordion');
    accordions.forEach(acc => {
        acc.open = open;
    });
}
window.toggleAllSettingsAccordions = toggleAllSettingsAccordions;

// -------------------------------------------------------------
// Auto-Deposit SMS Gateway Frontend Handlers
// -------------------------------------------------------------
async function initSmsGatewayCard() {
    try { loadAdminTotpStatus(); } catch(e) {}
    const urlInput = document.getElementById('smsWebhookUrlInput');
    if (urlInput) {
        urlInput.value = `${window.location.origin}/api/webhooks/incoming-sms`;
    }
    try {
        const res = await fetch('/api/admin/sms-gateway-info', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            const secInput = document.getElementById('smsWebhookSecretInput');
            if (secInput) secInput.value = data.secret || 'gomon_auto_secret_2026';
        }
    } catch (e) {
        console.error('Failed to load SMS gateway info', e);
    }
    loadAdminIncomingPayments();
}

function copySmsWebhookUrl() {
    const urlInput = document.getElementById('smsWebhookUrlInput');
    if (urlInput && urlInput.value) {
        navigator.clipboard.writeText(urlInput.value);
        showToast('Webhook URL কপি করা হয়েছে!', 'success');
    }
}

function copySmsWebhookSecret() {
    const secInput = document.getElementById('smsWebhookSecretInput');
    if (secInput && secInput.value) {
        navigator.clipboard.writeText(secInput.value);
        showToast('Secret Key কপি করা হয়েছে!', 'success');
    }
}

async function saveSmsWebhookSecret() {
    const secInput = document.getElementById('smsWebhookSecretInput');
    const secret = secInput ? secInput.value.trim() : '';
    if (!secret || secret.length < 8) {
        showToast('Secret Key কমপক্ষে ৮ অক্ষরের হতে হবে', 'warning');
        return;
    }
    try {
        const res = await fetch('/api/admin/sms-gateway-secret', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ secret })
        });
        const data = await res.json();
        if (res.ok) {
            showToast('Secret Key সফলভাবে সেভ হয়েছে!', 'success');
        } else {
            showToast(data.detail || 'সেভ করতে ব্যর্থ হয়েছে', 'error');
        }
    } catch (e) {
        showToast('সার্ভার এরর', 'error');
    }
}

async function runAdminSmsTest() {
    const textInput = document.getElementById('testSmsTextInput');
    const resBox = document.getElementById('testSmsResultBox');
    const raw_sms = textInput ? textInput.value.trim() : '';
    if (!raw_sms) {
        showToast('টেস্ট করার জন্য মেসেজ টেক্সট দিন', 'warning');
        return;
    }
    if (resBox) {
        resBox.style.display = 'block';
        resBox.innerHTML = '<span style="color: #38bdf8;">⏳ এসএমএস প্রসেস করা হচ্ছে...</span>';
    }
    try {
        const res = await fetch('/api/admin/test-sms-webhook', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ raw_sms })
        });
        const data = await res.json();
        if (res.ok) {
            playSound('coin');
            showToast('টেস্ট এসএমএস সফলভাবে এক্সিকিউট হয়েছে!', 'success');
            if (resBox) {
                resBox.innerHTML = `
                    <div style="background: rgba(16,185,129,0.15); border: 1px solid #10b981; padding: 8px 12px; border-radius: 6px; color: #10b981;">
                        <b>✅ টেস্ট ফলাফল:</b> TrxID: <code>${escapeHtml(data.parsed.trx_id)}</code> | টাকা: <b>${data.parsed.amount} BDT</b> | গেটওয়ে: <b>${data.parsed.gateway.toUpperCase()}</b><br>
                        স্ট্যাটাস: <b>${data.result.status}</b> - ${escapeHtml(data.result.message || '')}
                    </div>
                `;
            }
            loadAdminIncomingPayments();
            loadAdminOverview();
        } else {
            if (resBox) {
                resBox.innerHTML = `
                    <div style="background: rgba(239,68,68,0.15); border: 1px solid #ef4444; padding: 8px 12px; border-radius: 6px; color: #ef4444;">
                        <b>❌ ত্রুটি:</b> ${escapeHtml(data.detail || 'এসএমএস পার্স করতে পারেনি')}
                    </div>
                `;
            }
        }
    } catch (e) {
        if (resBox) {
            resBox.innerHTML = '<span style="color: #ef4444;">সার্ভারের সাথে কানেক্ট করা যায়নি।</span>';
        }
    }
}

async function loadAdminIncomingPayments() {
    const tbody = document.getElementById('adminIncomingPaymentsBody');
    if (!tbody || !token) return;
    try {
        const res = await fetch('/api/admin/incoming-payments', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (res.ok) {
            const list = await res.json();
            const counterEl = document.getElementById('smsFeedCounter');
            if (counterEl && Array.isArray(list)) {
                counterEl.textContent = `${list.length} SMS Logged`;
            }
            if (!list || list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 14px; font-size: 0.72rem;">এখনো কোনো এসএমএস রিসিভ হয়নি</td></tr>';
                return;
            }
            tbody.innerHTML = list.map(item => {
                const gw = (item.gateway || 'bkash').toLowerCase();
                const isClaimed = item.status === 'claimed';
                const gwClass = gw.includes('bkash') ? 'bkash' : (gw.includes('nagad') ? 'nagad' : 'other');
                const gwLabel = gw.includes('bkash') ? 'bKash' : (gw.includes('nagad') ? 'Nagad' : escapeHtml(gw.toUpperCase()));

                let timeHtml = '-';
                if (item.created_at) {
                    const parts = item.created_at.split(' ');
                    const datePart = parts[0] || '';
                    const timePart = (parts[1] || '').substring(0, 5);
                    timeHtml = `<span class="pro-cell-time">${datePart}</span> <span class="pro-cell-time" style="color: #64748b;">${timePart}</span>`;
                }

                return `
                    <tr>
                        <td>${timeHtml}</td>
                        <td><span class="pro-gw-badge ${gwClass}">${gwLabel}</span></td>
                        <td><span class="pro-cell-phone">${escapeHtml(item.sender_phone || '-')}</span></td>
                        <td><span class="pro-cell-amount"><span class="symbol">৳</span>${Number(item.amount || 0).toLocaleString('en-US')}</span></td>
                        <td>
                            <span class="pro-cell-trx" onclick="navigator.clipboard.writeText('${escapeHtml(item.trx_id)}'); if(typeof showToast==='function') showToast('TrxID কপি করা হয়েছে!', 'info')" title="ক্লিক করে TrxID কপি করুন">
                                ${escapeHtml(item.trx_id)}
                                <span style="opacity: 0.6; font-size: 0.6rem;">📋</span>
                            </span>
                        </td>
                        <td>
                            <span class="pro-chip ${isClaimed ? 'pro-chip-claimed' : 'pro-chip-unclaimed'}">
                                <span class="pro-chip-dot"></span>
                                ${isClaimed ? 'CLAIMED' : 'UNCLAIMED'}
                            </span>
                        </td>
                        <td>
                            ${item.claimed_by_username ? 
                                `<span class="pro-cell-user">@${escapeHtml(item.claimed_by_username)}</span>` : 
                                `<span style="color: #64748b; font-size: 0.72rem;">—</span>`
                            }
                        </td>
                    </tr>
                `;
            }).join('');
        }
    } catch (e) {
        console.error('Error loading incoming payments', e);
    }
}

// -------------------------------------------------------------
// Real-Time WebSockets Engine
// -------------------------------------------------------------
function initWebSocket() {
    if (wsPingInterval) {
        clearInterval(wsPingInterval);
        wsPingInterval = null;
    }
    if (ws) {
        try {
            ws.onclose = null;
            ws.close();
        } catch (e) {}
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const activeToken = token || localStorage.getItem('ff_token') || localStorage.getItem('token') || '';
    const wsUrl = `${protocol}//${location.host}/ws${activeToken ? `?token=${encodeURIComponent(activeToken)}` : ''}`;

    try {
        ws = new WebSocket(wsUrl);
    } catch (e) {
        setTimeout(initWebSocket, 3000);
        return;
    }

    ws.onopen = () => {
        const textEl = document.getElementById('connStatusText');
        const statusEl = document.getElementById('connectionStatus');
        if (textEl) textEl.innerText = 'Live Real-time';
        if (statusEl) statusEl.style.color = 'var(--neon-green)';
        loadPublicInfo();
        loadMatches();

        // Send explicit AUTH packet if active token exists
        if (activeToken && ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ type: 'AUTH', token: activeToken }));
            } catch (e) {}
        }

        // Single heartbeat ping interval with token & device_id
        if (wsPingInterval) clearInterval(wsPingInterval);
        wsPingInterval = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                const myDev = (typeof getOrCreateDeviceId === 'function') ? getOrCreateDeviceId() : '';
                const curTok = token || localStorage.getItem('ff_token') || '';
                ws.send(JSON.stringify({ type: 'ping', token: curTok, device_id: myDev }));
            }
        }, 15000);
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleWsMessage(data);
        } catch (e) {}
    };

    ws.onclose = () => {
        if (wsPingInterval) {
            clearInterval(wsPingInterval);
            wsPingInterval = null;
        }
        const textEl = document.getElementById('connStatusText');
        const statusEl = document.getElementById('connectionStatus');
        if (textEl) textEl.innerText = 'Reconnecting...';
        if (statusEl) statusEl.style.color = 'var(--neon-amber)';
        setTimeout(initWebSocket, 3000);
    };

    ws.onerror = () => {
        if (wsPingInterval) {
            clearInterval(wsPingInterval);
            wsPingInterval = null;
        }
    };
}

function handleWsMessage(data) {
    if (data.type === 'FORCE_LOGOUT') {
        // If message targets a specific user ID, only proceed if this client is that user
        if (data.target_user_id && currentUser && currentUser.id !== data.target_user_id) {
            return;
        }
        const myDev = (typeof getOrCreateDeviceId === 'function') ? getOrCreateDeviceId() : '';
        // If message targets a specific new device, do not logout if this client is that new device
        if (data.device_id && data.device_id === myDev) {
            return;
        }
        const kickMsg = data.message || 'আপনার অ্যাকাউন্টটি অন্য ডিভাইসে লগইন করায় এই ডিভাইস থেকে লগআউট করা হয়েছে।';
        showToast(kickMsg, 'error');
        playSound('alert');
        setTimeout(() => {
            if (typeof logout === 'function') {
                logout(false);
            }
        }, 500);
        return;
    }

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
    } else if (data.type === 'ADMIN_CHALLENGE_NOTICE') {
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator')) {
            showToast(`⚔️ Challenge #${data.code} waiting for Admin Room!`, 'info');
            playSound('alert');
            if (typeof loadAdminChallenges === 'function') loadAdminChallenges();
            if (typeof loadAdminOverview === 'function') loadAdminOverview();
        }
    } else if (data.type === 'CHALLENGE_ROOM_UPDATED') {
        showToast(`🎯 Challenge #${data.code} room details released!`, 'info');
        if (typeof loadMyChallenges === 'function') loadMyChallenges();
    } else if (data.type === 'ADMIN_ANNOUNCEMENT') {
        playSound('alert');
        showToast(`🚨 ${data.title}: ${data.message}`, 'error');
        document.querySelectorAll('#announcementText, .notice-text-bn').forEach(el => {
            el.innerText = `${data.title}: ${data.message}`;
        });
    } else if (data.type === 'SETTINGS_UPDATED') {
        if (data.notice !== undefined || data.notice_en !== undefined) {
            updateNoticeTicker(data.notice, data.notice_en);
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
            const reg = await navigator.serviceWorker.register('/sw.js');
            if (reg) {
                reg.update().catch(() => {});
            }
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

    sessionStorage.setItem('current_admin_section', sectionId);

    // Dynamic data loading for the opened section
    if (sectionId === 'dashboard') {
        if (currentUser && currentUser.role === 'admin') { loadAdminOverview(); loadAdminPromotions(); }
    } else if (sectionId === 'payments') {
        if (currentUser && currentUser.role === 'admin') loadAdminOverview();
    } else if (sectionId === 'withdrawals') {
        if (currentUser && currentUser.role === 'admin') loadAdminOverview();
    } else if (sectionId === 'players') {
        if (currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator')) loadAdminUsers();
    } else if (sectionId === 'matches') {
        loadMatches();
        loadAdminChallenges();
    } else if (sectionId === 'moderators') {
        if (currentUser && currentUser.role === 'admin') loadModeratorScoreboard();
    } else if (sectionId === 'history') {
        loadAdminMatchHistory();
    } else if (sectionId === 'settings') {
        initSmsGatewayCard();
        try { loadPublicInfo(); } catch (_) {}
    } else if (sectionId === 'promotions') {
        loadAdminPromotions();
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

        const winner = participants.find(p => p.rank_position === 1);
        const winnerName = winner ? (winner.player_ign || winner.username || '') : '';

        return `
            <div class="admin-history-card" id="histCard-${m.id}">
                <div class="admin-history-card-header" onclick="toggleAdminHistoryMatch(${m.id})">
                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <div class="admin-history-card-title" style="margin: 0;">
                            <span class="match-code-badge" style="font-size: 0.74rem; padding: 2px 7px;">#${escapeHtml(m.match_code || ('MATCH-' + m.id))}</span>
                            <span style="color: #ffffff; font-size: 0.98rem; font-weight: 800;">${escapeHtml(m.title)}</span>
                            ${badgeHtml}
                        </div>
                        ${winnerName ? `<span style="background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.35); padding: 2px 8px; border-radius: 999px; font-size: 0.74rem; font-weight: 800; display: inline-flex; align-items: center; gap: 4px;">🥇 ${escapeHtml(winnerName)}</span>` : ''}
                        <span style="font-size: 0.74rem; color: var(--neon-cyan); background: rgba(0, 210, 255, 0.08); padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(0, 210, 255, 0.25); font-weight: 700;">👥 ${participants.length}/${m.total_slots || 48}</span>
                        <span style="font-size: 0.74rem; color: var(--neon-green); background: rgba(0, 245, 155, 0.08); padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(0, 245, 155, 0.25); font-weight: 800;">💰 ৳${m.total_payout || 0}</span>
                    </div>

                    <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                        <span class="admin-history-retention-notice" style="font-size: 0.72rem; padding: 2px 7px;">
                            ⏳ ${retentionText}
                        </span>
                        <span style="font-size: 0.74rem; color: var(--text-muted);">
                            ${formatMatchTime12Hour(m.completed_at || m.created_at || m.match_time)}
                        </span>
                        ${m.completed_by_name ? `<span style="font-size: 0.74rem; color: var(--neon-green); font-weight: 700;">🏁 ${escapeHtml(m.completed_by_name)}</span>` : ''}
                        <button type="button" class="btn btn-outline btn-xs" id="histToggleBtn-${m.id}" style="font-size: 0.75rem; font-weight: 800; padding: 4px 10px; border-radius: 6px; display: inline-flex; align-items: center; gap: 5px; pointer-events: none; border-color: rgba(255,255,255,0.2); color: #f1f5f9; background: rgba(255,255,255,0.06);">
                            <span id="histBtnText-${m.id}">Details</span>
                            <span id="histArrow-${m.id}" style="display: inline-block; transition: transform 0.25s ease; font-size: 0.7rem;">▼</span>
                        </button>
                    </div>
                </div>

                <!-- Collapsible Details Body (Hidden by default for ultra-compact layout) -->
                <div class="admin-history-card-body" id="histBody-${m.id}" style="display: none;">
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
                            <b style="font-family: monospace; font-size: 0.82rem; color: #cbd5e1;">ID: ${escapeHtml(m.room_id || 'N/A')}${m.room_pass ? ` | Pass: ${escapeHtml(m.room_pass)}` : ''}</b>
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
            </div>
        `;
    }).join('');
}

function toggleAdminHistoryMatch(matchId) {
    const body = document.getElementById(`histBody-${matchId}`);
    const arrow = document.getElementById(`histArrow-${matchId}`);
    const btnText = document.getElementById(`histBtnText-${matchId}`);
    const card = document.getElementById(`histCard-${matchId}`);
    if (!body) return;

    const isHidden = (body.style.display === 'none' || !body.style.display);
    if (isHidden) {
        body.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
        if (btnText) btnText.textContent = 'Hide';
        if (card) card.classList.add('expanded');
    } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
        if (btnText) btnText.textContent = 'Details';
        if (card) card.classList.remove('expanded');
    }
}
window.toggleAdminHistoryMatch = toggleAdminHistoryMatch;

function toggleAllAdminHistory(expand) {
    document.querySelectorAll('.admin-history-card-body').forEach(b => {
        b.style.display = expand ? 'block' : 'none';
    });
    document.querySelectorAll('[id^="histArrow-"]').forEach(a => {
        a.style.transform = expand ? 'rotate(180deg)' : 'rotate(0deg)';
    });
    document.querySelectorAll('[id^="histBtnText-"]').forEach(t => {
        t.textContent = expand ? 'Hide' : 'Details';
    });
    document.querySelectorAll('.admin-history-card').forEach(c => {
        if (expand) c.classList.add('expanded');
        else c.classList.remove('expanded');
    });
}
window.toggleAllAdminHistory = toggleAllAdminHistory;

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
        openWalletModal();
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

    const elPromo = document.getElementById('profPromoCode');
    if (elPromo) elPromo.innerText = currentUser.promo_code || 'GOMONHUB-N/A';

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
    if (!currentUser || !currentUser.player_id) {
        showToast('Player ID not available!', 'info');
        return;
    }
    const pid = currentUser.player_id;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(pid);
        } else {
            const ta = document.createElement('textarea');
            ta.value = pid;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        showToast(`Player ID (${pid}) copied to clipboard!`, 'success');
    } catch (e) {
        showToast(`Player ID: ${pid}`, 'info');
    }
}

function copyProfilePromoCode() {
    if (!currentUser || !currentUser.promo_code) {
        showToast('Promo Code not available!', 'info');
        return;
    }
    const code = currentUser.promo_code;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(code);
        } else {
            const ta = document.createElement('textarea');
            ta.value = code;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        showToast(`Promo Code (${code}) copied to clipboard!`, 'success');
    } catch (e) {
        showToast(`Promo Code: ${code}`, 'info');
    }
}

// -------------------------------------------------------------
// Seamless State & Tab Restoration on Page Refresh
// -------------------------------------------------------------
function restoreLastActiveView(isCached = false) {
    if (!currentUser) return;

    let savedTab = sessionStorage.getItem('current_active_tab');
    if (window.location.hash) {
        const hashClean = window.location.hash.replace('#', '').trim();
        if (hashClean && document.getElementById('tab-' + hashClean)) {
            savedTab = 'tab-' + hashClean;
        }
    }

    if (!savedTab || !document.getElementById(savedTab)) {
        savedTab = 'tab-matches';
    }

    // Role check: Only admin or moderator can stay on tab-admin
    if (savedTab === 'tab-admin' && currentUser.role !== 'admin' && currentUser.role !== 'moderator') {
        savedTab = 'tab-matches';
        sessionStorage.setItem('current_active_tab', 'tab-matches');
    }

    // Switch tab with isRestore=true (preserves scroll position!)
    switchTab(savedTab, true);

    // If it's the final network-verified restore, trigger full fresh refresh
    if (!isCached) {
        if (savedTab === 'tab-matches') {
            fetchMatches();
        } else if (savedTab === 'tab-mymatches') {
            renderMyMatches();
        } else if (savedTab === 'tab-results') {
            loadCompletedResults();
        } else if (savedTab === 'tab-profile') {
            renderUserProfile();
            loadWalletHistory();
        } else if (savedTab === 'tab-shop') {
            loadWalletHistory();
        } else if (savedTab === 'tab-admin') {
            const savedSec = sessionStorage.getItem('current_admin_section') || (currentUser.role === 'moderator' ? 'matches' : 'dashboard');
            switchAdminSection(savedSec);
        }
    }

    // Restore active modal if one was open (profile details modal is never auto-restored on launch)
    const savedModal = sessionStorage.getItem('current_active_modal');
    if (savedModal === 'myProfileDetailsModal') {
        sessionStorage.removeItem('current_active_modal');
    } else if (savedModal) {
        if (savedModal === 'walletModal') {
            openWalletModal();
        } else if (savedModal === 'withdrawModal') {
            openWithdrawModal();
        } else if (savedModal === 'allRulesModal') {
            openRulesModal();
        } else {
            const m = document.getElementById(savedModal);
            if (m && !m.classList.contains('show')) {
                openModal(savedModal);
            }
        }
    }
}

// -------------------------------------------------------------
// Smart Mobile Navigation Stack & Double-Back to Exit Engine
// -------------------------------------------------------------
const EXIT_DOUBLE_PRESS_WINDOW = 1000; // 1 second window
let lastBackPressTime = 0;
let appTabHistory = ['tab-matches'];
let programmaticBackCount = 0;

function initAppNavigationBarrier() {
    try {
        const chCode = getDeepLinkChallengeCode();
        if (chCode) {
            sessionStorage.setItem('pending_challenge_code', chCode);
        }
        const matchCode = getDeepLinkMatchId();
        if (matchCode) {
            sessionStorage.setItem('pending_match_id', matchCode);
        }

        const clean = (window.location.hash || '#matches').replace('#', '').trim();
        const isDeepLinkHash = clean.includes('challenge') || clean.includes('match=');
        const initialTab = (!isDeepLinkHash && clean && document.getElementById('tab-' + clean)) ? ('tab-' + clean) : 'tab-matches';
        appTabHistory = [initialTab];
        history.replaceState({ type: 'root', tabId: initialTab }, '', '#' + initialTab.replace('tab-', ''));
        history.pushState({ type: 'barrier', tabId: initialTab }, '', '#' + initialTab.replace('tab-', ''));
    } catch (e) {}
}

// Browser Back/Forward hardware & gesture navigation listener
window.addEventListener('popstate', () => {
    if (programmaticBackCount > 0) {
        programmaticBackCount--;
        return;
    }

    // 1. If user is NOT logged in (Auth Modal is active)
    if (!currentUser) {
        const signupCard = document.getElementById('authSignupCard');
        const forgotReqCard = document.getElementById('authForgotRequestCard');
        const forgotOtpCard = document.getElementById('authForgotOtpCard');
        const forgotNewPassCard = document.getElementById('authForgotNewPassCard');
        const fpModal = document.getElementById('forgotPasswordModal');

        // If in forgotPasswordModal popup, close it
        if (fpModal && fpModal.classList.contains('show')) {
            closeModal('forgotPasswordModal', true);
            history.pushState({ type: 'barrier' }, '', window.location.hash || '#matches');
            return;
        }

        // If in signup or forgot cards inside authModal, return to Sign In
        const isSubAuthOpen = (signupCard && signupCard.style.display !== 'none' && signupCard.style.display !== '') ||
                              (forgotReqCard && forgotReqCard.style.display !== 'none' && forgotReqCard.style.display !== '') ||
                              (forgotOtpCard && forgotOtpCard.style.display !== 'none' && forgotOtpCard.style.display !== '') ||
                              (forgotNewPassCard && forgotNewPassCard.style.display !== 'none' && forgotNewPassCard.style.display !== '');

        if (isSubAuthOpen) {
            setAuthMode('login');
            history.pushState({ type: 'barrier' }, '', window.location.hash || '#matches');
            return;
        }

        // On Sign In (root auth screen): Double tap back within 1 second to exit
        const now = Date.now();
        if (now - lastBackPressTime <= EXIT_DOUBLE_PRESS_WINDOW) {
            showToast('Exiting...', 'info');
            try { window.close(); } catch (err) {}
            return; // Natural exit allowed
        } else {
            lastBackPressTime = now;
            history.pushState({ type: 'barrier' }, '', window.location.hash || '#matches');
            showToast('Press back again to exit', 'info');
            return;
        }
    }

    // 2. Priority 1 (Logged-in): Check if ANY modal is currently open
    const openModals = Array.from(document.querySelectorAll('.modal-overlay.show')).filter(m => m.id !== 'authModal');
    if (openModals.length > 0) {
        const topModal = openModals[openModals.length - 1];
        closeModal(topModal.id, true);
        history.pushState({ type: 'barrier' }, '', window.location.hash);
        return;
    }

    // 3. Priority 2: Check Tab Navigation History Stack (LIFO)
    if (appTabHistory.length > 1) {
        const currentActiveTab = sessionStorage.getItem('current_active_tab') || 'tab-matches';
        // If history.state is already the currently active tab (e.g. returning from a closed modal), keep user on current tab
        if (history.state && history.state.type === 'tab' && history.state.tabId === currentActiveTab) {
            return;
        }
        appTabHistory.pop(); // Remove current tab from stack
        const prevTab = appTabHistory[appTabHistory.length - 1]; // Previous visited tab
        if (prevTab && document.getElementById(prevTab)) {
            switchTab(prevTab, false, true);
            history.pushState({ type: 'barrier' }, '', '#' + prevTab.replace('tab-', ''));
            return;
        }
    }

    // 4. Priority 3: Root Tab reached (tab-matches or no more previous tabs)
    // Double Tap Back to Exit within 1 second (1000ms)
    const now = Date.now();
    if (now - lastBackPressTime <= EXIT_DOUBLE_PRESS_WINDOW) {
        showToast('Exiting app...', 'info');
        try { window.close(); } catch (err) {}
        // Natural exit allowed (no barrier pushed)
    } else {
        lastBackPressTime = now;
        history.pushState({ type: 'barrier' }, '', window.location.hash || '#matches');
        showToast('Press back again to exit', 'info');
    }
});

// -------------------------------------------------------------
// Tab Switching & Modal Helpers
// -------------------------------------------------------------
function switchTab(tabId, isRestore = false, fromPopstate = false) {
    if (tabId === 'tab-recharge' || tabId === 'tab-shop') {
        switchTab('tab-profile', isRestore, fromPopstate);
        openWalletModal();
        return;
    }

    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.mobile-nav-item').forEach(el => el.classList.remove('active'));

    const targetTab = document.getElementById(tabId);
    if (targetTab) targetTab.classList.add('active');

    const mainContainer = document.querySelector('.main-container');
    if (mainContainer) {
        if (tabId === 'tab-admin') {
            mainContainer.classList.add('admin-wide-mode');
        } else {
            mainContainer.classList.remove('admin-wide-mode');
        }
    }

    const cleanName = tabId.replace('tab-', '');
    const btn = document.getElementById('tabBtn-' + cleanName);
    if (btn) btn.classList.add('active');

    const mBtn = document.getElementById('mNav-' + cleanName);
    if (mBtn) mBtn.classList.add('active');

    // Save active tab state
    sessionStorage.setItem('current_active_tab', tabId);

    // Track tab navigation stack for hardware back button
    if (!fromPopstate && !isRestore) {
        if (appTabHistory[appTabHistory.length - 1] !== tabId) {
            appTabHistory.push(tabId);
            try {
                history.pushState({ type: 'tab', tabId: tabId }, '', '#' + cleanName);
            } catch (e) {}
        }
    } else {
        try {
            if (window.location.hash !== '#' + cleanName) {
                history.replaceState({ type: 'tab', tabId: tabId }, '', '#' + cleanName);
            }
        } catch (e) {}
    }

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
        const savedSec = sessionStorage.getItem('current_admin_section');
        if (savedSec && document.getElementById('adminSection-' + savedSec)) {
            switchAdminSection(savedSec);
        } else if (currentUser && currentUser.role === 'moderator') {
            switchAdminSection('matches');
        } else {
            switchAdminSection('dashboard');
        }
    }

    if (!isRestore) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
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
    if (adminBkashNumber && !adminBkashNumber.includes('লগইন')) {
        document.querySelectorAll('.displayBkashNumber, [id="displayBkashNumber"]').forEach(el => {
            el.innerText = adminBkashNumber;
        });
    }
    openModal('walletModal');
    loadWalletHistory();
    try { loadPublicInfo(); } catch(_) {}
}

function openWithdrawModal() {
    if (!currentUser) {
        showToast('উইথড্র করতে অনুগ্রহ করে আগে লগইন করুন!', 'warning');
        openModal('authModal');
        return;
    }
    const balEl = document.getElementById('withdrawUserBalance');
    if (balEl) balEl.innerText = 'BDT ' + (currentUser.digits_balance || 0);
    const phoneInp = document.getElementById('withdrawPhone');
    if (phoneInp) {
        phoneInp.value = '';
    }
    if (adminWithdrawNumber && !adminWithdrawNumber.includes('লগইন')) {
        document.querySelectorAll('.displayWithdrawNumber, [id="displayWithdrawNumber"]').forEach(el => {
            el.innerText = adminWithdrawNumber;
        });
    }
    openModal('withdrawModal');
    loadWithdrawHistory();
    try { loadPublicInfo(); } catch(_) {}
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

async function openMyProfileModal() {
    if (!currentUser) {
        openModal('authModal');
        return;
    }
    renderUserProfile();
    openModal('myProfileDetailsModal');
    if (!currentUser.promo_code || currentUser.promo_code === 'GOMONHUB-N/A') {
        try {
            const token = localStorage.getItem('ff_token');
            if (token) {
                const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${token}` } });
                if (res.ok) {
                    const freshUser = await res.json();
                    if (freshUser && freshUser.promo_code) {
                        currentUser = freshUser;
                        localStorage.setItem('ff_user', JSON.stringify(currentUser));
                        renderUserProfile();
                    }
                }
            }
        } catch (e) {}
    }
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
                    <span style="font-size:0.72rem; color:#64748b;">Finished: ${formatMatchTime12Hour(m.completed_at || m.match_time)}</span>
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
                        Match finished (Prizes distributed)
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
    if (modal) {
        modal.classList.add('show');
        modal.style.removeProperty('display');
    }
    const persistableModals = ['walletModal', 'withdrawModal', 'promotionModal', 'allRulesModal', 'topPlayersModal', 'devProfileModal', 'supportModal', 'adminAuditLogsModal'];
    if (persistableModals.includes(id)) {
        sessionStorage.setItem('current_active_modal', id);
    }
    // Track modal in browser history for hardware back button support
    if (id !== 'authModal' || currentUser) {
        try {
            history.pushState({ type: 'modal', modalId: id }, '', window.location.hash);
        } catch (e) {}
    }
}

function closeModal(id, fromPopstate = false) {
    if (id === 'authModal' && !currentUser) {
        return; // Non-logged-in users cannot dismiss login modal to enter app
    }
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('show');
        modal.style.removeProperty('display');
    }
    if (sessionStorage.getItem('current_active_modal') === id) {
        sessionStorage.removeItem('current_active_modal');
    }
    if (!fromPopstate) {
        if (history.state && history.state.type === 'modal' && history.state.modalId === id) {
            programmaticBackCount++;
            try {
                history.back();
            } catch (e) {}
            setTimeout(() => { if (programmaticBackCount > 0) programmaticBackCount--; }, 2000);
        }
    }
}

window.onclick = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        if (e.target.id === 'authModal' && !currentUser) {
            return; // Non-logged-in users cannot dismiss login modal by clicking background
        }
        closeModal(e.target.id);
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
    if (!newVersion) return;
    pendingUpdateVersion = newVersion;
    pendingUpdateNotes = notes;

    const installedVer = localStorage.getItem('installed_app_version') || currentInstalledVersion || 'v1.0.0';
    const curVerEl = document.getElementById('updateCurrentVer');
    if (curVerEl) curVerEl.innerText = installedVer;

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

window.addEventListener('online', () => {
    try { loadPublicInfo(); } catch (_) {}
});

async function handlePushUpdateSubmit(e) {
    e.preventDefault();
    const version = document.getElementById('adminNewVersionInput').value.trim();
    const notes = document.getElementById('adminUpdateNotesInput').value.trim();

    try {
        const activeToken = token || localStorage.getItem('ff_token') || localStorage.getItem('token');
        const res = await fetch('/api/admin/push-update', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${activeToken}`
            },
            body: JSON.stringify({ version, notes })
        });
        let data = {};
        try {
            data = await res.json();
        } catch (_) {}

        if (res.ok) {
            showToast(data.message || 'ভার্সন আপডেট সফলভাবে ব্রডকাস্ট হয়েছে!', 'success');
            playSound('alert');
            const badge = document.getElementById('adminCurrentVersionBadge');
            if (badge) badge.innerText = version;
            document.getElementById('adminNewVersionInput').value = incrementVersion(version);
        } else {
            showToast(data.detail || data.message || `Failed to release update (${res.status})`, 'error');
        }
    } catch (e) {
        showToast('সার্ভারের সাথে সংযোগ পাওয়া যায়নি। অনুগ্রহ করে ইন্টারনেট কানেকশন চেক করে আবার চেষ্টা করুন।', 'error');
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
// =============================================================
// ADMIN RESULT PUBLISHING & AUTO-PRIZE LOGIC (ENHANCED)
// =============================================================
let adminAllMatchesCache = [];
let currentAdminResultFilter = 'all';
let currentAdminResultStatus = 'pending';
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

    currentAdminResultFilter = 'all';
    currentAdminResultStatus = 'pending';

    if (preselectedMatchId) {
        const preId = parseInt(preselectedMatchId);
        const target = (adminAllMatchesCache || []).find(x => x.id === preId);
        if (target && target.status === 'completed') {
            currentAdminResultStatus = 'finished';
        }
    }

    // Sync active pills
    document.querySelectorAll('#publishResultModal .status-filter-pill').forEach(b => {
        b.classList.toggle('active', b.id === `adminResStatus-${currentAdminResultStatus}`);
    });
    document.querySelectorAll('#publishResultModal .cat-filter-pill').forEach(b => {
        b.classList.toggle('active', b.id === `adminResCat-${currentAdminResultFilter}`);
    });

    renderAdminResultDropdown();

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

function filterAdminResultStatus(status, btnElem) {
    currentAdminResultStatus = status || 'pending';
    
    document.querySelectorAll('#publishResultModal .status-filter-pill').forEach(b => {
        b.classList.toggle('active', b.id === `adminResStatus-${currentAdminResultStatus}`);
    });

    renderAdminResultDropdown();
}
window.filterAdminResultStatus = filterAdminResultStatus;

function filterAdminResultMatches(category, btnElem) {
    currentAdminResultFilter = category || 'all';
    
    document.querySelectorAll('#publishResultModal .cat-filter-pill').forEach(b => {
        b.classList.toggle('active', b.id === `adminResCat-${currentAdminResultFilter}`);
    });

    renderAdminResultDropdown();
}
window.filterAdminResultMatches = filterAdminResultMatches;

function renderAdminResultDropdown() {
    const select = document.getElementById('adminResultMatchSelect');
    if (!select) return;

    let filtered = adminAllMatchesCache || [];

    // 1. Status Filter: pending (open/closed) vs finished (completed)
    if (currentAdminResultStatus === 'pending') {
        filtered = filtered.filter(m => m.status !== 'completed' && m.status !== 'cancelled');
    } else if (currentAdminResultStatus === 'finished') {
        filtered = filtered.filter(m => m.status === 'completed');
    }

    // 2. Category Filter
    if (currentAdminResultFilter !== 'all') {
        filtered = filtered.filter(m => (m.match_type || '').toLowerCase().trim() === currentAdminResultFilter.toLowerCase().trim());
    }

    if (filtered.length === 0) {
        const statusLabel = currentAdminResultStatus === 'pending' ? 'Pending' : 'Finished';
        const catLabel = currentAdminResultFilter === 'all' ? 'All Categories' : currentAdminResultFilter;
        select.innerHTML = `<option value="">-- No ${statusLabel} matches found in [${catLabel}] --</option>`;
    } else {
        const placeholder = currentAdminResultStatus === 'pending'
            ? '-- Select a pending tournament match --'
            : '-- Select a finished match to view/update results --';
        select.innerHTML = `<option value="">${placeholder}</option>` + 
            filtered.map(m => {
                const statusTxt = m.status === 'completed' ? '🏁 Finished' : (m.status === 'reg_closed' ? '🔒 Closed' : '🟢 Open');
                const codeTag = m.match_code ? `[#${m.match_code}]` : `#${m.id}`;
                const timeTag = m.match_time ? ` - ⏰ ${formatMatchTime12Hour(m.match_time)}` : '';
                return `<option value="${m.id}">${codeTag} [${m.match_type}] ${escapeHtml(m.title)}${timeTag} (${statusTxt})</option>`;
            }).join('');
    }

    // Hide details until a match is explicitly selected
    const infoEl = document.getElementById('adminSelectedMatchInfo');
    const partsEl = document.getElementById('adminResultParticipantsContainer');
    const btnWrapper = document.getElementById('adminPublishBtnWrapper');
    if (infoEl) infoEl.style.display = 'none';
    if (partsEl) partsEl.style.display = 'none';
    if (btnWrapper) btnWrapper.style.display = 'none';
}
window.renderAdminResultDropdown = renderAdminResultDropdown;

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
        const resTimeEl = document.getElementById('resMatchTimeText');
        if (resTimeEl) resTimeEl.innerText = formatMatchTime12Hour(m.match_time);
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
            const slotNum = p.slot_number || (idx + 1);
            const kills = p.kills || 0;
            const rankPos = p.rank_position || '';
            const rankPrize = p.rank_prize || 0;
            const killPrize = kills * (m.per_kill || 0);
            const totalPrize = p.total_prize || (killPrize + rankPrize);

            const isTeammate = p.is_leader === 0;
            const teammateBadge = isTeammate 
                ? `<span style="font-size: 0.65rem; background: #e0f2fe; color: #0369a1; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 4px;">👥 Teammate</span>`
                : `<span style="font-size: 0.65rem; background: #ecfdf5; color: #047857; padding: 1px 6px; border-radius: 4px; font-weight: 700; margin-left: 4px;">👑 Booker</span>`;

            return `
                <tr id="resRow_slot_${slotNum}" style="border-bottom:1px solid #f1f5f9;">
                    <td style="padding:6px 8px; font-weight:700; color:#64748b;">#${slotNum}</td>
                    <td style="padding:6px 8px;">
                        <div style="font-weight:700; color:#0f172a; display: flex; align-items: center; flex-wrap: wrap;">
                            ${escapeHtml(p.ff_ign || p.username)} ${teammateBadge}
                        </div>
                        <div style="font-size:0.68rem; color:#64748b;">@${escapeHtml(p.username)} • UID: ${escapeHtml(p.ff_uid || 'N/A')}</div>
                    </td>
                    <td style="padding:6px 8px;">
                        <input type="number" id="resRank_slot_${slotNum}" data-slot="${slotNum}" data-userid="${p.user_id}" class="input-glow" value="${rankPos}" min="0" max="50" placeholder="Rank" style="width:100%; padding:4px 6px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;">
                    </td>
                    <td style="padding:6px 8px;">
                        <input type="number" id="resKills_slot_${slotNum}" data-slot="${slotNum}" data-userid="${p.user_id}" class="input-glow" value="${kills}" min="0" max="99" placeholder="0" style="width:100%; padding:4px 6px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;" oninput="calcRowPrizeBySlot(${slotNum})">
                    </td>
                    <td style="padding:6px 8px;">
                        <input type="number" id="resRankPrize_slot_${slotNum}" data-slot="${slotNum}" data-userid="${p.user_id}" class="input-glow" value="${rankPrize}" min="0" placeholder="0" style="width:100%; padding:4px 6px; font-size:0.75rem; border-radius:4px; border:1px solid #cbd5e1;" oninput="calcRowPrizeBySlot(${slotNum})">
                    </td>
                    <td style="padding:6px 8px; text-align:right;">
                        <span id="resTotalPrizeText_slot_${slotNum}" style="font-family:'Rajdhani',sans-serif; font-size:0.95rem; font-weight:800; color:#059669;">৳${totalPrize}</span>
                    </td>
                </tr>
            `;
        }).join('');

        document.getElementById('adminResultParticipantsContainer').style.display = 'block';
        document.getElementById('adminPublishBtnWrapper').style.display = 'block';

        // Show 1-Click Booyah Shortcuts for 4v4 / 2v2 / Clash Squad matches
        const isCsOrFewSlots = (m.total_slots <= 8) || (m.match_type || '').toLowerCase().includes('clash') || (m.match_type || '').toLowerCase().includes('cs');
        const booyahStrip = document.getElementById('csQuickBooyahButtons');
        if (booyahStrip) {
            booyahStrip.style.display = isCsOrFewSlots ? 'flex' : 'none';
        }

        // Update notice & submit button based on finished vs pending match
        const isFinished = m.status === 'completed';
        const noticeEl = document.getElementById('adminResultEditNotice');
        const submitBtn = document.getElementById('adminPublishResultBtn');
        if (isFinished) {
            if (noticeEl) noticeEl.style.display = 'flex';
            if (submitBtn) {
                submitBtn.innerHTML = '✏️ Update & Re-distribute Match Results';
                submitBtn.style.background = 'linear-gradient(135deg, #d97706, #b45309)';
                submitBtn.style.boxShadow = '0 4px 12px rgba(217, 119, 6, 0.35)';
            }
        } else {
            if (noticeEl) noticeEl.style.display = 'none';
            if (submitBtn) {
                submitBtn.innerHTML = '🚀 Distribute Prizes & Publish Results';
                submitBtn.style.background = 'linear-gradient(135deg, #059669, #047857)';
                submitBtn.style.boxShadow = '0 4px 12px rgba(5, 150, 105, 0.3)';
            }
        }

    } catch (err) {
        showToast('Failed to load match details', 'error');
    }
}

function calcRowPrizeBySlot(slotNum) {
    if (!currentAdminResultMatchData || !currentAdminResultMatchData.match) return;
    const perKill = currentAdminResultMatchData.match.per_kill || 0;
    
    const killsInput = document.getElementById(`resKills_slot_${slotNum}`);
    const rankPrizeInput = document.getElementById(`resRankPrize_slot_${slotNum}`);
    const totalSpan = document.getElementById(`resTotalPrizeText_slot_${slotNum}`);

    const kills = parseInt(killsInput ? killsInput.value : 0, 10) || 0;
    const rankPrize = parseInt(rankPrizeInput ? rankPrizeInput.value : 0, 10) || 0;
    const total = (kills * perKill) + rankPrize;

    if (totalSpan) {
        totalSpan.innerText = '৳' + total;
    }
}
window.calcRowPrizeBySlot = calcRowPrizeBySlot;

function quickFillCsBooyah(winningTeam) {
    if (!currentAdminResultMatchData || !currentAdminResultMatchData.match) return;
    const m = currentAdminResultMatchData.match;
    const participants = currentAdminResultMatchData.participants || [];
    const totalSlots = m.total_slots || 8;
    const halfSlots = Math.round(totalSlots / 2) || 4;
    const winnerPrize = (m.prize_breakdown && m.prize_breakdown.winner) ? parseInt(m.prize_breakdown.winner, 10) : (parseInt(m.prize_pool, 10) || 56);
    const perSlotPrize = Math.round(winnerPrize / halfSlots) || 14;

    participants.forEach(p => {
        const slotNum = p.slot_number;
        const isWinningTeam = winningTeam === 1 ? (slotNum <= halfSlots) : (slotNum > halfSlots);
        const rankInput = document.getElementById(`resRank_slot_${slotNum}`);
        const killsInput = document.getElementById(`resKills_slot_${slotNum}`);
        const rankPrizeInput = document.getElementById(`resRankPrize_slot_${slotNum}`);

        if (rankInput) rankInput.value = isWinningTeam ? 1 : 2;
        if (killsInput) killsInput.value = 0;
        if (rankPrizeInput) rankPrizeInput.value = isWinningTeam ? perSlotPrize : 0;

        calcRowPrizeBySlot(slotNum);
    });

    showToast(`👑 Auto-filled Booyah for Team ${winningTeam}! (৳${perSlotPrize}/slot)`, 'success');
}
window.quickFillCsBooyah = quickFillCsBooyah;

function calcRowPrize(userId) {
    // Backward-compatibility wrapper
}

async function submitMatchResultsPublish() {
    if (!currentAdminResultMatchData || !currentAdminResultMatchData.match) {
        showToast('Please select a tournament match', 'error');
        return;
    }

    const isFinished = currentAdminResultMatchData.match.status === 'completed';
    const confirmMsg = isFinished
        ? '⚠️ This match is already finished. Are you sure you want to update results and recalculate wallet prize adjustments?'
        : 'Are you sure you want to finalize this match and distribute prizes to player wallets?';
    if (!confirm(confirmMsg)) return;

    const matchId = currentAdminResultMatchData.match.id;
    const participants = currentAdminResultMatchData.participants || [];

    // Group by user_id and automatically SUM rank_prize and kills across all slots booked by each user
    const userTotals = {};
    for (const p of participants) {
        const slotNum = p.slot_number;
        const rankInput = document.getElementById(`resRank_slot_${slotNum}`) || document.getElementById(`resRank_${p.user_id}`);
        const killsInput = document.getElementById(`resKills_slot_${slotNum}`) || document.getElementById(`resKills_${p.user_id}`);
        const rankPrizeInput = document.getElementById(`resRankPrize_slot_${slotNum}`) || document.getElementById(`resRankPrize_${p.user_id}`);

        const rankPos = parseInt(rankInput ? rankInput.value : 0, 10) || 0;
        const kills = parseInt(killsInput ? killsInput.value : 0, 10) || 0;
        const rankPrize = parseInt(rankPrizeInput ? rankPrizeInput.value : 0, 10) || 0;

        if (!userTotals[p.user_id]) {
            userTotals[p.user_id] = {
                user_id: p.user_id,
                rank_position: rankPos,
                kills: kills,
                rank_prize: rankPrize
            };
        } else {
            // User booked multiple slots! Auto-sum kills and rank_prize!
            userTotals[p.user_id].kills += kills;
            userTotals[p.user_id].rank_prize += rankPrize;
            if (rankPos > 0 && (userTotals[p.user_id].rank_position === 0 || rankPos < userTotals[p.user_id].rank_position)) {
                userTotals[p.user_id].rank_position = rankPos;
            }
        }
    }

    const results = Object.values(userTotals);

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

// -------------------------------------------------------------
// Video Promotion & Earn System
// -------------------------------------------------------------
function openPromotionModal() {
    if (!currentUser) {
        try {
            const stored = localStorage.getItem('ff_user');
            if (stored) currentUser = JSON.parse(stored);
        } catch (e) {}
    }
    if (!currentUser) {
        showToast('ভিডিও প্রমোশন সাবমিট করতে প্রথমে লগইন করুন', 'info');
        openModal('authModal');
        return;
    }
    const urlInp = document.getElementById('promoVideoUrl');
    if (urlInp) urlInp.value = '';
    const notesInp = document.getElementById('promoNotes');
    if (notesInp) notesInp.value = '';
    handlePromoUrlInput('');

    openModal('promotionModal');
    loadMyPromotions();
}

function handlePromoUrlInput(val) {
    const badge = document.getElementById('promoPlatformBadge');
    if (!badge) return;
    const u = (val || '').toLowerCase().trim();
    if (!u) {
        badge.innerHTML = '🌐 লিংক পেস্ট করুন';
        badge.style.background = 'var(--bg-card-hover)';
        badge.style.borderColor = 'var(--border-glass)';
        badge.style.color = 'var(--text-muted)';
    } else if (u.includes('youtube.com') || u.includes('youtu.be')) {
        badge.innerHTML = '🔴 YouTube Video';
        badge.style.background = 'rgba(239, 68, 68, 0.12)';
        badge.style.borderColor = 'rgba(239, 68, 68, 0.35)';
        badge.style.color = '#dc2626';
    } else if (u.includes('tiktok.com')) {
        badge.innerHTML = '⬛ TikTok Video';
        badge.style.background = 'rgba(5, 150, 105, 0.12)';
        badge.style.borderColor = 'rgba(5, 150, 105, 0.35)';
        badge.style.color = '#059669';
    } else if (u.includes('facebook.com') || u.includes('fb.watch') || u.includes('fb.com')) {
        badge.innerHTML = '🔵 Facebook Reel/Video';
        badge.style.background = 'rgba(37, 99, 235, 0.12)';
        badge.style.borderColor = 'rgba(37, 99, 235, 0.35)';
        badge.style.color = '#2563eb';
    } else if (u.includes('instagram.com')) {
        badge.innerHTML = '🟣 Instagram Reel';
        badge.style.background = 'rgba(147, 51, 234, 0.12)';
        badge.style.borderColor = 'rgba(147, 51, 234, 0.35)';
        badge.style.color = '#9333ea';
    } else {
        badge.innerHTML = '🌐 Other Video Link';
        badge.style.background = 'rgba(217, 119, 6, 0.12)';
        badge.style.borderColor = 'rgba(217, 119, 6, 0.35)';
        badge.style.color = '#d97706';
    }
}

async function handlePromotionSubmit(e) {
    if (e) e.preventDefault();
    if (!currentUser) {
        openModal('authModal');
        return;
    }

    const urlInp = document.getElementById('promoVideoUrl');
    const notesInp = document.getElementById('promoNotes');
    const btn = document.getElementById('promoSubmitBtn');

    const video_url = urlInp ? urlInp.value.trim() : '';
    const notes = notesInp ? notesInp.value.trim() : '';

    if (!video_url || video_url.length < 10) {
        showToast('সঠিক ভিডিও লিংক প্রদান করুন', 'warning');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerText = 'সাবমিট হচ্ছে... ⏳';
    }

    try {
        const res = await fetchWithAuth('/api/promotions/submit', {
            method: 'POST',
            body: JSON.stringify({ video_url, notes })
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'সাবমিট ব্যর্থ হয়েছে');
        }
        showToast(data.message || 'ভিডিও লিংক জমা হয়েছে!', 'success');
        if (urlInp) urlInp.value = '';
        if (notesInp) notesInp.value = '';
        handlePromoUrlInput('');
        loadMyPromotions();
    } catch (err) {
        showToast(err.message || 'সার্ভারে সমস্যা হয়েছে', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = '🚀 সাবমিট করুন (Submit for Review)';
        }
    }
}

async function loadMyPromotions() {
    const listEl = document.getElementById('promoMySubmissionsList');
    if (!listEl) return;
    if (!currentUser) {
        listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 12px; font-size: 0.8rem;">লগইন করলে আপনার ভিডিও লিস্ট দেখতে পাবেন</div>';
        return;
    }

    try {
        const res = await fetchWithAuth('/api/promotions/my');
        if (!res.ok) throw new Error('Failed to load promotions');
        const items = await res.json();

        if (!items || items.length === 0) {
            listEl.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 16px; font-size: 0.82rem; background: var(--bg-card-hover); border: 1px solid var(--border-glass); border-radius: 8px;">আপনি এখনো কোনো ভিডিও লিংক জমা দেননি। ভিডিও বানিয়ে লিংক দিন ও রিওয়ার্ড জিতুন! 🎁</div>';
            return;
        }

        let html = '<div style="display: flex; flex-direction: column; gap: 10px;">';
        items.forEach(item => {
            let statusBadge = '';
            if (item.status === 'approved') {
                statusBadge = `<span style="background: rgba(16, 185, 129, 0.15); color: #059669; font-weight: 800; font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(16, 185, 129, 0.35);">🟢 Approved (+৳${item.reward_amount})</span>`;
            } else if (item.status === 'rejected') {
                statusBadge = `<span style="background: rgba(239, 68, 68, 0.15); color: #dc2626; font-weight: 800; font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.35);">🔴 Rejected</span>`;
            } else {
                statusBadge = `<span style="background: rgba(234, 179, 8, 0.15); color: #d97706; font-weight: 800; font-size: 0.72rem; padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(234, 179, 8, 0.35);">🟡 Pending Review</span>`;
            }

            let platformIcon = '🌐';
            let plat = (item.platform || '').toLowerCase();
            if (plat === 'youtube') platformIcon = '🔴 YouTube';
            else if (plat === 'tiktok') platformIcon = '⬛ TikTok';
            else if (plat === 'facebook') platformIcon = '🔵 Facebook';
            else if (plat === 'instagram') platformIcon = '🟣 Instagram';
            else platformIcon = '🌐 ' + (item.platform || 'Link');

            html += `
                <div style="background: var(--bg-card-hover); border: 1px solid var(--border-glass); border-radius: 10px; padding: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 6px;">
                        <span style="font-size: 0.75rem; font-weight: 800; color: var(--text-secondary);">${platformIcon}</span>
                        ${statusBadge}
                    </div>
                    <div style="margin-bottom: 6px;">
                        <a href="${item.video_url}" target="_blank" rel="noopener noreferrer" style="color: var(--neon-cyan, #0284c7); font-size: 0.78rem; text-decoration: underline; word-break: break-all; display: inline-block; font-weight: 600;">
                            🔗 ${item.video_url}
                        </a>
                    </div>
                    ${item.notes ? `<div style="font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 4px;">📝 <i>${item.notes}</i></div>` : ''}
                    ${item.admin_note ? `<div style="font-size: 0.75rem; color: ${item.status === 'approved' ? '#059669' : '#dc2626'}; margin-top: 4px; padding: 6px 10px; background: ${item.status === 'approved' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; border: 1px solid ${item.status === 'approved' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}; border-radius: 6px;"><b>অ্যাডমিন মন্তব্য:</b> ${item.admin_note}</div>` : ''}
                    <div style="font-size: 0.68rem; color: var(--text-muted); margin-top: 6px;">তারিখ: ${item.created_at || ''}</div>
                </div>
            `;
        });
        html += '</div>';
        listEl.innerHTML = html;
    } catch (e) {
        listEl.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 12px; font-size: 0.8rem;">ভিডিও হিস্ট্রি লোড করতে ব্যর্থ হয়েছে</div>';
    }
}

async function loadAdminPromotions() {
    const tbody = document.getElementById('adminPromotionsBody');
    const badge = document.getElementById('adminPendingPromotionsBadge');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">লোড হচ্ছে...</td></tr>';

    try {
        const res = await fetchWithAuth('/api/admin/promotions');
        if (!res.ok) throw new Error('Failed to fetch admin promotions');
        const items = await res.json();

        let pendingCount = 0;
        if (Array.isArray(items)) {
            items.forEach(it => { if (it.status === 'pending') pendingCount++; });
        }

        if (badge) {
            badge.innerText = pendingCount;
            badge.style.display = pendingCount > 0 ? 'inline-block' : 'none';
        }

        if (!items || items.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 24px;">কোনো ভিডিও প্রমোশন রিকোয়েস্ট পাওয়া যায়নি 🎉</td></tr>';
            return;
        }

        let html = '';
        items.forEach(it => {
            let statusHtml = '';
            if (it.status === 'approved') {
                statusHtml = `<span class="badge-status approved" style="font-size: 0.72rem;">🟢 Approved (+৳${it.reward_amount})</span>`;
            } else if (it.status === 'rejected') {
                statusHtml = `<span class="badge-status rejected" style="font-size: 0.72rem;">🔴 Rejected</span>`;
            } else {
                statusHtml = `<span class="badge-status pending" style="font-size: 0.72rem; animation: pulse 1.5s infinite;">🟡 Pending</span>`;
            }

            let platBadge = (it.platform || 'other').toUpperCase();
            let platColor = '#94a3b8';
            if (platBadge === 'YOUTUBE') platColor = '#ef4444';
            else if (platBadge === 'TIKTOK') platColor = '#00f59b';
            else if (platBadge === 'FACEBOOK') platColor = '#3b82f6';
            else if (platBadge === 'INSTAGRAM') platColor = '#a855f7';

            let actionsHtml = '';
            if (it.status === 'pending') {
                actionsHtml = `
                    <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                        <button type="button" class="btn btn-sm" style="background: #10b981; color: #fff; font-weight: 700; padding: 4px 10px; font-size: 0.75rem; border-radius: 6px; cursor: pointer;" onclick="adminActionPromotion(${it.id}, 'approve')">
                            ✅ Approve
                        </button>
                        <button type="button" class="btn btn-sm" style="background: #ef4444; color: #fff; font-weight: 700; padding: 4px 10px; font-size: 0.75rem; border-radius: 6px; cursor: pointer;" onclick="adminActionPromotion(${it.id}, 'reject')">
                            ❌ Reject
                        </button>
                    </div>
                `;
            } else if (it.status === 'approved') {
                actionsHtml = `
                    <div style="font-size: 0.75rem; color: #10b981; font-weight: 800;">
                        ৳${it.reward_amount} রিওয়ার্ড
                    </div>
                    <small style="color: #64748b; font-size: 0.7rem;">বাই: ${it.reviewed_by_name || 'Admin'}</small>
                `;
            } else {
                actionsHtml = `
                    <div style="font-size: 0.75rem; color: #ef4444; font-weight: 700;">
                        বাতিল
                    </div>
                    <small style="color: #64748b; font-size: 0.7rem;">${it.admin_note || ''}</small>
                `;
            }

            html += `
                <tr>
                    <td>
                        <div style="font-weight: 800; color: var(--text-primary);">${it.username || 'User #' + it.user_id}</div>
                        <div style="font-size: 0.75rem; color: var(--text-muted);">${it.phone || 'No phone'}</div>
                        <div style="font-size: 0.75rem; color: #059669; font-weight: 700;">Wallet: ৳${it.digits_balance || 0}</div>
                    </td>
                    <td>
                        <span style="font-weight: 800; font-size: 0.75rem; color: ${platColor}; background: var(--bg-card-hover); padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border-glass);">
                            ${platBadge}
                        </span>
                    </td>
                    <td>
                        <a href="${it.video_url}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 0.75rem; color: var(--neon-cyan, #0284c7); border-color: rgba(2, 132, 199, 0.4);">
                            ▶️ Open Video ↗️
                        </a>
                        <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 4px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                            ${it.video_url}
                        </div>
                    </td>
                    <td style="max-width: 160px; font-size: 0.78rem; color: var(--text-secondary);">
                        ${it.notes || '<span style="color:var(--text-muted);">—</span>'}
                    </td>
                    <td>${statusHtml}</td>
                    <td style="font-size: 0.75rem; color: var(--text-muted); white-space: nowrap;">
                        ${it.created_at ? it.created_at.replace('T', ' ').substring(0, 16) : ''}
                    </td>
                    <td>${actionsHtml}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #ef4444; padding: 24px;">ডাটা লোড করতে সমস্যা হয়েছে</td></tr>';
    }
}

async function adminActionPromotion(promoId, action) {
    if (action === 'approve') {
        const rewardStr = prompt('প্লেয়ারের ওয়ালেটে কত টাকা রিওয়ার্ড দিতে চান? (টাকা/Digits):', '50');
        if (rewardStr === null) return;
        const reward = parseInt(rewardStr, 10);
        if (isNaN(reward) || reward <= 0) {
            showToast('সঠিক টাকার অঙ্ক লিখুন (যেমন: ৫০ বা ১০০)', 'warning');
            return;
        }
        const admin_note = prompt('অ্যাডমিন মন্তব্য / নোট (ঐচ্ছিক):', 'চমৎকার ভিডিও! চালিয়ে যান।');

        try {
            const res = await fetchWithAuth(`/api/admin/promotions/${promoId}/action`, {
                method: 'POST',
                body: JSON.stringify({ action: 'approve', reward_amount: reward, admin_note: admin_note || '' })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Action failed');
            showToast(data.message || 'অনুমোদিত ও রিওয়ার্ড প্রদান সম্পন্ন!', 'success');
            loadAdminPromotions();
            if (typeof loadAdminOverview === 'function') loadAdminOverview();
        } catch (err) {
            showToast(err.message || 'অপারেশন ব্যর্থ হয়েছে', 'error');
        }
    } else if (action === 'reject') {
        const note = prompt('ভিডিও বাতিল করার কারণ লিখুন:', 'ভিডিওতে সাইটের নাম/লিংক পাওয়া যায়নি');
        if (note === null) return;

        try {
            const res = await fetchWithAuth(`/api/admin/promotions/${promoId}/action`, {
                method: 'POST',
                body: JSON.stringify({ action: 'reject', admin_note: note })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || 'Action failed');
            showToast(data.message || 'প্রমোশন বাতিল করা হয়েছে', 'info');
            loadAdminPromotions();
            if (typeof loadAdminOverview === 'function') loadAdminOverview();
        } catch (err) {
            showToast(err.message || 'অপারেশন ব্যর্থ হয়েছে', 'error');
        }
    }
}

window.openPromotionModal = openPromotionModal;
window.handlePromoUrlInput = handlePromoUrlInput;
window.handlePromotionSubmit = handlePromotionSubmit;
window.loadMyPromotions = loadMyPromotions;
window.loadAdminPromotions = loadAdminPromotions;
window.adminActionPromotion = adminActionPromotion;

// =============================================================
// Custom Challenge Arena (1v1 & 4v4 Escrow Battles)
// =============================================================

function openChallengeModal() {
    if (!localStorage.getItem('ff_token')) {
        showToast('Please sign in or register to enter Challenge Arena', 'error');
        openModal('authModal');
        return;
    }
    openModal('challengeModal');
    calculateChallengePool();
}

function switchChallengeTab(tabName) {
    const tabs = ['create', 'my', 'lobby'];
    tabs.forEach(t => {
        const btn = document.getElementById(`chTabBtn-${t}`);
        const content = document.getElementById(`chContent-${t}`);
        if (btn && content) {
            if (t === tabName) {
                btn.style.background = '#10b981';
                btn.style.color = '#ffffff';
                content.style.display = 'block';
            } else {
                btn.style.background = 'transparent';
                btn.style.color = '#64748b';
                content.style.display = 'none';
            }
        }
    });

    if (tabName === 'my') {
        loadMyChallenges();
    } else if (tabName === 'lobby') {
        loadOpenLobbies();
    }
}

function selectChallengeMode(mode) {
    const btn1 = document.getElementById('chModeBtn-1v1');
    const btn4 = document.getElementById('chModeBtn-4v4');
    const input = document.getElementById('chSelectedMode');
    if (input) input.value = mode;

    if (mode === '1v1') {
        if (btn1) {
            btn1.style.border = '2px solid #10b981';
            btn1.style.background = '#ecfdf5';
            btn1.style.color = '#065f46';
            btn1.style.fontWeight = '800';
        }
        if (btn4) {
            btn4.style.border = '1px solid #cbd5e1';
            btn4.style.background = '#ffffff';
            btn4.style.color = '#475569';
            btn4.style.fontWeight = '700';
        }
    } else {
        if (btn4) {
            btn4.style.border = '2px solid #10b981';
            btn4.style.background = '#ecfdf5';
            btn4.style.color = '#065f46';
            btn4.style.fontWeight = '800';
        }
        if (btn1) {
            btn1.style.border = '1px solid #cbd5e1';
            btn1.style.background = '#ffffff';
            btn1.style.color = '#475569';
            btn1.style.fontWeight = '700';
        }
    }
}

function setChallengeFee(val) {
    const feeInput = document.getElementById('chFeeInput');
    if (feeInput) feeInput.value = val;

    document.querySelectorAll('.ch-fee-preset').forEach(btn => {
        if (parseInt(btn.innerText.trim()) === val) {
            btn.style.border = '2px solid #10b981';
            btn.style.background = '#ecfdf5';
            btn.style.color = '#065f46';
            btn.style.fontWeight = '800';
        } else {
            btn.style.border = '1px solid #cbd5e1';
            btn.style.background = '#ffffff';
            btn.style.color = '#334155';
            btn.style.fontWeight = '700';
        }
    });

    calculateChallengePool();
}

function calculateChallengePool() {
    const feeInput = document.getElementById('chFeeInput');
    const fee = parseInt(feeInput ? feeInput.value : 50) || 50;
    const totalPool = fee * 2;
    const winnerReward = Math.floor(totalPool * 0.90);
    const platformFee = totalPool - winnerReward;

    const totalEl = document.getElementById('chTotalPoolDisplay');
    const winEl = document.getElementById('chWinnerRewardDisplay');
    const platEl = document.getElementById('chPlatformFeeDisplay');

    if (totalEl) totalEl.innerText = `BDT ${totalPool}`;
    if (winEl) winEl.innerText = `BDT ${winnerReward}`;
    if (platEl) platEl.innerText = `BDT ${platformFee}`;
}

function setGunAttr(val) {
    const valInput = document.getElementById('chGunAttrVal');
    if (valInput) valInput.value = val;
    const offBtn = document.getElementById('chGunOff');
    const onBtn = document.getElementById('chGunOn');
    if (val === 0) {
        if (offBtn) { offBtn.style.background = '#10b981'; offBtn.style.color = 'white'; offBtn.style.border = '1px solid #10b981'; }
        if (onBtn) { onBtn.style.background = 'white'; onBtn.style.color = '#64748b'; onBtn.style.border = '1px solid #cbd5e1'; }
    } else {
        if (onBtn) { onBtn.style.background = '#10b981'; onBtn.style.color = 'white'; onBtn.style.border = '1px solid #10b981'; }
        if (offBtn) { offBtn.style.background = 'white'; offBtn.style.color = '#64748b'; offBtn.style.border = '1px solid #cbd5e1'; }
    }
}

function setAmmo(val) {
    const valInput = document.getElementById('chAmmoVal');
    if (valInput) valInput.value = val;
    const yesBtn = document.getElementById('chAmmoYes');
    const noBtn = document.getElementById('chAmmoNo');
    if (val === 1) {
        if (yesBtn) { yesBtn.style.background = '#10b981'; yesBtn.style.color = 'white'; yesBtn.style.border = '1px solid #10b981'; }
        if (noBtn) { noBtn.style.background = 'white'; noBtn.style.color = '#64748b'; noBtn.style.border = '1px solid #cbd5e1'; }
    } else {
        if (noBtn) { noBtn.style.background = '#10b981'; noBtn.style.color = 'white'; noBtn.style.border = '1px solid #10b981'; }
        if (yesBtn) { yesBtn.style.background = 'white'; yesBtn.style.color = '#64748b'; yesBtn.style.border = '1px solid #cbd5e1'; }
    }
}

function selectChallengePrivacy(type) {
    const hidden = document.getElementById('chSelectedPrivacy');
    if (hidden) hidden.value = type;

    const pubBtn = document.getElementById('chPrivacyPublicBtn');
    const privBtn = document.getElementById('chPrivacyPrivateBtn');
    const timeSec = document.getElementById('chTimeConfigSection');
    const noticeBox = document.getElementById('chPrivateNoticeBox');
    const hint = document.getElementById('chPrivacyHint');

    if (type === 'public') {
        if (pubBtn) {
            pubBtn.style.background = '#ecfdf5';
            pubBtn.style.color = '#065f46';
            pubBtn.style.border = '2px solid #10b981';
            pubBtn.style.fontWeight = '800';
        }
        if (privBtn) {
            privBtn.style.background = '#ffffff';
            privBtn.style.color = '#475569';
            privBtn.style.border = '1px solid #cbd5e1';
            privBtn.style.fontWeight = '700';
        }
        if (timeSec) timeSec.style.display = 'block';
        if (noticeBox) noticeBox.style.display = 'none';
        if (hint) hint.innerText = 'ওপেন লবিতে সবার জন্য উন্মুক্ত থাকবে';
    } else {
        if (privBtn) {
            privBtn.style.background = '#eff6ff';
            privBtn.style.color = '#1e40af';
            privBtn.style.border = '2px solid #3b82f6';
            privBtn.style.fontWeight = '800';
        }
        if (pubBtn) {
            pubBtn.style.background = '#ffffff';
            pubBtn.style.color = '#475569';
            pubBtn.style.border = '1px solid #cbd5e1';
            pubBtn.style.fontWeight = '700';
        }
        if (timeSec) timeSec.style.display = 'none';
        if (noticeBox) noticeBox.style.display = 'block';
        if (hint) hint.innerText = 'শুধুমাত্র ইনভাইট লিংক দিয়ে জয়েন করা যাবে';
    }
}

function setChallengeTimePreset(val, idx) {
    const inp = document.getElementById('chMatchTimeInput');
    if (inp) inp.value = val;

    for (let i = 1; i <= 3; i++) {
        const b = document.getElementById(`chTimePreset-${i}`);
        if (b) {
            if (i === idx) {
                b.style.background = '#ecfdf5';
                b.style.color = '#065f46';
                b.style.border = '2px solid #10b981';
                b.style.fontWeight = '800';
            } else {
                b.style.background = '#ffffff';
                b.style.color = '#334155';
                b.style.border = '1px solid #cbd5e1';
                b.style.fontWeight = '700';
            }
        }
    }
}

async function parseResponseSafe(res) {
    try {
        const text = await res.text();
        try {
            return JSON.parse(text);
        } catch (_) {
            if (res.status === 500 || (text && text.includes('Internal Server Error'))) {
                return { detail: 'সার্ভার রেসপন্স করতে সমস্যা হচ্ছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' };
            }
            return { detail: (text && text.length < 150) ? text : `Server error (${res.status})` };
        }
    } catch (e) {
        return { detail: `Network error (${res.status || 'unknown'})` };
    }
}

let latestCreatedChallengeCode = null;

async function handleCreateChallenge(event) {
    event.preventDefault();
    const btn = document.getElementById('chSubmitBtn');
    if (btn) btn.disabled = true;

    try {
        const mode = document.getElementById('chSelectedMode').value;
        const entry_fee = parseInt(document.getElementById('chFeeInput').value) || 50;
        const gun_attributes = parseInt(document.getElementById('chGunAttrVal').value) || 0;
        const limited_ammo = parseInt(document.getElementById('chAmmoVal').value) || 0;
        const room_creator_role = document.getElementById('chRoomHost').value;
        const visibility = (document.getElementById('chSelectedPrivacy')?.value || 'public').trim();
        const match_time = visibility === 'public' ? (document.getElementById('chMatchTimeInput')?.value || 'Instant (5 mins)').trim() : '';

        const res = await fetchWithAuth('/api/challenges/create', {
            method: 'POST',
            body: JSON.stringify({
                mode,
                entry_fee,
                gun_attributes,
                limited_ammo,
                room_creator_role,
                visibility,
                match_time
            })
        });

        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Could not create challenge');

        latestCreatedChallengeCode = data.challenge_code;
        const shareCard = document.getElementById('chShareCard');
        const shareInput = document.getElementById('chShareLinkInput');
        const waBtn = document.getElementById('chWhatsAppShareBtn');

        const shareUrl = `${window.location.origin}/?challenge=${data.challenge_code}#challenge=${data.challenge_code}`;
        if (shareInput) shareInput.value = shareUrl;

        if (waBtn) {
            const timeLine = data.match_time ? `\n⏰ ম্যাচ শুরুর সময়: ${data.match_time}` : '';
            const privLine = data.visibility === 'private' ? ' (Private Match)' : '';
            const msg = encodeURIComponent(`⚔️ Free Fire ${mode}${privLine} Custom Challenge!\n💰 Entry Fee: ৳${entry_fee} | Winner Prize: ৳${data.prize_amount}${timeLine}\n🔥 চ্যালেঞ্জ গ্রহণ করতে এই লিংকে ক্লিক করুন:\n${shareUrl}`);
            waBtn.href = `https://wa.me/?text=${msg}`;
        }

        if (shareCard) shareCard.style.display = 'block';
        showToast('Challenge created! Stake locked in escrow.', 'success');
        if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
    } catch (err) {
        showToast(err.message || 'Challenge creation failed', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function copyChallengeLink() {
    const input = document.getElementById('chShareLinkInput');
    if (input && input.value) {
        navigator.clipboard.writeText(input.value);
        showToast('Challenge link copied to clipboard!', 'success');
    }
}

async function loadMyChallenges() {
    const container = document.getElementById('chMyListContainer');
    if (!container) return;
    container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 20px;">Loading your challenges...</div>';

    try {
        const res = await fetchWithAuth('/api/challenges/my');
        const list = await parseResponseSafe(res);
        if (!res.ok || !Array.isArray(list)) throw new Error((list && (list.detail || list.message)) || 'Failed to load challenges');

        if (!list || list.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 30px 10px; font-size: 0.88rem;">No active challenges found. Create one to begin.</div>';
            return;
        }

        let html = '';
        list.forEach(c => {
            const statusBg = c.status === 'completed' ? '#dcfce7' : c.status === 'open' ? '#fef3c7' : c.status === 'disputed' ? '#fee2e2' : '#e0f2fe';
            const statusColor = c.status === 'completed' ? '#15803d' : c.status === 'open' ? '#b45309' : c.status === 'disputed' ? '#b91c1c' : '#0369a1';

            const isCreator = currentUser && currentUser.id === c.creator_id;
            const myName = isCreator ? (c.creator_name || 'You') : (c.rival_name || currentUser?.username || 'You');
            const myIgn = isCreator ? c.creator_ign : (c.rival_ign || currentUser?.ff_ign || '');
            const myRole = isCreator ? 'Host' : 'Challenger';

            const oppName = isCreator ? (c.rival_name || (c.status === 'open' ? 'Waiting for rival...' : 'Challenger')) : (c.creator_name || 'Host');
            const oppIgn = isCreator ? c.rival_ign : c.creator_ign;
            const oppRole = isCreator ? 'Challenger' : 'Host';

            let actionHtml = '';
            if (c.status === 'open') {
                const myShareUrl = `${window.location.origin}/?challenge=${c.challenge_code}#challenge=${c.challenge_code}`;
                actionHtml = `
                    <div style="margin-top: 10px; padding: 8px 10px; background: rgba(245, 158, 11, 0.08); border: 1px solid rgba(245, 158, 11, 0.2); border-radius: 8px; font-size: 0.76rem; color: #b45309; font-weight: 600; margin-bottom: 8px;">
                        ⏳ কোনো প্রতিপক্ষ এখনও জয়েন করেনি। নিচের লিংকটি প্রতিপক্ষকে পাঠান।
                    </div>
                    <div style="display: flex; gap: 8px;">
                        <button type="button" class="btn btn-sm" onclick="navigator.clipboard.writeText('${myShareUrl}'); showToast('চ্যালেঞ্জ লিংক কপি হয়েছে!', 'success');"
                            style="flex: 1; background: #0f172a; color: white; padding: 8px 10px; font-size: 0.76rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer;">
                            📋 Copy Link
                        </button>
                        <button type="button" class="btn btn-sm" onclick="cancelChallenge('${c.challenge_code}')"
                            style="background: #ef4444; color: white; padding: 8px 10px; font-size: 0.76rem; font-weight: 700; border-radius: 6px; border: none; cursor: pointer;">
                            ✖ Cancel & Refund
                        </button>
                    </div>
                `;
            } else if (c.status === 'in_progress') {
                const isAdmin = currentUser && (currentUser.role === 'admin' || currentUser.role === 'moderator');
                let roomBox = '';

                if (c.room_id) {
                    roomBox = `
                        <div style="font-size: 0.82rem; color: #0f172a; font-weight: 700; margin-bottom: 6px;">
                            Room ID: <span style="font-family: monospace; color: #2563eb;">${c.room_id}</span> | Pass: <span style="font-family: monospace; color: #2563eb;">${c.room_password || 'None'}</span>
                        </div>
                        <button type="button" class="btn btn-sm" onclick="navigator.clipboard.writeText('${c.room_id}'); showToast('Room ID copied!', 'success');"
                            style="background: #2563eb; color: white; padding: 4px 10px; font-size: 0.72rem; border-radius: 6px; border: none;">
                            Copy Room ID
                        </button>
                    `;
                } else if (c.room_creator_role === 'admin') {
                    if (isAdmin) {
                        roomBox = `
                            <div style="font-size: 0.78rem; font-weight: 700; color: #1e40af; margin-bottom: 6px;">Host: Admin Room (Provide ID & Pass)</div>
                            <div style="display: flex; gap: 6px; margin-bottom: 6px;">
                                <input type="text" id="chRoomIdInput-${c.challenge_code}" placeholder="Room ID" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; border-radius: 6px; border: 1px solid #cbd5e1;">
                                <input type="text" id="chRoomPassInput-${c.challenge_code}" placeholder="Pass" style="width: 80px; padding: 6px 8px; font-size: 0.78rem; border-radius: 6px; border: 1px solid #cbd5e1;">
                            </div>
                            <button type="button" class="btn btn-sm" onclick="submitChallengeRoom('${c.challenge_code}')"
                                style="background: #2563eb; color: white; padding: 6px 12px; font-size: 0.74rem; font-weight: 700; border-radius: 6px; border: none;">
                                Release Room & Start
                            </button>
                        `;
                    } else {
                        roomBox = `
                            <div style="font-size: 0.8rem; font-weight: 700; color: #1e40af; margin-bottom: 3px;">Host: Admin Will Create Room</div>
                            <div style="font-size: 0.74rem; color: #3b82f6;">Admin has been notified. The Room ID & Password will appear here once Admin creates it.</div>
                        `;
                    }
                } else {
                    if (isCreator || isAdmin) {
                        roomBox = `
                            <div style="font-size: 0.78rem; font-weight: 700; color: #334155; margin-bottom: 6px;">Provide Room ID & Password</div>
                            <div style="display: flex; gap: 6px; margin-bottom: 6px;">
                                <input type="text" id="chRoomIdInput-${c.challenge_code}" placeholder="Room ID" style="flex: 1; padding: 6px 8px; font-size: 0.78rem; border-radius: 6px; border: 1px solid #cbd5e1;">
                                <input type="text" id="chRoomPassInput-${c.challenge_code}" placeholder="Pass" style="width: 80px; padding: 6px 8px; font-size: 0.78rem; border-radius: 6px; border: 1px solid #cbd5e1;">
                            </div>
                            <button type="button" class="btn btn-sm" onclick="submitChallengeRoom('${c.challenge_code}')"
                                style="background: #10b981; color: white; padding: 6px 12px; font-size: 0.74rem; font-weight: 700; border-radius: 6px; border: none;">
                                Update Room
                            </button>
                        `;
                    } else {
                        roomBox = `
                            <div style="font-size: 0.8rem; font-weight: 700; color: #334155; margin-bottom: 3px;">Host: Creator Will Create Room</div>
                            <div style="font-size: 0.74rem; color: #64748b;">Waiting for the challenge creator to create room and release ID & Password.</div>
                        `;
                    }
                }

                actionHtml = `
                    <!-- Room Credentials Section -->
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-top: 10px;">
                        ${roomBox}
                    </div>

                    <!-- Submit Result / Google Drive Proof -->
                    <div style="border-top: 1px dashed #e2e8f0; padding-top: 12px; margin-top: 12px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                            <span style="font-size: 0.8rem; font-weight: 800; color: #0f172a;">Submit Match Result</span>
                            <span style="font-size: 0.68rem; color: #64748b;">(SS only needed if you Won)</span>
                        </div>
                        <input type="file" id="chProofFile-${c.challenge_code}" accept="image/*" 
                            style="font-size: 0.75rem; margin-bottom: 10px; display: block; width: 100%; padding: 7px; border: 1.5px dashed #94a3b8; border-radius: 8px; background: rgba(0,0,0,0.02); box-sizing: border-box;">
                        <div style="display: flex; gap: 10px;">
                            <button type="button" class="btn btn-sm" onclick="submitChallengeProof('${c.challenge_code}', 'won', ${c.prize_amount})"
                                style="flex: 1; background: #10b981; color: white; padding: 11px 8px; font-size: 0.78rem; font-weight: 800; border-radius: 8px; border: none; display: flex; align-items: center; justify-content: center; gap: 6px; box-shadow: 0 2px 6px rgba(16,185,129,0.25); cursor: pointer;">
                                <span>🏆</span> <span>I Won (Booyah)</span>
                            </button>
                            <button type="button" class="btn btn-sm" onclick="submitChallengeProof('${c.challenge_code}', 'lost', ${c.prize_amount})"
                                style="flex: 1; background: #334155; color: #f8fafc; padding: 11px 8px; font-size: 0.78rem; font-weight: 800; border-radius: 8px; border: 1px solid #475569; display: flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;">
                                <span>🏳️</span> <span>I Lost</span>
                            </button>
                        </div>
                    </div>
                `;
            } else if (c.status === 'completed') {
                const proofUrl = c.creator_screenshot || c.rival_screenshot;
                const isWinner = currentUser && currentUser.id === c.winner_id;
                actionHtml = `
                    <div style="margin-top: 10px; padding: 10px; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 8px; font-size: 0.8rem; color: #15803d; font-weight: 700;">
                        ${isWinner ? '🎉 আপনি এই ম্যাচে বিজয়ী হয়েছেন!' : '🏁 ম্যাচ সমাপ্ত হয়েছে।'} 
                        ${proofUrl ? `<div style="margin-top: 4px;"><a href="${proofUrl}" target="_blank" style="color: #2563eb; text-decoration: underline;">📸 View Google Drive Proof</a></div>` : ''}
                    </div>
                `;
            } else if (c.status === 'disputed') {
                actionHtml = `
                    <div style="margin-top: 10px; padding: 10px; background: rgba(239, 68, 68, 0.08); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 8px; font-size: 0.8rem; color: #b91c1c; font-weight: 700;">
                        ⚠️ উভয় প্লেয়ারই বিজয়ী দাবি করেছে (Disputed)। অ্যাডমিন গুগল ড্রাইভের স্ক্রিনশট রিভিউ করে উইনার নির্ধারণ করবেন।
                    </div>
                `;
            }

            const isPrivate = (c.visibility === 'private');
            const visBadge = isPrivate ? 
                `<span style="background: rgba(59, 130, 246, 0.12); color: #2563eb; font-size: 0.68rem; font-weight: 800; padding: 2px 7px; border-radius: 4px; margin-left: 6px; border: 1px solid rgba(59, 130, 246, 0.3);">🔒 PRIVATE</span>` : 
                `<span style="background: rgba(16, 185, 129, 0.12); color: #059669; font-size: 0.68rem; font-weight: 800; padding: 2px 7px; border-radius: 4px; margin-left: 6px; border: 1px solid rgba(16, 185, 129, 0.3);">🌐 PUBLIC</span>`;
            const timeTag = c.match_time ? `<span style="font-size: 0.72rem; color: #d97706; font-weight: 700; background: rgba(245, 158, 11, 0.1); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(245, 158, 11, 0.25);">⏰ ${escapeHtml(c.match_time)}</span>` : '';

            html += `
                <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 14px; margin-bottom: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.04);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <span style="font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 1.05rem; color: #0f172a;">${escapeHtml(c.challenge_code)} (${escapeHtml(c.mode)})${visBadge}</span>
                        <span style="background: ${statusBg}; color: ${statusColor}; font-size: 0.72rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; text-transform: uppercase;">${escapeHtml(c.status)}</span>
                    </div>

                    <div style="font-size: 0.8rem; color: #475569; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                        <span>Stake: <b style="color: #0f172a;">BDT ${c.entry_fee}</b> | Prize: <b style="color: #10b981;">BDT ${c.prize_amount}</b></span>
                        ${timeTag}
                    </div>

                    <!-- VS Battle Display Box -->
                    <div style="background: rgba(15, 23, 42, 0.04); border: 1px solid rgba(0,0,0,0.06); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                            <!-- Left: YOU -->
                            <div style="flex: 1; text-align: left; min-width: 0;">
                                <div style="display: flex; align-items: center; gap: 4px; margin-bottom: 2px;">
                                    <span style="background: #10b981; color: white; font-size: 0.62rem; font-weight: 800; padding: 1px 6px; border-radius: 4px; text-transform: uppercase;">YOU</span>
                                    <span style="font-size: 0.68rem; color: #64748b; font-weight: 700;">(${myRole})</span>
                                </div>
                                <div style="font-size: 0.88rem; font-weight: 800; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                    ${escapeHtml(myName)}
                                </div>
                                <div style="font-size: 0.72rem; color: #64748b;">
                                    IGN: <b style="color: #059669;">${escapeHtml(myIgn || 'Not set')}</b>
                                </div>
                            </div>

                            <!-- VS Badge -->
                            <div style="width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #ef4444, #f59e0b); display: flex; align-items: center; justify-content: center; font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 900; color: white; box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3); flex-shrink: 0;">
                                VS
                            </div>

                            <!-- Right: OPPONENT -->
                            <div style="flex: 1; text-align: right; min-width: 0;">
                                <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-bottom: 2px;">
                                    <span style="font-size: 0.68rem; color: #64748b; font-weight: 700;">(${oppRole})</span>
                                    <span style="background: ${c.rival_id || !isCreator ? '#ef4444' : '#94a3b8'}; color: white; font-size: 0.62rem; font-weight: 800; padding: 1px 6px; border-radius: 4px; text-transform: uppercase;">OPPONENT</span>
                                </div>
                                <div style="font-size: 0.88rem; font-weight: 800; color: ${c.rival_id || !isCreator ? '#0f172a' : '#94a3b8'}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                    ${escapeHtml(oppName)}
                                </div>
                                <div style="font-size: 0.72rem; color: #64748b;">
                                    IGN: <b style="color: #dc2626;">${escapeHtml(oppIgn || (c.rival_id || !isCreator ? 'Not set' : 'Waiting...'))}</b>
                                </div>
                            </div>
                        </div>
                    </div>

                    ${actionHtml}
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 20px;">Could not load challenges.</div>';
    }
}

async function submitChallengeRoom(code) {
    const rId = (document.getElementById(`chRoomIdInput-${code}`)?.value || '').trim();
    const rPass = (document.getElementById(`chRoomPassInput-${code}`)?.value || '').trim();
    if (!rId) {
        showToast('Please enter Room ID', 'error');
        return;
    }

    try {
        const res = await fetchWithAuth(`/api/challenges/${code}/set-room`, {
            method: 'POST',
            body: JSON.stringify({ room_id: rId, room_password: rPass })
        });
        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Failed to update room');
        showToast('Room details updated!', 'success');
        loadMyChallenges();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function submitChallengeProof(code, claim, prize) {
    if (claim === 'lost') {
        const prizeTxt = prize ? `BDT ${prize}` : 'প্রাইজ মানি';
        const msg = `⚠️ আপনি কি নিশ্চিত যে আপনি এই ম্যাচে হেরে গেছেন?\n\nএটি কনফার্ম করলে ম্যাচ সাথে সাথে শেষ হয়ে যাবে এবং আপনার প্রতিপক্ষ উইনার হিসেবে ${prizeTxt} পেয়ে যাবে!`;
        if (!confirm(msg)) return;
        try {
            showToast('পরাজয় রেকর্ড করা হচ্ছে...', 'info');
            const res = await fetchWithAuth(`/api/challenges/${code}/submit-proof`, {
                method: 'POST',
                body: JSON.stringify({ claim: 'lost', image: '' })
            });
            const data = await parseResponseSafe(res);
            if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Failed to submit');
            showToast('রেজাল্ট সাবমিট হয়েছে।', 'info');
            loadMyChallenges();
            if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
        } catch (e) {
            showToast(e.message, 'error');
        }
        return;
    }

    const fileInput = document.getElementById(`chProofFile-${code}`);
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        showToast('⚠️ বিজয়ী দাবি করতে প্রথমে Booyah স্ক্রিনশট ফাইল সিলেক্ট করুন!', 'error');
        if (fileInput) fileInput.focus();
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();
    reader.onload = async function(e) {
        const base64 = e.target.result;
        showToast('Uploading proof to Google Drive...', 'info');
        try {
            const res = await fetchWithAuth(`/api/challenges/${code}/submit-proof`, {
                method: 'POST',
                body: JSON.stringify({ claim: 'won', image: base64 })
            });
            const data = await parseResponseSafe(res);
            if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Upload failed');
            showToast('Proof uploaded to Google Drive & result submitted!', 'success');
            loadMyChallenges();
            if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
        } catch (err) {
            showToast(err.message || 'Submission failed', 'error');
        }
    };
    reader.readAsDataURL(file);
}

async function cancelChallenge(code) {
    if (!confirm('Are you sure you want to cancel this challenge and get refunded?')) return;
    try {
        const res = await fetchWithAuth(`/api/challenges/${code}/cancel`, { method: 'POST' });
        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Cancel failed');
        showToast(data.message || 'Challenge cancelled and refunded.', 'success');
        loadMyChallenges();
        if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function loadOpenLobbies() {
    const container = document.getElementById('chLobbyListContainer');
    if (!container) return;
    container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 20px;">Scanning open lobbies...</div>';

    try {
        const res = await fetchWithAuth('/api/challenges/open');
        const list = await parseResponseSafe(res);
        if (!res.ok || !Array.isArray(list)) throw new Error((list && (list.detail || list.message)) || 'Failed to load lobbies');

        if (!list || list.length === 0) {
            container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 30px 10px; font-size: 0.88rem;">No open lobbies available right now. Check back shortly.</div>';
            return;
        }

        let html = '';
        list.forEach(c => {
            const timeBadge = c.match_time ? `
                <div style="margin-top: 5px; display: inline-flex; align-items: center; gap: 4px; background: rgba(245, 158, 11, 0.12); color: #b45309; border: 1px solid rgba(245, 158, 11, 0.3); font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 6px;">
                    <span>⏰ শুরু:</span> <span>${escapeHtml(c.match_time)}</span>
                </div>
            ` : `
                <div style="margin-top: 5px; display: inline-flex; align-items: center; gap: 4px; background: rgba(16, 185, 129, 0.1); color: #059669; font-size: 0.72rem; font-weight: 800; padding: 2px 7px; border-radius: 6px;">
                    <span>⚡ ইনস্ট্যান্ট (৫ মি.)</span>
                </div>
            `;

            html += `
                <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
                    <div style="flex: 1; min-width: 0;">
                        <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                            <span style="font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 1.05rem; color: #0f172a;">${escapeHtml(c.mode)} by ${escapeHtml(c.creator_name)}</span>
                            ${c.creator_ign ? `<span style="font-size: 0.68rem; color: #64748b; background: rgba(0,0,0,0.05); padding: 1px 6px; border-radius: 4px;">IGN: ${escapeHtml(c.creator_ign)}</span>` : ''}
                        </div>
                        <div style="font-size: 0.8rem; color: #475569; margin-top: 2px;">
                            Entry: <b>BDT ${c.entry_fee}</b> | Win: <b style="color: #10b981;">BDT ${c.prize_amount}</b>
                        </div>
                        ${timeBadge}
                    </div>
                    <button type="button" class="btn btn-sm" onclick="acceptChallenge('${c.challenge_code}')"
                        style="background: #10b981; color: white; font-weight: 800; font-size: 0.82rem; padding: 9px 16px; border-radius: 8px; border: none; cursor: pointer; flex-shrink: 0; box-shadow: 0 2px 6px rgba(16, 185, 129, 0.25);">
                        Accept
                    </button>
                </div>
            `;
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 20px;">Could not load open lobbies.</div>';
    }
}

async function acceptChallenge(code) {
    if (!confirm(`Are you sure you want to accept challenge ${code}? Your entry fee will be deducted and held in escrow.`)) return;

    try {
        const res = await fetchWithAuth(`/api/challenges/${code}/accept`, { method: 'POST' });
        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Could not accept challenge');

        showToast('Challenge accepted! Match is now active.', 'success');
        switchChallengeTab('my');
        if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
    } catch (err) {
        showToast(err.message || 'Failed to accept challenge', 'error');
    }
}

async function loadAdminChallenges() {
    const tbody = document.getElementById('adminChallengesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">Loading challenges...</td></tr>';

    try {
        const res = await fetchWithAuth('/api/admin/challenges');
        const list = await parseResponseSafe(res);
        if (!res.ok || !Array.isArray(list)) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #ef4444; padding: 20px;">Could not load challenges.</td></tr>';
            return;
        }

        if (list.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px;">No custom challenges found.</td></tr>';
            return;
        }

        let html = '';
        list.forEach(c => {
            const isNeedsAdminRoom = (c.room_creator_role === 'admin' && c.status === 'in_progress' && !c.room_id);
            const isDisputed = (c.status === 'disputed');
            const rowBg = isDisputed ? '#fff1f2' : isNeedsAdminRoom ? '#eff6ff' : 'transparent';

            let actionHtml = '';
            if (c.status === 'in_progress') {
                if (!c.room_id) {
                    actionHtml = `
                        <div style="display: flex; gap: 4px; align-items: center;">
                            <input type="text" id="admChRoomId-${c.challenge_code}" placeholder="Room ID" style="width: 85px; padding: 4px 6px; font-size: 0.74rem; border: 1px solid #cbd5e1; border-radius: 4px;">
                            <input type="text" id="admChRoomPass-${c.challenge_code}" placeholder="Pass" style="width: 55px; padding: 4px 6px; font-size: 0.74rem; border: 1px solid #cbd5e1; border-radius: 4px;">
                            <button type="button" class="btn btn-sm" onclick="adminSubmitChallengeRoom('${c.challenge_code}')"
                                style="background: #2563eb; color: white; font-size: 0.72rem; padding: 5px 8px; border-radius: 4px; border: none; font-weight: 700; white-space: nowrap;">
                                Release & Start
                            </button>
                        </div>
                    `;
                } else {
                    actionHtml = `
                        <div style="display: flex; gap: 4px; align-items: center;">
                            <span style="font-family: monospace; font-size: 0.74rem; color: #2563eb;">${c.room_id} / ${c.room_password || '-'}</span>
                            <button type="button" class="btn btn-sm" onclick="document.getElementById('admChEditBox-${c.challenge_code}').style.display='flex'; this.style.display='none';"
                                style="background: #64748b; color: white; font-size: 0.68rem; padding: 3px 6px; border-radius: 4px; border: none;">Edit</button>
                        </div>
                        <div id="admChEditBox-${c.challenge_code}" style="display: none; gap: 4px; margin-top: 4px;">
                            <input type="text" id="admChRoomId-${c.challenge_code}" value="${c.room_id}" style="width: 85px; padding: 4px 6px; font-size: 0.74rem; border: 1px solid #cbd5e1; border-radius: 4px;">
                            <input type="text" id="admChRoomPass-${c.challenge_code}" value="${c.room_password || ''}" style="width: 55px; padding: 4px 6px; font-size: 0.74rem; border: 1px solid #cbd5e1; border-radius: 4px;">
                            <button type="button" class="btn btn-sm" onclick="adminSubmitChallengeRoom('${c.challenge_code}')"
                                style="background: #10b981; color: white; font-size: 0.72rem; padding: 4px 8px; border-radius: 4px; border: none; font-weight: 700;">Save</button>
                        </div>
                    `;
                }
            } else if (c.status === 'disputed') {
                actionHtml = `
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div style="display: flex; gap: 4px;">
                            ${c.creator_screenshot ? `<a href="${c.creator_screenshot}" target="_blank" style="font-size: 0.70rem; color: #2563eb; text-decoration: underline;">Creator Proof</a>` : '<span style="font-size: 0.70rem; color: #94a3b8;">No Creator Proof</span>'}
                            ${c.rival_screenshot ? `<a href="${c.rival_screenshot}" target="_blank" style="font-size: 0.70rem; color: #2563eb; text-decoration: underline;">Rival Proof</a>` : '<span style="font-size: 0.70rem; color: #94a3b8;">No Rival Proof</span>'}
                        </div>
                        <div style="display: flex; gap: 4px;">
                            <button type="button" class="btn btn-xs" onclick="adminResolveChallenge('${c.challenge_code}', 'creator')" style="background: #10b981; color: white; font-size: 0.68rem; padding: 3px 6px; border: none; border-radius: 4px;">Creator Won</button>
                            <button type="button" class="btn btn-xs" onclick="adminResolveChallenge('${c.challenge_code}', 'rival')" style="background: #3b82f6; color: white; font-size: 0.68rem; padding: 3px 6px; border: none; border-radius: 4px;">Rival Won</button>
                            <button type="button" class="btn btn-xs" onclick="adminResolveChallenge('${c.challenge_code}', 'refund')" style="background: #ef4444; color: white; font-size: 0.68rem; padding: 3px 6px; border: none; border-radius: 4px;">Refund</button>
                        </div>
                    </div>
                `;
            } else if (c.status === 'completed') {
                actionHtml = `<span style="color: #15803d; font-weight: 700; font-size: 0.74rem;">Winner Paid</span>`;
            } else if (c.status === 'open') {
                actionHtml = `<span style="color: #b45309; font-weight: 700; font-size: 0.74rem;">Waiting for Rival</span>`;
            } else {
                actionHtml = `<span style="color: #64748b; font-size: 0.74rem;">${c.status}</span>`;
            }

            html += `
                <tr style="background: ${rowBg};">
                    <td>
                        <b style="font-family: 'Rajdhani', sans-serif; font-size: 0.92rem;">${c.challenge_code}</b>
                        <div style="font-size: 0.72rem; color: #64748b;">${c.mode}</div>
                    </td>
                    <td>
                        <div style="font-weight: 700; color: #0f172a;">${c.creator_name} <span style="font-size: 0.72rem; color: #64748b;">(${c.creator_ign || '-'})</span></div>
                        <div style="font-size: 0.74rem; color: #475569;">vs ${c.rival_name ? `${c.rival_name} (${c.rival_ign || '-'})` : '<i style="color: #94a3b8;">None</i>'}</div>
                    </td>
                    <td>
                        <div><b>BDT ${c.entry_fee}</b></div>
                        <div style="font-size: 0.72rem; color: #10b981; font-weight: 700;">Win: BDT ${c.prize_amount}</div>
                    </td>
                    <td>
                        <span style="font-weight: 700; font-size: 0.74rem; color: ${c.room_creator_role === 'admin' ? '#2563eb' : '#0f172a'};">
                            ${c.room_creator_role === 'admin' ? 'Admin' : 'Creator'}
                        </span>
                    </td>
                    <td>
                        <span style="font-size: 0.70rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; background: ${c.status === 'completed' ? '#dcfce7' : c.status === 'open' ? '#fef3c7' : c.status === 'disputed' ? '#fee2e2' : '#e0f2fe'}; color: ${c.status === 'completed' ? '#15803d' : c.status === 'open' ? '#b45309' : c.status === 'disputed' ? '#b91c1c' : '#0369a1'};">
                            ${isNeedsAdminRoom ? 'Needs Admin Room' : c.status}
                        </span>
                    </td>
                    <td colspan="2" style="padding: 8px;">
                        ${actionHtml}
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #ef4444; padding: 20px;">Could not load challenges.</td></tr>';
    }
}

async function adminSubmitChallengeRoom(code) {
    const rId = (document.getElementById(`admChRoomId-${code}`)?.value || '').trim();
    const rPass = (document.getElementById(`admChRoomPass-${code}`)?.value || '').trim();
    if (!rId) {
        showToast('Please enter Room ID', 'error');
        return;
    }

    try {
        const res = await fetchWithAuth(`/api/challenges/${code}/set-room`, {
            method: 'POST',
            body: JSON.stringify({ room_id: rId, room_password: rPass })
        });
        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Failed to update room');
        showToast(`Room ID released for #${code}! Match is active.`, 'success');
        loadAdminChallenges();
        loadAdminOverview();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

async function adminResolveChallenge(code, role) {
    if (!confirm(`Are you sure you want to resolve challenge #${code} with action: "${role}"?`)) return;
    try {
        const res = await fetchWithAuth(`/api/admin/challenges/${code}/resolve`, {
            method: 'POST',
            body: JSON.stringify({ winner_role: role })
        });
        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Resolution failed');
        showToast(data.message || 'Challenge resolved successfully!', 'success');
        loadAdminChallenges();
        loadAdminOverview();
    } catch (e) {
        showToast(e.message, 'error');
    }
}

window.openChallengeModal = openChallengeModal;
window.switchChallengeTab = switchChallengeTab;
window.selectChallengeMode = selectChallengeMode;
window.setChallengeFee = setChallengeFee;
window.calculateChallengePool = calculateChallengePool;
window.setGunAttr = setGunAttr;
window.setAmmo = setAmmo;
window.handleCreateChallenge = handleCreateChallenge;
window.copyChallengeLink = copyChallengeLink;
window.loadMyChallenges = loadMyChallenges;
window.loadOpenLobbies = loadOpenLobbies;
window.acceptChallenge = acceptChallenge;
window.submitChallengeRoom = submitChallengeRoom;
window.submitChallengeProof = submitChallengeProof;
window.cancelChallenge = cancelChallenge;
window.loadAdminChallenges = loadAdminChallenges;
window.adminSubmitChallengeRoom = adminSubmitChallengeRoom;
window.adminResolveChallenge = adminResolveChallenge;

// -------------------------------------------------------------
// Custom Challenge & Match Deep-Link Direct Access Engine
// -------------------------------------------------------------

function getDeepLinkChallengeCode() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        let code = urlParams.get('challenge');
        if (code && code.trim()) return code.trim();

        const hash = window.location.hash || '';
        if (hash.includes('challenge')) {
            const m = hash.match(/challenge[=/]([A-Za-z0-9_-]+)/i);
            if (m && m[1]) return m[1].trim();
        }

        const pending = sessionStorage.getItem('pending_challenge_code');
        if (pending && pending.trim()) return pending.trim();
    } catch (e) {}
    return null;
}

function getDeepLinkMatchId() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        let id = urlParams.get('match') || urlParams.get('match_id');
        if (id && id.trim()) return id.trim();

        const hash = window.location.hash || '';
        if (hash.includes('match')) {
            const m = hash.match(/match(?:_id)?[=/]([0-9]+)/i);
            if (m && m[1]) return m[1].trim();
        }

        const pending = sessionStorage.getItem('pending_match_id');
        if (pending && pending.trim()) return pending.trim();
    } catch (e) {}
    return null;
}

async function openChallengeByCode(code) {
    if (!code) return;
    const cleanCode = String(code).trim();
    sessionStorage.setItem('pending_challenge_code', cleanCode);

    openModal('challengeInviteModal');
    const body = document.getElementById('chInviteModalBody');
    if (!body) return;

    body.innerHTML = `
        <div style="text-align: center; color: #94a3b8; padding: 34px 16px;">
            <div style="width: 14px; height: 14px; border-radius: 50%; background: #10b981; margin: 0 auto 12px auto; box-shadow: 0 0 12px #10b981;"></div>
            <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.15rem; color: #f8fafc; font-weight: 700; letter-spacing: 0.5px;">CHALLENGE #${escapeHtml(cleanCode)}</div>
            <div style="font-size: 0.82rem; color: #94a3b8; margin-top: 4px;">চ্যালেঞ্জের সম্পূর্ণ তথ্য লোড করা হচ্ছে...</div>
        </div>
    `;

    try {
        const res = await fetch(`/api/challenges/${encodeURIComponent(cleanCode)}`);
        if (!res.ok) {
            body.innerHTML = `
                <div style="text-align: center; padding: 26px 16px; color: #cbd5e1;">
                    <div style="font-size: 2.4rem; margin-bottom: 8px;">⚠️</div>
                    <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.25rem; font-weight: 800; color: #f87171;">CHALLENGE NOT FOUND</div>
                    <p style="font-size: 0.82rem; color: #94a3b8; margin: 8px 0 18px 0; line-height: 1.4;">
                        এই চ্যালেঞ্জটি হয়তো হোস্ট বাতিল করেছেন অথবা লিংকটি ভুল।
                    </p>
                    <button type="button" class="btn btn-outline" onclick="sessionStorage.removeItem('pending_challenge_code'); closeModal('challengeInviteModal');" style="width: 100%; border-radius: 8px; border-color: #334155; color: #cbd5e1; padding: 9px;">
                        বন্ধ করুন
                    </button>
                </div>
            `;
            return;
        }

        const c = await res.json();

        const isCreator = currentUser && (currentUser.id === c.creator_id);
        const isRival = currentUser && (currentUser.id === c.rival_id);
        const userBal = currentUser ? (currentUser.digits_balance || 0) : 0;
        const hasEnoughBalance = userBal >= c.entry_fee;

        const hostRoleLabel = c.room_creator_role === 'creator' ? 'Challenger (Host)' : (c.room_creator_role === 'rival' ? 'Rival (You)' : 'Admin Auto-Host');
        const ammoLabel = c.limited_ammo === 'no' ? '♾️ Unlimited' : '📦 Limited';
        const gunAttrLabel = c.gun_attributes === 'yes' ? '✅ ON' : '❌ OFF';
        const modeBadge = c.mode === '4v4' ? '👥 4v4 Clash Squad' : '👤 1v1 Clash Squad';

        let actionAreaHtml = '';

        if (!currentUser) {
            actionAreaHtml = `
                <div style="background: rgba(37, 99, 235, 0.12); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                    <div style="font-size: 0.86rem; font-weight: 700; color: #93c5fd; margin-bottom: 4px;">⚔️ চ্যালেঞ্জ গ্রহণ করতে লগইন প্রয়োজন</div>
                    <p style="font-size: 0.76rem; color: #cbd5e1; margin: 0 0 12px 0;">আপনার Gomon Hub অ্যাকাউন্টে লগইন বা সাইন আপ করুন।</p>
                    <button type="button" class="btn" onclick="closeModal('challengeInviteModal'); openModal('authModal');" style="width: 100%; padding: 11px; font-weight: 800; border-radius: 8px; font-size: 0.92rem; background: linear-gradient(135deg, #10b981, #059669); border: none; color: white; cursor: pointer; box-shadow: 0 4px 14px rgba(16,185,129,0.35);">
                        🔐 Sign In / Register to Accept
                    </button>
                </div>
            `;
        } else if (c.status === 'open') {
            if (isCreator) {
                actionAreaHtml = `
                    <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                        <div style="font-size: 0.9rem; font-weight: 800; color: #fcd34d; margin-bottom: 4px;">👑 এটি আপনার তৈরি করা চ্যালেঞ্জ!</div>
                        <p style="font-size: 0.78rem; color: #cbd5e1; margin: 0 0 12px 0;">অপোনেন্টের সাথে লিংক শেয়ার করুন। অপোনেন্ট একসেপ্ট করলে ম্যাচ শুরু হবে।</p>
                        <div style="display: flex; gap: 8px;">
                            <button type="button" class="btn btn-sm" onclick="navigator.clipboard.writeText('${window.location.origin}/?challenge=${c.challenge_code}#challenge=${c.challenge_code}'); showToast('চ্যালেঞ্জ লিংক কপি হয়েছে!', 'success');" style="flex: 1; background: #2563eb; color: white; border: none; padding: 9px 12px; border-radius: 8px; font-weight: 700; font-size: 0.82rem; cursor: pointer;">
                                📋 Copy Link
                            </button>
                            <button type="button" class="btn btn-sm" onclick="sessionStorage.removeItem('pending_challenge_code'); closeModal('challengeInviteModal'); openChallengeModal('my');" style="flex: 1; background: #334155; color: white; border: none; padding: 9px 12px; border-radius: 8px; font-weight: 700; font-size: 0.82rem; cursor: pointer;">
                                🎮 My Challenges
                            </button>
                        </div>
                    </div>
                `;
            } else if (!hasEnoughBalance) {
                actionAreaHtml = `
                    <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.35); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                        <div style="font-size: 0.88rem; font-weight: 800; color: #f87171; margin-bottom: 4px;">⚠️ অপর্যাপ্ত ব্যালেন্স!</div>
                        <p style="font-size: 0.78rem; color: #cbd5e1; margin: 0 0 12px 0;">আপনার বর্তমান ব্যালেন্স ৳${userBal}, কিন্তু এই চ্যালেঞ্জের এন্ট্রি ফি ৳${c.entry_fee}।</p>
                        <button type="button" class="btn" onclick="closeModal('challengeInviteModal'); openWalletModal();" style="width: 100%; padding: 11px; font-weight: 800; border-radius: 8px; font-size: 0.92rem; background: linear-gradient(135deg, #f59e0b, #d97706); border: none; color: white; cursor: pointer; box-shadow: 0 4px 14px rgba(245,158,11,0.35);">
                            💳 Deposit Balance (৳${c.entry_fee - userBal} প্রয়োজন)
                        </button>
                    </div>
                `;
            } else {
                actionAreaHtml = `
                    <div style="margin-top: 16px;">
                        <button type="button" id="acceptInviteBtn-${c.challenge_code}" class="btn" onclick="acceptChallengeFromInvite('${c.challenge_code}', ${c.entry_fee})" style="width: 100%; padding: 14px; font-family: 'Rajdhani', sans-serif; font-size: 1.18rem; font-weight: 800; letter-spacing: 0.5px; border-radius: 10px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; border: none; box-shadow: 0 6px 20px rgba(16, 185, 129, 0.45); cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px;">
                            <span>⚔️ ACCEPT CHALLENGE</span>
                            <span style="background: rgba(0, 0, 0, 0.25); padding: 2px 10px; border-radius: 6px; font-size: 0.92rem;">(৳${c.entry_fee})</span>
                        </button>
                        <div style="font-size: 0.72rem; color: #94a3b8; text-align: center; margin-top: 8px; display: flex; align-items: center; justify-content: center; gap: 4px;">
                            <span>🔒</span> <span>Escrow সুরক্ষিত: উইনার পাবে সম্পূর্ণ ৳${c.prize_amount}</span>
                        </div>
                    </div>
                `;
            }
        } else if (c.status === 'in_progress') {
            if (isCreator || isRival) {
                actionAreaHtml = `
                    <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.35); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                        <div style="font-size: 0.92rem; font-weight: 800; color: #34d399; margin-bottom: 6px;">🔥 ম্যাচটি বর্তমানে চলমান!</div>
                        ${c.room_id ? `
                            <div style="background: #090e17; border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 8px; padding: 10px; margin: 10px 0; font-family: monospace; font-size: 0.95rem; color: #38bdf8;">
                                <div>Room ID: <b>${c.room_id}</b></div>
                                <div style="margin-top: 3px;">Pass: <b>${c.room_password || 'None'}</b></div>
                            </div>
                        ` : '<div style="font-size: 0.78rem; color: #cbd5e1; margin-bottom: 10px;">রুম আইডি তৈরি হচ্ছে...</div>'}
                        <button type="button" class="btn" onclick="sessionStorage.removeItem('pending_challenge_code'); closeModal('challengeInviteModal'); openChallengeModal('my');" style="width: 100%; background: #10b981; color: white; border: none; padding: 10px 14px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">
                            🎮 My Challenges এ রুম ও রেজাল্ট দেখুন
                        </button>
                    </div>
                `;
            } else {
                actionAreaHtml = `
                    <div style="background: rgba(148, 163, 184, 0.1); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                        <div style="font-size: 0.9rem; font-weight: 700; color: #e2e8f0; margin-bottom: 4px;">🔒 ম্যাচটি শুরু হয়ে গেছে</div>
                        <p style="font-size: 0.78rem; color: #94a3b8; margin: 0 0 12px 0;">অন্য একজন প্লেয়ার ইতিমধ্যে এই চ্যালেঞ্জটি গ্রহণ করেছেন।</p>
                        <button type="button" class="btn" onclick="sessionStorage.removeItem('pending_challenge_code'); closeModal('challengeInviteModal'); openChallengeModal('lobby');" style="width: 100%; background: #2563eb; color: white; border: none; padding: 10px 14px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">
                            🌐 অন্যান্য ওপেন চ্যালেঞ্জ দেখুন
                        </button>
                    </div>
                `;
            }
        } else if (c.status === 'completed') {
            actionAreaHtml = `
                <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                    <div style="font-size: 0.92rem; font-weight: 800; color: #34d399; margin-bottom: 4px;">🏁 ম্যাচ সমাপ্ত হয়েছে</div>
                    <p style="font-size: 0.78rem; color: #94a3b8; margin: 0 0 12px 0;">এই চ্যালেঞ্জটি সফলভাবে সম্পন্ন হয়েছে এবং প্রাইজ বিতরণ করা হয়েছে।</p>
                    <button type="button" class="btn" onclick="sessionStorage.removeItem('pending_challenge_code'); closeModal('challengeInviteModal'); openChallengeModal('lobby');" style="width: 100%; background: #2563eb; color: white; border: none; padding: 10px 14px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">
                        🌐 নতুন চ্যালেঞ্জ খুঁজুন
                    </button>
                </div>
            `;
        } else if (c.status === 'cancelled') {
            actionAreaHtml = `
                <div style="background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.2); border-radius: 12px; padding: 14px; text-align: center; margin-top: 16px;">
                    <div style="font-size: 0.92rem; font-weight: 800; color: #f87171; margin-bottom: 4px;">❌ চ্যালেঞ্জ বাতিল করা হয়েছে</div>
                    <p style="font-size: 0.78rem; color: #94a3b8; margin: 0 0 12px 0;">হোস্ট এই চ্যালেঞ্জটি বাতিল করে তার টাকা রিফান্ড নিয়েছেন।</p>
                    <button type="button" class="btn" onclick="sessionStorage.removeItem('pending_challenge_code'); closeModal('challengeInviteModal'); openChallengeModal('create');" style="width: 100%; background: #10b981; color: white; border: none; padding: 10px 14px; border-radius: 8px; font-weight: 700; font-size: 0.85rem; cursor: pointer;">
                        ⚔️ আপনি একটি নতুন চ্যালেঞ্জ দিন
                    </button>
                </div>
            `;
        }

        body.innerHTML = `
            <div>
                <!-- Top VS Duel Header -->
                <div style="background: linear-gradient(180deg, rgba(15, 23, 42, 0.8) 0%, rgba(13, 20, 36, 0.95) 100%); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 14px; padding: 16px; margin-bottom: 14px; position: relative;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                        <span style="font-family: 'Rajdhani', sans-serif; font-size: 0.82rem; font-weight: 800; color: #38bdf8; background: rgba(56, 189, 248, 0.12); padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(56, 189, 248, 0.3);">
                            ${modeBadge}
                        </span>
                        <span style="font-family: monospace; font-size: 0.76rem; color: #94a3b8;">
                            #${escapeHtml(c.challenge_code)}
                        </span>
                    </div>

                    <!-- Versus Player Cards -->
                    <div style="display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px;">
                        <!-- Host Player -->
                        <div style="text-align: center; background: rgba(16, 185, 129, 0.08); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 10px; padding: 10px 6px;">
                            <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(16, 185, 129, 0.2); border: 1.5px solid #10b981; display: flex; align-items: center; justify-content: center; margin: 0 auto 6px auto; font-size: 1.1rem;">
                                👑
                            </div>
                            <div style="font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 0.95rem; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${escapeHtml(c.creator_ign || c.creator_name || 'Host')}
                            </div>
                            <div style="font-size: 0.65rem; color: #34d399; font-weight: 700; text-transform: uppercase;">Challenger</div>
                        </div>

                        <!-- VS Badge -->
                        <div style="width: 36px; height: 36px; border-radius: 50%; background: linear-gradient(135deg, #ef4444, #f59e0b); display: flex; align-items: center; justify-content: center; font-family: 'Rajdhani', sans-serif; font-size: 0.95rem; font-weight: 900; color: white; box-shadow: 0 0 14px rgba(239, 68, 68, 0.5);">
                            VS
                        </div>

                        <!-- Rival Player -->
                        <div style="text-align: center; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 10px; padding: 10px 6px;">
                            <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(59, 130, 246, 0.2); border: 1.5px solid #3b82f6; display: flex; align-items: center; justify-content: center; margin: 0 auto 6px auto; font-size: 1.1rem;">
                                🎯
                            </div>
                            <div style="font-family: 'Rajdhani', sans-serif; font-weight: 800; font-size: 0.95rem; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
                                ${escapeHtml(c.rival_ign || c.rival_name || 'Opponent')}
                            </div>
                            <div style="font-size: 0.65rem; color: #60a5fa; font-weight: 700; text-transform: uppercase;">
                                ${c.rival_name ? 'Accepted' : 'Waiting...'}
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Prize & Stake Showcase Grid -->
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
                    <div style="background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 10px; padding: 10px; text-align: center;">
                        <div style="font-size: 0.7rem; color: #a7f3d0; text-transform: uppercase; font-weight: 700;">Winner Takes</div>
                        <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.45rem; font-weight: 900; color: #34d399; margin-top: 1px;">
                            ৳${c.prize_amount}
                        </div>
                    </div>
                    <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.25); border-radius: 10px; padding: 10px; text-align: center;">
                        <div style="font-size: 0.7rem; color: #bfdbfe; text-transform: uppercase; font-weight: 700;">Entry Stake Fee</div>
                        <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.45rem; font-weight: 900; color: #60a5fa; margin-top: 1px;">
                            ৳${c.entry_fee}
                        </div>
                    </div>
                </div>

                <!-- Match Rules Grid -->
                <div style="background: #090e17; border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 10px; padding: 10px 12px; margin-bottom: 6px;">
                    <div style="font-size: 0.7rem; color: #64748b; font-weight: 700; text-transform: uppercase; margin-bottom: 6px;">Match Specifications</div>
                    ${c.match_time ? `
                    <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #f59e0b; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
                        <span>Match Schedule:</span>
                        <b>⏰ ${escapeHtml(c.match_time)}</b>
                    </div>
                    ` : ''}
                    <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #cbd5e1; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
                        <span>Gun Attributes:</span>
                        <b>${gunAttrLabel}</b>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #cbd5e1; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
                        <span>Limited Ammo:</span>
                        <b>${ammoLabel}</b>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #cbd5e1; padding: 4px 0; border-bottom: 1px solid rgba(255,255,255,0.04);">
                        <span>Room Host:</span>
                        <b>${hostRoleLabel}</b>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: #cbd5e1; padding: 4px 0;">
                        <span>Privacy:</span>
                        <b>${c.visibility === 'private' ? '🔒 Private (Invite Only)' : '🌐 Public (Open Lobby)'}</b>
                    </div>
                </div>

                <!-- Dynamic Action Area -->
                ${actionAreaHtml}
            </div>
        `;
    } catch (err) {
        console.error('Error fetching challenge by code:', err);
        body.innerHTML = `
            <div style="text-align: center; padding: 24px 14px; color: #cbd5e1;">
                <div style="font-size: 2.2rem; margin-bottom: 8px;">❌</div>
                <div style="font-family: 'Rajdhani', sans-serif; font-size: 1.15rem; font-weight: 800; color: #f87171;">ERROR LOADING CHALLENGE</div>
                <p style="font-size: 0.8rem; color: #94a3b8; margin: 6px 0 16px 0;">সার্ভার থেকে চ্যালেঞ্জের তথ্য আনতে সমস্যা হয়েছে। দয়া করে ইন্টারনেট চেক করুন।</p>
                <button type="button" class="btn btn-outline" onclick="closeModal('challengeInviteModal');" style="width: 100%; border-radius: 8px; border-color: #334155; color: #cbd5e1; padding: 9px;">বন্ধ করুন</button>
            </div>
        `;
    }
}

async function acceptChallengeFromInvite(code, fee) {
    if (!currentUser) {
        sessionStorage.setItem('pending_challenge_code', code);
        closeModal('challengeInviteModal');
        openModal('authModal');
        showToast('Please login to accept challenge', 'info');
        return;
    }

    if ((currentUser.digits_balance || 0) < fee) {
        showToast(`ব্যালেন্স অপর্যাপ্ত! আপনার ব্যালেন্স ৳${currentUser.digits_balance || 0}, প্রয়োজন ৳${fee}`, 'error');
        closeModal('challengeInviteModal');
        openWalletModal();
        return;
    }

    if (!confirm(`Are you sure you want to accept challenge #${code} for ৳${fee}? Your entry fee will be locked in escrow.`)) {
        return;
    }

    const btn = document.getElementById(`acceptInviteBtn-${code}`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ Processing Escrow...</span>';
    }

    try {
        const res = await fetchWithAuth(`/api/challenges/${code}/accept`, { method: 'POST' });
        const data = await parseResponseSafe(res);
        if (!res.ok) throw new Error((data && (data.detail || data.message)) || 'Could not accept challenge');

        sessionStorage.removeItem('pending_challenge_code');
        closeModal('challengeInviteModal');

        showToast('⚔️ Challenge accepted! Match is active.', 'success');
        playSound('success');

        if (typeof updateProfileDisplay === 'function') updateProfileDisplay();
        if (typeof renderUserProfile === 'function') renderUserProfile();
        openChallengeModal('my');
    } catch (err) {
        showToast(err.message || 'Failed to accept challenge', 'error');
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<span>⚔️ ACCEPT CHALLENGE</span> <span style="background: rgba(0, 0, 0, 0.25); padding: 2px 10px; border-radius: 6px; font-size: 0.92rem;">(৳${fee})</span>`;
        }
    }
}

function checkAndTriggerDeepLinks() {
    const chCode = getDeepLinkChallengeCode();
    if (chCode) {
        openChallengeByCode(chCode);
        return;
    }

    const matchId = getDeepLinkMatchId();
    if (matchId) {
        sessionStorage.removeItem('pending_match_id');
        if (typeof openMatchInnerPortal === 'function') {
            openMatchInnerPortal(matchId);
        }
    }
}

window.getDeepLinkChallengeCode = getDeepLinkChallengeCode;
window.getDeepLinkMatchId = getDeepLinkMatchId;
window.openChallengeByCode = openChallengeByCode;
window.acceptChallengeFromInvite = acceptChallengeFromInvite;
window.checkAndTriggerDeepLinks = checkAndTriggerDeepLinks;



