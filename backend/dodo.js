/**
 * Dodo Payments — Subscription Billing Module
 *
 * Wraps the `dodopayments` SDK for LiveClaw's subscription lifecycle.
 *
 * Dodo acts as Merchant of Record — handles global taxes (EU VAT, India GST,
 * US sales tax), invoicing, and checkout hosting. No frontend SDK needed;
 * checkout sessions are fully server-side.
 *
 * Usage:
 *   const dodo = require('./dodo');
 *   const session = await dodo.createCheckoutSession('starter', 'user123', 'user@example.com');
 *   // → { sessionId, checkoutUrl }
 */

'use strict';

const DodoPayments = require('dodopayments').default;

// ─── Environment ────────────────────────────────────────────────────────────
let client = null;

/**
 * Lazily initialise the Dodo client.
 * Allows the module to be required even when DODO_API_KEY is not set
 * (e.g. in test or dev environments).
 */
function getClient() {
    if (client) return client;
    const apiKey = process.env.DODO_API_KEY;
    if (!apiKey) {
        throw new Error('DODO_API_KEY is not set — cannot initialise Dodo Payments client');
    }
    // DODO_MODE overrides the auto-detected environment.
    // Set DODO_MODE=test_mode in .env to test while Account Verification is pending.
    const mode = process.env.DODO_MODE || (process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode');
    client = new DodoPayments({
        bearerToken: apiKey,
        webhookKey: process.env.DODO_WEBHOOK_SECRET || null,
        environment: mode,
    });
    return client;
}

// ─── Product IDs ─────────────────────────────────────────────────────────────
// Standard plan: $9.99/mo
// Apply EARLYCLAW promo code → Dodo applies ~30.1% off → ~$6.99/mo (locked in, first 500)
const PRODUCT_ID = process.env.DODO_PRODUCT_ID || '';
// Two-day trial: $0.75 one-time payment → 48h trialing access, then prompted to subscribe
const TRIAL_PRODUCT_ID = process.env.DODO_TRIAL_PRODUCT_ID || '';

// ─── Bifrost budget — per-subscriber monthly LLM spend cap ──────────────────
// Configurable via PLAN_BUDGET_USD env var. Default $0.50 for beta launch
// (supports ~980 messages/user on MiniMax M2.7). Raise after adding credits.
const PLAN_BUDGET = parseFloat(process.env.PLAN_BUDGET_USD) || 0.50;

// ─── Bot limit — 1 bot per subscriber ───────────────────────────────────────
const BOT_LIMIT = 1;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Create a Dodo Checkout Session.
 *
 * @param {string} plan       - Plan name (currently always 'standard')
 * @param {string} userId     - Google sub (stored in metadata for webhook correlation)
 * @param {string} email      - Customer email for Dodo checkout
 * @param {string} [returnUrl] - URL to redirect after checkout
 * @param {string} [discountCode] - Optional discount/promo code (e.g. 'EARLYCLAW')
 * @param {boolean} [earlyClaw] - Whether this is an Early Claw offer checkout (for metadata tracking)
 * @returns {Promise<{ sessionId: string, checkoutUrl: string }>}
 */
async function createCheckoutSession(plan, userId, email, returnUrl, discountCode, earlyClaw = false) {
    const dodo = getClient();
    if (!PRODUCT_ID) {
        throw new Error('DODO_PRODUCT_ID is not configured. Set it in .env.');
    }

    const params = {
        product_cart: [{ product_id: PRODUCT_ID, quantity: 1 }],
        customer: { email, name: email },
        // early_claw flag travels with the subscription through Dodo's lifecycle
        // so the webhook handler can confirm and assign the spot after payment clears
        metadata: { liveclaw_user_id: userId, plan, ...(earlyClaw && { early_bird: '1' }) },
        return_url: returnUrl || 'https://liveclaw.xyz?checkout=success',
        // Enable UPI for Indian customers (Adaptive Currency must be on in Dodo dashboard).
        // credit/debit cover all international cards + Rupay; upi_collect adds UPI QR/VPA.
        allowed_payment_method_types: ['credit', 'debit', 'apple_pay', 'google_pay', 'upi_collect'],
    };

    if (discountCode) {
        params.discount_code = discountCode;
    }

    const session = await dodo.checkoutSessions.create(params);
    return {
        sessionId: session.session_id,
        checkoutUrl: session.checkout_url,
    };
}

/**
 * Create a $0.75 two-day trial checkout session.
 * On payment.succeeded the webhook activates a 48-hour trialing subscription.
 *
 * @param {string} userId          - Google sub
 * @param {string} email           - Customer email
 * @param {string} [returnUrl]     - URL to redirect after checkout
 * @param {string} [discountCode]  - Optional discount code (beta codes = 100% off)
 * @returns {Promise<{ sessionId: string, checkoutUrl: string }>}
 */
async function createTrialCheckoutSession(userId, email, returnUrl, discountCode) {
    const dodo = getClient();
    if (!TRIAL_PRODUCT_ID) {
        throw new Error('DODO_TRIAL_PRODUCT_ID is not configured. Set it in .env.');
    }
    const params = {
        product_cart: [{ product_id: TRIAL_PRODUCT_ID, quantity: 1 }],
        customer: { email, name: email },
        metadata: {
            liveclaw_user_id: userId,
            plan: 'trial',
            ...(discountCode && { beta_code: discountCode }),
        },
        return_url: returnUrl || 'https://liveclaw.xyz?checkout=trial-success',
        allowed_payment_method_types: ['credit', 'debit', 'apple_pay', 'google_pay', 'upi_collect'],
    };
    if (discountCode) {
        params.discount_code = discountCode;
    }
    const session = await dodo.checkoutSessions.create(params);
    return {
        sessionId: session.session_id,
        checkoutUrl: session.checkout_url,
    };
}

/**
 * Create a Dodo Customer Portal session.
 *
 * @param {string} dodoCustomerId - Dodo customer ID (cus_...)
 * @returns {Promise<{ link: string }>}
 */
async function createPortalSession(dodoCustomerId) {
    const dodo = getClient();
    const portal = await dodo.customers.customerPortal.create(dodoCustomerId);
    return { link: portal.link };
}

/**
 * Retrieve a subscription by ID from Dodo.
 *
 * @param {string} subscriptionId - Dodo subscription ID
 * @returns {Promise<object>} Subscription object
 */
async function getSubscription(subscriptionId) {
    const dodo = getClient();
    return dodo.subscriptions.retrieve(subscriptionId);
}

/**
 * Cancel a subscription (at end of billing period).
 *
 * @param {string} subscriptionId - Dodo subscription ID
 * @returns {Promise<object>}
 */
async function cancelSubscription(subscriptionId) {
    const dodo = getClient();
    return dodo.subscriptions.update(subscriptionId, {
        status: 'cancelled',
    });
}

/**
 * Verify and parse a Dodo webhook event.
 *
 * @param {string} rawBody       - Raw request body as string
 * @param {object} headers       - Request headers (must include webhook-id, webhook-timestamp, webhook-signature)
 * @returns {object} Parsed and verified webhook event
 * @throws {Error} If signature verification fails
 */
function verifyWebhookEvent(rawBody, headers) {
    const dodo = getClient();
    // The SDK's unwrap method verifies the signature using the webhookKey
    // and returns a typed event object.
    const normalised = {};
    for (const [k, v] of Object.entries(headers)) {
        normalised[k.toLowerCase()] = v;
    }
    return dodo.webhooks.unwrap(rawBody, { headers: normalised });
}

/**
 * Create a 100% discount code in Dodo, restricted to the trial product.
 * Each beta code becomes a Dodo coupon with usage_limit=1.
 *
 * @param {string} code - The beta code (e.g. 'A1B2-C3D4-E5F6')
 * @returns {Promise<{ discountId: string, code: string }>}
 */
async function createBetaDiscount(code) {
    const dodo = getClient();
    if (!TRIAL_PRODUCT_ID) {
        throw new Error('DODO_TRIAL_PRODUCT_ID is not configured. Set it in .env.');
    }
    const discount = await dodo.discounts.create({
        name: `Beta Code ${code}`,
        type: 'percentage',
        amount: 10000, // 100.00% in basis points
        code,
        usage_limit: 1,
        restricted_to: [TRIAL_PRODUCT_ID],
    });
    return { discountId: discount.discount_id, code: discount.code };
}

/**
 * Look up a discount by its code in Dodo.
 *
 * @param {string} code - The discount code
 * @returns {Promise<object>} Discount object
 */
async function retrieveDiscountByCode(code) {
    const dodo = getClient();
    return dodo.discounts.retrieveByCode(code);
}

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
    createCheckoutSession,
    createTrialCheckoutSession,
    createPortalSession,
    getSubscription,
    cancelSubscription,
    verifyWebhookEvent,
    createBetaDiscount,
    retrieveDiscountByCode,
    PRODUCT_ID,
    TRIAL_PRODUCT_ID,
    PLAN_BUDGET,
    BOT_LIMIT,
    // Expose for testing only
    ...(process.env.NODE_ENV === 'test' ? { _resetClient() { client = null; } } : {}),
};
