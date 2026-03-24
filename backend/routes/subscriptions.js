/**
 * LiveClaw — Subscription Routes
 *
 * Extracted from server.js. Uses factory pattern with dependency injection.
 *
 * Routes:
 *   POST   /create-checkout-session
 *   POST   /create-portal-session
 *   GET    /subscription/:userId
 *   POST   /create-trial-checkout
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
        if (existing && ['active', 'trialing'].includes(existing.status)) {
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
            discountCode = 'EARLYCLAW'; // Dodo applies ~30.1% off → ~$6.99/mo
            logEvent(userId, 'promo_code_applied', { code: 'EARLYCLAW', spotsRemaining: 500 - usedCount - 1 });
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
                plan, userId, email || `${userId}@liveclaw.xyz`,
                'https://liveclaw.xyz?checkout=success',
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

    // ─── POST /create-trial-checkout — $0.99 Two-Day Trial Checkout ─────────────
    // Creates a Dodo one-time payment for the trial product ($0.99).
    // On payment.succeeded the webhook activates a 48h trialing subscription.
    router.post('/create-trial-checkout', deployLimiter, asyncHandler(authMiddleware), checkoutPerUser, asyncHandler(async (req, res) => {
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

        // Block if user already has active/trialing access
        const existing = await stmtSubs.getByUserId(userId);
        if (existing && ['active', 'trialing'].includes(existing.status)) {
            return res.status(409).json({
                error: 'You already have an active subscription',
                status: existing.status,
            });
        }

        // Block if user has already used a trial (trial_ends_at was set at any point)
        const usedTrial = await db.get(
            'SELECT trial_ends_at FROM subscriptions WHERE user_id = ? AND trial_ends_at IS NOT NULL',
            [userId]
        );
        if (usedTrial) {
            return res.status(409).json({ error: 'Trial already used. Please subscribe to continue.' });
        }

        try {
            const session = await dodo.createTrialCheckoutSession(
                userId,
                email || `${userId}@liveclaw.xyz`,
                'https://liveclaw.xyz?checkout=trial-success'
            );
            logEvent(userId, 'trial_checkout_created', { sessionId: session.sessionId });
            return res.json({ checkoutUrl: session.checkoutUrl, sessionId: session.sessionId });
        } catch (err) {
            log.checkout.error('Dodo trial checkout error', { error: err.message });
            return res.status(502).json({ error: 'Failed to create trial checkout session' });
        }
    }));

    // ─── GET /pricing — Public Pricing ──────────────────────────────────────────
    router.get('/pricing', asyncHandler(async (req, res) => {
        const earlyBirdUsed = (await db.get(
            "SELECT COUNT(*) as count FROM subscriptions WHERE early_bird = 1 AND status IN ('active','trialing','past_due')"
        )).count;

        // Check trial eligibility if userId is provided
        let trialEligible = true;
        const userId = req.query.userId;
        if (userId && typeof userId === 'string') {
            const usedTrial = await db.get(
                'SELECT trial_ends_at FROM subscriptions WHERE user_id = ? AND trial_ends_at IS NOT NULL',
                [userId]
            );
            if (usedTrial) trialEligible = false;
        }

        return res.json({
            trialEligible,
            plans: {
                trial: {
                    id: 'trial',
                    name: 'LiveClaw Trial',
                    price: 0.99,
                    currency: 'usd',
                    interval: 'one-time',
                    duration: '48 hours',
                    features: [
                        '24/7 AI agent on Telegram',
                        'Custom personality (SOUL.md)',
                        'Full access for 48 hours',
                    ],
                },
                standard: {
                    id: 'standard',
                    name: 'LiveClaw',
                    price: 9.99,
                    currency: 'usd',
                    interval: 'month',
                    bots: 1,
                    channels: ['telegram'],
                    features: [
                        '24/7 AI agent on Telegram',
                        'Custom personality (SOUL.md)',
                        'Unlimited messages within budget',
                        'Email support',
                    ],
                },
                earlyClaw: {
                    id: 'standard',
                    name: 'LiveClaw — Early Claw',
                    price: 6.99,
                    currency: 'usd',
                    interval: 'month',
                    bots: 1,
                    channels: ['telegram'],
                    promoCode: 'EARLYCLAW',
                    spotsRemaining: Math.max(0, 500 - earlyBirdUsed),
                    features: [
                        '24/7 AI agent on Telegram',
                        'Custom personality (SOUL.md)',
                        'Unlimited messages within budget',
                        'Email support',
                        'Locked-in Early Claw pricing',
                    ],
                },
            },
        });
    }));

    // ─── POST /redeem-beta — Redeem a Beta Access Code via Dodo Checkout ────────
    // Validates the beta code in our DB, then creates a Dodo trial checkout with
    // the code as a 100% discount coupon. Dodo handles billing ($0.99 - 100% = $0.00),
    // then fires payment.succeeded → webhook activates 48h trial.
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

        // Validate format: XXXX-XXXX-XXXX (12 alphanumeric chars in 3 groups)
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
            return res.status(400).json({ error: 'Invalid beta code format' });
        }

        // Check user doesn't already have an active/trialing subscription
        const existing = await stmtSubs.getByUserId(userId);
        if (existing && ['active', 'trialing'].includes(existing.status)) {
            return res.status(409).json({
                error: 'You already have an active subscription',
                status: existing.status,
            });
        }

        // Validate the beta code exists and is unclaimed in our DB
        const record = await stmtBeta.getByCode(code);
        if (!record) {
            return res.status(404).json({ error: 'Beta code not found' });
        }
        if (record.redeemed_by) {
            return res.status(410).json({ error: 'Beta code has already been used' });
        }

        // Atomically claim the code in our DB (prevents double-use)
        const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
        const ua = (req.headers['user-agent'] || '').slice(0, 256);
        const changes = (await stmtBeta.redeem(userId, ip, ua, code)).changes;
        if (changes === 0) {
            return res.status(410).json({ error: 'Beta code has already been used' });
        }

        // Create a Dodo checkout for the trial product with this code as a 100% discount
        try {
            const session = await dodo.createTrialCheckoutSession(
                userId,
                email || `${userId}@liveclaw.xyz`,
                'https://liveclaw.xyz?checkout=trial-success',
                code  // beta code = Dodo discount code
            );

            // Track that this user used this beta code
            await db.run(
                'UPDATE subscriptions SET beta_code_used = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                [code, userId]
            );

            logEvent(userId, 'beta_code_redeemed', { code, sessionId: session.sessionId });

            return res.json({
                success: true,
                checkoutUrl: session.checkoutUrl,
                sessionId: session.sessionId,
                message: 'Complete checkout to activate your 48-hour free trial.',
            });
        } catch (err) {
            log.checkout.error('Beta redeem checkout error', { error: err.message });
            // Roll back the DB claim so user can retry
            await db.run(
                'UPDATE beta_codes SET redeemed_by = NULL, redeemed_at = NULL, redeemed_ip = NULL, user_agent = NULL WHERE code = ? AND redeemed_by = ?',
                [code, userId]
            );
            return res.status(502).json({ error: 'Failed to create trial checkout session' });
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

    return router;
}

module.exports = { createSubscriptionRouter };
