/**
 * Integration tests for LiveClaw API endpoints.
 *
 * Uses supertest to make real HTTP requests against the Express app
 * with an in-memory SQLite database. No actual server is started —
 * supertest binds to an ephemeral port internally.
 *
 * Test coverage:
 *  - GET  /health
 *  - GET  /admin/stats
 *  - POST /verify-turnstile
 *  - GET  /webhook/applixir-reward
 *  - POST /webhook/telegram-stars
 *  - POST /deploy-bot
 *  - POST /stop-bot
 *  - GET  /status/:userId
 *  - POST /create-invoice
 *  - Security: CORS, Helmet headers
 *  - 404 handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app, db;

beforeAll(() => {
    // Import server — does NOT auto-listen in test mode
    const mod = require('../server');
    app = mod.app;
    db = mod.db;
});

afterAll(() => {
    if (db && db.open) {
        db.close();
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /health', () => {
    it('returns 200 with service info', async () => {
        const res = await request(app)
            .get('/health')
            .expect(200);

        expect(res.body.status).toBe('ok');
        expect(res.body.service).toBe('LiveClaw Orchestrator');
        expect(res.body.version).toBe('1.0.0');
        expect(res.body).toHaveProperty('runningBots');
        expect(res.body).toHaveProperty('ts');
    });

    it('includes correct content-type', async () => {
        const res = await request(app)
            .get('/health')
            .expect('Content-Type', /json/);

        expect(res.body.status).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/stats
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/stats', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/stats')
            .expect(401);
    });

    it('returns 200 with correct admin secret', async () => {
        const res = await request(app)
            .get('/admin/stats')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.bots).toBeDefined();
        expect(res.body.bots).toHaveProperty('total');
        expect(res.body.bots).toHaveProperty('running');
        expect(res.body.bots).toHaveProperty('stopped');
        expect(res.body.bots).toHaveProperty('crashed');
        expect(res.body.credits).toHaveProperty('totalAllocated');
        expect(res.body.system).toHaveProperty('uptime');
        expect(res.body.system.memoryMB).toHaveProperty('rss');
    });

    it('rejects wrong admin secret', async () => {
        await request(app)
            .get('/admin/stats')
            .set('x-admin-secret', 'wrong-secret')
            .expect(401);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /verify-turnstile
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /verify-turnstile', () => {
    it('rejects missing token', async () => {
        const res = await request(app)
            .post('/verify-turnstile')
            .send({})
            .expect(400);

        expect(res.body.success).toBe(false);
    });

    it('rejects empty token', async () => {
        await request(app)
            .post('/verify-turnstile')
            .send({ token: '' })
            .expect(400);
    });

    it('rejects non-string token', async () => {
        await request(app)
            .post('/verify-turnstile')
            .send({ token: 12345 })
            .expect(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /webhook/applixir-reward
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /webhook/applixir-reward', () => {
    it('rejects missing params', async () => {
        await request(app)
            .get('/webhook/applixir-reward')
            .expect(400);
    });

    it('rejects wrong secretKey', async () => {
        await request(app)
            .get('/webhook/applixir-reward')
            .query({
                secretKey: 'wrong-secret',
                userId: 'user-1',
                gameApiKey: 'gk-1',
                gameId: 'g-1',
            })
            .expect(401);
    });

    it('rejects unknown userId', async () => {
        await request(app)
            .get('/webhook/applixir-reward')
            .query({
                secretKey: 'test-applixir-secret',
                userId: 'nonexistent-user',
            })
            .expect(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /webhook/telegram-stars
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /webhook/telegram-stars', () => {
    it('responds 200 to pre_checkout_query', async () => {
        await request(app)
            .post('/webhook/telegram-stars')
            .send({
                pre_checkout_query: {
                    id: 'pco-test-123',
                    from: { id: 12345 },
                    currency: 'XTR',
                    total_amount: 10,
                },
            })
            .expect(200);
    });

    it('handles malformed body gracefully', async () => {
        await request(app)
            .post('/webhook/telegram-stars')
            .send({})
            .expect(200);  // Webhook should always return 200 to prevent retries
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /deploy-bot — Validation
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /deploy-bot', () => {
    it('rejects missing userId', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({ telegramToken: '123456:ABC' })
            .expect(400);

        expect(res.body.error).toMatch(/userId/i);
    });

    it('rejects missing telegramToken', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({ userId: 'user-1' })
            .expect(400);

        expect(res.body.error).toMatch(/telegramToken/i);
    });

    it('rejects invalid telegramToken format', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({ userId: 'user-1', telegramToken: 'not-a-token' })
            .expect(400);

        expect(res.body.error).toMatch(/Invalid.*token/i);
    });

    it('rejects invalid model', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({
                userId: 'user-1',
                telegramToken: '1234567890:ABCDEFghijklmnopqrstuvwxyz123456789',
                model: 'gpt-99-super',
            })
            .expect(400);

        expect(res.body.error).toMatch(/Invalid model/i);
    });

    it('rejects userId longer than 128 chars', async () => {
        await request(app)
            .post('/deploy-bot')
            .send({
                userId: 'x'.repeat(200),
                telegramToken: '1234567890:ABCDEFghijklmnopqrstuvwxyz123456789',
            })
            .expect(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /stop-bot — Validation
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /stop-bot', () => {
    it('rejects missing userId', async () => {
        await request(app)
            .post('/stop-bot')
            .send({})
            .expect(400);
    });

    it('returns 404 for unknown user', async () => {
        await request(app)
            .post('/stop-bot')
            .send({ userId: 'nonexistent-user' })
            .expect(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /status/:userId
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /status/:userId', () => {
    it('returns 404 for unknown user', async () => {
        const res = await request(app)
            .get('/status/nonexistent-user')
            .expect(404);

        expect(res.body.error).toMatch(/No bot found/i);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /create-invoice — Validation
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /create-invoice', () => {
    it('rejects missing userId', async () => {
        await request(app)
            .post('/create-invoice')
            .send({ stars: 10 })
            .expect(400);
    });

    it('rejects invalid stars value', async () => {
        await request(app)
            .post('/create-invoice')
            .send({ userId: 'user-1', stars: -5 })
            .expect(400);
    });

    it('rejects stars > 10000', async () => {
        await request(app)
            .post('/create-invoice')
            .send({ userId: 'user-1', stars: 99999 })
            .expect(400);
    });

    it('returns 404 if no bot deployed', async () => {
        await request(app)
            .post('/create-invoice')
            .send({ userId: 'no-bot-user', stars: 10 })
            .expect(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security Headers (Helmet)
// ═══════════════════════════════════════════════════════════════════════════
describe('Security headers', () => {
    it('includes X-Content-Type-Options: nosniff', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('includes X-Frame-Options', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('returns JSON content type', async () => {
        const res = await request(app).get('/health');
        expect(res.headers['content-type']).toMatch(/application\/json/);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 404 Handling
// ═══════════════════════════════════════════════════════════════════════════
describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
        await request(app)
            .get('/nonexistent-route')
            .expect(404);
    });
});
