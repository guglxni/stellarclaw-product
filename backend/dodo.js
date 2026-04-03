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
// Apply EARLYCLAW promo code → 25% off first month → $7.49 first month, then $9.99/mo (first 500)
const PRODUCT_ID = process.env.DODO_PRODUCT_ID || '';
// Credits: one-time purchase to top up LLM budget via Bifrost VK
const CREDITS_PRODUCT_ID = process.env.DODO_CREDITS_PRODUCT_ID || '';

// ─── Bifrost budget — per-subscriber monthly LLM spend cap ──────────────────
// MiniMax M2.7 (reasoning model, $0.30/$1.20 per M tokens):
//   Casual (10 msgs/day): $0.70-1.00/mo | Medium (20/day): $1.50-2.50 | Heavy (30/day): $2.50-4.00
// $3.00 budget supports all usage tiers with healthy margin at $9.99/mo standard.
const PLAN_BUDGET = parseFloat(process.env.PLAN_BUDGET_USD) || 3.00;

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
        // Payment methods — all must also be enabled in the Dodo dashboard.
        // upi_autopay  = UPI AutoPay e-mandate for recurring subscriptions (India)
        // upi_collect  = one-time UPI QR/VPA (fallback for non-mandate flows)
        // credit/debit = international cards + Rupay
        // apple_pay / google_pay = wallet pass-through
        allowed_payment_method_types: [
            'credit', 'debit',
            'apple_pay', 'google_pay',
            'upi_autopay', 'upi_collect',
        ],
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
 * Create a one-time credits checkout for topping up LLM budget.
 *
 * @param {string} userId      - LiveClaw user ID
 * @param {string} email       - Customer email
 * @param {number} quantity    - Number of $1 credit units to purchase
 * @param {string} [returnUrl] - Redirect after checkout
 * @returns {Promise<{ sessionId: string, checkoutUrl: string }>}
 */
async function createCreditsCheckout(userId, email, quantity = 1, returnUrl) {
    const dodo = getClient();
    if (!CREDITS_PRODUCT_ID) {
        throw new Error('DODO_CREDITS_PRODUCT_ID is not configured. Set it in .env.');
    }
    const session = await dodo.checkoutSessions.create({
        product_cart: [{ product_id: CREDITS_PRODUCT_ID, quantity }],
        customer: { email, name: email },
        metadata: { liveclaw_user_id: userId, plan: 'credits', credit_amount_usd: String(quantity) },
        return_url: returnUrl || 'https://liveclaw.xyz?checkout=credits-success',
        allowed_payment_method_types: ['credit', 'debit', 'apple_pay', 'google_pay', 'upi_collect'],
    });
    return { sessionId: session.session_id, checkoutUrl: session.checkout_url };
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
 * Create a 100% discount code in Dodo, restricted to the standard product.
 * Each beta code becomes a Dodo coupon with usage_limit=1, first month only.
 *
 * @param {string} code - The beta code (e.g. 'A1B2-C3D4-E5F6')
 * @returns {Promise<{ discountId: string, code: string }>}
 */
async function createBetaDiscount(code) {
    const dodo = getClient();
    if (!PRODUCT_ID) {
        throw new Error('DODO_PRODUCT_ID is not configured. Set it in .env.');
    }
    const discount = await dodo.discounts.create({
        name: `Beta Code ${code}`,
        type: 'percentage',
        amount: 10000, // 100.00% in basis points
        code,
        usage_limit: 1,
        restricted_to: [PRODUCT_ID],
        subscription_cycles: 1, // First month only
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

/**
 * Fetch actual MRR from Dodo Payments API.
 *
 * MRR = sum of actual subscription payments received in the last 30 days.
 * Uses real Dodo API data (not count × price) so:
 *   - Beta-code subscriptions (100% discount) → $0 contribution this month
 *   - Discounted first month → actual discounted amount
 *   - Regular subscribers → $9.99
 *
 * Handles pagination. Returns cents (integer).
 */
async function getPaymentsMRR() {
    const dodo = getClient();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10); // YYYY-MM-DD

    let mrrCents = 0;

    // Use async iterator — SDK handles pagination automatically
    for await (const payment of dodo.payments.list({
        status: 'succeeded',
        created_at_gte: thirtyDaysAgo,
        page_size: 100,
    })) {
        // Only count subscription payments (not one-time credits)
        if (payment.subscription_id) {
            mrrCents += payment.total_amount || 0;
        }
    }

    return mrrCents;
}

/**
 * Fetch contracted MRR from Dodo Payments API.
 *
 * Contracted MRR = sum of recurring_pre_tax_amount × quantity for all active subscriptions.
 * This is the "forward-looking" MRR: what we expect to collect next cycle.
 * For discounted first-month subs, this shows the FULL price (next billing will be full price).
 *
 * Returns cents (integer).
 */
async function getContractedMRR() {
    const dodo = getClient();
    let mrrCents = 0;

    for await (const sub of dodo.subscriptions.list({
        status: 'active',
        page_size: 100,
    })) {
        mrrCents += (sub.recurring_pre_tax_amount || 0) * (sub.quantity || 1);
    }

    return mrrCents;
}

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
    createCheckoutSession,
    createCreditsCheckout,
    createPortalSession,
    getSubscription,
    cancelSubscription,
    verifyWebhookEvent,
    createBetaDiscount,
    retrieveDiscountByCode,
    getPaymentsMRR,
    getContractedMRR,
    PRODUCT_ID,
    CREDITS_PRODUCT_ID,
    PLAN_BUDGET,
    BOT_LIMIT,
    // Expose for testing only
    ...(process.env.NODE_ENV === 'test' ? { _resetClient() { client = null; } } : {}),
};
