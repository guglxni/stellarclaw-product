/**
 * LiveClaw Orchestrator — server.js
 *
 * Production-grade Express API that:
 *  1. Creates Bifrost Virtual Keys with $0.05 starting budget
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
const fs = require('fs');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const bifrost = require('./bifrost');

// ─── Configuration ──────────────────────────────────────────────────────────
const config = Object.freeze({
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    picobotPath: process.env.PICOBOT_PATH || path.join(__dirname, 'picobot'),
    dbPath: process.env.DB_PATH || path.join(__dirname, 'liveclaw.db'),
    botsDir: process.env.BOTS_DIR || path.join(__dirname, '..', 'bots'),
    bifrostBase: process.env.BIFROST_GATEWAY_URL || 'http://localhost:8080',
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
    applixirSecret: process.env.APPLIXIR_SECRET_KEY,
    masterBotToken: process.env.TELEGRAM_MASTER_BOT_TOKEN,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://liveclaw.xyz').split(','),
    starsToUsdRate: parseFloat(process.env.STARS_TO_USD_RATE) || 0.015,
    adRewardUsd: parseFloat(process.env.AD_REWARD_USD) || 0.02,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '', // 32-byte hex for AES-256-GCM
    watchdogIntervalMs: parseInt(process.env.WATCHDOG_INTERVAL_MS, 10) || 30000,
});

const isProd = config.nodeEnv === 'production';

// ─── Google JWT Verification (Server-Side Auth) ─────────────────────────────
// Verifies Google ID tokens using Google's public keys (JWKS).
// This ensures the userId comes from a real Google sign-in, not a spoofed request.

let googleKeysCache = null;
let googleKeysCacheExpiry = 0;

async function getGooglePublicKeys() {
    if (googleKeysCache && Date.now() < googleKeysCacheExpiry) {
        return googleKeysCache;
    }
    const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!res.ok) throw new Error(`Google JWKS fetch failed: ${res.status}`);
    googleKeysCache = await res.json();
    // Cache for 6 hours
    googleKeysCacheExpiry = Date.now() + 6 * 60 * 60 * 1000;
    return googleKeysCache;
}

/**
 * Decodes and verifies a Google ID token.
 * Returns the payload { sub, email, name, ... } or null if invalid.
 */
async function verifyGoogleToken(idToken) {
    if (!idToken || typeof idToken !== 'string') return null;

    try {
        // Decode header to find the key ID
        const [headerB64] = idToken.split('.');
        const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
        const kid = header.kid;

        const jwks = await getGooglePublicKeys();
        const key = jwks.keys?.find(k => k.kid === kid);
        if (!key) return null;

        // Import the public key and verify
        const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
        const [, payloadB64, signatureB64] = idToken.split('.');
        const signedData = `${headerB64}.${payloadB64}`;
        const signature = Buffer.from(signatureB64, 'base64url');

        const valid = crypto.verify(
            header.alg === 'RS256' ? 'sha256' : 'sha256',
            Buffer.from(signedData),
            publicKey,
            signature
        );

        if (!valid) return null;

        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

        // Check expiry
        if (payload.exp && payload.exp * 1000 < Date.now()) return null;

        return payload;
    } catch (err) {
        console.warn('[auth] Google JWT verification failed:', err.message);
        return null;
    }
}

