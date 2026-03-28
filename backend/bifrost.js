/**
 * LiveClaw — Bifrost AI Gateway Integration
 *
 * Bifrost (https://github.com/maximhq/bifrost) is an open-source, high-performance
 * AI gateway written in Go. It natively supports Virtual Key management with
 * hierarchical budgeting, making it the perfect fit for per-user cost control.
 *
 * Architecture:
 *   - Virtual Key management: POST/PUT/GET/DELETE /api/governance/virtual-keys
 *   - LLM traffic routing:   POST /v1/chat/completions (OpenAI-compatible)
 *   - Both run on the SAME self-hosted Bifrost instance (localhost:8080)
 *
 * Features used:
 *   - Per-user Virtual Keys with dollar budget caps
 *   - Provider routing (MiniMax, Kimi via OpenAI-compatible interface)
 *   - Budget enforcement with automatic cutoff
 *   - Rate limiting per Virtual Key
 */

'use strict';

const BIFROST_BASE = process.env.BIFROST_GATEWAY_URL || 'http://localhost:8080';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generic Bifrost API request with error handling.
 *
 * @param {string} path    - API path (e.g. '/api/governance/virtual-keys')
 * @param {object} options - fetch options
 * @returns {Promise<object>}
 */
async function bifrostRequest(path, options = {}) {
    const url = `${BIFROST_BASE}${path}`;

    const headers = { 'Content-Type': 'application/json', ...options.headers };

    const res = await fetch(url, {
        ...options,
        headers,
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Bifrost API ${options.method || 'GET'} ${path} → ${res.status}: ${body}`);
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Creates a Bifrost Virtual Key for a new user with an initial budget.
 *
 * The Virtual Key:
 *   - Has a dollar budget limit (default $0.05)
 *   - Routes to the configured MiniMax/Kimi provider
 *   - Returns a `sk-bf-*` key that picobot uses as its OPENAI_API_KEY
 *
 * @param  {string} userId      - Unique user identifier
 * @param  {string} model       - Model name (e.g. 'minimax-m2.7', 'minimax-m2.5', 'kimi-k2.5')
 * @param  {number} creditLimit - Starting budget in USD (default $0.05)
 * @returns {Promise<{id: string, key: string}>}
 */
async function createVirtualKey(userId, model = 'minimax-m2.7', creditLimit = 0.05) {
    if (!userId || typeof userId !== 'string') {
        throw new TypeError('userId must be a non-empty string');
    }
    if (typeof creditLimit !== 'number' || creditLimit <= 0) {
        throw new TypeError('creditLimit must be a positive number');
    }

    // Map our model names to provider config
    const providerConfig = getProviderConfig(model);

    const payload = {
        name: `liveclaw-${userId}`,
        description: `LiveClaw agent for user ${userId}`,
        provider_configs: [providerConfig],
        customer_id: `liveclaw-user-${userId}`,
        budget: {
            max_limit: creditLimit,
            reset_duration: '1M', // Monthly reset
        },
        rate_limit: {
            request_max_limit: 100,
            request_reset_duration: '1h',
            token_max_limit: 50000,
            token_reset_duration: '1d',
        },
        is_active: true,
    };

    const data = await bifrostRequest('/api/governance/virtual-keys', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    return {
        id: data.id || data.vk_id || `vk-${Date.now()}`,
        key: data.key || data.virtual_key || data.id,
    };
}

/**
 * Tops up an existing Virtual Key by increasing its budget limit.
 *
 * @param  {string} vkId          - Virtual Key ID
 * @param  {number} currentLimit  - Current budget limit in USD
 * @param  {number} amountToAdd   - Amount to add in USD
 * @returns {Promise<object>}     - Bifrost API response
 */
async function topUpCredits(vkId, currentLimit, amountToAdd) {
    if (!vkId || typeof vkId !== 'string') {
        throw new TypeError('vkId must be a non-empty string');
    }
    if (typeof currentLimit !== 'number' || typeof amountToAdd !== 'number') {
        throw new TypeError('currentLimit and amountToAdd must be numbers');
    }
    if (amountToAdd <= 0) {
        throw new RangeError('amountToAdd must be positive');
    }

    const newLimit = parseFloat((currentLimit + amountToAdd).toFixed(6));

    return bifrostRequest(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`, {
        method: 'PUT',
        body: JSON.stringify({
            budget: {
                max_limit: newLimit,
                reset_duration: '1M',
            },
        }),
    });
}

/**
 * Retrieves the current state of a Virtual Key.
 *
 * @param  {string} vkId - Virtual Key ID
 * @returns {Promise<object>}
 */
async function getVirtualKey(vkId) {
    if (!vkId || typeof vkId !== 'string') {
        throw new TypeError('vkId must be a non-empty string');
    }

    return bifrostRequest(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`, {
        method: 'GET',
    });
}

/**
 * Deactivates a Virtual Key (e.g., when user stops their bot).
 *
 * @param  {string} vkId - Virtual Key ID
 * @returns {Promise<object>}
 */
async function deactivateVirtualKey(vkId) {
    if (!vkId || typeof vkId !== 'string') {
        throw new TypeError('vkId must be a non-empty string');
    }

    return bifrostRequest(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`, {
        method: 'PUT',
        body: JSON.stringify({ is_active: false }),
    });
}

/**
 * Returns LLM budget usage statistics for a Virtual Key.
 * Handles multiple Bifrost field name variants across versions.
 *
 * @param  {string} vkId - Virtual Key ID
 * @returns {Promise<{spentUsd: number, limitUsd: number, remainingUsd: number, isActive: boolean}>}
 */
async function getVirtualKeyUsage(vkId) {
    const data = await getVirtualKey(vkId);
    const budget = data.budget || {};
    // Bifrost uses current_usage; older builds may use used/spend/usage
    const spent = budget.current_usage ?? budget.used ?? budget.spend ?? budget.usage ?? 0;
    const limit = budget.max_limit ?? budget.limit ?? 0;
    return {
        spentUsd: parseFloat(Number(spent).toFixed(6)),
        limitUsd: parseFloat(Number(limit).toFixed(6)),
        remainingUsd: parseFloat(Math.max(0, Number(limit) - Number(spent)).toFixed(6)),
        isActive: data.is_active !== false,
    };
}

/**
 * Returns the Bifrost gateway URL for LLM traffic routing.
 * picobot sends LLM requests to this URL (OpenAI-compatible).
 *
 * @returns {string}
 */
function getGatewayUrl() {
    return `${BIFROST_BASE}/v1`;
}

// ─── Provider Config Helpers ────────────────────────────────────────────────

/**
 * Maps LiveClaw model names to Bifrost provider_configs.
 * All models are routed through OpenRouter (OpenAI-compatible interface).
 * The 'openrouter' provider must be configured in Bifrost UI with:
 *   Base URL: https://openrouter.ai/api/v1
 *   API Key:  $OPENROUTER_API_KEY from .env
 */
function getProviderConfig(model) {
    const providers = {
        'minimax-m2.7': {
            provider: 'openrouter',
            weight: 1.0,
            allowed_models: ['minimax/minimax-m2.7'],
        },
        'minimax-m2.5': {
            provider: 'openrouter',
            weight: 1.0,
            allowed_models: ['minimax/minimax-m2.5'],
        },
        'kimi-k2.5': {
            provider: 'openrouter',
            weight: 1.0,
            allowed_models: ['moonshotai/kimi-k2.5'],
        },
        'mimo-v2-pro': {
            provider: 'openrouter',
            weight: 1.0,
            allowed_models: ['xiaomi/mimo-v2-pro'],
        },
        'glm-5': {
            provider: 'openrouter',
            weight: 1.0,
            allowed_models: ['z-ai/glm-5'],
        },
        'deepseek-v3.2': {
            provider: 'openrouter',
            weight: 1.0,
            allowed_models: ['deepseek/deepseek-chat-v3-0324'],
        },
    };

    return providers[model] || providers['minimax-m2.7'];
}

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
    createVirtualKey,
    topUpCredits,
    getVirtualKey,
    getVirtualKeyUsage,
    deactivateVirtualKey,
    getGatewayUrl,
    getProviderConfig,
};
