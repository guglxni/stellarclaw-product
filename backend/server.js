/**
 * LiveClaw Orchestrator — server.js
 *
 * Production-grade Express API that:
 *  1. Creates Portkey.ai Virtual Keys with $0.05 starting budget
 *  2. Spawns isolated picobot Go binaries per user
 *  3. Persists process mappings in SQLite
 *  4. Verifies Cloudflare Turnstile CAPTCHA
 *  5. Processes AppLixir S2S ad-reward postbacks
 *  6. Handles Telegram Stars payment webhooks
 *  7. Gracefully shuts down on SIGTERM/SIGINT
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const portkey = require('./portkey');

// ─── Configuration ──────────────────────────────────────────────────────────
const config = Object.freeze({
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    picobotPath: process.env.PICOBOT_PATH || path.join(__dirname, 'picobot'),
    dbPath: process.env.DB_PATH || path.join(__dirname, 'liveclaw.db'),
    portkeyBase: process.env.PORTKEY_GATEWAY_URL || 'http://localhost:8787/v1',
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
    applixirSecret: process.env.APPLIXIR_SECRET_KEY,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://liveclaw.xyz').split(','),
    starsToUsdRate: parseFloat(process.env.STARS_TO_USD_RATE) || 0.015,
    adRewardUsd: parseFloat(process.env.AD_REWARD_USD) || 0.02,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '', // 32-byte hex for AES-256-GCM
});

const isProd = config.nodeEnv === 'production';

// ─── Token Encryption Helpers ───────────────────────────────────────────────
// Encrypt sensitive tokens at rest in SQLite (AES-256-GCM)
const ALGO = 'aes-256-gcm';
const IV_LEN = 16;

function deriveKey() {
    if (!config.encryptionKey || config.encryptionKey.length < 32) {
        // In dev/test, fall through to plaintext (warn loudly)
        return null;
    }
    return Buffer.from(config.encryptionKey, 'hex');
}

function encryptToken(plaintext) {
    const key = deriveKey();
    if (!key) return plaintext; // dev fallback
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    let enc = cipher.update(plaintext, 'utf8', 'hex');
    enc += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${tag}:${enc}`;
}

function decryptToken(ciphertext) {
    const key = deriveKey();
    if (!key) return ciphertext; // dev fallback
    const [ivHex, tagHex, encHex] = ciphertext.split(':');
    if (!ivHex || !tagHex || !encHex) return ciphertext; // plaintext legacy
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let dec = decipher.update(encHex, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
}

// ─── Database ───────────────────────────────────────────────────────────────
const db = new Database(config.dbPath);

// WAL mode for better concurrent read/write performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT    NOT NULL UNIQUE,
        pid             INTEGER NOT NULL,
        model           TEXT    NOT NULL DEFAULT 'minimax-m2.5',
        telegram_token  TEXT    NOT NULL,
        portkey_vk_id   TEXT,
        portkey_vk      TEXT    NOT NULL,
        credit_limit    REAL    NOT NULL DEFAULT 0.05,
        status          TEXT    NOT NULL DEFAULT 'running'
                        CHECK(status IN ('running','stopped','crashed')),
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS event_logs (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id  TEXT    NOT NULL,
        event    TEXT    NOT NULL,
        detail   TEXT,
        ip       TEXT,
        ts       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
    CREATE INDEX IF NOT EXISTS idx_logs_user   ON event_logs(user_id, ts);
`);

// Prepared statements (compiled once, reused for perf)
const stmt = {
    upsertBot: db.prepare(`
        INSERT INTO bots (user_id, pid, model, telegram_token, portkey_vk_id, portkey_vk, credit_limit, status)
        VALUES (@user_id, @pid, @model, @telegram_token, @portkey_vk_id, @portkey_vk, @credit_limit, 'running')
        ON CONFLICT(user_id) DO UPDATE SET
            pid            = excluded.pid,
            model          = excluded.model,
            telegram_token = excluded.telegram_token,
            portkey_vk_id  = excluded.portkey_vk_id,
            portkey_vk     = excluded.portkey_vk,
            credit_limit   = excluded.credit_limit,
            status         = 'running',
            updated_at     = CURRENT_TIMESTAMP
    `),
    getBot: db.prepare('SELECT * FROM bots WHERE user_id = ?'),
    updateCredit: db.prepare('UPDATE bots SET credit_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'),
    updateStatus: db.prepare("UPDATE bots SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"),
    insertLog: db.prepare('INSERT INTO event_logs (user_id, event, detail, ip) VALUES (?, ?, ?, ?)'),
    runningBots: db.prepare("SELECT user_id, pid FROM bots WHERE status = 'running'"),
    countRunning: db.prepare("SELECT COUNT(*) as count FROM bots WHERE status = 'running'"),
};

function logEvent(userId, event, detail = null, ip = null) {
    stmt.insertLog.run(userId, event, typeof detail === 'object' ? JSON.stringify(detail) : detail, ip);
}

// ─── Async Error Wrapper ────────────────────────────────────────────────────
// Catches unhandled promise rejections in route handlers and forwards to error middleware.
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ─── Express App ────────────────────────────────────────────────────────────
const app = express();

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
app.use(helmet());

// CORS — restrict to our frontend domain
app.use(cors({
    origin: isProd ? config.allowedOrigins : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

// Body parsing with size limits to prevent DoS
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request ID middleware for tracing
app.use((req, _res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    next();
});

// Request logging
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        console.log(`[${req.requestId}] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    });
    next();
});

// ─── Rate Limiters ──────────────────────────────────────────────────────────
const deployLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 5,                // 5 deploys per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many deploy requests. Please try again shortly.' },
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(generalLimiter);

// ─── Cloudflare Turnstile Verification ──────────────────────────────────────
app.post('/verify-turnstile', asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, error: 'Token is required' });
    }

    if (!config.turnstileSecret) {
        console.error('[Turnstile] TURNSTILE_SECRET_KEY not configured');
        return res.status(500).json({ success: false, error: 'Turnstile not configured' });
    }

    const formData = new URLSearchParams();
    formData.append('secret', config.turnstileSecret);
    formData.append('response', token);

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    if (ip) formData.append('remoteip', ip);

    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData,
    });

    const outcome = await result.json();

    if (outcome.success) {
        return res.json({ success: true });
    }

    console.warn(`[Turnstile] Verification failed ip=${ip}`, outcome['error-codes']);
    return res.status(403).json({ success: false, error: 'CAPTCHA verification failed' });
}));

// ─── AppLixir S2S Postback Rewards ──────────────────────────────────────────
// AppLixir sends S2S callbacks as GET requests with query parameters:
//   ?gameApiKey={KEY}&gameId={ID}&secretKey={SECRET}&userId={UID}&eventId={EID}
app.get('/webhook/applixir-reward', webhookLimiter, asyncHandler(async (req, res) => {
    const { secretKey, userId, gameApiKey, gameId, eventId } = req.query;

    if (!secretKey || !userId) {
        return res.status(400).send('Missing required params: secretKey, userId');
    }

    if (!config.applixirSecret) {
        console.error('[AppLixir] APPLIXIR_SECRET_KEY not configured');
        return res.status(500).send('Webhook not configured');
    }

    // Verify the secretKey matches our stored secret (timing-safe)
    const incomingBuf = Buffer.from(String(secretKey), 'utf8');
    const expectedBuf = Buffer.from(config.applixirSecret, 'utf8');

    if (incomingBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(incomingBuf, expectedBuf)) {
        console.error(`[AppLixir] Invalid secretKey for userId=${userId}`);
        logEvent(userId, 'ad_reward_rejected', { reason: 'bad_secret', gameApiKey });
        return res.status(401).send('Unauthorized');
    }

    const bot = stmt.getBot.get(userId);
    if (!bot) {
        console.warn(`[AppLixir] No bot for userId=${userId} (ad watched but no deployment)`);
        return res.status(404).send('Bot not found');
    }

    const newLimit = bot.credit_limit + config.adRewardUsd;
    await portkey.topUpCredits(bot.portkey_vk_id, bot.credit_limit, config.adRewardUsd);
    stmt.updateCredit.run(newLimit, userId);
    logEvent(userId, 'ad_reward_credited', {
        added: config.adRewardUsd, newTotal: newLimit, eventId, gameId,
    });

    console.log(`[AppLixir] User ${userId} +$${config.adRewardUsd} → $${newLimit}`);
    return res.send('OK');
}));

// ─── Telegram Stars Payment Webhook ─────────────────────────────────────────
app.post('/webhook/telegram-stars', webhookLimiter, asyncHandler(async (req, res) => {
    const update = req.body;

    const payment = update?.message?.successful_payment;
    if (!payment) {
        // Not a payment update — acknowledge silently
        return res.sendStatus(200);
    }

    const userId = payment.invoice_payload;
    const totalStars = payment.total_amount;
    const currency = payment.currency;

    if (currency !== 'XTR') {
        console.warn(`[TelegramStars] Unknown currency: ${currency}`);
        return res.sendStatus(200);
    }

    const addUsd = totalStars * config.starsToUsdRate;
    const bot = stmt.getBot.get(userId);

    if (!bot) {
        console.error(`[TelegramStars] Bot not found for userId=${userId}`);
        return res.status(404).json({ error: 'Bot not found' });
    }

    const newLimit = bot.credit_limit + addUsd;
    await portkey.topUpCredits(bot.portkey_vk_id, bot.credit_limit, addUsd);
    stmt.updateCredit.run(newLimit, userId);
    logEvent(userId, 'stars_credited', { stars: totalStars, usdAdded: addUsd, newTotal: newLimit });

    console.log(`[TelegramStars] User ${userId} spent ${totalStars}★ → +$${addUsd.toFixed(4)}`);
    return res.sendStatus(200);
}));

// ─── Spawn picobot ──────────────────────────────────────────────────────────
function spawnPicobot(telegramToken, portkeyVirtualKey, model = 'minimax-m2.5') {
    const env = {
        // Only pass what picobot needs — do NOT spread process.env to avoid leaking secrets
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: portkeyVirtualKey,
        OPENAI_API_BASE: config.portkeyBase,  // Self-hosted Portkey gateway
        PICOBOT_MODEL: model,
        PICOBOT_MAX_TOKENS: '8192',
        TELEGRAM_BOT_TOKEN: telegramToken,
    };

    const child = spawn(config.picobotPath, ['gateway'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'], // fully detached, no pipe leaks
        env,
    });

    child.unref();

    child.on('error', (err) => {
        console.error(`[picobot][pid=${child.pid}] spawn error: ${err.message}`);
    });

    return child.pid;
}

// ─── POST /deploy-bot ───────────────────────────────────────────────────────
app.post('/deploy-bot', deployLimiter, asyncHandler(async (req, res) => {
    const { userId, telegramToken, model = 'minimax-m2.5', creditLimit = 0.05 } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    // ── Validation ──────────────────────────────────────────────────────────
    if (!userId || typeof userId !== 'string' || userId.length > 128) {
        return res.status(400).json({ error: 'userId is required (string, max 128 chars)' });
    }
    if (!telegramToken || typeof telegramToken !== 'string') {
        return res.status(400).json({ error: 'telegramToken is required' });
    }
    if (!/^\d+:[A-Za-z0-9_-]{30,50}$/.test(telegramToken)) {
        return res.status(400).json({ error: 'Invalid Telegram bot token format' });
    }

    const ALLOWED_MODELS = ['minimax-m2.5', 'kimi-k2.5'];
    if (!ALLOWED_MODELS.includes(model)) {
        return res.status(400).json({ error: `Invalid model. Allowed: ${ALLOWED_MODELS.join(', ')}` });
    }

    console.log(`[deploy] userId=${userId} model=${model} ip=${ip}`);
    logEvent(userId, 'deploy_requested', { model, creditLimit }, ip);

    // ── Stop existing bot if running ────────────────────────────────────────
    const existing = stmt.getBot.get(userId);
    if (existing && existing.status === 'running') {
        try { process.kill(existing.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
        stmt.updateStatus.run('stopped', userId);
        logEvent(userId, 'existing_bot_stopped', { pid: existing.pid });
    }

    // ── Create Portkey Virtual Key ──────────────────────────────────────────
    let virtualKey;
    try {
        virtualKey = await portkey.createVirtualKey(userId, creditLimit);
        logEvent(userId, 'portkey_vk_created', { id: virtualKey.id });
    } catch (err) {
        console.error('[deploy] Portkey error:', err.message);
        logEvent(userId, 'portkey_error', err.message);
        const detail = isProd ? undefined : err.message;
        return res.status(502).json({ error: 'Failed to create API key', detail });
    }

    // ── Spawn picobot ───────────────────────────────────────────────────────
    let pid;
    try {
        pid = spawnPicobot(telegramToken, virtualKey.key, model);
        logEvent(userId, 'picobot_spawned', { pid, model });
    } catch (err) {
        console.error('[deploy] picobot spawn error:', err.message);
        logEvent(userId, 'picobot_error', err.message);
        const detail = isProd ? undefined : err.message;
        return res.status(500).json({ error: 'Failed to spawn agent', detail });
    }

    // ── Persist to SQLite (token encrypted at rest) ─────────────────────────
    stmt.upsertBot.run({
        user_id: userId,
        pid,
        model,
        telegram_token: encryptToken(telegramToken),
        portkey_vk_id: virtualKey.id,
        portkey_vk: virtualKey.key,
        credit_limit: creditLimit,
    });

    return res.status(201).json({
        success: true,
        pid,
        model,
        creditLimit,
        message: 'Your Claw agent is live on Telegram!',
    });
}));

// ─── POST /stop-bot ─────────────────────────────────────────────────────────
app.post('/stop-bot', asyncHandler(async (req, res) => {
    const { userId } = req.body;
    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    const bot = stmt.getBot.get(userId);
    if (!bot) return res.status(404).json({ error: 'No bot found for this user' });

    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }

    stmt.updateStatus.run('stopped', userId);
    logEvent(userId, 'bot_stopped_manual', { pid: bot.pid });

    return res.json({ success: true, message: `Agent (pid ${bot.pid}) stopped.` });
}));

// ─── GET /status/:userId ────────────────────────────────────────────────────
app.get('/status/:userId', (req, res) => {
    const { userId } = req.params;
    const bot = stmt.getBot.get(userId);
    if (!bot) return res.status(404).json({ error: 'No bot found' });

    let alive = false;
    try { process.kill(bot.pid, 0); alive = true; } catch (_) { /* not running */ }

    // Auto-detect crashed bots
    if (bot.status === 'running' && !alive) {
        stmt.updateStatus.run('crashed', userId);
        bot.status = 'crashed';
    }

    return res.json({
        userId: bot.user_id,
        pid: bot.pid,
        model: bot.model,
        status: bot.status,
        creditLimit: bot.credit_limit,
        createdAt: bot.created_at,
        alive,
    });
});