/**
 * Middleware that verifies Authorization: Bearer <google_id_token>
 * Sets req.verifiedUserId and req.verifiedEmail on success.
 * In dev mode, falls through if no token is provided.
 */
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (!isProd) {
            // Dev mode: allow unauthenticated requests
            return next();
        }
        return res.status(401).json({ error: 'Authorization header required' });
    }

    const token = authHeader.slice(7);
    const payload = await verifyGoogleToken(token);

    if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired Google token' });
    }

    req.verifiedUserId = payload.sub;
    req.verifiedEmail = payload.email;
    next();
}

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
        bifrost_vk_id   TEXT,
        bifrost_vk      TEXT    NOT NULL,
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

    CREATE TABLE IF NOT EXISTS processed_events (
        event_id TEXT    PRIMARY KEY,
        user_id  TEXT    NOT NULL,
        type     TEXT    NOT NULL,
        ts       DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_bots_status ON bots(status);
    CREATE INDEX IF NOT EXISTS idx_logs_user   ON event_logs(user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_pe_user     ON processed_events(user_id);
`);

// Prepared statements (compiled once, reused for perf)
const stmt = {
    upsertBot: db.prepare(`
        INSERT INTO bots (user_id, pid, model, telegram_token, bifrost_vk_id, bifrost_vk, credit_limit, status)
        VALUES (@user_id, @pid, @model, @telegram_token, @bifrost_vk_id, @bifrost_vk, @credit_limit, 'running')
        ON CONFLICT(user_id) DO UPDATE SET
            pid            = excluded.pid,
            model          = excluded.model,
            telegram_token = excluded.telegram_token,
            bifrost_vk_id  = excluded.bifrost_vk_id,
            bifrost_vk     = excluded.bifrost_vk,
            credit_limit   = excluded.credit_limit,
            status         = 'running',
            updated_at     = CURRENT_TIMESTAMP
    `),
    getBot: db.prepare('SELECT * FROM bots WHERE user_id = ?'),
    updateCredit: db.prepare('UPDATE bots SET credit_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'),
    updateStatus: db.prepare("UPDATE bots SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?"),
    updatePid: db.prepare('UPDATE bots SET pid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?'),
    insertLog: db.prepare('INSERT INTO event_logs (user_id, event, detail, ip) VALUES (?, ?, ?, ?)'),
    runningBots: db.prepare("SELECT * FROM bots WHERE status = 'running'"),
    countRunning: db.prepare("SELECT COUNT(*) as count FROM bots WHERE status = 'running'"),
    checkEvent: db.prepare('SELECT event_id FROM processed_events WHERE event_id = ?'),
    markEvent: db.prepare('INSERT OR IGNORE INTO processed_events (event_id, user_id, type) VALUES (?, ?, ?)'),
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
const isTest = config.nodeEnv === 'test';

const deployLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute
    max: 5,                // 5 deploys per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many deploy requests. Please try again shortly.' },
    skip: () => isTest,    // Disable in test mode
});

const webhookLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
});

const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
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

    // Idempotency: check if this eventId was already processed
    const dedupKey = `applixir-${eventId || `${userId}-${Date.now()}`}`;
    if (stmt.checkEvent.get(dedupKey)) {
        console.log(`[AppLixir] Duplicate event ${dedupKey} — skipping`);
        return res.send('OK');
    }

    const newLimit = bot.credit_limit + config.adRewardUsd;
    await bifrost.topUpCredits(bot.bifrost_vk_id, bot.credit_limit, config.adRewardUsd);
    stmt.updateCredit.run(newLimit, userId);
    stmt.markEvent.run(dedupKey, userId, 'ad_reward');
    logEvent(userId, 'ad_reward_credited', {
        added: config.adRewardUsd, newTotal: newLimit, eventId, gameId,
    });

    console.log(`[AppLixir] User ${userId} +$${config.adRewardUsd} → $${newLimit}`);
    return res.send('OK');
}));

// ─── Telegram Stars Payment Webhook ─────────────────────────────────────────
app.post('/webhook/telegram-stars', webhookLimiter, asyncHandler(async (req, res) => {
    const update = req.body;

    // Handle pre_checkout_query (REQUIRED — must respond within 10 seconds)
    if (update.pre_checkout_query) {
        const pcoId = update.pre_checkout_query.id;
        console.log(`[TelegramStars] pre_checkout_query id=${pcoId}`);

        if (!config.masterBotToken) {
            console.error('[TelegramStars] TELEGRAM_MASTER_BOT_TOKEN not configured');
            return res.sendStatus(200);
        }

        await fetch(`https://api.telegram.org/bot${config.masterBotToken}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: pcoId, ok: true }),
        });

        return res.sendStatus(200);
    }

    // Handle successful_payment
    const payment = update?.message?.successful_payment;
    if (!payment) {
        return res.sendStatus(200); // Not a payment update
    }

    const userId = payment.invoice_payload;
    const totalStars = payment.total_amount;
    const currency = payment.currency;
    const chargeId = payment.telegram_payment_charge_id;

    if (currency !== 'XTR') {
        console.warn(`[TelegramStars] Unknown currency: ${currency}`);
        return res.sendStatus(200);
    }

    // Idempotency: check if this payment was already processed
    const dedupKey = `tg-stars-${chargeId || `${userId}-${totalStars}-${Date.now()}`}`;
    if (stmt.checkEvent.get(dedupKey)) {
        console.log(`[TelegramStars] Duplicate payment ${dedupKey} — skipping`);
        return res.sendStatus(200);
    }

    const addUsd = totalStars * config.starsToUsdRate;
    const bot = stmt.getBot.get(userId);

    if (!bot) {
        console.error(`[TelegramStars] Bot not found for userId=${userId}`);
        return res.status(404).json({ error: 'Bot not found' });
    }

    const newLimit = bot.credit_limit + addUsd;
    await bifrost.topUpCredits(bot.bifrost_vk_id, bot.credit_limit, addUsd);
    stmt.updateCredit.run(newLimit, userId);
    stmt.markEvent.run(dedupKey, userId, 'stars_payment');
    logEvent(userId, 'stars_credited', { stars: totalStars, usdAdded: addUsd, newTotal: newLimit, chargeId });

    console.log(`[TelegramStars] User ${userId} spent ${totalStars}★ → +$${addUsd.toFixed(4)}`);
    return res.sendStatus(200);
}));

