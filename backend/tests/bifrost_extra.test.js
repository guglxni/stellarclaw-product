/**
 * Additional coverage for bifrost.js uncovered paths:
 *   - createVirtualKey: existing VK branch (lines 111-130)
 *   - ensureBifrostCustomer: concurrent lock path (line 179)
 *   - getVirtualKeyUsage: all budget field name variants (lines 282-287)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const bifrost = require('../bifrost');

beforeEach(() => {
    mockFetch.mockReset();
});

// ─── createVirtualKey: existing VK found — reactivate path ────────────────
describe('createVirtualKey() — existing VK reactivation', () => {
    function mockListResponse(vkId, existingKey = null) {
        // GET /api/governance/virtual-keys?name=... → finds existing VK
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                virtual_keys: [{ id: vkId, name: `liveclaw-${Date.now()}`, value: existingKey }],
            }),
        });
    }

    it('reactivates existing VK and returns its ID + key from PUT response', async () => {
        const vkId = 'vk-existing-001';
        // Call 1: GET customers (find or create customer)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ customers: [{ id: 'cust-001', name: 'liveclaw-user-reactivate' }] }),
        });
        // Call 2: GET virtual-keys?name=... → found
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                virtual_keys: [{ id: vkId, name: 'liveclaw-reactivate' }],
            }),
        });
        // Call 3: GET /virtual-keys/:id → retrieve current key value
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                virtual_key: { id: vkId, value: 'sk-bf-reactivated', is_active: true },
            }),
        });
        // Call 4: PUT /virtual-keys/:id → reactivate
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ virtual_key: { id: vkId, value: 'sk-bf-reactivated' } }),
        });

        const result = await bifrost.createVirtualKey('reactivate', 'minimax-m2.7', 3.00);

        expect(result.id).toBe(vkId);
        expect(result.key).toBe('sk-bf-reactivated');
        // PUT must have been called to reactivate
        const putCall = mockFetch.mock.calls.find(([, opts]) => opts?.method === 'PUT');
        expect(putCall).toBeDefined();
        const body = JSON.parse(putCall[1].body);
        expect(body.is_active).toBe(true);
    });

    it('uses existingVkKey when GET individual VK fetch fails', async () => {
        const vkId = 'vk-existing-002';
        const existingKey = 'sk-bf-from-db';

        // GET customers
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ customers: [{ id: 'cust-002', name: 'liveclaw-user-fallback' }] }),
        });
        // GET virtual-keys?name → found, no value
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ virtual_keys: [{ id: vkId, name: 'liveclaw-fallback' }] }),
        });
        // GET individual VK → fails
        mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'Unauthorized' });
        // PUT reactivate
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ virtual_key: { id: vkId } }),
        });

        const result = await bifrost.createVirtualKey('fallback', 'minimax-m2.7', 3.00, existingKey);
        expect(result.id).toBe(vkId);
        expect(result.key).toBe(existingKey);
    });
});

// ─── createVirtualKey: customer creation via POST (no existing customer) ──
describe('createVirtualKey() — fresh customer creation path', () => {
    it('creates a new customer and new VK when neither exists', async () => {
        // GET customers?name= → empty list (no existing customer)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ customers: [] }),
        });
        // POST /customers → new customer
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ customer: { id: 'cust-new-001' } }),
        });
        // GET virtual-keys?name= → empty list (no existing VK)
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({ virtual_keys: [] }),
        });
        // POST /virtual-keys → new VK
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                virtual_key: { id: 'vk-new-001', value: 'sk-bf-new-key' },
            }),
        });

        const result = await bifrost.createVirtualKey('fresh-user', 'minimax-m2.7', 3.00);

        expect(result.id).toBe('vk-new-001');
        expect(result.key).toBe('sk-bf-new-key');
        // A POST to /customers should have been made
        const customerPost = mockFetch.mock.calls.find(
            ([url, opts]) => url.includes('/customers') && opts?.method === 'POST'
        );
        expect(customerPost).toBeDefined();
    });

    it('concurrent createVirtualKey calls for same user share the customer lock', async () => {
        // Both calls see no existing customer, both try to create
        // The lock ensures only one POST /customers goes out
        let customerPostCount = 0;
        mockFetch.mockImplementation(async (url, opts) => {
            if (url.includes('/customers?name=')) {
                return { ok: true, text: async () => JSON.stringify({ customers: [] }) };
            }
            if (url.includes('/customers') && opts?.method === 'POST') {
                customerPostCount++;
                return { ok: true, text: async () => JSON.stringify({ customer: { id: 'cust-concurrent' } }) };
            }
            if (url.includes('/virtual-keys?name=')) {
                return { ok: true, text: async () => JSON.stringify({ virtual_keys: [] }) };
            }
            if (url.includes('/virtual-keys') && opts?.method === 'POST') {
                return { ok: true, text: async () => JSON.stringify({ virtual_key: { id: `vk-${Date.now()}`, value: 'sk-bf-concurrent' } }) };
            }
            return { ok: true, text: async () => '{}' };
        });

        await Promise.all([
            bifrost.createVirtualKey('concurrent-user', 'minimax-m2.7', 3.00),
            bifrost.createVirtualKey('concurrent-user', 'minimax-m2.7', 3.00),
        ]);

        // Customer POST should only be called once due to in-memory lock
        expect(customerPostCount).toBe(1);
    });
});

// ─── getVirtualKeyUsage: budget field name variants ───────────────────────
describe('getVirtualKeyUsage() — field name variants (lines 282-287)', () => {
    async function callUsage(budgetFields) {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                id: 'vk-usage-test',
                is_active: true,
                budget: budgetFields,
            }),
        });
        return bifrost.getVirtualKeyUsage('vk-usage-test');
    }

    it('reads current_usage (primary field)', async () => {
        const result = await callUsage({ current_usage: 1.5, max_limit: 3.0 });
        expect(result.spentUsd).toBe(1.5);
        expect(result.limitUsd).toBe(3.0);
        expect(result.remainingUsd).toBe(1.5);
        expect(result.isActive).toBe(true);
    });

    it('falls back to used field', async () => {
        const result = await callUsage({ used: 0.75, max_limit: 2.0 });
        expect(result.spentUsd).toBe(0.75);
        expect(result.remainingUsd).toBeCloseTo(1.25, 5);
    });

    it('falls back to spend field', async () => {
        const result = await callUsage({ spend: 2.0, limit: 5.0 });
        expect(result.spentUsd).toBe(2.0);
        expect(result.limitUsd).toBe(5.0);
    });

    it('falls back to usage field', async () => {
        const result = await callUsage({ usage: 0.1, max_limit: 1.0 });
        expect(result.spentUsd).toBe(0.1);
    });

    it('defaults to 0 when no budget fields present', async () => {
        const result = await callUsage({});
        expect(result.spentUsd).toBe(0);
        expect(result.limitUsd).toBe(0);
        expect(result.remainingUsd).toBe(0);
    });

    it('remainingUsd is never negative (clamped to 0)', async () => {
        // Spent > limit (edge case in buggy data)
        const result = await callUsage({ current_usage: 5.0, max_limit: 3.0 });
        expect(result.remainingUsd).toBe(0);
    });

    it('isActive is false when is_active=false', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            text: async () => JSON.stringify({
                id: 'vk-inactive', is_active: false, budget: { current_usage: 0, max_limit: 3 },
            }),
        });
        const result = await bifrost.getVirtualKeyUsage('vk-inactive');
        expect(result.isActive).toBe(false);
    });
});
