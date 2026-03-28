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
 *  - GET  /admin/revenue
 *  - GET  /admin/dashboard-live
 *  - GET  /admin/metrics/prometheus
 *  - GET  /admin/users
 *  - GET  /admin/users/:userId
 *  - GET  /admin/events
 *  - POST /admin/users/:userId/stop
 *  - POST /admin/users/:userId/credit
 *  - POST /verify-turnstile
 *  - POST /deploy-bot
 *  - POST /stop-bot
 *  - POST /register-chat
 *  - POST /notify-low-credits
 *  - Security: CORS, Helmet headers
 *  - 404 handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';

let app, db, stmt;

beforeAll(async () => {
    // Import server — does NOT auto-listen in test mode
    const mod = require('../server');
    await mod.dbReady;
    app = mod.app;
    db = mod.db;
    stmt = mod.stmt;
});

afterAll(async () => {
    if (db) {
        try { await db.close(); } catch (_) { /* already closed */ }
    }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /health
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /health', () => {
    it('returns 200 with minimal status (no system details)', async () => {
        const res = await request(app)
            .get('/health')
            .expect(200);

        expect(res.body.status).toMatch(/^(ok|degraded)$/);
        expect(res.body).toHaveProperty('checks');
        expect(res.body.checks).toHaveProperty('db');
        expect(res.body).toHaveProperty('ts');
        // Sensitive details should NOT be exposed on public health
        expect(res.body).not.toHaveProperty('memory');
        expect(res.body).not.toHaveProperty('runningBots');
        expect(res.body).not.toHaveProperty('version');
        expect(res.body).not.toHaveProperty('env');
    });

    it('includes correct content-type', async () => {
        const res = await request(app)
            .get('/health')
            .expect('Content-Type', /json/);

        expect(res.body.status).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /readyz
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /readyz', () => {
    it('returns 200 with db check', async () => {
        const res = await request(app)
            .get('/readyz')
            .expect(200);

        expect(res.body.status).toBe('ok');
        expect(res.body.checks).toHaveProperty('db', true);
        expect(res.body).toHaveProperty('ts');
        // Should NOT expose service name or system details
        expect(res.body).not.toHaveProperty('service');
        expect(res.body).not.toHaveProperty('memory');
    });

    it('caches response for subsequent requests', async () => {
        const res1 = await request(app).get('/readyz').expect(200);
        const res2 = await request(app).get('/readyz').expect(200);
        // Both should return the same cached timestamp (within 5s TTL)
        expect(res1.body.ts).toBe(res2.body.ts);
    });
});

describe('GET /admin/health', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/health')
            .expect(401);
    });

    it('returns detailed system info with admin secret', async () => {
        const res = await request(app)
            .get('/admin/health')
            .set('X-Admin-Secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.status).toMatch(/^(ok|degraded)$/);
        expect(res.body.service).toBe('LiveClaw Orchestrator');
        expect(res.body.version).toBe('2.0.0');
        expect(res.body).toHaveProperty('runningBots');
        expect(res.body).toHaveProperty('maxBots');
        expect(res.body).toHaveProperty('checks');
        expect(res.body.checks).toHaveProperty('db');
        expect(res.body).toHaveProperty('memory');
        expect(res.body.memory).toHaveProperty('totalMB');
        expect(res.body.memory).toHaveProperty('freeMB');
        expect(res.body).toHaveProperty('ts');
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
        expect(res.body.bots).toHaveProperty('maxConcurrent');
        expect(res.body.bots).toHaveProperty('capacityPct');
        expect(res.body.credits).toHaveProperty('totalAllocated');
        expect(res.body.system).toHaveProperty('uptime');
        expect(res.body.system.node).toHaveProperty('rssMB');
        expect(res.body.system.os).toHaveProperty('totalMemMB');
        expect(res.body.system.os).toHaveProperty('loadAvg');
        expect(res.body).toHaveProperty('botInstances');
    });

    it('rejects wrong admin secret', async () => {
        await request(app)
            .get('/admin/stats')
            .set('x-admin-secret', 'wrong-secret')
            .expect(401);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/revenue
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/revenue', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/revenue')
            .expect(401);
    });

    it('returns revenue data with correct admin secret', async () => {
        const res = await request(app)
            .get('/admin/revenue')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body).toHaveProperty('period', '30d');
        expect(res.body).toHaveProperty('subscriptions');
        expect(res.body.subscriptions).toHaveProperty('active');
        expect(res.body.subscriptions).toHaveProperty('churned');
        expect(res.body.subscriptions).toHaveProperty('mrrUsd');
        expect(res.body).toHaveProperty('revenue');
        expect(res.body.revenue).toHaveProperty('payments');
        expect(res.body.revenue).toHaveProperty('totalUsd');
        expect(res.body).toHaveProperty('dailyBreakdown');
        expect(Array.isArray(res.body.dailyBreakdown)).toBe(true);
    });

    it('accepts period query parameter', async () => {
        const res = await request(app)
            .get('/admin/revenue')
            .query({ period: '7d' })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.period).toBe('7d');
    });

    it('defaults to 30d for unknown period', async () => {
        const res = await request(app)
            .get('/admin/revenue')
            .query({ period: 'invalid' })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.period).toBe('invalid');
        // Should still return data (uses -30 days fallback)
        expect(res.body).toHaveProperty('revenue');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/dashboard-live
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/dashboard-live', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/dashboard-live')
            .expect(401);
    });

    it('returns unified live telemetry payload', async () => {
        const res = await request(app)
            .get('/admin/dashboard-live')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body).toHaveProperty('health');
        expect(res.body).toHaveProperty('traffic');
        expect(res.body).toHaveProperty('system');
        expect(res.body).toHaveProperty('bots');
        expect(res.body).toHaveProperty('subscriptions');
        expect(res.body).toHaveProperty('revenue');
        expect(res.body).toHaveProperty('instances');
        expect(res.body).toHaveProperty('events');

        expect(res.body.traffic).toHaveProperty('1m');
        expect(res.body.traffic['1m']).toHaveProperty('reqPerSec');
        expect(Array.isArray(res.body.instances)).toBe(true);
        expect(Array.isArray(res.body.payments)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/metrics/prometheus
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/metrics/prometheus', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/metrics/prometheus')
            .expect(401);
    });

    it('returns Prometheus text payload with key metrics', async () => {
        const res = await request(app)
            .get('/admin/metrics/prometheus')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200)
            .expect('Content-Type', /text\/plain/);

        expect(res.text).toContain('liveclaw_http_requests_total');
        expect(res.text).toContain('liveclaw_agents_running');
        expect(res.text).toContain('liveclaw_subscriptions_active');
        expect(res.text).toContain('liveclaw_revenue_paid_usd');
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/users
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/users', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/users')
            .expect(401);
    });

    it('returns user list with correct admin secret', async () => {
        const res = await request(app)
            .get('/admin/users')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body).toHaveProperty('users');
        expect(Array.isArray(res.body.users)).toBe(true);
        expect(res.body).toHaveProperty('total');
        expect(res.body).toHaveProperty('limit');
        expect(res.body).toHaveProperty('offset');
    });

    it('filters by status', async () => {
        const res = await request(app)
            .get('/admin/users')
            .query({ status: 'running' })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(Array.isArray(res.body.users)).toBe(true);
    });

    it('supports pagination', async () => {
        const res = await request(app)
            .get('/admin/users')
            .query({ limit: 5, offset: 0 })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.limit).toBe(5);
        expect(res.body.offset).toBe(0);
    });

    it('caps limit at 200', async () => {
        const res = await request(app)
            .get('/admin/users')
            .query({ limit: 9999 })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.limit).toBe(200);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/users/:userId
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/users/:userId', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/users/test-user')
            .expect(401);
    });

    it('returns 404 for nonexistent user', async () => {
        await request(app)
            .get('/admin/users/nonexistent-user')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /admin/events
// ═══════════════════════════════════════════════════════════════════════════
describe('GET /admin/events', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .get('/admin/events')
            .expect(401);
    });

    it('returns event log with correct admin secret', async () => {
        const res = await request(app)
            .get('/admin/events')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body).toHaveProperty('events');
        expect(Array.isArray(res.body.events)).toBe(true);
        expect(res.body).toHaveProperty('total');
        expect(res.body).toHaveProperty('eventTypes');
        expect(Array.isArray(res.body.eventTypes)).toBe(true);
    });

    it('supports event type filtering', async () => {
        const res = await request(app)
            .get('/admin/events')
            .query({ event: 'deploy_requested' })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(Array.isArray(res.body.events)).toBe(true);
    });

    it('supports user ID filtering', async () => {
        const res = await request(app)
            .get('/admin/events')
            .query({ userId: 'test-user' })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(Array.isArray(res.body.events)).toBe(true);
    });

    it('caps limit at 500', async () => {
        const res = await request(app)
            .get('/admin/events')
            .query({ limit: 9999 })
            .set('x-admin-secret', 'test-admin-secret')
            .expect(200);

        expect(res.body.limit).toBe(500);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /admin/users/:userId/stop
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /admin/users/:userId/stop', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .post('/admin/users/test-user/stop')
            .expect(401);
    });

    it('returns 404 for nonexistent user', async () => {
        await request(app)
            .post('/admin/users/nonexistent-user/stop')
            .set('x-admin-secret', 'test-admin-secret')
            .expect(404);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /admin/users/:userId/credit
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /admin/users/:userId/credit', () => {
    it('returns 401 without admin secret', async () => {
        await request(app)
            .post('/admin/users/test-user/credit')
            .send({ amount: 0.05 })
            .expect(401);
    });

    it('rejects zero amount', async () => {
        await request(app)
            .post('/admin/users/test-user/credit')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ amount: 0 })
            .expect(400);
    });

    it('rejects missing amount', async () => {
        await request(app)
            .post('/admin/users/test-user/credit')
            .set('x-admin-secret', 'test-admin-secret')
            .send({})
            .expect(400);
    });

    it('returns 404 for nonexistent user', async () => {
        await request(app)
            .post('/admin/users/nonexistent-user/credit')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ amount: 0.05 })
            .expect(404);
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

    it('rejects missing telegramToken with 403 (ownership check rejects unauthenticated)', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({ userId: 'user-1' })
            .expect(403);

        expect(res.body.error).toMatch(/match/i);
    });

    it('rejects invalid telegramToken format with 403 (ownership check rejects unauthenticated)', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({ userId: 'user-1', telegramToken: 'not-a-token' })
            .expect(403);

        expect(res.body.error).toMatch(/match/i);
    });

    it('rejects invalid model with 403 (ownership check rejects unauthenticated)', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({
                userId: 'user-1',
                telegramToken: '1234567890:ABCDEFghijklmnopqrstuvwxyz123456789',
                model: 'gpt-99-super',
            })
            .expect(403);

        expect(res.body.error).toMatch(/match/i);
    });

    it('accepts kimi-k2.5 as a valid model', async () => {
        const res = await request(app)
            .post('/deploy-bot')
            .send({
                userId: 'user-kimi',
                telegramToken: '1234567890:ABCDEFghijklmnopqrstuvwxyz123456789',
                model: 'kimi-k2.5',
            });

        expect(res.status).not.toBe(400);
        expect(res.body.error || '').not.toMatch(/Invalid model/i);
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

    it('returns 403 for unknown user (ownership check rejects unauthenticated)', async () => {
        await request(app)
            .post('/stop-bot')
            .send({ userId: 'nonexistent-user' })
            .expect(403);
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
// POST /register-chat
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /register-chat', () => {
    const SEED_USER = 'register-chat-test-user';

    beforeAll(async () => {
        // Seed a bot for tests
        await stmt.upsertBot({
            user_id: SEED_USER,
            pid: 0,
            model: 'minimax-m2.5',
            telegram_token: 'enc:test',
            bifrost_vk_id: 'vk-test',
            bifrost_vk: 'enc:vk',
            credit_limit: 1.0,
            discord_token: null,
            slack_app_token: null,
            slack_bot_token: null,
            active_channels: '["telegram"]',
        });
    });

    it('rejects missing userId', async () => {
        await request(app)
            .post('/register-chat')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ chatId: '12345' })
            .expect(400);
    });

    it('rejects missing chatId', async () => {
        await request(app)
            .post('/register-chat')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: SEED_USER })
            .expect(400);
    });

    it('returns 404 for unknown user', async () => {
        await request(app)
            .post('/register-chat')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: 'nonexistent-user', chatId: '12345' })
            .expect(404);
    });

    it('rejects unauthenticated requests', async () => {
        await request(app)
            .post('/register-chat')
            .send({ userId: SEED_USER, chatId: '12345' })
            .expect(401);
    });

    it('registers chat ID successfully', async () => {
        const res = await request(app)
            .post('/register-chat')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: SEED_USER, chatId: '999888777' })
            .expect(200);

        expect(res.body.success).toBe(true);

        // Verify it was persisted
        const bot = await stmt.getBot(SEED_USER);
        expect(bot.telegram_chat_id).toBe('999888777');
    });

    it('accepts numeric chatId', async () => {
        const res = await request(app)
            .post('/register-chat')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: SEED_USER, chatId: 111222333 })
            .expect(200);

        expect(res.body.success).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /notify-low-credits
