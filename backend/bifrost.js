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
 * Generic Bifrost API request with timeout, retry, and error handling.
 *
 * @param {string} path    - API path (e.g. '/api/governance/virtual-keys')
 * @param {object} options - fetch options
 * @param {number} retries - Number of retry attempts (default 2, total 3 attempts)
 * @returns {Promise<object>}
 */
async function bifrostRequest(path, options = {}, retries = 2) {
    const url = `${BIFROST_BASE}${path}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const method = options.method || 'GET';

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                ...options,
                headers,
                signal: AbortSignal.timeout(10000), // 10s timeout
            });

            if (!res.ok) {
                const body = await res.text();
                const err = new Error(`Bifrost API ${method} ${path} → ${res.status}: ${body}`);
                err.statusCode = res.status;
                // Don't retry 4xx (client errors) — only retry 5xx and network errors
                if (res.status < 500) throw err;
                if (attempt === retries) throw err;
            } else {
                const text = await res.text();
                return text ? JSON.parse(text) : {};
            }
        } catch (err) {
            if (err.statusCode && err.statusCode < 500) throw err; // Don't retry client errors
            if (attempt === retries) throw err;
        }
        // Exponential backoff: 200ms, 600ms
        await new Promise(r => setTimeout(r, 200 * Math.pow(3, attempt)));
    }
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
async function createVirtualKey(userId, model = 'minimax-m2.7', creditLimit = 0.05, existingVkKey = null) {
    if (!userId || typeof userId !== 'string') {
        throw new TypeError('userId must be a non-empty string');
    }
    if (typeof creditLimit !== 'number' || creditLimit <= 0) {
        throw new TypeError('creditLimit must be a positive number');
    }

    // Ensure Bifrost customer exists (required FK for virtual keys)
    const customerId = await ensureBifrostCustomer(userId);

    // Map our model names to provider config
    const providerConfig = getProviderConfig(model);

    const vkName = `liveclaw-${userId}`;

    // Check if a VK with this name already exists (e.g. from a previous deploy).
    // Bifrost rejects duplicate names, so reactivate + update instead of creating.
    let existingId = null;
    try {
        const list = await bifrostRequest(`/api/governance/virtual-keys?name=${encodeURIComponent(vkName)}`);
        const keys = list.virtual_keys || list.keys || list.data || [];
        const found = keys.find(k => k.name === vkName);
        if (found) existingId = found.id;
    } catch (_) { /* fall through to create */ }

    if (existingId) {
        // Bifrost PUT responses may not include the key value (sk-bf-*) for security.
        // Try GET first to retrieve it; fall back to the key passed in from the DB.
        let currentKey = existingVkKey;
        if (!currentKey) {
            try {
                const getResp = await bifrostRequest(`/api/governance/virtual-keys/${encodeURIComponent(existingId)}`);
                const getVk = getResp.virtual_key || getResp;
                currentKey = getVk.value || getVk.key || getResp.key || null;
            } catch (_) { /* fall through */ }
        }

        // Reactivate and update provider config + budget for the new deploy
        const data = await bifrostRequest(`/api/governance/virtual-keys/${encodeURIComponent(existingId)}`, {
            method: 'PUT',
            body: JSON.stringify({
                provider_configs: [providerConfig],
                budget: { max_limit: creditLimit, reset_duration: '1M' },
                is_active: true,
            }),
        });

        // Update rate limits in a separate call (Bifrost requires dedicated endpoint)
        try {
            await updateVirtualKeyRateLimit(existingId, {
                request_max_limit: 500,
                request_reset_duration: '1h',
                token_max_limit: 500000,
                token_reset_duration: '1d',
            });
        } catch (_) { /* non-fatal — existing limits still apply */ }
        const vk = data.virtual_key || data;
        return {
            id: existingId,
            key: currentKey || vk.value || vk.key || data.key || existingId,
        };
    }

    // No existing VK — create fresh
    const payload = {
        name: vkName,
        description: `LiveClaw agent for user ${userId}`,
        provider_configs: [providerConfig],
        customer_id: customerId,
        budget: {
            max_limit: creditLimit,
            reset_duration: '1M',
        },
        rate_limit: {
            request_max_limit: 500,
            request_reset_duration: '1h',
            token_max_limit: 500000,
            token_reset_duration: '1d',
        },
        is_active: true,
    };

    const data = await bifrostRequest('/api/governance/virtual-keys', {
        method: 'POST',
        body: JSON.stringify(payload),
    });

    const vk = data.virtual_key || data;
    return {
        id: vk.id || data.id || data.vk_id || `vk-${Date.now()}`,
        key: vk.value || data.key || data.virtual_key || data.id,
    };
}

/**
 * Ensures a Bifrost governance customer exists for the given user.
 * Creates one if it doesn't exist, returns the Bifrost-assigned customer ID.
 * Uses in-memory lock to prevent duplicate creation under concurrent requests.
 */
const _customerLocks = new Map();

async function ensureBifrostCustomer(userId) {
    const customerName = `liveclaw-user-${userId}`;

    // Prevent concurrent creation for the same user
    if (_customerLocks.has(userId)) {
        return _customerLocks.get(userId);
    }

    const promise = (async () => {
        try {
            // Check if customer already exists
            const list = await bifrostRequest(`/api/governance/customers?name=${encodeURIComponent(customerName)}`);
            const customers = list.customers || [];
            const existing = customers.find(c => c.name === customerName);
            if (existing) return existing.id;
        } catch (_) { /* fall through to create */ }

        // Create new customer
        const data = await bifrostRequest('/api/governance/customers', {
            method: 'POST',
            body: JSON.stringify({ name: customerName }),
        });

        const customer = data.customer || data;
        return customer.id;
    })();

    _customerLocks.set(userId, promise);
    try {
        return await promise;
    } finally {
        _customerLocks.delete(userId);
    }
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

/**
 * Updates a Virtual Key's rate limits.
 * Used by the watchdog to proactively increase limits when a bot
 * approaches its token cap, preventing the generic "Sorry, I encountered
 * an error" message that picobot shows on 429 responses.
 *
 * @param  {string} vkId              - Virtual Key ID
 * @param  {object} rateLimitConfig   - New rate limit settings
 * @param  {number} rateLimitConfig.token_max_limit       - Max tokens per window
 * @param  {string} rateLimitConfig.token_reset_duration   - e.g. '1d'
 * @param  {number} [rateLimitConfig.request_max_limit]    - Max requests per window
 * @param  {string} [rateLimitConfig.request_reset_duration] - e.g. '1h'
 * @returns {Promise<object>}
 */
async function updateVirtualKeyRateLimit(vkId, rateLimitConfig) {
    if (!vkId || typeof vkId !== 'string') {
        throw new TypeError('vkId must be a non-empty string');
    }
    return bifrostRequest(`/api/governance/virtual-keys/${encodeURIComponent(vkId)}`, {
        method: 'PUT',
        body: JSON.stringify({ rate_limit: rateLimitConfig }),
    });
}

// ─── Provider Bootstrap ─────────────────────────────────────────────────────

/**
 * Ensures the Bifrost OpenRouter provider key matches OPENROUTER_API_KEY.
 * Called at orchestrator startup — idempotent, non-fatal on failure.
 *
 * Bifrost stores providers in config.db (not the governance API). The correct
 * endpoint is /api/providers. We update the key if it doesn't match the env var
 * so a rotated OPENROUTER_API_KEY automatically propagates to Bifrost.
 */
async function ensureBifrostProvider() {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        console.warn('[bifrost] OPENROUTER_API_KEY not set — skipping provider sync');
        return;
    }

    let currentKeySuffix = null;
    try {
        const list = await bifrostRequest('/api/providers');
        const providers = list.providers || [];
        const or = providers.find(p => p.name === 'openrouter');
        if (or && or.keys && or.keys.length > 0) {
            const stored = or.keys[0].value?.value || '';
            currentKeySuffix = stored.slice(-4);
        }
    } catch (err) {
        console.warn('[bifrost] Could not read provider list:', err.message);
        return;
    }

    const wantSuffix = apiKey.slice(-4);
    if (currentKeySuffix === wantSuffix) return; // key already matches

    console.log(`[bifrost] OpenRouter key mismatch (stored: ...${currentKeySuffix}, want: ...${wantSuffix}) — updating`);
    try {
        await bifrostRequest('/api/providers/openrouter', {
            method: 'PUT',
            body: JSON.stringify({
                name: 'openrouter',
                keys: [{
                    id: 'openrouter-key-1',
                    name: 'openrouter-primary',
                    value: { value: apiKey, env_var: '', from_env: false },
                    models: [],
                    blacklisted_models: [],
                    weight: 1,
                    enabled: true,
                    use_for_batch_api: false,
                }],
                network_config: {
                    default_request_timeout_in_seconds: 30,
                    max_retries: 0,
                    retry_backoff_initial: 500,
                    retry_backoff_max: 5000,
                    stream_idle_timeout_in_seconds: 60,
                    max_conns_per_host: 5000,
                },
                concurrency_and_buffer_size: { concurrency: 1000, buffer_size: 5000 },
                send_back_raw_request: false,
                send_back_raw_response: false,
                store_raw_request_response: false,
            }),
        });
        console.log('[bifrost] OpenRouter provider key updated successfully');
    } catch (err) {
        console.error('[bifrost] Failed to update OpenRouter provider key:', err.message);
    }
}

// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
    createVirtualKey,
    topUpCredits,
    getVirtualKey,
    getVirtualKeyUsage,
    deactivateVirtualKey,
    updateVirtualKeyRateLimit,
    getGatewayUrl,
    getProviderConfig,
    ensureBifrostProvider,
};
