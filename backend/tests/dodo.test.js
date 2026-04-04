/**
 * Unit tests for dodo.js — Dodo Payments billing module.
 *
 * Mocks the dodopayments SDK via require.cache injection (CJS-compatible).
 * This pattern reliably intercepts CJS require() calls regardless of
 * ESM/CJS interop mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock function handles ──────────────────────────────────────────────────
const mockCheckoutCreate    = vi.fn();
const mockPortalCreate      = vi.fn();
const mockSubsRetrieve      = vi.fn();
const mockSubsUpdate        = vi.fn();
const mockDiscountsCreate   = vi.fn();
const mockDiscountsByCode   = vi.fn();
const mockWebhooksUnwrap    = vi.fn();
const mockPaymentsList      = vi.fn();
const mockSubscriptionsList = vi.fn();

// Async generator helper for paginated list responses
function makeAsyncIter(items) {
    return {
        [Symbol.asyncIterator]: async function* () {
            for (const item of items) yield item;
        },
    };
}

// The mock client object — same reference used across all tests
const mockClient = {
    checkoutSessions: { create: mockCheckoutCreate },
    customers:        { customerPortal: { create: mockPortalCreate } },
    subscriptions:    { retrieve: mockSubsRetrieve, update: mockSubsUpdate, list: mockSubscriptionsList },
    payments:         { list: mockPaymentsList },
    discounts:        { create: mockDiscountsCreate, retrieveByCode: mockDiscountsByCode },
    webhooks:         { unwrap: mockWebhooksUnwrap },
};

// Inject mock into require.cache BEFORE dodo.js is loaded.
// Must use a plain `function` — arrow functions can't be used with `new`.
// When a constructor returns an object, `new Ctor()` returns that object.
function MockDodoPayments() { return mockClient; }
const dodoResolved = require.resolve('dodopayments');
require.cache[dodoResolved] = {
    id: dodoResolved,
    filename: dodoResolved,
    loaded: true,
    exports: { default: MockDodoPayments },
};

// Now safe to require dodo.js — it will get the mocked dodopayments
const dodo = require('../dodo');

beforeEach(() => {
    vi.clearAllMocks();
    process.env.DODO_API_KEY            = 'test_key';
    process.env.DODO_PRODUCT_ID         = 'pdt_test';
    process.env.DODO_CREDITS_PRODUCT_ID = 'pdt_credits_test';
    process.env.NODE_ENV                = 'test';
    // Default list mocks return empty iterators
    mockPaymentsList.mockReturnValue(makeAsyncIter([]));
    mockSubscriptionsList.mockReturnValue(makeAsyncIter([]));
});

// ── createCheckoutSession ──────────────────────────────────────────────────
describe('createCheckoutSession()', () => {
    it('creates a session with correct product and metadata', async () => {
        mockCheckoutCreate.mockResolvedValue({
            session_id:   'sess_abc',
            checkout_url: 'https://checkout.test/sess_abc',
        });

        const result = await dodo.createCheckoutSession('standard', 'user123', 'user@test.com');

        expect(result).toEqual({ sessionId: 'sess_abc', checkoutUrl: 'https://checkout.test/sess_abc' });
        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.product_cart[0].product_id).toBe('pdt_test_standard');
        expect(params.metadata.liveclaw_user_id).toBe('user123');
        expect(params.metadata.plan).toBe('standard');
        expect(params.customer.email).toBe('user@test.com');
    });

    it('applies discount code when provided', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 'sess_promo', checkout_url: 'https://x' });

        await dodo.createCheckoutSession('standard', 'u1', 'u@x.com', null, 'EARLYCLAW');

        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.discount_code).toBe('EARLYCLAW');
    });

    it('omits discount_code field when no code given', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 's', checkout_url: 'u' });

        await dodo.createCheckoutSession('standard', 'u1', 'u@x.com');

        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params).not.toHaveProperty('discount_code');
    });

    it('sets early_bird metadata flag when earlyClaw=true', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 's', checkout_url: 'u' });

        await dodo.createCheckoutSession('standard', 'u1', 'u@x.com', null, null, true);

        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.metadata.early_bird).toBe('1');
    });

    it('uses custom return_url when provided', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 's', checkout_url: 'u' });

        await dodo.createCheckoutSession('standard', 'u1', 'u@x.com', 'https://custom.example/return');

        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.return_url).toBe('https://custom.example/return');
    });

    it('includes UPI payment methods for global reach', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 's', checkout_url: 'u' });

        await dodo.createCheckoutSession('standard', 'u1', 'u@x.com');

        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.allowed_payment_method_types).toContain('upi_autopay');
        expect(params.allowed_payment_method_types).toContain('credit');
        expect(params.allowed_payment_method_types).toContain('apple_pay');
    });
});

// ── createCreditsCheckout ──────────────────────────────────────────────────
describe('createCreditsCheckout()', () => {
    it('creates one-time checkout with correct quantity', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 'sess_cr', checkout_url: 'https://x' });

        const result = await dodo.createCreditsCheckout('user1', 'u@x.com', 3);

        expect(result.sessionId).toBe('sess_cr');
        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.product_cart[0].product_id).toBe('pdt_credits_test'); // set in setup.js
        expect(params.product_cart[0].quantity).toBe(3);
        expect(params.metadata.credit_amount_usd).toBe('3');
        expect(params.metadata.plan).toBe('credits');
    });

    it('defaults quantity to 1', async () => {
        mockCheckoutCreate.mockResolvedValue({ session_id: 's', checkout_url: 'u' });

        await dodo.createCreditsCheckout('u', 'u@x.com');

        const params = mockCheckoutCreate.mock.calls[0][0];
        expect(params.product_cart[0].quantity).toBe(1);
    });
});

// ── createPortalSession ────────────────────────────────────────────────────
describe('createPortalSession()', () => {
    it('returns portal link for valid customer ID', async () => {
        mockPortalCreate.mockResolvedValue({ link: 'https://portal.test/cus_xyz' });

        const result = await dodo.createPortalSession('cus_xyz');

        expect(result.link).toBe('https://portal.test/cus_xyz');
        expect(mockPortalCreate).toHaveBeenCalledWith('cus_xyz');
    });
});

// ── getSubscription ────────────────────────────────────────────────────────
describe('getSubscription()', () => {
    it('retrieves subscription by ID', async () => {
        mockSubsRetrieve.mockResolvedValue({ subscription_id: 'sub_123', status: 'active' });

        const result = await dodo.getSubscription('sub_123');

        expect(result.status).toBe('active');
        expect(mockSubsRetrieve).toHaveBeenCalledWith('sub_123');
    });
});

// ── cancelSubscription ─────────────────────────────────────────────────────
describe('cancelSubscription()', () => {
    it('sends cancelled status update', async () => {
        mockSubsUpdate.mockResolvedValue({ status: 'cancelled' });

        await dodo.cancelSubscription('sub_123');

        expect(mockSubsUpdate).toHaveBeenCalledWith('sub_123', { status: 'cancelled' });
    });
});

// ── verifyWebhookEvent ─────────────────────────────────────────────────────
describe('verifyWebhookEvent()', () => {
    it('delegates signature verification to SDK unwrap', () => {
        mockWebhooksUnwrap.mockReturnValue({ type: 'subscription.active', data: {} });

        const headers = {
            'webhook-id':        'wh_id',
            'webhook-timestamp': '1234567890',
            'webhook-signature': 'v1,sigvalue',
        };
        const result = dodo.verifyWebhookEvent('{"type":"subscription.active"}', headers);

        expect(result.type).toBe('subscription.active');
        expect(mockWebhooksUnwrap).toHaveBeenCalledOnce();
    });

    it('normalises header keys to lowercase before unwrap', () => {
        mockWebhooksUnwrap.mockReturnValue({ type: 'payment.succeeded' });

        dodo.verifyWebhookEvent('{}', {
            'Webhook-Id':        'wid',
            'Webhook-Timestamp': '123',
            'Webhook-Signature': 'v1,sig',
        });

        const [, opts] = mockWebhooksUnwrap.mock.calls[0];
        expect(opts.headers).toHaveProperty('webhook-id', 'wid');
        expect(opts.headers).toHaveProperty('webhook-timestamp', '123');
    });

    it('propagates SDK error on bad signature', () => {
        mockWebhooksUnwrap.mockImplementation(() => { throw new Error('Invalid signature'); });

        expect(() => dodo.verifyWebhookEvent('{}', {})).toThrow('Invalid signature');
    });
});

// ── createBetaDiscount ─────────────────────────────────────────────────────
describe('createBetaDiscount()', () => {
    it('creates 100% discount restricted to the standard product', async () => {
        mockDiscountsCreate.mockResolvedValue({ discount_id: 'disc_123', code: 'BETA-TEST' });

        const result = await dodo.createBetaDiscount('BETA-TEST');

        expect(result).toEqual({ discountId: 'disc_123', code: 'BETA-TEST' });
        const params = mockDiscountsCreate.mock.calls[0][0];
        expect(params.amount).toBe(10000);
        expect(params.usage_limit).toBe(1);
        expect(params.subscription_cycles).toBe(1);
        expect(params.restricted_to).toContain('pdt_test_standard');
        expect(params.type).toBe('percentage');
    });
});

// ── retrieveDiscountByCode ─────────────────────────────────────────────────
describe('retrieveDiscountByCode()', () => {
    it('fetches discount by code string', async () => {
        mockDiscountsByCode.mockResolvedValue({ discount_id: 'disc_abc', code: 'PROMO' });

        const result = await dodo.retrieveDiscountByCode('PROMO');

        expect(result.code).toBe('PROMO');
        expect(mockDiscountsByCode).toHaveBeenCalledWith('PROMO');
    });
});

// ── getPaymentsMRR ─────────────────────────────────────────────────────────
describe('getPaymentsMRR()', () => {
    it('returns 0 when no payments in last 30 days', async () => {
        const mrr = await dodo.getPaymentsMRR();
        expect(mrr).toBe(0);
    });

    it('sums only subscription payments (not one-time)', async () => {
        mockPaymentsList.mockReturnValue(makeAsyncIter([
            { subscription_id: 'sub_1', total_amount: 999 },
            { subscription_id: null,    total_amount: 500 },  // one-time — excluded
            { subscription_id: 'sub_2', total_amount: 999 },
        ]));

        const mrr = await dodo.getPaymentsMRR();

        expect(mrr).toBe(1998);
    });

    it('uses ISO 8601 timestamp for created_at_gte filter', async () => {
        await dodo.getPaymentsMRR();

        const params = mockPaymentsList.mock.calls[0][0];
        expect(params.created_at_gte).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(params.status).toBe('succeeded');
    });

    it('handles missing total_amount gracefully (defaults to 0)', async () => {
        mockPaymentsList.mockReturnValue(makeAsyncIter([
            { subscription_id: 'sub_1', total_amount: undefined },
        ]));

        const mrr = await dodo.getPaymentsMRR();

        expect(mrr).toBe(0);
    });
});

// ── getContractedMRR ───────────────────────────────────────────────────────
describe('getContractedMRR()', () => {
    it('returns 0 when no active subscriptions', async () => {
        const mrr = await dodo.getContractedMRR();
        expect(mrr).toBe(0);
    });

    it('sums recurring_pre_tax_amount × quantity for all active subs', async () => {
        mockSubscriptionsList.mockReturnValue(makeAsyncIter([
            { recurring_pre_tax_amount: 999, quantity: 1 },
            { recurring_pre_tax_amount: 999, quantity: 2 },
        ]));

        const mrr = await dodo.getContractedMRR();

        expect(mrr).toBe(2997);
    });

    it('defaults quantity to 1 when missing', async () => {
        mockSubscriptionsList.mockReturnValue(makeAsyncIter([
            { recurring_pre_tax_amount: 999 },
        ]));

        const mrr = await dodo.getContractedMRR();

        expect(mrr).toBe(999);
    });

    it('queries only active subscriptions', async () => {
        await dodo.getContractedMRR();

        const params = mockSubscriptionsList.mock.calls[0][0];
        expect(params.status).toBe('active');
    });
});
