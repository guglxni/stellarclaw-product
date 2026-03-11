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
        telegramToken: null,
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
            const safeKeys = ['userId', 'userName', 'userEmail', 'userAvatar', 'idToken', 'telegramToken', 'selectedModel', 'selectedChannel', 'isDeployed', 'botPid', 'botCreditLimit', 'subscription'];
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
            if (state.isDeployed) {
                showSuccessDashboard();
            } else {
                renderAuthenticatedFlow();
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
        if (googleBtn.dataset.liveclawAuthBound === '1') return;
        googleBtn.dataset.liveclawAuthBound = '1';

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
                showToast('Google sign-in is not configured yet. Please contact support.', 'error');
            }
        });
    }

    // ─── Token Refresh ────────────────────────────────────────────────────
    let _tokenRefreshResolve = null;

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

        // Resolve any pending silent token refresh
        if (_tokenRefreshResolve) {
            _tokenRefreshResolve(true);
            _tokenRefreshResolve = null;
        }

        renderAuthenticatedFlow();
    }

    /**
     * Ensures state.idToken is fresh (not expired).
     * Tries Google One Tap silent refresh first, falls back to asking user to re-sign-in.
     * Returns true if token is valid, false if user needs to sign in again.
     */
    async function ensureFreshToken() {
        if (state.idToken) {
            try {
                const payload = decodeJwt(state.idToken);
                // Valid for at least 60 more seconds
                if (payload.exp && payload.exp * 1000 > Date.now() + 60000) {
                    return true;
                }
            } catch (_) { /* fall through to refresh */ }
        }

        // Token expired — try silent refresh via Google One Tap
        if (window.google && GOOGLE_CLIENT_ID) {
            const refreshed = await new Promise((resolve) => {
                _tokenRefreshResolve = resolve;
                const timeout = setTimeout(() => {
                    _tokenRefreshResolve = null;
                    resolve(false);
                }, 4000);
                try {
                    google.accounts.id.prompt((notification) => {
                        if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
                            clearTimeout(timeout);
                            _tokenRefreshResolve = null;
                            resolve(false);
                        }
                        // If displayed + auto-selected, handleGoogleCredential will resolve(true)
                    });
                } catch (_) {
                    clearTimeout(timeout);
                    _tokenRefreshResolve = null;
                    resolve(false);
                }
            });
            if (refreshed) return true;
        }

        // Silent refresh failed — ask user to sign in again
        showToast('Your session has expired. Please sign in again.', 'error', 'Session expired');
        return false;
    }

    function signOut() {
        state.userId = null;
        state.userName = null;
        state.userEmail = null;
        state.userAvatar = null;
        state.idToken = null;
        state.telegramToken = null;
        state.isDeployed = false;
        state.botPid = null;
        state.botCreditLimit = null;
        saveState();
        location.reload();
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
        if (connectBtn.dataset.liveclawConnectBound === '1') return;
        connectBtn.dataset.liveclawConnectBound = '1';

        // Modal "Save & Connect" now stores Telegram token and unlocks deploy CTA.
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

            const originalLabel = connectBtn.innerHTML;
            connectBtn.disabled = true;
            connectBtn.innerHTML = `
                <svg class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path>
                </svg>
                Verifying bot token...
            `;

            try {
                if (!await ensureFreshToken()) return;
                const headers = { 'Content-Type': 'application/json' };
                if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

                const verifyRes = await fetch(API_BASE + '/verify-telegram-token', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        userId: state.userId,
                        telegramToken: token,
                    }),
                });

                const verifyData = await verifyRes.json();
                if (!verifyRes.ok || !verifyData.success) {
                    showToast(verifyData.error || 'Could not verify Telegram token.', 'error');
                    return;
                }

                state.telegramToken = token;
                state.selectedChannel = 'telegram';
                saveState();

                closeTelegramModal();
                markTelegramConnected();
                renderAuthenticatedFlow();

                showToast('Your bot is now linked. You are ready to send & receive messages.', 'success', 'Telegram connected');
            } catch (err) {
                console.error('[LiveClaw] Telegram verify error:', err);
                showToast('Network issue while verifying token. Please retry.', 'error');
            } finally {
                connectBtn.disabled = false;
                connectBtn.innerHTML = originalLabel;
            }
        });
    }

    async function deployFromMainButton(buttonEl) {
        if (!state.userId) {
            showToast('Please sign in with Google first', 'error');
            return;
        }
        if (!state.telegramToken) {
            showToast('Connect Telegram first to continue.', 'error');
            const telegramBtn = findTelegramOptionButton();
            if (telegramBtn) telegramBtn.click();
            return;
        }

        const origHTML = buttonEl.innerHTML;
        buttonEl.disabled = true;
        buttonEl.innerHTML = `
            <svg class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path>
            </svg>
            Checking subscription...
        `;

        try {
            // Step 0: Ensure Google token is still valid
            if (!await ensureFreshToken()) {
                buttonEl.disabled = false;
                buttonEl.innerHTML = origHTML;
                return;
            }

            // Step 1: Check subscription status first
            const headers = { 'Content-Type': 'application/json' };
            if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

            const subRes = await fetch(API_BASE + '/subscription/' + encodeURIComponent(state.userId), { headers });
            const subData = await subRes.json();

            const hasActiveSub = subData.hasSubscription && ['active', 'trialing', 'past_due'].includes(subData.status);

            if (!hasActiveSub) {
                // No subscription — show pricing modal to choose a plan
                buttonEl.disabled = false;
                buttonEl.innerHTML = origHTML;
                showPricingModal();
                return;
            }

            // Step 2: Has subscription — proceed with deploy
            buttonEl.innerHTML = `
                <svg class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path>
                </svg>
                Deploying LiveClaw...
            `;

            await executeDeploy(buttonEl, origHTML, headers);
        } catch (err) {
            console.error('[LiveClaw] Deploy error:', err);
            showToast('Network error. Please try again.', 'error');
            buttonEl.disabled = false;
            buttonEl.innerHTML = origHTML;
        }
    }

    async function executeDeploy(buttonEl, origHTML, headers) {
        const modelMap = {
            'MiniMax M2.5': 'minimax-m2.5',
            'Kimi K2.5': 'kimi-k2.5',
        };
        const modelId = modelMap[state.selectedModel] || 'minimax-m2.5';

        try {
            const res = await fetch(API_BASE + '/deploy-bot', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    userId: state.userId,
                    telegramToken: state.telegramToken,
                    model: modelId,
                }),
            });

            const data = await res.json();

            if (res.ok && data.success) {
                state.isDeployed = true;
                state.botPid = data.pid;
                state.botCreditLimit = data.creditLimit;
                saveState();

                showToast('Your Claw agent is live on Telegram!', 'success', 'Deployed');
                showSuccessDashboard();
                return;
            }

            if (res.status === 402) {
                showPricingModal();
            } else if (res.status === 403 && data.maxBots) {
                showToast(data.message || 'Bot limit reached. Upgrade your plan.', 'error');
            } else if (res.status === 503) {
                showToast(data.message || 'Server is currently at capacity. Please retry shortly.', 'error');
            } else {
                showToast(data.message || data.error || 'Deployment failed. Please try again.', 'error');
            }
        } catch (err) {
            console.error('[LiveClaw] Deploy error:', err);
            showToast('Network error while deploying. Please try again.', 'error');
        } finally {
            if (buttonEl) {
                buttonEl.disabled = false;
                buttonEl.innerHTML = origHTML;
            }
        }
    }

    function findTelegramOptionButton() {
        const allBtns = document.querySelectorAll('button.options-card');
        for (const btn of allBtns) {
            const img = btn.querySelector('img');
            if (img && img.alt === 'Telegram') return btn;
        }
        return null;
    }

    function markTelegramConnected() {
        const tgBtn = findTelegramOptionButton();
        if (!tgBtn || tgBtn.classList.contains('selected')) return;
        tgBtn.classList.add('selected');
        // Add checkmark SVG like model buttons have
        const existing = tgBtn.querySelector('.liveclaw-check');
        if (!existing) {
            const check = document.createElement('span');
            check.className = 'shrink-0 ml-auto flex items-center liveclaw-check';
            check.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-5 text-zinc-400"><path d="M5 12l5 5l10 -10"></path></svg>';
            tgBtn.appendChild(check);
        }
        // Update the label text to white (matches model selected state)
        const label = tgBtn.querySelector('h2');
        if (label) {
            label.classList.remove('text-zinc-400');
            label.classList.add('text-white');
        }
    }

    function renderAuthenticatedFlow() {
        if (!state.userId || state.isDeployed) return;

        // Try to find existing auth flow container first (re-render after Telegram connect)
        let authSection = document.getElementById('liveclaw-auth-flow');
        if (!authSection) {
            // First render — find the Google button and replace its parent
            const googleBtn = findGoogleButton();
            if (!googleBtn) return;
            authSection = googleBtn.closest('div.w-full.flex.flex-col.gap-3.min-w-0') || googleBtn.parentElement;
        }
        if (!authSection) return;

        const displayName = escapeHtml(state.userName || 'Signed In');
        const displayEmail = escapeHtml(state.userEmail || '');
        const deployDisabled = !state.telegramToken;
        const deployBtnClasses = deployDisabled
            ? 'bg-zinc-700/90 border border-zinc-600/40 text-zinc-400 cursor-not-allowed'
            : 'bg-white cursor-pointer hover:opacity-90';
        const deployBtnStyle = deployDisabled
            ? 'style="width:fit-content; padding: 0.75rem 1.5rem;"'
            : 'style="width:fit-content; padding: 0.75rem 1.5rem; color:#09090b;"';

        const avatarHtml = state.userAvatar
            ? `<img src="${escapeHtml(state.userAvatar)}" alt="${displayName}" class="size-8 rounded-full object-cover">`
            : `<span class="size-8 rounded-full bg-white/15 text-white text-xs font-semibold flex items-center justify-center">${displayName.slice(0, 1).toUpperCase()}</span>`;

        // Ensure the container has the right ID and classes so re-renders can find it
        authSection.id = 'liveclaw-auth-flow';
        authSection.className = 'w-full flex flex-col gap-3 min-w-0';

        authSection.innerHTML = `
                <div class="flex items-center gap-2.5 px-0.5 py-0.5 min-w-0">
                    ${avatarHtml}
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-1.5">
                            <p class="text-sm text-white font-medium truncate">${displayName}</p>
                            <button id="liveclaw-signout-btn" type="button" title="Sign out"
                                class="shrink-0 flex items-center justify-center size-5 rounded-md text-zinc-500 hover:text-red-400 transition-colors">
                                <svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                                    <polyline points="16 17 21 12 16 7"></polyline>
                                    <line x1="21" y1="12" x2="9" y2="12"></line>
                                </svg>
                            </button>
                        </div>
                        <p class="text-xs text-zinc-500 truncate">${displayEmail}</p>
                    </div>
                </div>

                <button id="liveclaw-deploy-main-btn" type="button" ${deployDisabled ? 'disabled' : ''} ${deployBtnStyle}
                    class="${deployBtnClasses} font-medium text-sm px-5 py-2.5 rounded-xl flex flex-row items-center justify-center gap-2 transition-all duration-300 disabled:cursor-not-allowed">
                    <svg xmlns="http://www.w3.org/2000/svg" class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"></path></svg>
                    <span class="text-base font-medium">Deploy LiveClaw</span>
                </button>

                <div id="liveclaw-pricing-line"></div>
        `;

        const signOutBtn = document.getElementById('liveclaw-signout-btn');
        if (signOutBtn) signOutBtn.addEventListener('click', signOut);

        const deployBtn = document.getElementById('liveclaw-deploy-main-btn');
        if (deployBtn) {
            deployBtn.addEventListener('click', function () {
                deployFromMainButton(deployBtn);
            });
        }

        // If token is persisted, also mark the Telegram chip as selected visually
        if (state.telegramToken) {
            markTelegramConnected();
        }

        fetchAndRenderPricingLine();
    }

    async function fetchAndRenderPricingLine() {
        const el = document.getElementById('liveclaw-pricing-line');
        if (!el) return;
        try {
            const res = await fetch(API_BASE + '/pricing');
            if (!res.ok) throw new Error('failed');
            const data = await res.json();
            const standard = data.plans.standard;
            const earlyClaw = data.plans.earlyClaw;
            const slotsLeft = earlyClaw ? Math.max(0, earlyClaw.spotsRemaining) : 0;
            const slotColor = slotsLeft < 50 ? '#f87171' : slotsLeft < 150 ? '#fb923c' : '#38bdf8';
            const slotSpan = slotsLeft > 0
                ? ` <span style="color:${slotColor}; font-weight:500;">🦞 Early Claw $${earlyClaw.price.toFixed(2)}/mo with code EARLYCLAW \u2014 only ${slotsLeft} slots left</span>`
                : '';

            if (!state.telegramToken) {
                el.innerHTML = '<p class="text-[#6A6B6C] font-medium text-sm">Connect Telegram to continue.</p>';
            } else {
                el.innerHTML = `
                    <p class="text-xs text-zinc-500">
                        <span class="font-medium text-zinc-400">$${standard.price.toFixed(2)}/month.</span>
                        $0.99 one-day trial available. Cancel anytime.${slotSpan}
                    </p>
                `;
            }
        } catch (_) {
            if (el) el.innerHTML = '<p class="text-[#6A6B6C] font-medium text-sm">Connect Telegram to continue.</p>';
        }
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
                        if (!await ensureFreshToken()) return;
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
            if (!await ensureFreshToken()) return;
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
            if (!await ensureFreshToken()) return;
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
        modal.style.cssText = 'position:fixed;inset:0;z-index:200;display:flex;align-items:center;justify-content:center;padding:1rem;';
        modal.innerHTML = `
            <div id="pricing-backdrop" style="position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px);"></div>
            <div style="position:relative;z-index:10;width:100%;max-width:42rem;max-height:90dvh;overflow-y:auto;border-radius:1rem;border:1px solid rgba(255,255,255,0.08);background:#09090b;box-shadow:0 8px 40px rgba(0,0,0,0.5);padding:1.5rem 2rem;">
                <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem;">
                    <h2 style="color:#fff;font-weight:600;font-size:1.25rem;">Get LiveClaw</h2>
                    <button id="pricing-close-btn" style="color:#71717a;font-size:1.5rem;line-height:1;cursor:pointer;background:none;border:none;">&times;</button>
                </div>
                <p style="color:#a1a1aa;font-size:0.875rem;margin-bottom:1.25rem;">Deploy your 24/7 AI agent on Telegram. Choose the plan that works for you.</p>

                <div id="pricing-loading" style="display:flex;gap:1rem;">
                    <div style="flex:1;border-radius:0.75rem;border:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.02);padding:1.5rem;height:14rem;"></div>
                    <div style="flex:1;border-radius:0.75rem;border:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.02);padding:1.5rem;height:14rem;"></div>
                </div>

                <div id="pricing-plans" style="display:none;gap:1rem;"></div>

                <div style="margin-top:1rem;display:flex;align-items:center;gap:0.75rem;padding:0 0.25rem;">
                    <div style="display:flex;align-items:center;gap:0.375rem;color:#71717a;font-size:0.75rem;">
                        <svg style="width:0.875rem;height:0.875rem;" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd"/></svg>
                        Secure checkout by Dodo Payments
                    </div>
                    <div style="display:flex;align-items:center;gap:0.375rem;color:#71717a;font-size:0.75rem;margin-left:auto;">
                        <svg style="width:0.875rem;height:0.875rem;" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 00-2 2v4a2 2 0 002 2V6h10a2 2 0 00-2-2H4zm2 6a2 2 0 012-2h8a2 2 0 012 2v4a2 2 0 01-2 2H8a2 2 0 01-2-2v-4zm6 1a1 1 0 100 2 1 1 0 000-2z" clip-rule="evenodd"/></svg>
                        Global taxes included
                    </div>
                </div>

                <div style="margin-top:0.75rem;display:flex;gap:0.5rem;">
                    <input id="pricing-promo-input" type="text" maxlength="20" placeholder="Promo code"
                        style="flex:1;border-radius:0.5rem;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);padding:0.5rem 0.875rem;font-size:0.875rem;color:#fff;outline:none;" />
                    <button id="pricing-promo-btn"
                        style="border-radius:0.5rem;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:0.5rem 1rem;font-size:0.875rem;color:#d4d4d8;font-weight:500;cursor:pointer;">
                        Apply
                    </button>
                </div>
                <p id="pricing-promo-msg" style="font-size:0.75rem;margin-top:0.375rem;min-height:1rem;"></p>
            </div>
        `;
        document.body.appendChild(modal);

        let appliedPromo = null;

        document.getElementById('pricing-backdrop').addEventListener('click', () => modal.remove());
        document.getElementById('pricing-close-btn').addEventListener('click', () => modal.remove());

        fetchAndRenderPlans();

        async function fetchAndRenderPlans() {
            try {
                const url = state.userId
                    ? API_BASE + '/pricing?userId=' + encodeURIComponent(state.userId)
                    : API_BASE + '/pricing';
                const res = await fetch(url);
                if (!res.ok) throw new Error('Failed to load pricing');
                const data = await res.json();
                renderPlans(data.plans, data.trialEligible !== false);
            } catch (_) {
                document.getElementById('pricing-loading').innerHTML = '<p style="color:#f87171;font-size:0.875rem;text-align:center;padding:2rem 0;">Failed to load pricing. Please try again.</p>';
            }
        }

        function makeFeaturesHtml(features) {
            return features.map(f =>
                '<li style="display:flex;align-items:center;gap:0.5rem;">' +
                '<svg style="width:0.875rem;height:0.875rem;color:#34d399;flex-shrink:0;" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>' +
                escapeHtml(f) + '</li>'
            ).join('');
        }

        function renderPlans(plans, trialEligible) {
            const container = document.getElementById('pricing-plans');
            const loading = document.getElementById('pricing-loading');
            if (!container || !loading) return;

            const standard = plans.standard;
            const trial = plans.trial;
            const earlyClaw = plans.earlyClaw;
            const showEarlyClaw = earlyClaw && earlyClaw.spotsRemaining > 0;

            // Determine which subscription plan to show (standard or earlyClaw)
            const subPlan = (appliedPromo === 'EARLYCLAW' && showEarlyClaw) ? earlyClaw : standard;
            const isEB = subPlan === earlyClaw;
            const subBorder = isEB ? 'rgba(245,158,11,0.4)' : 'rgba(99,102,241,0.4)';
            const subCtaBg = isEB ? '#f59e0b' : '#6366f1';
            const spotsLeft = earlyClaw ? earlyClaw.spotsRemaining : 0;

            const earlyClawBar = isEB ? `
                <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.25rem;">
                    <div style="flex:1;height:0.375rem;border-radius:9999px;background:rgba(255,255,255,0.05);overflow:hidden;">
                        <div style="height:100%;border-radius:9999px;background:${spotsLeft < 50 ? '#ef4444' : spotsLeft < 150 ? '#f59e0b' : '#10b981'};width:${Math.min(100, ((500 - spotsLeft) / 500) * 100)}%;"></div>
                    </div>
                    <span style="font-size:0.75rem;color:${spotsLeft < 50 ? '#f87171' : '#a1a1aa'};font-weight:500;white-space:nowrap;">${spotsLeft} spots left</span>
                </div>` : '';

            // Trial card (left)
            const trialCardHtml = trialEligible ? `
                <div style="flex:1;min-width:0;position:relative;border-radius:0.75rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);padding:1.25rem;display:flex;flex-direction:column;gap:0.625rem;">
                    <span style="position:absolute;top:-0.625rem;left:50%;transform:translateX(-50%);background:#10b981;color:#fff;font-size:0.7rem;font-weight:600;padding:0.125rem 0.625rem;border-radius:9999px;white-space:nowrap;">Try it first</span>
                    <h3 style="color:#fff;font-weight:600;font-size:1rem;margin-top:0.25rem;">24-Hour Trial</h3>
                    <div style="display:flex;align-items:baseline;gap:0.25rem;">
                        <span style="color:#fff;font-size:1.5rem;font-weight:700;">$${trial.price.toFixed(2)}</span>
                        <span style="color:#71717a;font-size:0.8rem;">one-time</span>
                    </div>
                    <ul style="color:#a1a1aa;font-size:0.75rem;list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0.375rem;flex:1;">
                        ${makeFeaturesHtml(trial.features)}
                    </ul>
                    <button id="pricing-trial-btn"
                        style="margin-top:0.5rem;width:100%;border-radius:0.5rem;background:transparent;border:1px solid rgba(99,102,241,0.4);color:#a5b4fc;padding:0.5rem;font-size:0.8rem;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:0.375rem;">
                        Start Trial — $0.99
                    </button>
                    <p style="text-align:center;color:#52525b;font-size:0.7rem;">One-time payment. No auto-renew.</p>
                </div>` : `
                <div style="flex:1;min-width:0;border-radius:0.75rem;border:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.02);padding:1.25rem;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5rem;opacity:0.5;">
                    <span style="color:#71717a;font-size:0.875rem;font-weight:500;">Trial Used</span>
                    <p style="color:#52525b;font-size:0.75rem;text-align:center;">You\u2019ve already used your trial. Subscribe to continue.</p>
                </div>`;

            // Subscription card (right)
            const subCardHtml = `
                <div style="flex:1;min-width:0;position:relative;border-radius:0.75rem;border:1px solid ${subBorder};background:rgba(255,255,255,0.03);padding:1.25rem;display:flex;flex-direction:column;gap:0.625rem;">
                    <span style="position:absolute;top:-0.625rem;left:50%;transform:translateX(-50%);background:${subCtaBg};color:#fff;font-size:0.7rem;font-weight:600;padding:0.125rem 0.625rem;border-radius:9999px;white-space:nowrap;">
                        ${isEB ? '\ud83d\udd25 Early Claw' : 'Recommended'}
                    </span>
                    <h3 style="color:#fff;font-weight:600;font-size:1rem;margin-top:0.25rem;">${escapeHtml(subPlan.name)}</h3>
                    <div style="display:flex;align-items:baseline;gap:0.25rem;">
                        ${isEB ? '<span style="color:#71717a;font-size:1rem;text-decoration:line-through;">$' + standard.price.toFixed(2) + '</span>' : ''}
                        <span style="color:#fff;font-size:1.5rem;font-weight:700;">$${subPlan.price.toFixed(2)}</span>
                        <span style="color:#71717a;font-size:0.8rem;">/month</span>
                    </div>
                    ${earlyClawBar}
                    <ul style="color:#a1a1aa;font-size:0.75rem;list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:0.375rem;flex:1;">
                        ${makeFeaturesHtml(subPlan.features)}
                    </ul>
                    <button id="pricing-sub-btn"
                        style="margin-top:0.5rem;width:100%;border-radius:0.5rem;background:${subCtaBg};color:#fff;padding:0.5rem;font-size:0.8rem;font-weight:600;cursor:pointer;border:none;display:flex;align-items:center;justify-content:center;gap:0.375rem;">
                        Subscribe — $${subPlan.price.toFixed(2)}/mo
                    </button>
                    <p style="text-align:center;color:#52525b;font-size:0.7rem;">Cancel anytime. Billed monthly.</p>
                </div>`;

            container.innerHTML = `
                <div style="display:flex;gap:1rem;flex-wrap:wrap;">
                    ${trialCardHtml}
                    ${subCardHtml}
                </div>
            `;

            loading.style.display = 'none';
            container.style.display = 'flex';

            // Wire trial button
            const trialBtn = document.getElementById('pricing-trial-btn');
            if (trialBtn) {
                trialBtn.addEventListener('click', () => startCheckout(trialBtn, 'trial', false));
            }

            // Wire subscription button
            const subBtn = document.getElementById('pricing-sub-btn');
            if (subBtn) {
                subBtn.addEventListener('click', () => startCheckout(subBtn, 'subscription', isEB));
            }

            container._plans = plans;
        }

        async function startCheckout(btn, type, earlyClaw) {
            const origHTML = btn.innerHTML;
            btn.disabled = true;
            btn.style.opacity = '0.7';
            btn.innerHTML = '<svg style="width:1rem;height:1rem;animation:spin 1s linear infinite;" viewBox="0 0 24 24" fill="none"><circle style="opacity:0.25;" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path style="opacity:0.75;" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Redirecting\u2026';
            try {
                if (!await ensureFreshToken()) {
                    btn.disabled = false;
                    btn.style.opacity = '1';
                    btn.innerHTML = origHTML;
                    return;
                }
                const headers = { 'Content-Type': 'application/json' };
                if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;

                let endpoint, body;
                if (type === 'trial') {
                    endpoint = '/create-trial-checkout';
                    body = { userId: state.userId, email: state.userEmail };
                } else {
                    endpoint = '/create-checkout-session';
                    body = { userId: state.userId, email: state.userEmail, plan: 'standard' };
                    if (earlyClaw) body.promoCode = 'EARLYCLAW';
                }

                const res = await fetch(API_BASE + endpoint, {
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
                    btn.style.opacity = '1';
                    btn.innerHTML = origHTML;
                }
            } catch (_) {
                showToast('Network error. Please try again.', 'error');
                btn.disabled = false;
                btn.style.opacity = '1';
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
                    promoMsg.style.color = '#34d399';
                    promoMsg.textContent = '\u2713 Early Claw pricing applied! Save $' + (container._plans.standard.price - ec.price).toFixed(2) + '/mo';
                    promoInput.disabled = true;
                    promoBtn.textContent = 'Applied';
                    promoBtn.disabled = true;
                    renderPlans(container._plans, !!document.getElementById('pricing-trial-btn'));
                } else {
                    promoMsg.style.color = '#f87171';
                    promoMsg.textContent = 'All Early Claw spots have been claimed.';
                }
            } else {
                promoMsg.style.color = '#f87171';
                promoMsg.textContent = 'Invalid promo code.';
            }
        });

        promoInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') promoBtn.click();
        });
    }

    // ─── Toast Notification ─────────────────────────────────────────────────
    function showToast(message, type = 'info', customTitle) {
        // Remove existing toast
        const existing = document.getElementById('liveclaw-toast');
        if (existing) existing.remove();

        const variants = {
            success: {
                bg: 'rgba(16,185,129,0.2)',
                border: 'rgba(16,185,129,0.35)',
                titleColor: '#a7f3d0',
                bodyColor: '#6ee7b7',
                icon: '<path d="M20 6L9 17l-5-5"/>',
                label: 'Success',
            },
            error: {
                bg: 'rgba(239,68,68,0.2)',
                border: 'rgba(239,68,68,0.35)',
                titleColor: '#fecaca',
                bodyColor: '#fca5a5',
                icon: '<path d="M6 6l12 12M18 6L6 18"/>',
                label: 'Action needed',
            },
            info: {
                bg: 'rgba(59,130,246,0.2)',
                border: 'rgba(59,130,246,0.35)',
                titleColor: '#bfdbfe',
                bodyColor: '#93c5fd',
                icon: '<path d="M12 8h.01M11 12h1v4h1"/><circle cx="12" cy="12" r="10"/>',
                label: 'Notice',
            },
        };

        const v = variants[type] || variants.info;
        const titleText = customTitle || v.label;

        const toast = document.createElement('div');
        toast.id = 'liveclaw-toast';
        toast.style.cssText = `position:fixed;top:1.5rem;right:1.5rem;z-index:200;width:min(92vw,420px);border-radius:0.75rem;border:1px solid ${v.border};background:${v.bg};padding:1rem;backdrop-filter:blur(12px);box-shadow:0 4px 24px rgba(0,0,0,0.3);transition:transform 0.3s ease;transform:translateX(120%);`;
        toast.innerHTML = `
            <div style="display:flex;align-items:flex-start;gap:0.75rem;">
                <div style="margin-top:0.125rem;border-radius:9999px;border:1px solid rgba(255,255,255,0.2);padding:0.375rem;color:${v.bodyColor};">
                    <svg xmlns="http://www.w3.org/2000/svg" style="width:0.875rem;height:0.875rem;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${v.icon}</svg>
                </div>
                <div style="min-width:0;">
                    <p style="font-size:0.875rem;font-weight:600;color:${v.titleColor};">${escapeHtml(titleText)}</p>
                    <p style="font-size:0.875rem;color:${v.bodyColor};">${escapeHtml(message)}</p>
                </div>
            </div>
        `;
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
            if (video) {
                video.pause();
                video.currentTime = 0;
            }
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

    // ─── Checkout Return Handler ─────────────────────────────────────────
    function handleCheckoutReturn() {
        const params = new URLSearchParams(window.location.search);
        const checkoutStatus = params.get('checkout');
        if (!checkoutStatus) return;

        // Clean URL without reload
        const cleanUrl = window.location.pathname;
        window.history.replaceState({}, '', cleanUrl);

        if (checkoutStatus === 'success' || checkoutStatus === 'trial-success') {
            showToast('Payment confirmed! Deploying your agent now...', 'success', 'Payment successful');

            // Wait briefly for webhook to process, then auto-deploy
            setTimeout(async () => {
                if (!state.userId || !state.telegramToken) {
                    showToast('Sign in and connect Telegram to finish deployment.', 'info');
                    return;
                }

                const deployBtn = document.getElementById('liveclaw-deploy-main-btn');
                if (deployBtn) {
                    const origHTML = deployBtn.innerHTML;
                    deployBtn.disabled = true;
                    deployBtn.innerHTML = `
                        <svg class="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.4 0 0 5.4 0 12h4z"></path>
                        </svg>
                        Deploying LiveClaw...
                    `;
                    if (!await ensureFreshToken()) return;
                    const headers = { 'Content-Type': 'application/json' };
                    if (state.idToken) headers['Authorization'] = 'Bearer ' + state.idToken;
                    await executeDeploy(deployBtn, origHTML, headers);
                }
            }, 2000);
        }
    }

    // ─── Init ───────────────────────────────────────────────────────────────
    function init() {
        injectStyles();
        initGoogleAuth();
        wireConnectButton();
        wireModelTracking();
        handleCheckoutReturn();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
        // Retry for hydration edge cases
        setTimeout(init, 600);
    }
})();