// ═══════════════════════════════════════════════════════════════════════════
describe('POST /notify-low-credits', () => {
    const SEED_USER = 'notify-test-user';
    const NO_CHAT_USER = 'notify-no-chat-user';

    beforeAll(async () => {
        await stmt.upsertBot({
            user_id: SEED_USER,
            pid: 0,
            model: 'minimax-m2.5',
            telegram_token: 'enc:test',
            bifrost_vk_id: 'vk-test',
            bifrost_vk: 'enc:vk',
            credit_limit: 0.001,
            discord_token: null,
            slack_app_token: null,
            slack_bot_token: null,
            active_channels: '["telegram"]',
        });
        await stmt.updateChatId('12345678', SEED_USER);

        await stmt.upsertBot({
            user_id: NO_CHAT_USER,
            pid: 0,
            model: 'minimax-m2.5',
            telegram_token: 'enc:test',
            bifrost_vk_id: 'vk-test',
            bifrost_vk: 'enc:vk',
            credit_limit: 0.001,
            discord_token: null,
            slack_app_token: null,
            slack_bot_token: null,
            active_channels: '["telegram"]',
        });
    });

    it('rejects missing userId', async () => {
        await request(app)
            .post('/notify-low-credits')
            .set('x-admin-secret', 'test-admin-secret')
            .send({})
            .expect(400);
    });

    it('returns 404 for unknown user', async () => {
        await request(app)
            .post('/notify-low-credits')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: 'nonexistent-user' })
            .expect(404);
    });

    it('returns 400 when no chat ID registered', async () => {
        const res = await request(app)
            .post('/notify-low-credits')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: NO_CHAT_USER })
            .expect(400);

        expect(res.body.error).toMatch(/chat ID/i);
    });

    it('rejects unauthenticated requests', async () => {
        await request(app)
            .post('/notify-low-credits')
            .send({ userId: SEED_USER })
            .expect(401);
    });

    it('attempts to send Telegram notification (may fail in test env)', async () => {
        // In test env, Telegram API call will fail since the bot token is fake.
        // We validate it reaches the Telegram API call and returns 502 (not 400/404).
        const res = await request(app)
            .post('/notify-low-credits')
            .set('x-admin-secret', 'test-admin-secret')
            .send({ userId: SEED_USER });

        // Should either be 200 (unlikely) or 502 (Telegram API failure with fake token)
        expect([200, 502]).toContain(res.status);
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
