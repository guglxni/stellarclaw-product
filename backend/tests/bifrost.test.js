/**
 * Unit tests for bifrost.js — Bifrost AI Gateway integration.
 *
 * Tests cover:
 *  - Input validation (type checks, edge cases)
 *  - API request construction (correct paths, methods, payloads)
 *  - Response parsing and error handling
 *  - Provider config mapping
 *  - Gateway URL generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch before importing the module
const mockFetch = vi.fn();
global.fetch = mockFetch;

const bifrost = require('../bifrost');

describe('bifrost.js', () => {
    beforeEach(() => {
        mockFetch.mockReset();
    });

    // ── createVirtualKey ────────────────────────────────────────────────
    describe('createVirtualKey()', () => {
        it('throws TypeError for empty userId', async () => {
            await expect(bifrost.createVirtualKey('')).rejects.toThrow(TypeError);
            await expect(bifrost.createVirtualKey(null)).rejects.toThrow(TypeError);
            await expect(bifrost.createVirtualKey(123)).rejects.toThrow(TypeError);
        });

        it('throws TypeError for invalid creditLimit', async () => {
            await expect(bifrost.createVirtualKey('user1', 'minimax-m2.5', 0)).rejects.toThrow(TypeError);
            await expect(bifrost.createVirtualKey('user1', 'minimax-m2.5', -1)).rejects.toThrow(TypeError);
            await expect(bifrost.createVirtualKey('user1', 'minimax-m2.5', 'not-a-number')).rejects.toThrow(TypeError);
        });

        it('sends correct POST to /api/governance/virtual-keys', async () => {
            // 1st call: GET customers (empty list → create)
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ customers: [] }),
            });
            // 2nd call: POST create customer
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ customer: { id: 'cust-abc' } }),
            });
            // 3rd call: GET existing VK by name (none found)
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ virtual_keys: [] }),
            });
            // 4th call: POST create VK
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ virtual_key: { id: 'vk-123', value: 'sk-bf-test' } }),
            });

            const result = await bifrost.createVirtualKey('user-abc', 'minimax-m2.5', 0.05);

            // VK creation is the 4th call
            const [url, options] = mockFetch.mock.calls[3];
            expect(url).toContain('/api/governance/virtual-keys');
            expect(options.method).toBe('POST');

            const body = JSON.parse(options.body);
            expect(body.name).toBe('liveclaw-user-abc');
            expect(body.budget.max_limit).toBe(0.05);
            expect(body.provider_configs[0].provider).toBe('openrouter');
            expect(body.is_active).toBe(true);
            expect(body.customer_id).toBe('cust-abc');
            expect(result).toEqual({ id: 'vk-123', key: 'sk-bf-test' });
        });

        it('handles API error gracefully', async () => {
            // Customer lookup succeeds
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ customers: [{ id: 'cust-1', name: 'liveclaw-user-user1' }] }),
            });
            // VK name lookup (no existing VK)
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ virtual_keys: [] }),
            });
            // VK creation fails 3 times (initial + 2 retries)
            const failResponse = { ok: false, status: 500, text: async () => 'Internal Server Error' };
            mockFetch.mockResolvedValueOnce(failResponse);
            mockFetch.mockResolvedValueOnce(failResponse);
            mockFetch.mockResolvedValueOnce(failResponse);

            await expect(bifrost.createVirtualKey('user1')).rejects.toThrow(/500/);
        });

        it('uses default model if not specified', async () => {
            // Customer exists
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ customers: [{ id: 'cust-1', name: 'liveclaw-user-user1' }] }),
            });
            // VK name lookup (no existing VK)
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ virtual_keys: [] }),
            });
            // VK creation
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ virtual_key: { id: 'vk-1', value: 'sk-bf-x' } }),
            });

            await bifrost.createVirtualKey('user1');
            // VK creation is the 3rd call (after customer lookup + VK name lookup)
            const body = JSON.parse(mockFetch.mock.calls[2][1].body);
            expect(body.provider_configs[0].allowed_models).toContain('minimax/minimax-m2.7');
        });
    });

    // ── topUpCredits ────────────────────────────────────────────────────
    describe('topUpCredits()', () => {
        it('throws TypeError for empty vkId', async () => {
            await expect(bifrost.topUpCredits('', 0.05, 0.02)).rejects.toThrow(TypeError);
        });

        it('throws TypeError for non-numeric params', async () => {
            await expect(bifrost.topUpCredits('vk-1', 'not', 0.02)).rejects.toThrow(TypeError);
        });

        it('throws RangeError for zero or negative amount', async () => {
            await expect(bifrost.topUpCredits('vk-1', 0.05, 0)).rejects.toThrow(RangeError);
            await expect(bifrost.topUpCredits('vk-1', 0.05, -1)).rejects.toThrow(RangeError);
        });

        it('sends correct PUT with new budget limit', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ success: true }),
            });

            await bifrost.topUpCredits('vk-123', 0.05, 0.02);

            const [url, options] = mockFetch.mock.calls[0];
            expect(url).toContain('/api/governance/virtual-keys/vk-123');
            expect(options.method).toBe('PUT');

            const body = JSON.parse(options.body);
            expect(body.budget.max_limit).toBeCloseTo(0.07);
        });

        it('avoids floating-point drift', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => '{}',
            });

            await bifrost.topUpCredits('vk-1', 0.1, 0.2);
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.budget.max_limit).toBe(0.3); // Not 0.30000000000000004
        });
    });

    // ── getVirtualKey ───────────────────────────────────────────────────
    describe('getVirtualKey()', () => {
        it('throws TypeError for empty vkId', async () => {
            await expect(bifrost.getVirtualKey('')).rejects.toThrow(TypeError);
        });

        it('sends GET to correct path', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => JSON.stringify({ id: 'vk-1', budget: { max_limit: 0.05 } }),
            });

            const result = await bifrost.getVirtualKey('vk-1');
            expect(result.budget.max_limit).toBe(0.05);
            expect(mockFetch.mock.calls[0][1].method).toBe('GET');
        });

        it('URL-encodes the vkId', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => '{}',
            });

            await bifrost.getVirtualKey('vk/special+chars');
            expect(mockFetch.mock.calls[0][0]).toContain('vk%2Fspecial%2Bchars');
        });
    });

    // ── deactivateVirtualKey ────────────────────────────────────────────
    describe('deactivateVirtualKey()', () => {
        it('throws TypeError for empty vkId', async () => {
            await expect(bifrost.deactivateVirtualKey('')).rejects.toThrow(TypeError);
        });

        it('sends PUT with is_active: false', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                text: async () => '{}',
            });

            await bifrost.deactivateVirtualKey('vk-1');
            const body = JSON.parse(mockFetch.mock.calls[0][1].body);
            expect(body.is_active).toBe(false);
        });
    });

    // ── getGatewayUrl ───────────────────────────────────────────────────
    describe('getGatewayUrl()', () => {
        it('appends /v1 to BIFROST_GATEWAY_URL', () => {
            const url = bifrost.getGatewayUrl();
            expect(url).toMatch(/\/v1$/);
        });
    });

    // ── getProviderConfig ───────────────────────────────────────────────
    describe('getProviderConfig()', () => {
        it('returns minimax config for minimax-m2.5', () => {
            const cfg = bifrost.getProviderConfig('minimax-m2.5');
            expect(cfg.provider).toBe('openrouter');
            expect(cfg.allowed_models).toContain('minimax/minimax-m2.5');
        });

        it('returns kimi config for kimi-k2.5', () => {
            const cfg = bifrost.getProviderConfig('kimi-k2.5');
            expect(cfg.provider).toBe('openrouter');
            expect(cfg.allowed_models).toContain('moonshotai/kimi-k2.5');
        });

        it('falls back to minimax for unknown model', () => {
            const cfg = bifrost.getProviderConfig('unknown-model');
            expect(cfg.provider).toBe('openrouter');
            expect(cfg.allowed_models).toContain('minimax/minimax-m2.7');
        });
    });
});
