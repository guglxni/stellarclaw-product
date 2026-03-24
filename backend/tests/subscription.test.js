/**
 * Integration tests for LiveClaw Subscription, Pricing, and Referral endpoints.
 *
 * Covers:
 *  - GET  /pricing
 *  - GET  /subscription/:userId
 *  - POST /create-checkout-session (mocked Dodo SDK)
 *  - POST /create-portal-session  (mocked Dodo SDK)
 *  - POST /referral/generate
 *  - POST /referral/apply
 *  - POST /webhook/dodo           (signature verification mocked)
 *  - POST /deploy-bot subscription gate (402 + bot limit)
 */

import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import request from 'supertest';

let app, db, stmt, stmtSubs, dodoModule;

// ── Mock functions (assigned in beforeAll after requiring the real module) ──
const mockFns = {
    createCheckoutSession: vi.fn().mockResolvedValue({
        sessionId: 'sess_test_123',
        checkoutUrl: 'https://checkout.dodopayments.com/test',
    }),
    createPortalSession: vi.fn().mockResolvedValue({
        link: 'https://portal.dodopayments.com/test',
    }),
    getSubscription: vi.fn().mockResolvedValue({
        subscription_id: 'sub_test_123',
        status: 'active',
    }),
    cancelSubscription: vi.fn().mockResolvedValue({}),
    verifyWebhookEvent: vi.fn(),
};

beforeAll(async () => {
    // Require server first (this also requires ./dodo internally)
    const mod = require('../server');
    await mod.dbReady;
    app = mod.app;
    db = mod.db;
    stmt = mod.stmt;
    stmtSubs = mod.stmtSubs;

    // CJS require returns the SAME object reference — mutating it affects
    // all consumers (including server.js's `const dodo = require('./dodo')`)
    dodoModule = require('../dodo');
    dodoModule.createCheckoutSession = mockFns.createCheckoutSession;
    dodoModule.createPortalSession = mockFns.createPortalSession;
    dodoModule.getSubscription = mockFns.getSubscription;
    dodoModule.cancelSubscription = mockFns.cancelSubscription;
    dodoModule.verifyWebhookEvent = mockFns.verifyWebhookEvent;
});

afterAll(async () => {
    if (db) {
        try { await db.close(); } catch (_) { /* already closed */ }
    }
});

const TEST_USER = 'test-sub-user-001';
const TEST_USER_2 = 'test-sub-user-002';

