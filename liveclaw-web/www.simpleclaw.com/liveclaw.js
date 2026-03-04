/**
 * LiveClaw Frontend Integration — liveclaw.js
 *
 * Wires the cloned static UI to the LiveClaw Node.js backend orchestrator.
 *
 * Features:
 *  1. Google OAuth 2.0 sign-in (accounts.google.com/gsi)
 *  2. Deploy bot via POST /deploy-bot with userId, token, model
 *  3. Success dashboard replaces hero section after deployment
 *  4. Persists auth state in localStorage
 */

(function () {
    'use strict';

    // ─── Config ─────────────────────────────────────────────────────────────
    const API_BASE = window.LIVECLAW_API_BASE || '/api'; // Nginx proxies /api → :3000
    const GOOGLE_CLIENT_ID = window.LIVECLAW_GOOGLE_CLIENT_ID || '';

    // ─── State ──────────────────────────────────────────────────────────────
    let state = {
        userId: null,
        userName: null,
        userEmail: null,
        userAvatar: null,
        selectedModel: 'minimax-m2.5',
        selectedChannel: null,
        isDeployed: false,
        botPid: null,
        botCreditLimit: null,
    };

    // Restore from localStorage (with validation to prevent prototype pollution)
    try {
        const saved = JSON.parse(localStorage.getItem('liveclaw_state'));
        if (saved && typeof saved.userId === 'string' && saved.userId.length < 256) {
            // Only restore known safe keys
            const safeKeys = ['userId', 'userName', 'userEmail', 'userAvatar', 'selectedModel', 'selectedChannel', 'isDeployed', 'botPid', 'botCreditLimit'];
            for (const key of safeKeys) {
                if (key in saved) state[key] = saved[key];
            }
        }
    } catch (_) { /* noop */ }

    function saveState() {
        try {
            localStorage.setItem('liveclaw_state', JSON.stringify(state));
        } catch (_) { /* noop */ }
    }

    // ─── Google Sign-In ─────────────────────────────────────────────────────
    function initGoogleAuth() {
        const googleBtn = findGoogleButton();
        if (!googleBtn) return;

        // If already signed in, update button immediately
        if (state.userId) {
            updateAuthButton(googleBtn);
            if (state.isDeployed) {
                showSuccessDashboard();
            }
            return;
        }

        // Load Google Identity Services library
        if (GOOGLE_CLIENT_ID) {
            loadScript('https://accounts.google.com/gsi/client', function () {
                window.google.accounts.id.initialize({
                    client_id: GOOGLE_CLIENT_ID,
                    callback: handleGoogleCredential,
                    auto_select: true,
                });
            });
        }

        // Wire the existing button for click
        googleBtn.addEventListener('click', function (e) {
            e.preventDefault();
            if (state.userId) {
                // Already signed in — show sign out option
                if (confirm('Sign out of ' + state.userEmail + '?')) {
                    signOut();
                }
                return;
            }

            if (GOOGLE_CLIENT_ID && window.google) {
                window.google.accounts.id.prompt();
            } else {
                // Fallback: mock sign-in for development without Google Client ID
                handleMockSignIn();
            }
        });
    }

    function handleGoogleCredential(response) {
        // Decode the JWT credential to get user info
        const payload = decodeJwt(response.credential);
        state.userId = payload.sub; // Google user ID
        state.userName = payload.name;
        state.userEmail = payload.email;
        state.userAvatar = payload.picture;
        saveState();

        const googleBtn = findGoogleButton();
        if (googleBtn) updateAuthButton(googleBtn);
    }

    function handleMockSignIn() {
        // Dev-only: prompt for a user ID
        const id = prompt('Enter your user ID (dev mode — no Google Client ID configured):');
        if (!id) return;
        state.userId = id;
        state.userName = id;
        state.userEmail = id + '@liveclaw.xyz';
        state.userAvatar = null;
        saveState();

        const googleBtn = findGoogleButton();
        if (googleBtn) updateAuthButton(googleBtn);
    }

    function signOut() {
        state.userId = null;
        state.userName = null;
        state.userEmail = null;
        state.userAvatar = null;
        state.isDeployed = false;
        state.botPid = null;
        state.botCreditLimit = null;
        saveState();
        location.reload();
    }

    function updateAuthButton(btn) {
        if (!state.userId) return;
        const span = btn.querySelector('span');
        const img = btn.querySelector('img');

        if (span) span.textContent = state.userName || state.userEmail || 'Signed In';
        if (img && state.userAvatar) {
            img.src = state.userAvatar;
            img.alt = state.userName;
            img.style.borderRadius = '50%';
        }
        btn.classList.add('liveclaw-authed');
    }

    function findGoogleButton() {
        // Find the button containing "Sign in with Google" or the one we already updated
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            const span = btn.querySelector('span.text-base.font-medium');
            if (span && (
                span.textContent.includes('Sign in with Google') ||
                btn.classList.contains('liveclaw-authed')
            )) {
                return btn;
            }
        }
        return null;
    }

    // ─── Deploy Bot ─────────────────────────────────────────────────────────
    function wireConnectButton() {
        const connectBtn = document.getElementById('connect-btn');
        if (!connectBtn) return;

        // Override the existing button click
        connectBtn.addEventListener('click', async function (e) {
            e.preventDefault();
            e.stopPropagation();

            // Require auth
            if (!state.userId) {
                showToast('Please sign in with Google first', 'error');
                closeTelegramModal();
                // Highlight Google button
                const gBtn = findGoogleButton();
                if (gBtn) {
                    gBtn.style.animation = 'liveclaw-pulse 0.5s ease-in-out 3';
                    setTimeout(() => gBtn.style.animation = '', 1500);
                }
                return;
            }

            const tokenInput = document.getElementById('bot-token');
            const token = tokenInput ? tokenInput.value.trim() : '';

            if (!token) {
                showToast('Please enter your bot token', 'error');
                return;
            }

            // Validate token format client-side
            if (!/^\d+:[A-Za-z0-9_-]{30,50}$/.test(token)) {
                showToast('Invalid token format. Paste the full token from BotFather.', 'error');
                return;
            }

            // Map the selected model to backend model ID
            const modelMap = {
                'MiniMax M2.5': 'minimax-m2.5',
                'Kimi k2.5': 'kimi-k2.5',
            };
            const modelId = modelMap[state.selectedModel] || 'minimax-m2.5';

            // Show loading state
            connectBtn.disabled = true;
            const origHTML = connectBtn.innerHTML;
            connectBtn.innerHTML = `
                <svg class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path>
                </svg>
                Deploying your Claw agent...
            `;

            try {
                const res = await fetch(API_BASE + '/deploy-bot', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: state.userId,
                        telegramToken: token,
                        model: modelId,
                    }),
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    state.isDeployed = true;
                    state.botPid = data.pid;
                    state.botCreditLimit = data.creditLimit;
                    saveState();

                    showToast('Your Claw agent is live on Telegram!', 'success');
                    closeTelegramModal();
                    showSuccessDashboard();
                } else {
                    showToast(data.error || 'Deployment failed. Please try again.', 'error');
                    connectBtn.disabled = false;
                    connectBtn.innerHTML = origHTML;
                }
            } catch (err) {
                console.error('[LiveClaw] Deploy error:', err);
                showToast('Network error. Is the backend running?', 'error');
                connectBtn.disabled = false;
                connectBtn.innerHTML = origHTML;
            }
        });
    }

    // ─── Success Dashboard ──────────────────────────────────────────────────
    function showSuccessDashboard() {
        // Find the hero section (the one with the h1)
        const h1 = document.querySelector('h1.main-text');
        if (!h1) return;

        // The hero section is the parent <section>
        const heroSection = h1.closest('section');
        if (!heroSection) return;

        // Also find the card/options area below it
        const optionsArea = heroSection.nextElementSibling;

        // Replace hero content
        heroSection.innerHTML = `
            <div class="flex flex-col items-center gap-6 text-center">
                <div class="relative">
                    <div class="w-20 h-20 rounded-full bg-emerald-500/20 flex items-center justify-center">
                        <svg xmlns="http://www.w3.org/2000/svg" class="w-10 h-10 text-emerald-400" viewBox="0 0 24 24" fill="none"
                             stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M5 12l5 5l10 -10"></path>
                        </svg>
                    </div>
                    <span class="absolute -bottom-1 -right-1 w-5 h-5 bg-emerald-500 rounded-full border-2 border-zinc-950 flex items-center justify-center">
                        <span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                    </span>
                </div>
                <h1 class="main-text text-balance">Your Claw Agent is Live 🎉</h1>
                <p class="text-sm sm:text-base text-zinc-400 leading-relaxed max-w-xl mx-auto">
                    Your AI agent is running 24/7 on Telegram. Open your bot in the Telegram app and start chatting!
                </p>
            </div>
        `;

        // Replace the options/card area with a status dashboard
        if (optionsArea) {
            optionsArea.innerHTML = `
                <div class="w-full flex justify-center px-4 sm:px-6 pb-8">
                    <div class="w-full max-w-lg flex flex-col gap-4">
                        <!-- Status Card -->
                        <div class="rounded-2xl border border-white/8 bg-white/[0.03] p-5 flex flex-col gap-4">
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Status</span>
                                <span class="flex items-center gap-2 text-emerald-400 text-sm font-medium">
                                    <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
                                    Active
                                </span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Model</span>
                                <span class="text-white text-sm font-medium">${state.selectedModel || 'MiniMax M2.5'}</span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Credits</span>
                                <span class="text-white text-sm font-medium">$${(state.botCreditLimit || 0.05).toFixed(2)}</span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Process ID</span>
                                <span class="text-zinc-500 text-sm font-mono">${state.botPid || '—'}</span>
                            </div>
                        </div>

                        <!-- Actions -->
                        <div class="flex gap-3">
                            <button id="liveclaw-refresh-btn"
                                class="flex-1 rounded-xl border border-white/8 bg-white/[0.03] py-2.5 text-sm text-white font-medium cursor-pointer hover:bg-white/[0.06] transition-colors flex items-center justify-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"></path>
                                    <path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"></path>
                                </svg>
                                Refresh Status
                            </button>
                            <button id="liveclaw-stop-btn"
                                class="flex-1 rounded-xl border border-red-500/20 bg-red-500/10 py-2.5 text-sm text-red-400 font-medium cursor-pointer hover:bg-red-500/20 transition-colors flex items-center justify-center gap-2">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                                    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                                </svg>
                                Stop Agent
                            </button>
                        </div>

                        <p class="text-center text-zinc-500 text-xs mt-2">
                            Need more credits? Open your bot in Telegram and tap <strong class="text-zinc-400">"Refuel Agent"</strong> to watch a short ad or buy credits with Telegram Stars.
                        </p>
                    </div>
                </div>
            `;

            // Wire dashboard buttons
            const refreshBtn = document.getElementById('liveclaw-refresh-btn');
            const stopBtn = document.getElementById('liveclaw-stop-btn');

            if (refreshBtn) {
                refreshBtn.addEventListener('click', async () => {
                    try {
                        const res = await fetch(API_BASE + '/status/' + encodeURIComponent(state.userId));
                        const data = await res.json();
                        if (res.ok) {
                            const statusEl = refreshBtn.closest('.flex.flex-col.gap-4');
                            const card = statusEl ? statusEl.querySelector('.rounded-2xl') : null;
                            if (card) {
                                const spans = card.querySelectorAll('.text-sm.font-medium');
                                // status
                                const statusSpan = card.querySelector('.text-emerald-400, .text-red-400');
                                if (statusSpan) {
                                    const isAlive = data.alive;
                                    statusSpan.className = `flex items-center gap-2 ${isAlive ? 'text-emerald-400' : 'text-red-400'} text-sm font-medium`;
                                    // Sanitize server-supplied status text to prevent XSS
                                    const safeStatus = escapeHtml(String(data.status || 'unknown'));
                                    statusSpan.innerHTML = `<span class="w-2 h-2 ${isAlive ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'} rounded-full"></span>${isAlive ? 'Active' : safeStatus}`;
                                }
                            }
                            state.botCreditLimit = data.creditLimit;
                            saveState();
                            showToast('Status refreshed', 'success');
                        }
                    } catch (err) {
                        showToast('Failed to refresh status', 'error');
                    }
                });
            }

            if (stopBtn) {
                stopBtn.addEventListener('click', async () => {
                    if (!confirm('Stop your Claw agent? You can redeploy anytime.')) return;
                    try {
                        const res = await fetch(API_BASE + '/stop-bot', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ userId: state.userId }),
                        });
                        if (res.ok) {
                            state.isDeployed = false;
                            state.botPid = null;
                            saveState();
                            showToast('Agent stopped.', 'success');
                            location.reload();
                        }
                    } catch (err) {
                        showToast('Failed to stop agent', 'error');
                    }
                });
            }
        }
    }

    // ─── Toast Notification ─────────────────────────────────────────────────
    function showToast(message, type = 'info') {
        // Remove existing toast
        const existing = document.getElementById('liveclaw-toast');
        if (existing) existing.remove();

        const colors = {
            success: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300',
            error: 'bg-red-500/20 border-red-500/30 text-red-300',
            info: 'bg-blue-500/20 border-blue-500/30 text-blue-300',
        };

        const toast = document.createElement('div');
        toast.id = 'liveclaw-toast';
        toast.className = `fixed top-6 right-6 z-[200] px-5 py-3 rounded-xl border text-sm font-medium ${colors[type]} backdrop-blur-md shadow-lg transition-all duration-300`;
        toast.style.transform = 'translateX(120%)';
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(0)';
        });

        setTimeout(() => {
            toast.style.transform = 'translateX(120%)';
            setTimeout(() => toast.remove(), 300);
        }, 3500);
    }

    // ─── Track Model Selection ──────────────────────────────────────────────
    function wireModelTracking() {
        const allBtns = document.querySelectorAll('button.options-card');
        allBtns.forEach(function (btn) {
            const img = btn.querySelector('img');
            if (img && (img.alt === 'MiniMax M2.5' || img.alt === 'Kimi k2.5')) {
                btn.addEventListener('click', function () {
                    if (img.alt === 'Kimi k2.5') return; // disabled / coming soon
                    state.selectedModel = img.alt;
                    saveState();
                });
            }
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────────
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function decodeJwt(token) {
        try {
            const base64Url = token.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            return JSON.parse(atob(base64));
        } catch (_) {
            return {};
        }
    }

    function loadScript(src, callback) {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = callback;
        document.head.appendChild(script);
    }

    function closeTelegramModal() {
        const modal = document.getElementById('telegram-modal');
        if (modal) {
            modal.style.cssText = 'display: none !important;';
            const video = modal.querySelector('video');
            if (video) video.pause();
        }
    }

    // ─── CSS Injection ──────────────────────────────────────────────────────
    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes liveclaw-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
                50% { box-shadow: 0 0 0 8px rgba(99, 102, 241, 0); }
            }
            .animate-spin {
                animation: spin 1s linear infinite;
            }
            @keyframes spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .animate-pulse {
                animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
            }
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        `;
        document.head.appendChild(style);
    }

    // ─── Init ───────────────────────────────────────────────────────────────
    function init() {
        injectStyles();
        initGoogleAuth();
        wireConnectButton();
        wireModelTracking();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
        // Retry for hydration edge cases
        setTimeout(init, 600);
    }
})();
