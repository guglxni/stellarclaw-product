/**
 * StellarClaw — Subscription Routes
 *
 * Extracted from server.js. Uses factory pattern with dependency injection.
 *
 * Routes:
 *   POST   /create-checkout-session
 *   POST   /create-portal-session
 *   GET    /subscription/:userId
 *   GET    /pricing
 *   POST   /redeem-beta
 *   POST   /referral/generate
 *   POST   /referral/apply
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

/**
 * Creates the subscription router with all dependencies injected.
 *
 * @param {object} deps - Shared dependencies from server.js
 * @returns {express.Router}
 */
function createSubscriptionRouter(deps) {
    const {
        config,
        isProd,
        db,
        stmt,
        stmtSubs,
        stmtBeta,
        logEvent,
        log,
        dodo,
        asyncHandler,
        authMiddleware,
        deployLimiter,
        checkoutPerUser,
    } = deps;

    const router = express.Router();

    // ─── POST /create-checkout-session — Dodo Payments Checkout ─────────────────
    router.post('/create-checkout-session', deployLimiter, asyncHandler(authMiddleware), checkoutPerUser, asyncHandler(async (req, res) => {
        const { referralCode, promoCode } = req.body;
        const plan = 'standard'; // unified plan
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'User ID required' });
        }
        if (req.verifiedUserId && req.verifiedUserId !== (req.body?.userId || req.verifiedUserId)) {
            return res.status(403).json({ error: 'Forbidden: user ID mismatch' });
        }
        const email = req.verifiedEmail || req.body.email;

        if (typeof userId !== 'string') {
            return res.status(400).json({ error: 'userId is required' });
        }

        // Check if user already has an active subscription
        const existing = await stmtSubs.getByUserId(userId);
        if (existing && ['active', 'trialing', 'past_due'].includes(existing.status)) {
            return res.status(409).json({
                error: 'You already have an active subscription',
                plan: existing.plan,
                status: existing.status,
            });
        }

        // ── EARLYCLAW promo code validation ─────────────────────────────────────
        // Count only confirmed-paying subscribers so abandoned checkouts never
        // consume a spot. Spots are permanently assigned in the webhook handler
        // once Dodo confirms the subscription is active/trialing.
        let earlyBird = false;
        let discountCode = null;
        if (promoCode && typeof promoCode === 'string' && promoCode.toUpperCase() === 'EARLYCLAW') {
            const usedCount = (await db.get(
                "SELECT COUNT(*) as count FROM subscriptions WHERE early_bird = 1 AND status IN ('active','trialing','past_due')"
            )).count;
            if (usedCount >= 500) {
                return res.status(410).json({
                    error: 'Early Claw offer has ended',
                    message: 'All 500 Early Claw spots have been claimed.',
                });
            }
            earlyBird = true;
            discountCode = 'EARLYCLAW'; // Dodo applies 30% off first month → $6.99, then $9.99/mo
            logEvent(userId, 'promo_code_applied', { code: 'EARLYCLAW', spotsRemaining: 500 - usedCount });
        }

        // Handle referral code
        if (referralCode && typeof referralCode === 'string') {
            const referrer = await stmtSubs.getReferralByCode(referralCode.toUpperCase());
            if (referrer && referrer.user_id !== userId) {
                // Valid referral — track it
                await stmtSubs.setReferredBy(referralCode.toUpperCase(), userId);
                await stmtSubs.insertReferral(referrer.user_id, userId, referralCode.toUpperCase());
                logEvent(userId, 'referral_applied', { code: referralCode, referrerId: referrer.user_id });
            }
        }

        try {
            const session = await dodo.createCheckoutSession(
                plan, userId, email || `${userId}@stellarclaw.xyz`,
                'https://stellarclaw.xyz?checkout=success',
                discountCode,
                earlyBird
            );

            // Ensure user has a subscription record (inactive until webhook confirms)
            if (!existing) {
                await stmtSubs.upsert({
                    user_id: userId,
                    dodo_customer_id: null,
                    dodo_subscription_id: null,
                    plan,
                    status: 'inactive',
                    current_period_start: null,
                    current_period_end: null,
                });
            }

            // NOTE: early_bird = 1 is NOT set here — it is set in the webhook handler
            // (subscription.active or payment.succeeded) once Dodo confirms payment,
            // so abandoned checkouts never consume a promo spot.

            logEvent(userId, 'checkout_session_created', { plan, sessionId: session.sessionId, earlyBird });

            return res.json({
                checkoutUrl: session.checkoutUrl,
                sessionId: session.sessionId,
                earlyBird,
            });
        } catch (err) {
            log.checkout.error('Dodo checkout error', { error: err.message });
            logEvent(userId, 'checkout_error', err.message);
            return res.status(502).json({ error: 'Failed to create checkout session' });
        }
    }));

    // ─── POST /create-portal-session — Dodo Customer Portal ────────────────────
    router.post('/create-portal-session', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'User ID required' });
        }
        if (req.verifiedUserId && req.verifiedUserId !== (req.body?.userId || req.verifiedUserId)) {
            return res.status(403).json({ error: 'Forbidden: user ID mismatch' });
        }

        if (typeof userId !== 'string') {
            return res.status(400).json({ error: 'userId is required' });
        }

        const sub = await stmtSubs.getByUserId(userId);
        if (!sub || !sub.dodo_customer_id) {
            return res.status(404).json({ error: 'No subscription found. Subscribe first.' });
        }

        try {
            const portal = await dodo.createPortalSession(sub.dodo_customer_id);
            logEvent(userId, 'portal_session_created');
            return res.json({ portalUrl: portal.link });
        } catch (err) {
            log.checkout.error('Dodo portal error', { error: err.message });
            return res.status(502).json({ error: 'Failed to create portal session' });
        }
    }));

    // ─── GET /subscription/:userId — Subscription Status ───────────────────────
    router.get('/subscription/:userId', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const { userId } = req.params;

        // In production, ensure user can only check their own subscription
        if (req.verifiedUserId && req.verifiedUserId !== userId) {
            return res.status(403).json({ error: 'Cannot view another user\'s subscription' });
        }

        const sub = await stmtSubs.getByUserId(userId);
        if (!sub) {
            return res.json({
                hasSubscription: false,
                plan: null,
                status: 'inactive',
            });
        }

        return res.json({
            hasSubscription: true,
            plan: sub.plan,
            status: sub.status,
            currentPeriodEnd: sub.current_period_end,
            earlyBird: !!sub.early_bird,
            referralCode: sub.referral_code,
            dodoCustomerId: sub.dodo_customer_id,
        });
    }));

    // ─── GET /pricing — Public Pricing ──────────────────────────────────────────
    router.get('/pricing', asyncHandler(async (req, res) => {
        const earlyBirdUsed = (await db.get(
            "SELECT COUNT(*) as count FROM subscriptions WHERE early_bird = 1 AND status IN ('active','trialing','past_due')"
        )).count;

        const allChannels = ['telegram', 'discord', 'slack', 'whatsapp'];
        const allModels = [
            { id: 'minimax-m2.7', name: 'MiniMax M2.7', context: '200K' },
            { id: 'minimax-m2.5', name: 'MiniMax M2.5', context: '196K' },
            { id: 'kimi-k2.5', name: 'Kimi K2.5', context: '128K' },
            { id: 'mimo-v2-pro', name: 'MiMo v2 Pro', context: '1M' },
            { id: 'glm-5', name: 'GLM-5', context: '80K' },
            { id: 'deepseek-v3.2', name: 'DeepSeek v3.2', context: '128K' },
        ];

        return res.json({
            models: allModels,
            plans: {
                standard: {
                    id: 'standard',
                    name: 'StellarClaw',
                    price: 9.99,
                    currency: 'usd',
                    interval: 'month',
                    bots: 1,
                    channels: allChannels,
                    features: [
                        '24/7 AI agent on Telegram, Discord, Slack & WhatsApp',
                        '6 AI models — MiniMax, MiMo, GLM-5, DeepSeek & more',
                        'Custom personality (SOUL.md)',
                        'Unlimited messages within budget',
                        'Email support',
                    ],
                },
                earlyClaw: {
                    id: 'standard',
                    name: 'Early Claw',
                    firstMonthPrice: 6.99,
                    price: 9.99,
                    currency: 'usd',
                    interval: 'month',
                    bots: 1,
                    channels: allChannels,
                    promoCode: 'EARLYCLAW',
                    spotsRemaining: Math.max(0, 500 - earlyBirdUsed),
                    features: [
                        'First month $6.99, then $9.99/mo',
                        '24/7 AI agent on Telegram, Discord, Slack & WhatsApp',
                        '6 AI models — MiniMax, MiMo, GLM-5, DeepSeek & more',
                        'Custom personality (SOUL.md)',
                        'Unlimited messages within budget',
                        'Email support',
                    ],
                },
            },
        });
    }));

    // ─── POST /redeem-beta — Redeem a Beta Access Code via Dodo Checkout ────────
    // Validates the beta code in our DB, then creates a standard checkout with
    // the code as a 100% discount coupon (first month free via subscription_cycles: 1).
    // Dodo handles billing ($9.99 - 100% = $0.00 first month), then charges normally.
    router.post('/redeem-beta', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const { betaCode } = req.body;
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'User ID required' });
        }
        if (req.verifiedUserId && req.verifiedUserId !== (req.body?.userId || req.verifiedUserId)) {
            return res.status(403).json({ error: 'Forbidden: user ID mismatch' });
        }
        const email = req.verifiedEmail || req.body.email;

        if (typeof userId !== 'string') {
            return res.status(400).json({ error: 'userId is required' });
        }
        if (!betaCode || typeof betaCode !== 'string') {
            return res.status(400).json({ error: 'betaCode is required' });
        }

        const code = betaCode.toUpperCase().trim();

        // Two valid formats:
        // - XXXX-XXXX-XXXX → DB-tracked beta code (90.09% off first month)
        // - 16-char alphanum → direct Dodo discount code (e.g. founder 100% off codes)
        const isDbBetaCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
        const isDirectDodoCode = /^[A-Z0-9]{16}$/.test(code);

        if (!isDbBetaCode && !isDirectDodoCode) {
            return res.status(400).json({ error: 'Invalid beta code format' });
        }

        // Check user doesn't already have an active/trialing subscription
        const existing = await stmtSubs.getByUserId(userId);
        if (existing && ['active', 'trialing', 'past_due'].includes(existing.status)) {
            return res.status(409).json({
                error: 'You already have an active subscription',
                status: existing.status,
            });
        }

        // DB-tracked beta codes: validate existence + atomic claim
        if (isDbBetaCode) {
            const record = await stmtBeta.getByCode(code);
            if (!record) {
                return res.status(404).json({ error: 'Beta code not found' });
            }
            if (record.redeemed_by) {
                return res.status(410).json({ error: 'Beta code has already been used' });
            }

            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
            const ua = (req.headers['user-agent'] || '').slice(0, 256);
            const changes = (await stmtBeta.redeem(userId, ip, ua, code)).changes;
            if (changes === 0) {
                return res.status(410).json({ error: 'Beta code has already been used' });
            }

            // Create a Dodo checkout with the beta code as a discount
            try {
                const session = await dodo.createCheckoutSession(
                    'beta',
                    userId,
                    email || `${userId}@stellarclaw.xyz`,
                    'https://stellarclaw.xyz?checkout=success',
                    code
                );
                await db.run(
                    'UPDATE subscriptions SET beta_code_used = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                    [code, userId]
                );
                logEvent(userId, 'beta_code_redeemed', { code, sessionId: session.sessionId });
                return res.json({
                    success: true,
                    checkoutUrl: session.checkoutUrl,
                    sessionId: session.sessionId,
                    message: 'Complete checkout to activate your discounted first month.',
                });
            } catch (err) {
                log.checkout.error('Beta redeem checkout error', { error: err.message });
                await db.run(
                    'UPDATE beta_codes SET redeemed_by = NULL, redeemed_at = NULL, redeemed_ip = NULL, user_agent = NULL WHERE code = ? AND redeemed_by = ?',
                    [code, userId]
                );
                return res.status(502).json({ error: 'Failed to create checkout session' });
            }
        }

        // ── Direct Dodo discount codes (16-char, e.g. founder codes) ─────────────
        // Bypass checkout entirely — no payment info required.
        // Usage enforcement: check our DB (since we're not going through Dodo checkout).
        const alreadyUsed = await db.get(
            'SELECT user_id FROM subscriptions WHERE beta_code_used = ? LIMIT 1',
            [code]
        );
        if (alreadyUsed) {
            return res.status(410).json({ error: 'This code has already been used' });
        }

        // Provision the user directly as active — perpetual access, no billing
        const now = new Date().toISOString();
        await stmtSubs.upsert({
            user_id: userId,
            dodo_customer_id: null,
            dodo_subscription_id: `founder:${code}`,
            plan: 'standard',
            status: 'active',
            current_period_start: now,
            current_period_end: null,
        });
        await db.run(
            'UPDATE subscriptions SET beta_code_used = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            [code, userId]
        );

        logEvent(userId, 'founder_code_redeemed', { code });

        return res.json({
            success: true,
            provisioned: true,
            message: 'Founder access activated! Welcome to StellarClaw.',
        });
    }));

    // ─── POST /purchase-credits — Buy LLM Credits via Dodo ─────────────────────
    // Creates a Dodo one-time checkout for credit top-up.
    // On payment.succeeded, the webhook tops up the user's Bifrost VK budget.
    router.post('/purchase-credits', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId) return res.status(401).json({ error: 'User ID required' });
        if (req.verifiedUserId && req.verifiedUserId !== (req.body?.userId || req.verifiedUserId)) {
            return res.status(403).json({ error: 'Forbidden' });
        }
        const email = req.verifiedEmail || req.body.email;
        const amount = parseInt(req.body.amount, 10);

        if (!amount || amount < 1 || amount > 50) {
            return res.status(400).json({ error: 'Amount must be between $1 and $50' });
        }

        // User must have an active subscription and a deployed bot
        const sub = await stmtSubs.getByUserId(userId);
        if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) {
            return res.status(403).json({ error: 'Active subscription required' });
        }
        const bot = await db.get('SELECT bifrost_vk_id FROM bots WHERE user_id = ?', [userId]);
        if (!bot || !bot.bifrost_vk_id) {
            return res.status(404).json({ error: 'No deployed bot found' });
        }

        try {
            const session = await dodo.createCreditsCheckout(
                userId,
                email || `${userId}@stellarclaw.xyz`,
                amount,
                'https://stellarclaw.xyz?checkout=credits-success'
            );
            logEvent(userId, 'credits_checkout_created', { amount, sessionId: session.sessionId });
            return res.json({ checkoutUrl: session.checkoutUrl, sessionId: session.sessionId });
        } catch (err) {
            log.checkout.error('Credits checkout error', { error: err.message });
            return res.status(502).json({ error: 'Failed to create credits checkout' });
        }
    }));

    // ─── POST /referral/generate — Generate Referral Code ───────────────────────
    router.post('/referral/generate', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'User ID required' });
        }
        if (req.verifiedUserId && req.verifiedUserId !== (req.body?.userId || req.verifiedUserId)) {
            return res.status(403).json({ error: 'Forbidden: user ID mismatch' });
        }

        if (typeof userId !== 'string') {
            return res.status(400).json({ error: 'userId is required' });
        }

        const sub = await stmtSubs.getByUserId(userId);
        if (!sub) {
            return res.status(404).json({ error: 'No subscription found. Subscribe first.' });
        }

        // Return existing code if already generated
        if (sub.referral_code) {
            return res.json({ referralCode: sub.referral_code });
        }

        // Generate unique code: LC-XXXXX (no I/O/0/1 confusion)
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        let attempts = 0;
        do {
            code = 'LC-';
            for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
            attempts++;
        } while (await stmtSubs.getReferralByCode(code) && attempts < 10);

        if (attempts >= 10) {
            return res.status(500).json({ error: 'Failed to generate unique code' });
        }

        await stmtSubs.setReferralCode(code, userId);
        logEvent(userId, 'referral_code_generated', { code });

        return res.json({ referralCode: code });
    }));

    // ─── POST /referral/apply — Apply Referral Code ────────────────────────────
    // Rate limiter for referral code attempts (prevents enumeration)
    const referralLimiter = rateLimit({
        windowMs: 15 * 60 * 1000, // 15 minutes
        max: 10, // 10 attempts per 15 min per IP
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many referral attempts, try again later' },
    });

    router.post('/referral/apply', referralLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId) {
            return res.status(401).json({ error: 'User ID required' });
        }
        if (req.verifiedUserId && req.verifiedUserId !== (req.body?.userId || req.verifiedUserId)) {
            return res.status(403).json({ error: 'Forbidden: user ID mismatch' });
        }
        const { referralCode } = req.body;

        if (typeof userId !== 'string') {
            return res.status(400).json({ error: 'userId is required' });
        }
        if (!referralCode || typeof referralCode !== 'string') {
            return res.status(400).json({ error: 'referralCode is required' });
        }

        const code = referralCode.toUpperCase().trim();

        // Validate code format
        if (!/^LC-[A-Z2-9]{5}$/.test(code)) {
            return res.status(400).json({ error: 'Invalid referral code format' });
        }

        // Find referrer
        const referrer = await stmtSubs.getReferralByCode(code);
        if (!referrer) {
            return res.status(404).json({ error: 'Referral code not found' });
        }

        // Can't refer yourself
        if (referrer.user_id === userId) {
            return res.status(400).json({ error: 'Cannot use your own referral code' });
        }

        // Ensure user hasn't already been referred
        const userSub = await stmtSubs.getByUserId(userId);
        if (userSub && userSub.referred_by) {
            return res.status(409).json({ error: 'You have already used a referral code' });
        }

        // Ensure user has a subscription record
        if (!userSub) {
            await stmtSubs.upsert({
                user_id: userId,
                dodo_customer_id: null,
                dodo_subscription_id: null,
                plan: 'standard',
                status: 'inactive',
                current_period_start: null,
                current_period_end: null,
            });
        }

        await stmtSubs.setReferredBy(code, userId);
        await stmtSubs.insertReferral(referrer.user_id, userId, code);
        logEvent(userId, 'referral_applied', { code, referrerId: referrer.user_id });

        return res.json({ success: true, message: 'Referral code applied successfully' });
    }));

    // ─── Waitlist ─────────────────────────────────────────────────────────────
    // Rate-limited: 5 attempts per 15 min per IP
    const waitlistLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

    // POST /waitlist/join — Submit email + X username, receive OTP
    router.post('/waitlist/join', waitlistLimiter, asyncHandler(async (req, res) => {
        const { email, xUsername, linkedinUrl } = req.body;
        if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            return res.status(400).json({ error: 'Valid email required' });
        }
        if (!xUsername || typeof xUsername !== 'string' || xUsername.trim().length < 1 || xUsername.length > 50) {
            return res.status(400).json({ error: 'X (Twitter) username is required' });
        }
        // Sanitize X username: strip @ prefix, allow only alphanumeric + underscore
        const cleanX = xUsername.trim().replace(/^@/, '');
        if (!/^[a-zA-Z0-9_]{1,15}$/.test(cleanX)) {
            return res.status(400).json({ error: 'Invalid X username format' });
        }
        // Validate LinkedIn URL if provided
        let cleanLinkedin = null;
        if (linkedinUrl && typeof linkedinUrl === 'string' && linkedinUrl.trim()) {
            const url = linkedinUrl.trim();
            if (url.length > 200 || !/^https?:\/\/(www\.)?linkedin\.com\/in\/[a-zA-Z0-9_-]+\/?$/i.test(url)) {
                return res.status(400).json({ error: 'Invalid LinkedIn profile URL' });
            }
            cleanLinkedin = url;
        }

        const normalised = email.toLowerCase().trim();

        // Check if already verified. Return same success response to avoid email enumeration (A01).
        const existing = await db.get('SELECT verified, promo_code FROM waitlist WHERE email = ?', [normalised]);
        if (existing && existing.verified) {
            return res.json({ success: true, message: 'Verification code sent to your email.' });
        }

        // Generate 6-digit OTP, expires in 10 minutes
        const otp = String(crypto.randomInt(100000, 999999));
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        await db.run(
            `INSERT INTO waitlist (email, x_username, linkedin_url, otp, otp_expires) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET otp = excluded.otp, otp_expires = excluded.otp_expires,
             x_username = excluded.x_username, linkedin_url = excluded.linkedin_url`,
            [normalised, cleanX, cleanLinkedin, otp, otpExpires]
        );

        // Send OTP via Resend (FOSS-friendly transactional email, 3k/mo free)
        const resendKey = process.env.RESEND_API_KEY;
        if (resendKey) {
            try {
                const emailRes = await fetch('https://api.resend.com/emails', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        from: process.env.RESEND_FROM || 'StellarClaw <noreply@stellarclaw.xyz>',
                        to: normalised,
                        subject: 'Your StellarClaw verification code',
                        html: `<div style="font-family:-apple-system,sans-serif;max-width:400px;margin:0 auto;padding:2rem;">
                            <h2 style="color:#fff;margin:0 0 0.5rem;">StellarClaw</h2>
                            <p style="color:#a1a1aa;font-size:0.9375rem;margin:0 0 1.5rem;">Here's your verification code:</p>
                            <div style="background:#18181b;border:1px solid #27272a;border-radius:0.75rem;padding:1.25rem;text-align:center;margin:0 0 1.5rem;">
                                <span style="font-size:2rem;font-weight:700;letter-spacing:0.3em;color:#e4e4e7;">${otp}</span>
                            </div>
                            <p style="color:#71717a;font-size:0.8125rem;margin:0;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
                        </div>`,
                    }),
                });
                if (!emailRes.ok) {
                    const errBody = await emailRes.text();
                    log.checkout.error('Resend email failed', { status: emailRes.status, body: errBody });
                }
            } catch (err) {
                log.checkout.error('Resend email error', { error: err.message });
            }
        } else {
            // Fallback: log OTP (dev mode)
            log.checkout.info('Waitlist OTP (no RESEND_API_KEY)', { email: normalised, otp });
        }

        logEvent('system', 'waitlist_otp_sent', { email: normalised, xUsername: cleanX });

        return res.json({ success: true, message: 'Verification code sent to your email.' });
    }));

    // POST /waitlist/verify — Verify OTP, mark as verified
    router.post('/waitlist/verify', waitlistLimiter, asyncHandler(async (req, res) => {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required' });
        const normalised = email.toLowerCase().trim();

        const record = await db.get('SELECT otp, otp_expires, verified FROM waitlist WHERE email = ?', [normalised]);
        // Return the same error for unknown email and wrong OTP to prevent email enumeration (A01).
        if (!record) return res.status(400).json({ error: 'Invalid verification code' });
        if (record.verified) return res.json({ success: true, message: 'Already verified. You will receive your code soon.' });

        // Constant-time comparison prevents timing-based OTP brute-force (A07).
        const expected = Buffer.from(String(record.otp).trim().padEnd(16));
        const provided  = Buffer.from(String(otp).trim().padEnd(16));
        const match = expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
        if (!match) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }
        if (new Date(record.otp_expires) < new Date()) {
            return res.status(410).json({ error: 'Code expired. Request a new one.' });
        }

        await db.run(
            'UPDATE waitlist SET verified = 1, otp = NULL, otp_expires = NULL WHERE email = ?',
            [normalised]
        );
        logEvent('system', 'waitlist_verified', { email: normalised });

        return res.json({ success: true, message: 'Email verified! You are on the waitlist and will receive your exclusive promo code soon.' });
    }));

    // GET /waitlist/count — Public count of waitlist signups
    const countLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
    router.get('/waitlist/count', countLimiter, asyncHandler(async (_req, res) => {
        const row = await db.get('SELECT COUNT(*) as c FROM waitlist WHERE verified = 1');
        return res.json({ count: Number(row.c) || 0 });
    }));

    return router;
}

module.exports = { createSubscriptionRouter };
