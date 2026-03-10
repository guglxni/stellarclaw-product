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
        idToken: null,
        selectedModel: 'minimax-m2.5',
        selectedChannel: null,
        isDeployed: false,
        botPid: null,
        botCreditLimit: null,
        // Subscription state
        subscription: null,  // { plan, status, currentPeriodEnd, earlyBird, referralCode, dodoCustomerId }
    };

    // Restore from localStorage (with validation to prevent prototype pollution)
    try {
        const saved = JSON.parse(localStorage.getItem('liveclaw_state'));
        if (saved && typeof saved.userId === 'string' && saved.userId.length < 256) {
            // Only restore known safe keys
            const safeKeys = ['userId', 'userName', 'userEmail', 'userAvatar', 'idToken', 'selectedModel', 'selectedChannel', 'isDeployed', 'botPid', 'botCreditLimit', 'subscription'];
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
        // Store the raw JWT for Authorization header
        state.idToken = response.credential;
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
        state.idToken = null;
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
                'Kimi K2.5': 'kimi-k2.5',
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
                const headers = { 'Content-Type': 'application/json' };
                if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

                const res = await fetch(API_BASE + '/deploy-bot', {
                    method: 'POST',
                    headers,
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
                } else if (res.status === 402) {
                    // Subscription required — show pricing
                    showToast(data.message || 'Subscription required to deploy.', 'error');
                    connectBtn.disabled = false;
                    connectBtn.innerHTML = origHTML;
                    closeTelegramModal();
                    showPricingModal();
                } else if (res.status === 403 && data.maxBots) {
                    // Bot limit reached
                    showToast(data.message || 'Bot limit reached. Upgrade your plan.', 'error');
                    connectBtn.disabled = false;
                    connectBtn.innerHTML = origHTML;
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

        // Fetch subscription info for dashboard display
        fetchSubscription();

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
                <h1 class="main-text text-balance">Your Claw Agent is Live</h1>
                <p class="text-sm sm:text-base text-zinc-400 leading-relaxed max-w-xl mx-auto">
                    Your AI agent is running 24/7 on Telegram. Open your bot in the Telegram app and start chatting!
                </p>
            </div>
        `;

        const planLabel = state.subscription ? escapeHtml(state.subscription.plan || 'starter') : '—';
        const planUpper = planLabel.charAt(0).toUpperCase() + planLabel.slice(1);

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
                                <span class="text-zinc-400 text-sm">Plan</span>
                                <span class="text-white text-sm font-medium">${planUpper}</span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Model</span>
                                <span class="text-white text-sm font-medium">${escapeHtml(state.selectedModel || 'MiniMax M2.5')}</span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Budget</span>
                                <span class="text-white text-sm font-medium">$${(state.botCreditLimit || 0.05).toFixed(2)}</span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-zinc-400 text-sm">Process ID</span>
                                <span class="text-zinc-500 text-sm font-mono">${escapeHtml(String(state.botPid || '—'))}</span>
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

                        <!-- Manage Subscription -->
                        <button id="liveclaw-manage-sub-btn"
                            class="w-full rounded-xl border border-indigo-500/20 bg-indigo-500/10 py-2.5 text-sm text-indigo-300 font-medium cursor-pointer hover:bg-indigo-500/20 transition-colors flex items-center justify-center gap-2">
                            <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
                            </svg>
                            Manage Subscription
                        </button>

                        <p class="text-center text-zinc-500 text-xs mt-1">
                            View billing, upgrade, or cancel your plan.
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
                        const headers = { 'Content-Type': 'application/json' };
                        if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

                        const res = await fetch(API_BASE + '/stop-bot', {
                            method: 'POST',
                            headers,
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

            // Manage Subscription — open Dodo portal
            const manageSubBtn = document.getElementById('liveclaw-manage-sub-btn');
            if (manageSubBtn) {
                manageSubBtn.addEventListener('click', async () => {
                    await openPortal();
                });
            }
        }
    }

    // ─── Subscription Helpers ───────────────────────────────────────────────
    async function fetchSubscription() {
        if (!state.userId) return;
        try {
            const headers = {};
            if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

            const res = await fetch(API_BASE + '/subscription/' + encodeURIComponent(state.userId), { headers });
            if (res.ok) {
                const data = await res.json();
                if (data.hasSubscription) {
                    state.subscription = {
                        plan: data.plan,
                        status: data.status,
                        currentPeriodEnd: data.currentPeriodEnd,
                        earlyBird: data.earlyBird,
                        referralCode: data.referralCode,
                        dodoCustomerId: data.dodoCustomerId,
                    };
                } else {
                    state.subscription = null;
                }
                saveState();
            }
        } catch (_) { /* network error — ignore */ }
    }

    async function openPortal() {
        if (!state.userId) return;
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

            const res = await fetch(API_BASE + '/create-portal-session', {
                method: 'POST',
                headers,
                body: JSON.stringify({ userId: state.userId }),
            });
            const data = await res.json();
            if (res.ok && data.portalUrl) {
                window.open(data.portalUrl, '_blank');
            } else {
                showToast(data.error || 'Failed to open billing portal.', 'error');
            }
        } catch (_) {
            showToast('Network error. Please try again.', 'error');
        }
    }

    function showPricingModal() {
        // Remove existing modal if present
        const existing = document.getElementById('liveclaw-pricing-modal');
        if (existing) existing.remove();

        const modal = document.createElement('div');
        modal.id = 'liveclaw-pricing-modal';
        modal.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4';
        modal.innerHTML = `
            <div class="absolute inset-0 bg-black/70 backdrop-blur-sm" id="pricing-backdrop"></div>
            <div class="relative z-10 w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl border border-white/8 bg-zinc-950 shadow-[0_8px_40px_rgba(0,0,0,0.5)] p-6 sm:p-8">
                <div class="flex items-center justify-between mb-2">
                    <h2 class="text-white font-semibold text-xl">Get LiveClaw</h2>
                    <button id="pricing-close-btn" class="text-zinc-500 hover:text-white transition-colors text-2xl leading-none cursor-pointer">&times;</button>
                </div>
                <p class="text-zinc-400 text-sm mb-5">Deploy your 24/7 AI agent on Telegram. 1-day free trial — cancel anytime.</p>

                <!-- Loading skeleton -->
                <div id="pricing-loading" class="flex flex-col gap-4 animate-pulse">
                    <div class="rounded-xl border border-white/5 bg-white/[0.02] p-6 h-64"></div>
                </div>

                <!-- Plans render here -->
                <div id="pricing-plans" class="hidden flex flex-col gap-4"></div>

                <!-- Promo code -->
                <div class="mt-5 flex gap-2">
                    <input id="pricing-promo-input" type="text" maxlength="20" placeholder="Promo code"
                        class="flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-indigo-500/50 transition-colors" />
                    <button id="pricing-promo-btn"
                        class="rounded-lg bg-white/[0.06] hover:bg-white/10 border border-white/10 px-4 py-2 text-sm text-zinc-300 font-medium cursor-pointer transition-colors">
                        Apply
                    </button>
                </div>
                <p id="pricing-promo-msg" class="text-xs mt-1.5 h-4"></p>
            </div>
        `;
        document.body.appendChild(modal);

        // State
        let appliedPromo = null;

        // Close handlers
        document.getElementById('pricing-backdrop').addEventListener('click', () => modal.remove());
        document.getElementById('pricing-close-btn').addEventListener('click', () => modal.remove());

        // Fetch plans from API
        fetchAndRenderPlans();

        async function fetchAndRenderPlans() {
            try {
                const res = await fetch(API_BASE + '/pricing');
                if (!res.ok) throw new Error('Failed to load pricing');
                const data = await res.json();
                renderPlans(data.plans);
            } catch (_) {
                document.getElementById('pricing-loading').innerHTML = '<p class="text-red-400 text-sm text-center py-8">Failed to load pricing. Please try again.</p>';
            }
        }

        function renderPlans(plans) {
            const container = document.getElementById('pricing-plans');
            const loading = document.getElementById('pricing-loading');
            if (!container || !loading) return;

            const standard = plans.standard;
            const earlyClaw = plans.earlyClaw;
            const showEarlyClaw = earlyClaw && earlyClaw.spotsRemaining > 0;
            const activePlan = (appliedPromo === 'EARLYCLAW' && showEarlyClaw) ? earlyClaw : standard;
            const price = activePlan.price;
            const isEB = activePlan === earlyClaw;
            const spotsLeft = earlyClaw ? earlyClaw.spotsRemaining : 0;

            container.innerHTML = `
                <div class="relative rounded-xl border ${isEB ? 'border-amber-500/40' : 'border-indigo-500/40'} bg-white/[0.03] p-6 flex flex-col gap-3 transition-all duration-300">
                    <span class="absolute -top-2.5 left-1/2 -translate-x-1/2 ${isEB ? 'bg-amber-500' : 'bg-indigo-500'} text-white text-xs font-medium px-2.5 py-0.5 rounded-full transition-colors">
                        ${isEB ? '🔥 Early Claw' : '1-Day Free Trial'}
                    </span>

                    <h3 class="text-white font-semibold text-lg mt-1">${escapeHtml(activePlan.name)}</h3>

                    <div class="flex items-baseline gap-1.5">
                        ${isEB ? '<span class="text-zinc-500 text-lg line-through">$' + standard.price.toFixed(2) + '</span>' : ''}
                        <span class="text-white text-3xl font-bold">$${price.toFixed(2)}</span>
                        <span class="text-zinc-500 text-sm">/${activePlan.interval}</span>
                    </div>

                    ${isEB ? `
                    <div class="flex items-center gap-2 mt-1">
                        <div class="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden">
                            <div class="h-full rounded-full ${spotsLeft < 50 ? 'bg-red-500' : spotsLeft < 150 ? 'bg-amber-500' : 'bg-emerald-500'} transition-all duration-500"
                                style="width: ${Math.min(100, ((500 - spotsLeft) / 500) * 100)}%"></div>
                        </div>
                        <span class="text-xs ${spotsLeft < 50 ? 'text-red-400' : 'text-zinc-400'} font-medium whitespace-nowrap">${spotsLeft} spots left</span>
                    </div>` : ''}

                    <ul class="text-zinc-400 text-xs space-y-2 mt-2">
                        ${activePlan.features.map(f => `<li class="flex items-center gap-2"><svg class="w-3.5 h-3.5 text-emerald-400 shrink-0" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>${escapeHtml(f)}</li>`).join('')}
                    </ul>

                    <button id="pricing-cta-btn" data-plan="standard"
                        class="mt-3 w-full rounded-lg ${isEB ? 'bg-amber-500 hover:bg-amber-600' : 'bg-indigo-500 hover:bg-indigo-600'} text-white py-2.5 text-sm font-semibold cursor-pointer transition-colors flex items-center justify-center gap-2">
                        <svg class="w-4 h-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-8.707l-3-3a1 1 0 00-1.414 1.414L10.586 9H7a1 1 0 100 2h3.586l-1.293 1.293a1 1 0 101.414 1.414l3-3a1 1 0 000-1.414z" clip-rule="evenodd"/></svg>
                        Start Free Trial
                    </button>
                    <p class="text-center text-zinc-600 text-xs">No charge for 24h. Cancel anytime.</p>
                </div>

                <div class="flex items-center gap-3 px-1">
                    <div class="flex items-center gap-1.5 text-zinc-500 text-xs">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg>
                        Secure checkout by Dodo Payments
                    </div>
                    <div class="flex items-center gap-1.5 text-zinc-500 text-xs ml-auto">
                        <svg class="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 1a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd"/></svg>
                        Global taxes included
                    </div>
                </div>
            `;

            loading.classList.add('hidden');
            container.classList.remove('hidden');

            // Wire CTA button
            const ctaBtn = document.getElementById('pricing-cta-btn');
            if (ctaBtn) {
                ctaBtn.addEventListener('click', () => startCheckout(ctaBtn, activePlan === earlyClaw));
            }

            // Store plans for promo toggle
            container._plans = plans;
        }

        async function startCheckout(btn, earlyClaw) {
            const origHTML = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<svg class="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Redirecting\u2026';
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

                const body = {
                    userId: state.userId,
                    email: state.userEmail,
                    plan: 'standard',
                };
                if (earlyClaw) body.promoCode = 'EARLYCLAW';

                const res = await fetch(API_BASE + '/create-checkout-session', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                });
                const data = await res.json();
                if (res.ok && data.checkoutUrl) {
                    window.location.href = data.checkoutUrl;
                } else {
                    showToast(data.error || 'Failed to create checkout session.', 'error');
                    btn.disabled = false;
                    btn.innerHTML = origHTML;
                }
            } catch (_) {
                showToast('Network error. Please try again.', 'error');
                btn.disabled = false;
                btn.innerHTML = origHTML;
            }
        }

        // Promo code handler
        const promoInput = document.getElementById('pricing-promo-input');
        const promoBtn = document.getElementById('pricing-promo-btn');
        const promoMsg = document.getElementById('pricing-promo-msg');

        promoBtn.addEventListener('click', () => {
            const code = promoInput.value.trim().toUpperCase();
            const container = document.getElementById('pricing-plans');
            if (!code) return;

            if (code === 'EARLYCLAW' && container._plans) {
                const ec = container._plans.earlyClaw;
                if (ec && ec.spotsRemaining > 0) {
                    appliedPromo = 'EARLYCLAW';
                    promoMsg.className = 'text-xs mt-1.5 h-4 text-emerald-400';
                    promoMsg.textContent = '\u2713 Early Claw pricing applied! Save $' + (container._plans.standard.price - ec.price).toFixed(2) + '/mo';
                    promoInput.disabled = true;
                    promoBtn.textContent = 'Applied';
                    promoBtn.disabled = true;
                    renderPlans(container._plans);
                } else {
                    promoMsg.className = 'text-xs mt-1.5 h-4 text-red-400';
                    promoMsg.textContent = 'All Early Claw spots have been claimed.';
                }
            } else {
                promoMsg.className = 'text-xs mt-1.5 h-4 text-red-400';
                promoMsg.textContent = 'Invalid promo code.';
            }
        });

        promoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') promoBtn.click();
        });
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
            if (img && (img.alt === 'MiniMax M2.5' || img.alt === 'Kimi K2.5')) {
                btn.addEventListener('click', function () {
                    if (img.alt === 'Kimi K2.5') return; // disabled / coming soon
                    state.selectedModel = img.alt;
                    saveState();
                });
            }
        });
    }

    // ─── Helpers ────────────────────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(String(str)));
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