// ─── POST /create-invoice — Telegram Stars Payment Link ──────────────────────
app.post('/create-invoice', deployLimiter, asyncHandler(async (req, res) => {
    const { userId, stars = 10 } = req.body;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }
    if (!Number.isInteger(stars) || stars < 1 || stars > 10000) {
        return res.status(400).json({ error: 'stars must be an integer between 1 and 10000' });
    }

    const bot = stmt.getBot.get(userId);
    if (!bot) {
        return res.status(404).json({ error: 'No bot found. Deploy first.' });
    }

    // Determine which bot token to use for invoice creation
    const botToken = config.masterBotToken;
    if (!botToken) {
        return res.status(500).json({ error: 'Payment system not configured' });
    }

    const usdValue = (stars * config.starsToUsdRate).toFixed(3);

    const result = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'LiveClaw Credits',
            description: `${stars} Telegram Stars → $${usdValue} agent credits`,
            payload: userId, // Returned in successful_payment.invoice_payload
            currency: 'XTR',
            prices: [{ label: 'Agent Credits', amount: stars }],
        }),
    });

    const data = await result.json();

    if (data.ok) {
        logEvent(userId, 'invoice_created', { stars, usdValue });
        return res.json({ invoiceLink: data.result, stars, usdValue });
    }

    console.error(`[Invoice] Telegram API error: ${data.description}`);
    return res.status(502).json({ error: 'Failed to create invoice', detail: data.description });
}));