// ═══════════════════════════════════════════════════════════════════════════
// GET /pricing
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /pricing', () => {
    it('returns 200 with trial, standard, and earlyClaw plans', async () => {
        const res = await request(app)
            .get('/pricing')
            .expect(200);

        expect(res.body.plans).toBeDefined();
        expect(res.body.trialEligible).toBe(true);

        // Trial plan
        expect(res.body.plans.trial).toBeDefined();
        expect(res.body.plans.trial.id).toBe('trial');
        expect(res.body.plans.trial.price).toBe(0.99);
        expect(res.body.plans.trial.interval).toBe('one-time');
        expect(Array.isArray(res.body.plans.trial.features)).toBe(true);

        // Standard plan
        expect(res.body.plans.standard).toBeDefined();
        expect(res.body.plans.standard.id).toBe('standard');
        expect(res.body.plans.standard.price).toBe(9.99);
        expect(res.body.plans.standard.bots).toBe(1);
        expect(Array.isArray(res.body.plans.standard.features)).toBe(true);

        // Early Claw plan
        expect(res.body.plans.earlyClaw).toBeDefined();
        expect(res.body.plans.earlyClaw.price).toBe(6.99);
        expect(res.body.plans.earlyClaw.promoCode).toBe('EARLYCLAW');
        expect(typeof res.body.plans.earlyClaw.spotsRemaining).toBe('number');
    });

    it('reports trial ineligible when user has used trial', async () => {
        // Seed a used trial
        await stmtSubs.upsert({
            user_id: 'trial-used-user',
            dodo_customer_id: null,
            dodo_subscription_id: null,
            plan: 'trial',
            status: 'cancelled',
            current_period_start: null,
            current_period_end: null,
        });
        await db.run(
            "UPDATE subscriptions SET trial_ends_at = datetime('now', '-1 hour') WHERE user_id = ?",
            ['trial-used-user']
        );

        const res = await request(app)
            .get('/pricing?userId=trial-used-user')
            .expect(200);

        expect(res.body.trialEligible).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /subscription/:userId
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /subscription/:userId', () => {
    it('returns hasSubscription: false for unknown user', async () => {
        const res = await request(app)
            .get('/subscription/nonexistent-user-xyz')
            .expect(200);

        expect(res.body.hasSubscription).toBe(false);
    });

    it('returns subscription details for subscribed user', async () => {
        // Seed a subscription
        await stmtSubs.upsert({
            user_id: TEST_USER,
            dodo_customer_id: 'cus_test_001',
            dodo_subscription_id: 'sub_test_001',
            plan: 'standard',
            status: 'active',
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        });

        const res = await request(app)
            .get('/subscription/' + TEST_USER)
            .expect(200);

        expect(res.body.hasSubscription).toBe(true);
        expect(res.body.plan).toBe('standard');
        expect(res.body.status).toBe('active');
        expect(res.body.currentPeriodEnd).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /create-checkout-session
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /create-checkout-session', () => {
    it('returns 401 for missing userId (security: rejects before field validation)', async () => {
        await request(app)
            .post('/create-checkout-session')
            .send({})
            .expect(401);
    });

    it('creates checkout session for valid request', async () => {
        const newUser = 'checkout-test-user-' + Date.now();
        const res = await request(app)
            .post('/create-checkout-session')
            .send({ userId: newUser, email: 'test@example.com' })
            .expect(200);

        expect(res.body.checkoutUrl).toBe('https://checkout.dodopayments.com/test');
        expect(res.body.sessionId).toBe('sess_test_123');
        expect(mockFns.createCheckoutSession).toHaveBeenCalled();
    });

    it('creates checkout session with EARLYCLAW promo code', async () => {
        const newUser = 'earlyclaw-test-user-' + Date.now();
        const res = await request(app)
            .post('/create-checkout-session')
            .send({ userId: newUser, email: 'early@example.com', promoCode: 'EARLYCLAW' })
            .expect(200);

        expect(res.body.checkoutUrl).toBe('https://checkout.dodopayments.com/test');
        expect(res.body.earlyBird).toBe(true);
        expect(mockFns.createCheckoutSession).toHaveBeenCalled();
    });

    it('returns 409 if user already has active subscription', async () => {
        // TEST_USER was seeded with active subscription
        const res = await request(app)
            .post('/create-checkout-session')
            .send({ userId: TEST_USER, email: 'test@example.com' })
            .expect(409);

        expect(res.body.error).toMatch(/already.*active/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /create-portal-session
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /create-portal-session', () => {
    it('returns 401 for missing userId (security: rejects before field validation)', async () => {
        await request(app)
            .post('/create-portal-session')
            .send({})
            .expect(401);
    });

    it('returns 404 for user without subscription', async () => {
        await request(app)
            .post('/create-portal-session')
            .send({ userId: 'no-such-user-portal' })
            .expect(404);
    });

    it('creates portal session for subscribed user', async () => {
        const res = await request(app)
            .post('/create-portal-session')
            .send({ userId: TEST_USER })
            .expect(200);

        expect(res.body.portalUrl).toBe('https://portal.dodopayments.com/test');
        expect(mockFns.createPortalSession).toHaveBeenCalledWith('cus_test_001');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /referral/generate
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /referral/generate', () => {
    it('returns 401 for missing userId (security: rejects before field validation)', async () => {
        await request(app)
            .post('/referral/generate')
            .send({})
            .expect(401);
    });

    it('returns 404 for user without subscription', async () => {
        await request(app)
            .post('/referral/generate')
            .send({ userId: 'no-sub-user-ref' })
            .expect(404);
    });

    it('generates a referral code for subscribed user', async () => {
        const res = await request(app)
            .post('/referral/generate')
            .send({ userId: TEST_USER })
            .expect(200);

        expect(res.body.referralCode).toBeDefined();
        expect(res.body.referralCode).toMatch(/^LC-[A-Z2-9]{5}$/);
    });

    it('returns existing code if already generated', async () => {
        const res1 = await request(app)
            .post('/referral/generate')
            .send({ userId: TEST_USER })
            .expect(200);

        const res2 = await request(app)
            .post('/referral/generate')
            .send({ userId: TEST_USER })
            .expect(200);

        expect(res1.body.referralCode).toBe(res2.body.referralCode);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /referral/apply
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /referral/apply', () => {
    it('returns 401 for missing fields (security: rejects before field validation)', async () => {
        await request(app)
            .post('/referral/apply')
            .send({})
            .expect(401);
    });

    it('returns 400 for invalid code format', async () => {
        const res = await request(app)
            .post('/referral/apply')
            .send({ userId: TEST_USER_2, referralCode: 'BAD-CODE' })
            .expect(400);

        expect(res.body.error).toMatch(/invalid.*format/i);
    });

    it('returns 404 for non-existent referral code', async () => {
        await request(app)
            .post('/referral/apply')
            .send({ userId: TEST_USER_2, referralCode: 'LC-ZZZZZ' })
            .expect(404);
    });

    it('prevents self-referral', async () => {
        // Get TEST_USER's referral code
        const genRes = await request(app)
            .post('/referral/generate')
            .send({ userId: TEST_USER })
            .expect(200);

        const code = genRes.body.referralCode;

        const res = await request(app)
            .post('/referral/apply')
            .send({ userId: TEST_USER, referralCode: code })
            .expect(400);

        expect(res.body.error).toMatch(/cannot.*your own/i);
    });

    it('applies a valid referral code', async () => {
        // Get TEST_USER's referral code
        const genRes = await request(app)
            .post('/referral/generate')
            .send({ userId: TEST_USER })
            .expect(200);

        const code = genRes.body.referralCode;

        const res = await request(app)
            .post('/referral/apply')
            .send({ userId: TEST_USER_2, referralCode: code })
            .expect(200);

        expect(res.body.success).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /webhook/dodo
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /webhook/dodo', () => {
    it('returns 401 for invalid signature', async () => {
        mockFns.verifyWebhookEvent.mockImplementationOnce(() => {
            throw new Error('Invalid signature');
        });

        await request(app)
            .post('/webhook/dodo')
            .set('Content-Type', 'application/json')
            .set('webhook-id', 'wh_test')
            .set('webhook-timestamp', String(Math.floor(Date.now() / 1000)))
            .set('webhook-signature', 'invalid')
            .send('{}')
            .expect(401);
    });

    it('handles subscription.active event', async () => {
        const event = {
            type: 'subscription.active',
            data: {
                subscription_id: 'sub_webhook_001',
                product_id: 'prod_starter_456',
                customer: { customer_id: 'cus_webhook_001' },
                status: 'active',
                metadata: { liveclaw_user_id: 'webhook-user-001' },
                next_billing_date: new Date(Date.now() + 30 * 86400000).toISOString(),
                previous_billing_date: new Date().toISOString(),
            },
            business_id: 'biz_test',
        };

        mockFns.verifyWebhookEvent.mockReturnValueOnce(event);

        const res = await request(app)
            .post('/webhook/dodo')
            .set('Content-Type', 'application/json')
            .set('webhook-id', 'wh_active_001')
            .set('webhook-timestamp', String(Math.floor(Date.now() / 1000)))
            .set('webhook-signature', 'v1,testsig')
            .send(JSON.stringify(event))
            .expect(200);

        expect(res.body.received).toBe(true);

        // Verify subscription was upserted
        const sub = await stmtSubs.getByUserId('webhook-user-001');
        expect(sub).toBeDefined();
        expect(sub.status).toBe('active');
        expect(sub.plan).toBe('standard');
    });

    it('handles subscription.cancelled event', async () => {
        const event = {
            type: 'subscription.cancelled',
            data: {
                subscription_id: 'sub_webhook_001',
                product_id: 'prod_starter_456',
                customer: { customer_id: 'cus_webhook_001' },
                status: 'cancelled',
                metadata: { liveclaw_user_id: 'webhook-user-001' },
            },
            business_id: 'biz_test',
        };

        mockFns.verifyWebhookEvent.mockReturnValueOnce(event);

        await request(app)
            .post('/webhook/dodo')
            .set('Content-Type', 'application/json')
            .set('webhook-id', 'wh_cancel_001')
            .set('webhook-timestamp', String(Math.floor(Date.now() / 1000)))
            .set('webhook-signature', 'v1,testsig')
            .send(JSON.stringify(event))
            .expect(200);

        const sub = await stmtSubs.getByUserId('webhook-user-001');
        expect(sub).toBeDefined();
        expect(sub.status).toBe('cancelled');
    });

    it('handles payment.succeeded event', async () => {
        const event = {
            type: 'payment.succeeded',
            data: {
                payment_id: 'pay_test_001',
                subscription_id: 'sub_webhook_001',
                product_id: 'prod_starter_456',
                customer: { customer_id: 'cus_webhook_001' },
                total_amount: 399,
                currency: 'USD',
                metadata: { liveclaw_user_id: 'webhook-user-001' },
            },
            business_id: 'biz_test',
        };

        mockFns.verifyWebhookEvent.mockReturnValueOnce(event);

        await request(app)
            .post('/webhook/dodo')
            .set('Content-Type', 'application/json')
            .set('webhook-id', 'wh_pay_001')
            .set('webhook-timestamp', String(Math.floor(Date.now() / 1000)))
            .set('webhook-signature', 'v1,testsig')
            .send(JSON.stringify(event))
            .expect(200);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /deploy-bot — Subscription Gate
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /deploy-bot — subscription gate', () => {
    it('returns 403 when user has no subscription (ownership check rejects unauthenticated first)', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({
                userId: 'no-sub-deploy-user',
                telegramToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz12345678',
                model: 'minimax-m2.5',
            })
            .expect(403);

        expect(res.body.error).toMatch(/match/i);
    });

    it('allows deploy for user with active subscription', async () => {
        // Seed subscription for deploy test user
        const deployUser = 'deploy-sub-test-' + Date.now();
        await stmtSubs.upsert({
            user_id: deployUser,
            dodo_customer_id: 'cus_deploy_001',
            dodo_subscription_id: 'sub_deploy_001',
            plan: 'standard',
            status: 'active',
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(),
        });

        // Deploy will fail at Bifrost step (not mocked), but should not fail at subscription gate
        const res = await request(app)
            .post('/deploy-bot')
            .send({
                userId: deployUser,
                telegramToken: '1234567890:ABCdefGHIjklMNOpqrsTUVwxyz12345678',
                model: 'minimax-m2.5',
            });

        // Should NOT be 402 (subscription gate passed)
        expect(res.status).not.toBe(402);
    });
});
