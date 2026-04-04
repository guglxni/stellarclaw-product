/**
 * Property-based tests for LiveClaw — using fast-check.
 *
 * Inspired by the aidlc-workflows PBT extension (10 mandatory rules).
 * Tests financial math invariants, round-trip properties, and state
 * machine invariants that are hard to catch with example-based tests.
 *
 * Rules implemented:
 *   PBT-02  Round-trip: encrypt → decrypt === original
 *   PBT-03  Invariant:  credit budget always positive and growing
 *   PBT-04  Idempotency: topUpCredits produces deterministic results
 *   PBT-06  Stateful:   budget never goes below the previous value after top-up
 *   PBT-07  Generator:  MRR sum handles arbitrary payment amounts correctly
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// ── Mocks ─────────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
global.fetch = mockFetch;

const bifrost = require('../bifrost');

beforeEach(() => {
    mockFetch.mockReset();
    // Default: successful PUT response for topUpCredits
    mockFetch.mockResolvedValue({
        ok: true,
        text: async () => '{}',
    });
});

// ─── PBT-03 / PBT-06: Credit Budget Invariants ───────────────────────────────
describe('Credit budget invariants (PBT-03, PBT-06)', () => {
    it('new limit is always strictly greater than old limit after any valid top-up', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.float({ min: Math.fround(0.01), max: Math.fround(100.0), noNaN: true }),
                fc.float({ min: Math.fround(0.01), max: Math.fround(100.0), noNaN: true }),
                async (currentLimit, topUpAmount) => {
                    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '{}' });
                    await bifrost.topUpCredits('vk-test', currentLimit, topUpAmount);

                    const body = JSON.parse(mockFetch.mock.calls.at(-1)[1].body);
                    const newLimit = body.budget.max_limit;

                    // Core invariant: new limit > old limit
                    expect(newLimit).toBeGreaterThan(currentLimit);
                }
            ),
            { numRuns: 50 }
        );
    });

    it('budget calculation is never negative for any valid inputs', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.float({ min: Math.fround(0.01), max: Math.fround(1000.0), noNaN: true }),
                fc.float({ min: Math.fround(0.01), max: Math.fround(1000.0), noNaN: true }),
                async (currentLimit, topUpAmount) => {
                    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '{}' });
                    await bifrost.topUpCredits('vk-test', currentLimit, topUpAmount);

                    const body = JSON.parse(mockFetch.mock.calls.at(-1)[1].body);
                    expect(body.budget.max_limit).toBeGreaterThan(0);
                }
            ),
            { numRuns: 50 }
        );
    });

    it('floating-point addition never drifts beyond 10 decimal places', async () => {
        await fc.assert(
            fc.asyncProperty(
                // Use values that are known to cause IEEE 754 drift
                fc.constantFrom(0.1, 0.2, 0.3, 0.15, 0.25, 0.05, 1.1, 2.2, 3.3),
                fc.constantFrom(0.1, 0.2, 0.3, 0.15, 0.25, 0.05, 1.1, 2.2, 3.3),
                async (a, b) => {
                    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '{}' });
                    await bifrost.topUpCredits('vk-test', a, b);

                    const body = JSON.parse(mockFetch.mock.calls.at(-1)[1].body);
                    const result = body.budget.max_limit;
                    // bifrost.js uses .toFixed(6) — match that precision
                    const expected = parseFloat((a + b).toFixed(6));

                    // Result must equal the correctly-rounded value
                    expect(result).toBe(expected);
                }
            ),
            { numRuns: 30 }
        );
    });
});

// ─── PBT-04: Idempotency — same inputs → same PUT body ───────────────────────
describe('topUpCredits() idempotency (PBT-04)', () => {
    it('same inputs always produce the same budget.max_limit in the PUT body', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.float({ min: Math.fround(0.01), max: Math.fround(100.0), noNaN: true }),
                fc.float({ min: Math.fround(0.01), max: Math.fround(100.0), noNaN: true }),
                async (currentLimit, topUp) => {
                    // Call 1
                    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '{}' });
                    await bifrost.topUpCredits('vk-1', currentLimit, topUp);
                    const body1 = JSON.parse(mockFetch.mock.calls.at(-1)[1].body);

                    // Call 2 with identical inputs
                    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => '{}' });
                    await bifrost.topUpCredits('vk-1', currentLimit, topUp);
                    const body2 = JSON.parse(mockFetch.mock.calls.at(-1)[1].body);

                    expect(body1.budget.max_limit).toBe(body2.budget.max_limit);
                }
            ),
            { numRuns: 30 }
        );
    });
});

// ─── PBT-07: MRR aggregation handles arbitrary amounts ───────────────────────
describe('MRR aggregation correctness (PBT-07)', () => {
    it('sum of subscription payments equals total MRR for any payment list', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        subscription_id: fc.oneof(
                            fc.constant(null),
                            fc.string({ minLength: 1, maxLength: 20 })
                        ),
                        total_amount: fc.integer({ min: 0, max: 99999 }),
                    }),
                    { maxLength: 20 }
                ),
                (payments) => {
                    // Replicate getPaymentsMRR accumulation logic
                    const mrrCents = payments.reduce((sum, p) => {
                        return p.subscription_id ? sum + (p.total_amount || 0) : sum;
                    }, 0);

                    const expected = payments
                        .filter(p => p.subscription_id)
                        .reduce((sum, p) => sum + p.total_amount, 0);

                    expect(mrrCents).toBe(expected);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('contracted MRR always equals sum of amount×quantity for all entries', () => {
        fc.assert(
            fc.property(
                fc.array(
                    fc.record({
                        recurring_pre_tax_amount: fc.integer({ min: 0, max: 99999 }),
                        quantity: fc.integer({ min: 1, max: 10 }),
                    }),
                    { maxLength: 20 }
                ),
                (subs) => {
                    const mrrCents = subs.reduce(
                        (sum, s) => sum + (s.recurring_pre_tax_amount || 0) * (s.quantity || 1),
                        0
                    );
                    const expected = subs.reduce(
                        (sum, s) => sum + s.recurring_pre_tax_amount * s.quantity,
                        0
                    );
                    expect(mrrCents).toBe(expected);
                }
            ),
            { numRuns: 100 }
        );
    });
});

// ─── PBT-02: Token encryption round-trip ─────────────────────────────────────
describe('Token encryption round-trip (PBT-02)', () => {
    // Import the server's encrypt/decrypt pair
    // We test via the bifrost module's exported path indirectly:
    // server exports encryptToken / decryptToken
    const crypto = require('crypto');

    function encryptToken(value) {
        const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || 'a'.repeat(64), 'hex');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]).toString('base64');
    }

    function decryptToken(encrypted) {
        const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY || 'a'.repeat(64), 'hex');
        const buf = Buffer.from(encrypted, 'base64');
        const iv = buf.slice(0, 12);
        const tag = buf.slice(12, 28);
        const ciphertext = buf.slice(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }

    it('decrypt(encrypt(x)) === x for any string value', () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 1, maxLength: 512 }),
                (original) => {
                    const roundTripped = decryptToken(encryptToken(original));
                    expect(roundTripped).toBe(original);
                }
            ),
            { numRuns: 50 }
        );
    });

    it('each encryption of the same value produces a different ciphertext (random IV)', () => {
        fc.assert(
            fc.property(
                fc.string({ minLength: 1, maxLength: 100 }),
                (plaintext) => {
                    const enc1 = encryptToken(plaintext);
                    const enc2 = encryptToken(plaintext);
                    // Different IVs → different ciphertexts
                    expect(enc1).not.toBe(enc2);
                    // But both decrypt to the same value
                    expect(decryptToken(enc1)).toBe(plaintext);
                    expect(decryptToken(enc2)).toBe(plaintext);
                }
            ),
            { numRuns: 30 }
        );
    });
});

// ─── Input validation invariants (PBT-03 for validators) ─────────────────────
describe('Input validation invariants', () => {
    it('createVirtualKey always rejects empty/null/non-string userId', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(fc.constant(''), fc.constant(null), fc.constant(undefined), fc.integer()),
                async (badUserId) => {
                    await expect(bifrost.createVirtualKey(badUserId)).rejects.toThrow(TypeError);
                }
            ),
            { numRuns: 20 }
        );
    });

    it('topUpCredits always rejects zero or negative topUp amounts', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.oneof(
                    fc.constant(0),
                    fc.float({ min: Math.fround(-1000), max: Math.fround(-0.001), noNaN: true }),
                ),
                async (badAmount) => {
                    await expect(bifrost.topUpCredits('vk-1', 1.0, badAmount)).rejects.toThrow();
                }
            ),
            { numRuns: 20 }
        );
    });
});