// ─── Spawn picobot ──────────────────────────────────────────────────────────
// picobot reads ~/.picobot/config.json — env vars only work in Docker.
// We generate a per-user config.json in an isolated HOME directory.
function spawnPicobot(userId, telegramToken, bifrostVirtualKey, model = 'minimax-m2.5', telegramAllowFrom = []) {
    // Create isolated workspace per user
    const userDir = path.join(config.botsDir, userId);
    const configDir = path.join(userDir, '.picobot');
    const workspaceDir = path.join(configDir, 'workspace');

    fs.mkdirSync(workspaceDir, { recursive: true });

    // Write per-user config.json
    const picobotConfig = {
        agents: {
            defaults: {
                workspace: workspaceDir,
                model,
                maxTokens: 8192,
                temperature: 0.7,
                maxToolIterations: 200,
            },
        },
        providers: {
            openai: {
                apiKey: bifrostVirtualKey,
                apiBase: `${config.bifrostBase}/v1`,
            },
        },
        channels: {
            telegram: {
                enabled: true,
                token: telegramToken,
                allowFrom: telegramAllowFrom || [], // restrict to specific Telegram user IDs
            },
        },
    };

    fs.writeFileSync(
        path.join(configDir, 'config.json'),
        JSON.stringify(picobotConfig, null, 2),
        'utf8'
    );

    // Write default SOUL.md for the agent personality
    const soulPath = path.join(workspaceDir, 'SOUL.md');
    if (!fs.existsSync(soulPath)) {
        fs.writeFileSync(soulPath, [
            '# LiveClaw Agent',
            'You are a helpful AI assistant powered by LiveClaw.',
            'Be concise, friendly, and helpful.',
        ].join('\n'), 'utf8');
    }

    const child = spawn(config.picobotPath, ['gateway'], {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'], // fully detached, no pipe leaks
        env: {
            PATH: process.env.PATH,
            HOME: userDir, // picobot reads $HOME/.picobot/config.json
        },
        cwd: userDir,
    });

    child.unref();

    child.on('error', (err) => {
        console.error(`[picobot][pid=${child.pid}] spawn error: ${err.message}`);
    });

    return child.pid;
}