// ─── GET /health ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    // Quick DB check
    let dbOk = false;
    let runningBots = 0;
    try {
        const row = stmt.countRunning.get();
        runningBots = row.count;
        dbOk = true;
    } catch (_) { /* DB inaccessible */ }

    const status = dbOk ? 'ok' : 'degraded';
    const code = dbOk ? 200 : 503;

    return res.status(code).json({
        status,
        service: 'LiveClaw Orchestrator',
        version: '1.0.0',
        env: config.nodeEnv,
        runningBots,
        ts: new Date().toISOString(),
    });
});

// ─── Global Error Handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
    const status = err.statusCode || 500;
    console.error(`[${req.requestId || '-'}] Error ${status}:`, err.message);

    res.status(status).json({
        error: isProd ? 'Internal server error' : err.message,
    });
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
let server;

function gracefulShutdown(signal) {
    console.log(`\n[shutdown] Received ${signal}. Cleaning up...`);

    // 1. Stop accepting new connections
    if (server) {
        server.close(() => console.log('[shutdown] HTTP server closed.'));
    }

    // 2. SIGTERM all running bot processes
    try {
        const bots = stmt.runningBots.all();
        for (const bot of bots) {
            try {
                process.kill(bot.pid, 'SIGTERM');
                console.log(`[shutdown] Sent SIGTERM to picobot pid=${bot.pid} (user=${bot.user_id})`);
            } catch (_) { /* already dead */ }
            stmt.updateStatus.run('stopped', bot.user_id);
        }
    } catch (_) { /* DB may already be closed */ }

    // 3. Close SQLite
    try {
        db.close();
        console.log('[shutdown] SQLite closed.');
    } catch (_) { /* noop */ }

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────────────────────────
server = app.listen(config.port, () => {
    console.log(`\n🦀 LiveClaw Orchestrator v1.0.0`);
    console.log(`   Environment: ${config.nodeEnv}`);
    console.log(`   Listening:   http://localhost:${config.port}`);
    console.log(`   Endpoints:`);
    console.log(`     POST /deploy-bot`);
    console.log(`     POST /stop-bot`);
    console.log(`     GET  /status/:userId`);
    console.log(`     GET  /health`);
    console.log(`     POST /verify-turnstile`);
    console.log(`     GET  /webhook/applixir-reward`);
    console.log(`     POST /webhook/telegram-stars\n`);
});
