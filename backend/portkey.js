/**
 * LiveClaw — Portkey.ai Financial Governance Utility
 *
 * Manages Virtual Key lifecycle for per-user budget control:
 *  - createVirtualKey(): POST to /v1/virtual-keys with $0.05 starting credit
 *  - topUpCredits():     PUT to /v1/virtual-keys/{slug} to increase credit_limit
 *  - getVirtualKey():    GET to /v1/virtual-keys/{slug} for current state
 *
 * All functions throw on API errors with descriptive messages.
 */

'use strict';

const PORTKEY_BASE = process.env.PORTKEY_GATEWAY_URL || 'http://localhost:8787/v1';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** @returns {string} Portkey API key from env, or throws */
function getPortkeyKey() {
    const key = process.env.PORTKEY_API_KEY;
    if (!key) {
        throw new Error('PORTKEY_API_KEY is not set in environment');
    }
    return key;
}

/** Standard headers for all Portkey API calls */
function portkeyHeaders(contentType = true) {
    const headers = { 'x-portkey-api-key': getPortkeyKey() };
    if (contentType) headers['Content-Type'] = 'application/json';
    return headers;
}

/**
 * Generic Portkey API request with error handling
 * @param {string} path    - API path (e.g. '/virtual-keys')
 * @param {object} options - fetch options
 * @returns {Promise<object>}
 */
async function portkeyRequest(path, options = {}) {
    const url = `${PORTKEY_BASE}${path}`;

    const res = await fetch(url, {
        ...options,
        headers: {
            ...portkeyHeaders(!!options.body),
            ...options.headers,
        },
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Portkey API ${options.method || 'GET'} ${path} → ${res.status}: ${body}`);
    }

    // Some endpoints may return 204 No Content
    const text = await res.text();
    return text ? JSON.parse(text) : {};
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Creates a Portkey Virtual Key for a new user with an initial budget.
 *
 * @param  {string} userId      - Unique user identifier
 * @param  {number} creditLimit - Starting budget in USD (default $0.05)
 * @returns {Promise<{id: string, key: string}>}
 */
async function createVirtualKey(userId, creditLimit = 0.05) {
    if (!userId || typeof userId !== 'string') {
        throw new TypeError('userId must be a non-empty string');
    }
    if (typeof creditLimit !== 'number' || creditLimit <= 0) {
        throw new TypeError('creditLimit must be a positive number');
    }

    const payload = {
        name: `liveclaw-${userId}-${Date.now()}`,
        provider: 'openai', // Portkey routes MiniMax via OpenAI-compatible endpoint
        api_key: process.env.MINIMAX_API_KEY,
        usage_limits: {
            credit_limit: creditLimit,
            alert_threshold: 0.9,
        },
        metadata: {
            environment: process.env.NODE_ENV || 'development',
            user_id: userId,
            platform: 'liveclaw',
        },
    };

    if (!payload.api_key) {
        throw new Error('MINIMAX_API_KEY is not set in environment');
    }

    const data = await portkeyRequest('/virtual-keys', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    return {
        id: data.id || data.slug || `vk-${Date.now()}`,
        key: data.slug || data.virtual_key || data.id,
    };
}

/**
 * Tops up an existing Portkey Virtual Key by increasing its credit limit.
 *
 * @param  {string} slug          - Virtual Key slug/ID
 * @param  {number} currentLimit  - Current credit limit in USD
 * @param  {number} amountToAdd   - Amount to add in USD
 * @returns {Promise<object>}     - Portkey API response
 */
async function topUpCredits(slug, currentLimit, amountToAdd) {
    if (!slug || typeof slug !== 'string') {
        throw new TypeError('slug must be a non-empty string');
    }
    if (typeof currentLimit !== 'number' || typeof amountToAdd !== 'number') {
        throw new TypeError('currentLimit and amountToAdd must be numbers');
    }
    if (amountToAdd <= 0) {
        throw new RangeError('amountToAdd must be positive');
    }

    const newLimit = parseFloat((currentLimit + amountToAdd).toFixed(6)); // avoid floating-point drift

    return portkeyRequest(`/virtual-keys/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: JSON.stringify({
            usage_limits: {
                credit_limit: newLimit,
            },
        }),
    });
}

/**
 * Retrieves the current state of a Virtual Key (useful for syncing credit limits).
 *
 * @param  {string} slug - Virtual Key slug/ID
 * @returns {Promise<object>}
 */
async function getVirtualKey(slug) {
    if (!slug || typeof slug !== 'string') {
        throw new TypeError('slug must be a non-empty string');
    }

    return portkeyRequest(`/virtual-keys/${encodeURIComponent(slug)}`, {
        method: 'GET',
    });
}

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
    createVirtualKey,
    topUpCredits,
    getVirtualKey,
};