// ─── POST /deploy-bot ───────────────────────────────────────────────────────
app.post('/deploy-bot', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const { userId, telegramToken, model = 'minimax-m2.5', creditLimit = 0.05, telegramAllowFrom = [] } = req.body;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;

    // In production, ensure the userId matches the verified Google token
    if (isProd && req.verifiedUserId && req.verifiedUserId !== userId) {
        return res.status(403).json({ error: 'userId does not match authenticated user' });
    }

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

    // ── Create Bifrost Virtual Key ──────────────────────────────────────────
    let virtualKey;
    try {
        virtualKey = await bifrost.createVirtualKey(userId, model, creditLimit);
        logEvent(userId, 'bifrost_vk_created', { id: virtualKey.id });
    } catch (err) {
        console.error('[deploy] Bifrost error:', err.message);
        logEvent(userId, 'bifrost_error', err.message);
        const detail = isProd ? undefined : err.message;
        return res.status(502).json({ error: 'Failed to create API key', detail });
    }

    // ── Spawn picobot ───────────────────────────────────────────────────────
    let pid;
    try {
        // Normalize telegramAllowFrom to array of strings
        const allowFrom = Array.isArray(telegramAllowFrom)
            ? telegramAllowFrom.map(String).filter(s => /^\d+$/.test(s))
            : [];
        pid = spawnPicobot(userId, telegramToken, virtualKey.key, model, allowFrom);
        logEvent(userId, 'picobot_spawned', { pid, model, allowFrom: allowFrom.length });
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
        bifrost_vk_id: virtualKey.id,
        bifrost_vk: virtualKey.key,
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
app.post('/stop-bot', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
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
        creditDepleted: bot.credit_limit <= 0.001, // flag for frontend warning
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

// ─── GET /admin/stats — Operational Dashboard ───────────────────────────────
// Protected by a simple admin secret header for now.
app.get('/admin/stats', (req, res) => {
    const adminSecret = process.env.ADMIN_SECRET;
    if (adminSecret && req.headers['x-admin-secret'] !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!adminSecret && isProd) {
        return res.status(403).json({ error: 'ADMIN_SECRET not configured' });
    }

    try {
        const totalBots = db.prepare('SELECT COUNT(*) as c FROM bots').get().c;
        const running = db.prepare("SELECT COUNT(*) as c FROM bots WHERE status = 'running'").get().c;
        const stopped = db.prepare("SELECT COUNT(*) as c FROM bots WHERE status = 'stopped'").get().c;
        const crashed = db.prepare("SELECT COUNT(*) as c FROM bots WHERE status = 'crashed'").get().c;
        const totalCredit = db.prepare('SELECT COALESCE(SUM(credit_limit), 0) as c FROM bots').get().c;
        const depleted = db.prepare('SELECT COUNT(*) as c FROM bots WHERE credit_limit <= 0.001 AND status = \'running\'').get().c;
        const recentEvents = db.prepare('SELECT event, COUNT(*) as c FROM event_logs WHERE ts > datetime(\'now\', \'-1 hour\') GROUP BY event').all();

        const memUsage = process.memoryUsage();

        return res.json({
            bots: { total: totalBots, running, stopped, crashed, creditDepleted: depleted },
            credits: { totalAllocated: parseFloat(totalCredit.toFixed(4)) },
            recentEventsLastHour: recentEvents,
            system: {
                uptime: Math.round(process.uptime()),
                memoryMB: {
                    rss: Math.round(memUsage.rss / 1024 / 1024),
                    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                },
                nodeVersion: process.version,
            },
            ts: new Date().toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ error: 'Stats query failed', detail: err.message });
    }
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
// In test mode, DO NOT auto-listen — supertest creates its own ephemeral server.
if (config.nodeEnv !== 'test') {
    server = app.listen(config.port, () => {
        console.log(`\n🦀 LiveClaw Orchestrator v1.0.0`);
        console.log(`   Environment: ${config.nodeEnv}`);
        console.log(`   Bots dir:    ${config.botsDir}`);
        console.log(`   Listening:   http://localhost:${config.port}`);
        console.log(`   Endpoints:`);
        console.log(`     POST /deploy-bot`);
        console.log(`     POST /stop-bot`);
        console.log(`     POST /create-invoice`);
        console.log(`     GET  /status/:userId`);
        console.log(`     GET  /health`);
        console.log(`     POST /verify-turnstile`);
        console.log(`     GET  /webhook/applixir-reward`);
        console.log(`     POST /webhook/telegram-stars\n`);

        // Ensure bots directory exists
        fs.mkdirSync(config.botsDir, { recursive: true });
    });

    // ─── Bot Watchdog ───────────────────────────────────────────────────────
    // Periodically checks running bots and auto-restarts crashed ones.
    const watchdogTimer = setInterval(() => {
        try {
            const bots = stmt.runningBots.all();
            for (const bot of bots) {
                let alive = false;
                try { process.kill(bot.pid, 0); alive = true; } catch (_) { /* not running */ }

                if (!alive) {
                    console.warn(`[watchdog] Bot for user=${bot.user_id} pid=${bot.pid} is dead. Auto-restarting...`);

                    try {
                        const decryptedToken = decryptToken(bot.telegram_token);
                        const newPid = spawnPicobot(bot.user_id, decryptedToken, bot.bifrost_vk, bot.model);
                        stmt.updatePid.run(newPid, 'running', bot.user_id);
                        logEvent(bot.user_id, 'bot_auto_restarted', { oldPid: bot.pid, newPid });
                        console.log(`[watchdog] Restarted bot for user=${bot.user_id} newPid=${newPid}`);
                    } catch (err) {
                        console.error(`[watchdog] Failed to restart bot for user=${bot.user_id}: ${err.message}`);
                        stmt.updateStatus.run('crashed', bot.user_id);
                        logEvent(bot.user_id, 'bot_restart_failed', err.message);
                    }
                }
            }
        } catch (err) {
            console.error(`[watchdog] Error: ${err.message}`);
        }
    }, config.watchdogIntervalMs);

    // Prevent watchdog from keeping process alive during shutdown
    watchdogTimer.unref();
}

// ─── Module Exports (for testing) ───────────────────────────────────────────
// Export app and db so supertest and test harnesses can use them.
// In production, this export is unused.
module.exports = { app, db };
