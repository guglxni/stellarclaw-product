/**
 * LiveClaw Orchestrator — server.js
 *
 * Production-grade Express API that:
 *  1. Creates Bifrost Virtual Keys with plan-based budgets
 *  2. Spawns isolated picobot Go binaries per user
 *  3. Persists process mappings in SQLite
 *  4. Verifies Cloudflare Turnstile CAPTCHA
 *  5. Manages Dodo Payments subscription lifecycle (checkout, portal, webhooks)
 *  6. Gracefully shuts down on SIGTERM/SIGINT
 *
 * Monetisation: Dodo Payments — $12.99/mo standard ($9.99 Early Claw offer w/ EARLYCLAW code) with 1-day trial.
 * MoR model: Dodo handles global taxes, invoicing, and checkout.
 */

'use strict';

require('dotenv').config({ override: false });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createDatabase } = require('./database');
const bifrost = require('./bifrost');
const dodo = require('./dodo');
const { TOTP } = require('otpauth');
const jwt = require('jsonwebtoken');

// ─── Capacity Planning ──────────────────────────────────────────────────────
// Unit Economics (s-2vcpu-2gb DigitalOcean droplet):
//   Total RAM:      2 GB
//   OS + Docker:    ~400 MB (Ubuntu 24 + Bifrost container)
//   Node.js heap:   ~100 MB (orchestrator, PM2 cap = 256 MB)
//   Per picobot:    ~15-25 MB RSS (Go binary, idle ~15 MB, active ~25 MB)
//   Usable for bots: ~1,200 MB → 1200/25 = ~48 concurrent bots (conservative)
//   Safe headroom:   cap at 50 bots → leaves ~200 MB buffer for spikes
//
// Disk (25 GB SSD):
//   OS + Docker images: ~4 GB
//   SQLite DB:          <50 MB even at 500 users
//   Picobot binary:     ~30 MB
//   Per-bot workspace:  ~1-5 MB (config.json + SOUL.md + workspace)
//   Safe for 500+ users
const MAX_CONCURRENT_BOTS = parseInt(process.env.MAX_CONCURRENT_BOTS, 10) || 200;

// ─── Configuration ──────────────────────────────────────────────────────────
const config = Object.freeze({
    port: parseInt(process.env.PORT, 10) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    picobotPath: process.env.PICOBOT_PATH || path.join(__dirname, 'picobot'),
    dbPath: process.env.DB_PATH || path.join(__dirname, 'liveclaw.db'),
    botsDir: process.env.BOTS_DIR || path.join(__dirname, '..', 'bots'),
    bifrostBase: process.env.BIFROST_GATEWAY_URL || 'http://localhost:8080',
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
    masterBotToken: process.env.TELEGRAM_MASTER_BOT_TOKEN,
    allowedOrigins: (process.env.ALLOWED_ORIGINS || 'https://liveclaw.xyz').split(','),
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '', // 32-byte hex for AES-256-GCM
    watchdogIntervalMs: parseInt(process.env.WATCHDOG_INTERVAL_MS, 10) || 30000,
    // Dodo Payments — unified subscription (see CREDENTIALS.md §3)
    dodoApiKey: process.env.DODO_API_KEY || '',
    dodoWebhookSecret: process.env.DODO_WEBHOOK_SECRET || '',
    // MCP — global servers injected into every picobot instance
    // JSON string of { "serverName": { url/command config } }
    mcpServersConfig: process.env.MCP_SERVERS_CONFIG || '',
    // Admin TOTP + JWT (see scripts/setup-totp.js)
    adminTotpSecret: process.env.ADMIN_TOTP_SECRET || '',
    adminJwtSecret: process.env.ADMIN_JWT_SECRET || '',
});

const isProd = config.nodeEnv === 'production';

// ─── Startup Environment Validation ────────────────────────────────────────
// Fail fast in production if critical secrets are missing or still set to
// placeholder values. Prevents accidentally running with insecure defaults.
const REQUIRED_IN_PROD = [
    ['TOKEN_ENCRYPTION_KEY',      config.encryptionKey,    64, 'hex'],
    ['ADMIN_SECRET',              process.env.ADMIN_SECRET, null, null],
    ['ADMIN_TOTP_SECRET',         config.adminTotpSecret,  null, null],
    ['ADMIN_JWT_SECRET',          config.adminJwtSecret,   null, null],
    ['TURNSTILE_SECRET_KEY',      config.turnstileSecret,  null, null],
    // Dodo Payments — required for subscription billing
    ['DODO_API_KEY',           config.dodoApiKey,         null, null],
    ['DODO_WEBHOOK_SECRET',    config.dodoWebhookSecret,  null, null],
];

if (isProd) {
    const missing = [];
    for (const [name, value, expectedLen, encoding] of REQUIRED_IN_PROD) {
        if (!value || value.startsWith('CHANGE_ME') || value.startsWith('your-')) {
            missing.push(`  ✗ ${name} is not set or still a placeholder`);
            continue;
        }
        if (expectedLen && value.length !== expectedLen) {
            missing.push(`  ✗ ${name} must be ${expectedLen} ${encoding} chars (got ${value.length})`);
        }
    }
    if (missing.length > 0) {
        console.error('\n[startup] FATAL — missing or invalid environment variables in production:');
        missing.forEach(m => console.error(m));
        console.error('\nFill in /opt/liveclaw/backend/.env and run: pm2 reload liveclaw-orchestrator --update-env\n');
        process.exit(1);
    }
    console.log('[startup] All required environment variables validated.');
}

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

        // Validate audience claim — reject tokens issued for a different OAuth client
        const expectedAud = process.env.GOOGLE_CLIENT_ID;
        if (expectedAud && payload.aud !== expectedAud) return null;

        // Validate issuer
        if (payload.iss !== 'accounts.google.com' && payload.iss !== 'https://accounts.google.com') return null;

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
let db, stmt, stmtSubs, stmtBeta;

async function initDatabase() {
db = createDatabase({
    databaseUrl: process.env.DATABASE_URL,
    dbPath: config.dbPath,
});

await db.exec(`
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
        telegram_chat_id TEXT,
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

// ── Subscription & Referral Tables ──────────────────────────────────────────
await db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id               TEXT    NOT NULL UNIQUE,
        dodo_customer_id      TEXT    UNIQUE,
        dodo_subscription_id  TEXT    UNIQUE,
        plan                  TEXT    NOT NULL DEFAULT 'standard'
                              CHECK(plan IN ('standard')),
        status                TEXT    NOT NULL DEFAULT 'inactive'
                              CHECK(status IN ('active','past_due','cancelled','inactive','trialing')),
        trial_ends_at         DATETIME,
        current_period_start  DATETIME,
        current_period_end    DATETIME,
        early_bird            INTEGER NOT NULL DEFAULT 0,
        referral_code         TEXT    UNIQUE,
        referred_by           TEXT,
        created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS referrals (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id  TEXT    NOT NULL,
        referee_id   TEXT    NOT NULL,
        code         TEXT    NOT NULL,
        status       TEXT    NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','converted','rewarded')),
        rewarded_at  DATETIME,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id           TEXT    NOT NULL,
        dodo_payment_id   TEXT    UNIQUE,
        amount_cents      INTEGER NOT NULL,
        currency          TEXT    NOT NULL DEFAULT 'usd',
        plan              TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'paid',
        created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS beta_codes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        code         TEXT    NOT NULL UNIQUE,
        redeemed_by  TEXT    UNIQUE,
        redeemed_at  DATETIME,
        redeemed_ip  TEXT,
        user_agent   TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_subs_user     ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subs_dodo     ON subscriptions(dodo_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_beta_code     ON beta_codes(code);
`);

// Migrate existing tables — add new columns if they don't exist yet
try { await db.exec("ALTER TABLE bots ADD COLUMN telegram_chat_id TEXT"); } catch (_) { /* already exists */ }
try { await db.exec("ALTER TABLE subscriptions ADD COLUMN beta_code_used TEXT"); } catch (_) { /* already exists */ }
try { await db.exec("ALTER TABLE beta_codes ADD COLUMN redeemed_ip TEXT"); } catch (_) { /* already exists */ }
try { await db.exec("ALTER TABLE beta_codes ADD COLUMN user_agent TEXT"); } catch (_) { /* already exists */ }

// Statement functions (async equivalents of prepared statements)
stmt = {
    upsertBot: (params) => db.run(`
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
    `, params),
    getBot: (userId) => db.get('SELECT * FROM bots WHERE user_id = ?', [userId]),
    updateCredit: (creditLimit, userId) => db.run('UPDATE bots SET credit_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [creditLimit, userId]),
    updateStatus: (status, userId) => db.run("UPDATE bots SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?", [status, userId]),
    updatePid: (pid, status, userId) => db.run('UPDATE bots SET pid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [pid, status, userId]),
    insertLog: (userId, event, detail, ip) => db.run('INSERT INTO event_logs (user_id, event, detail, ip) VALUES (?, ?, ?, ?)', [userId, event, detail, ip]),
    runningBots: () => db.all("SELECT * FROM bots WHERE status = 'running'"),
    countRunning: () => db.get("SELECT COUNT(*) as count FROM bots WHERE status = 'running'"),
    checkEvent: (eventId) => db.get('SELECT event_id FROM processed_events WHERE event_id = ?', [eventId]),
    markEvent: (eventId, userId, type) => db.run('INSERT OR IGNORE INTO processed_events (event_id, user_id, type) VALUES (?, ?, ?)', [eventId, userId, type]),
    updateChatId: (chatId, userId) => db.run('UPDATE bots SET telegram_chat_id = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [chatId, userId]),
};

// Subscription & referral statement functions
stmtSubs = {
    upsert: (params) => db.run(`
        INSERT INTO subscriptions (user_id, dodo_customer_id, dodo_subscription_id, plan, status, current_period_start, current_period_end)
        VALUES (@user_id, @dodo_customer_id, @dodo_subscription_id, @plan, @status, @current_period_start, @current_period_end)
        ON CONFLICT(user_id) DO UPDATE SET
            dodo_customer_id     = COALESCE(excluded.dodo_customer_id, subscriptions.dodo_customer_id),
            dodo_subscription_id = COALESCE(excluded.dodo_subscription_id, subscriptions.dodo_subscription_id),
            plan                 = excluded.plan,
            status               = excluded.status,
            current_period_start = excluded.current_period_start,
            current_period_end   = excluded.current_period_end,
            updated_at           = CURRENT_TIMESTAMP
    `, params),
    getByUserId: (userId) => db.get('SELECT * FROM subscriptions WHERE user_id = ?', [userId]),
    getByDodoSubId: (subId) => db.get('SELECT * FROM subscriptions WHERE dodo_subscription_id = ?', [subId]),
    getByDodoCustId: (custId) => db.get('SELECT * FROM subscriptions WHERE dodo_customer_id = ?', [custId]),
    updateStatus: (status, userId) => db.run('UPDATE subscriptions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [status, userId]),
    updatePlan: (plan, subId) => db.run('UPDATE subscriptions SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE dodo_subscription_id = ?', [plan, subId]),
    setReferralCode: (code, userId) => db.run('UPDATE subscriptions SET referral_code = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [code, userId]),
    setReferredBy: (code, userId) => db.run('UPDATE subscriptions SET referred_by = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [code, userId]),
    countActive: () => db.get("SELECT COUNT(*) as count FROM subscriptions WHERE status IN ('active','trialing','past_due')"),
    expireTrials: () => db.run(
        "UPDATE subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP " +
        "WHERE status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at < datetime('now')"
    ),
    getExpiredBetaUsers: () => db.all(
        "SELECT user_id FROM subscriptions WHERE status = 'trialing' " +
        "AND trial_ends_at IS NOT NULL AND trial_ends_at < datetime('now')"
    ),
    insertPayment: (userId, payId, amountCents, currency, plan, status) => db.run(
        'INSERT INTO payments (user_id, dodo_payment_id, amount_cents, currency, plan, status) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, payId, amountCents, currency, plan, status]
    ),
    insertReferral: (referrerId, refereeId, code) => db.run(
        "INSERT INTO referrals (referrer_id, referee_id, code, status) VALUES (?, ?, ?, 'pending')",
        [referrerId, refereeId, code]
    ),
    getReferralByCode: (code) => db.get('SELECT * FROM subscriptions WHERE referral_code = ?', [code]),
    setBetaCodeUsed: (code, userId) => db.run('UPDATE subscriptions SET beta_code_used = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?', [code, userId]),
    countConvertedReferrals: (referrerId) => db.get("SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND status = 'converted'", [referrerId]),
    countRewardedReferrals: (referrerId) => db.get("SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ? AND status = 'rewarded'", [referrerId]),
    getPendingReferral: (refereeId) => db.get("SELECT * FROM referrals WHERE referee_id = ? AND status = 'pending' LIMIT 1", [refereeId]),
    updateReferralStatus: (status, rewardValue, id) => db.run(
        "UPDATE referrals SET status = ?, rewarded_at = CASE WHEN ? = 'rewarded' THEN CURRENT_TIMESTAMP ELSE rewarded_at END WHERE id = ?",
        [status, rewardValue, id]
    ),
    countUserBots: (userId) => db.get("SELECT COUNT(*) as count FROM bots WHERE user_id = ? AND status = 'running'", [userId]),
};

// Beta-code statement functions
stmtBeta = {
    insert: (code) => db.run('INSERT OR IGNORE INTO beta_codes (code) VALUES (?)', [code]),
    getByCode: (code) => db.get('SELECT * FROM beta_codes WHERE code = ?', [code]),
    redeem: (userId, ip, ua, code) => db.run(
        'UPDATE beta_codes SET redeemed_by = ?, redeemed_at = CURRENT_TIMESTAMP, redeemed_ip = ?, user_agent = ? '
        + 'WHERE code = ? AND redeemed_by IS NULL',
        [userId, ip, ua, code]
    ),
    listAll: () => db.all('SELECT code, redeemed_by, redeemed_at, redeemed_ip, created_at FROM beta_codes ORDER BY created_at ASC'),
    countTotal: () => db.get('SELECT COUNT(*) as count FROM beta_codes'),
    countUsed: () => db.get('SELECT COUNT(*) as count FROM beta_codes WHERE redeemed_by IS NOT NULL'),
};
} // end initDatabase

function logEvent(userId, event, detail = null, ip = null) {
    stmt.insertLog(userId, event, typeof detail === 'object' ? JSON.stringify(detail) : detail, ip).catch(err => {
        console.error(`[logEvent] Failed: ${err.message}`);
    });
}

// ─── SSRF Guard ─────────────────────────────────────────────────────────────
// Rejects URLs that target loopback, private, or cloud-metadata addresses.
// Used to prevent SSRF via user-supplied MCP server URLs.
function isPrivateUrl(url) {
    try {
        const { hostname } = new URL(url);
        if (/^(localhost|.*\.local|.*\.internal)$/i.test(hostname)) return true;
        const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (ipv4) {
            const [, a, b] = ipv4.map(Number);
            if (a === 10) return true;                         // 10.0.0.0/8
            if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
            if (a === 192 && b === 168) return true;           // 192.168.0.0/16
            if (a === 127) return true;                        // 127.0.0.0/8
            if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (cloud metadata)
            if (a === 0) return true;                          // 0.0.0.0/8
        }
        if (hostname === '::1' || /^fe80:/i.test(hostname)) return true; // IPv6 loopback/link-local
        return false;
    } catch (_) {
        return true; // unparseable URL → block
    }
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

// Trust the first proxy (Nginx / Cloudflare) so req.ip returns the real client IP.
// Essential for rate limiting and geo-logging behind a reverse proxy.
app.set('trust proxy', 1);

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
app.use(helmet());

// CORS — In a two-droplet setup the frontend (liveclaw.xyz) calls the backend
// (api.liveclaw.xyz) cross-origin. credentials: true so cookies/auth headers pass.
app.use(cors({
    origin: isProd ? config.allowedOrigins : '*',
    credentials: true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Admin-Secret'],
}));

// Body parsing with size limits to prevent DoS
app.use(express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
        // Save raw body for webhook signature verification
        if (req.url === '/webhook/dodo') {
            req.rawBody = buf.toString('utf8');
        }
    },
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Request ID middleware for tracing
app.use((req, _res, next) => {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    next();
});

// Request logging
const requestTelemetry = {
    startedAt: Date.now(),
    total: 0,
    errors5xx: 0,
    byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    recent: [],
};
const romUsageCache = new Map(); // userId → { value: MB, ts: ms } — 30s TTL
const vkUsageCache = new Map();  // vkId   → { value: {spentUsd,limitUsd,...}, ts: ms } — 30s TTL

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const ms = Date.now() - start;
        requestTelemetry.total += 1;
        if (res.statusCode >= 500) requestTelemetry.errors5xx += 1;
        if (res.statusCode >= 500) requestTelemetry.byClass['5xx'] += 1;
        else if (res.statusCode >= 400) requestTelemetry.byClass['4xx'] += 1;
        else if (res.statusCode >= 300) requestTelemetry.byClass['3xx'] += 1;
        else requestTelemetry.byClass['2xx'] += 1;

        requestTelemetry.recent.push({
            ts: Date.now(),
            ms,
            method: req.method,
            path: req.path,
            status: res.statusCode,
        });
        if (requestTelemetry.recent.length > 600) {
            requestTelemetry.recent.splice(0, requestTelemetry.recent.length - 600);
        }

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

// Admin login: 7 attempts per 15 min per IP — locks out on 8th attempt
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 7,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
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

// ─── POST /create-checkout-session — Dodo Payments Checkout ─────────────────
app.post('/create-checkout-session', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const { referralCode, promoCode } = req.body;
    const plan = 'standard'; // unified plan
    const userId = req.verifiedUserId || req.body.userId;
    const email = req.verifiedEmail || req.body.email;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    // Check if user already has an active subscription
    const existing = await stmtSubs.getByUserId(userId);
    if (existing && ['active', 'trialing'].includes(existing.status)) {
        return res.status(409).json({
            error: 'You already have an active subscription',
            plan: existing.plan,
            status: existing.status,
        });
    }

    // ── EARLYCLAW promo code validation ─────────────────────────────────────
    // Count only confirmed-paying subscribers so abandoned checkouts never
    // consume a spot. Spots are permanently assigned in the webhook handler
    // once Dodo confirms the subscription is active/trialing.
    let earlyBird = false;
    let discountCode = null;
    if (promoCode && typeof promoCode === 'string' && promoCode.toUpperCase() === 'EARLYCLAW') {
        const usedCount = (await db.get(
            "SELECT COUNT(*) as count FROM subscriptions WHERE early_bird = 1 AND status IN ('active','trialing','past_due')"
        )).count;
        if (usedCount >= 500) {
            return res.status(410).json({
                error: 'Early Claw offer has ended',
                message: 'All 500 Early Claw spots have been claimed.',
            });
        }
        earlyBird = true;
        discountCode = 'EARLYCLAW'; // Dodo applies 23.10% off → ~$9.99/mo
        logEvent(userId, 'promo_code_applied', { code: 'EARLYCLAW', spotsRemaining: 500 - usedCount - 1 });
    }

    // Handle referral code
    if (referralCode && typeof referralCode === 'string') {
        const referrer = await stmtSubs.getReferralByCode(referralCode.toUpperCase());
        if (referrer && referrer.user_id !== userId) {
            // Valid referral — track it
            await stmtSubs.setReferredBy(referralCode.toUpperCase(), userId);
            await stmtSubs.insertReferral(referrer.user_id, userId, referralCode.toUpperCase());
            logEvent(userId, 'referral_applied', { code: referralCode, referrerId: referrer.user_id });
        }
    }

    try {
        const session = await dodo.createCheckoutSession(
            plan, userId, email || `${userId}@liveclaw.xyz`,
            'https://liveclaw.xyz?checkout=success',
            discountCode,
            earlyBird
        );

        // Ensure user has a subscription record (inactive until webhook confirms)
        if (!existing) {
            await stmtSubs.upsert({
                user_id: userId,
                dodo_customer_id: null,
                dodo_subscription_id: null,
                plan,
                status: 'inactive',
                current_period_start: null,
                current_period_end: null,
            });
        }

        // NOTE: early_bird = 1 is NOT set here — it is set in the webhook handler
        // (subscription.active or payment.succeeded) once Dodo confirms payment,
        // so abandoned checkouts never consume a promo spot.

        logEvent(userId, 'checkout_session_created', { plan, sessionId: session.sessionId, earlyBird });

        return res.json({
            checkoutUrl: session.checkoutUrl,
            sessionId: session.sessionId,
            earlyBird,
        });
    } catch (err) {
        console.error('[checkout] Dodo error:', err.message);
        logEvent(userId, 'checkout_error', err.message);
        return res.status(502).json({ error: 'Failed to create checkout session' });
    }
}));

// ─── POST /create-portal-session — Dodo Customer Portal ────────────────────
app.post('/create-portal-session', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const userId = req.verifiedUserId || req.body.userId;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    const sub = await stmtSubs.getByUserId(userId);
    if (!sub || !sub.dodo_customer_id) {
        return res.status(404).json({ error: 'No subscription found. Subscribe first.' });
    }

    try {
        const portal = await dodo.createPortalSession(sub.dodo_customer_id);
        logEvent(userId, 'portal_session_created');
        return res.json({ portalUrl: portal.link });
    } catch (err) {
        console.error('[portal] Dodo error:', err.message);
        return res.status(502).json({ error: 'Failed to create portal session' });
    }
}));

// ─── GET /subscription/:userId — Subscription Status ───────────────────────
app.get('/subscription/:userId', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const { userId } = req.params;

    // In production, ensure user can only check their own subscription
    if (isProd && req.verifiedUserId && req.verifiedUserId !== userId) {
        return res.status(403).json({ error: 'Cannot view another user\'s subscription' });
    }

    const sub = await stmtSubs.getByUserId(userId);
    if (!sub) {
        return res.json({
            hasSubscription: false,
            plan: null,
            status: 'inactive',
        });
    }

    return res.json({
        hasSubscription: true,
        plan: sub.plan,
        status: sub.status,
        currentPeriodEnd: sub.current_period_end,
        earlyBird: !!sub.early_bird,
        referralCode: sub.referral_code,
        dodoCustomerId: sub.dodo_customer_id,
    });
}));

// ─── POST /create-trial-checkout — $0.99 One-Day Trial Checkout ─────────────
// Creates a Dodo one-time payment for the trial product ($0.99).
// On payment.succeeded the webhook activates a 24h trialing subscription.
app.post('/create-trial-checkout', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const userId = req.verifiedUserId || req.body.userId;
    const email = req.verifiedEmail || req.body.email;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    // Block if user already has active/trialing access
    const existing = await stmtSubs.getByUserId(userId);
    if (existing && ['active', 'trialing'].includes(existing.status)) {
        return res.status(409).json({
            error: 'You already have an active subscription',
            status: existing.status,
        });
    }

    // Block if user has already used a trial (trial_ends_at was set at any point)
    const usedTrial = await db.get(
        'SELECT trial_ends_at FROM subscriptions WHERE user_id = ? AND trial_ends_at IS NOT NULL',
        [userId]
    );
    if (usedTrial) {
        return res.status(409).json({ error: 'Trial already used. Please subscribe to continue.' });
    }

    try {
        const session = await dodo.createTrialCheckoutSession(
            userId,
            email || `${userId}@liveclaw.xyz`,
            'https://liveclaw.xyz?checkout=trial-success'
        );
        logEvent(userId, 'trial_checkout_created', { sessionId: session.sessionId });
        return res.json({ checkoutUrl: session.checkoutUrl, sessionId: session.sessionId });
    } catch (err) {
        console.error('[trial-checkout] Dodo error:', err.message);
        return res.status(502).json({ error: 'Failed to create trial checkout session' });
    }
}));

// ─── GET /pricing — Public Pricing ──────────────────────────────────────────
app.get('/pricing', asyncHandler(async (_req, res) => {
    const earlyBirdUsed = (await db.get(
        "SELECT COUNT(*) as count FROM subscriptions WHERE early_bird = 1 AND status IN ('active','trialing','past_due')"
    )).count;

    return res.json({
        plans: {
            standard: {
                id: 'standard',
                name: 'LiveClaw',
                price: 12.99,
                currency: 'usd',
                interval: 'month',
                trialDays: 1,
                bots: 1,
                budget: 5.00,
                channels: ['telegram'],
                features: [
                    '24/7 AI agent on Telegram',
                    '$5.00/mo AI budget (auto-resets)',
                    'Custom personality (SOUL.md)',
                    'Unlimited messages within budget',
                    'Email support',
                ],
            },
            earlyClaw: {
                id: 'standard',
                name: 'LiveClaw — Early Claw',
                price: 9.99,
                currency: 'usd',
                interval: 'month',
                trialDays: 1,
                bots: 1,
                budget: 5.00,
                channels: ['telegram'],
                promoCode: 'EARLYCLAW',
                spotsRemaining: Math.max(0, 500 - earlyBirdUsed),
                features: [
                    '24/7 AI agent on Telegram',
                    '$5.00/mo AI budget (auto-resets)',
                    'Custom personality (SOUL.md)',
                    'Unlimited messages within budget',
                    'Email support',
                    'Locked-in Early Claw pricing',
                ],
            },
        },
    });
}));

// ─── POST /redeem-beta — Redeem a Beta Access Code via Dodo Checkout ────────
// Validates the beta code in our DB, then creates a Dodo trial checkout with
// the code as a 100% discount coupon. Dodo handles billing ($0.99 - 100% = $0.00),
// then fires payment.succeeded → webhook activates 24h trial.
app.post('/redeem-beta', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const { betaCode } = req.body;
    const userId = req.verifiedUserId || req.body.userId;
    const email = req.verifiedEmail || req.body.email;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }
    if (!betaCode || typeof betaCode !== 'string') {
        return res.status(400).json({ error: 'betaCode is required' });
    }

    const code = betaCode.toUpperCase().trim();

    // Validate format: XXXX-XXXX-XXXX (12 alphanumeric chars in 3 groups)
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid beta code format' });
    }

    // Check user doesn't already have an active/trialing subscription
    const existing = await stmtSubs.getByUserId(userId);
    if (existing && ['active', 'trialing'].includes(existing.status)) {
        return res.status(409).json({
            error: 'You already have an active subscription',
            status: existing.status,
        });
    }

    // Validate the beta code exists and is unclaimed in our DB
    const record = await stmtBeta.getByCode(code);
    if (!record) {
        return res.status(404).json({ error: 'Beta code not found' });
    }
    if (record.redeemed_by) {
        return res.status(410).json({ error: 'Beta code has already been used' });
    }

    // Atomically claim the code in our DB (prevents double-use)
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const ua = (req.headers['user-agent'] || '').slice(0, 256);
    const changes = (await stmtBeta.redeem(userId, ip, ua, code)).changes;
    if (changes === 0) {
        return res.status(410).json({ error: 'Beta code has already been used' });
    }

    // Create a Dodo checkout for the trial product with this code as a 100% discount
    try {
        const session = await dodo.createTrialCheckoutSession(
            userId,
            email || `${userId}@liveclaw.xyz`,
            'https://liveclaw.xyz?checkout=trial-success',
            code  // beta code = Dodo discount code
        );

        // Track that this user used this beta code
        await db.run(
            'UPDATE subscriptions SET beta_code_used = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
            [code, userId]
        );

        logEvent(userId, 'beta_code_redeemed', { code, sessionId: session.sessionId });

        return res.json({
            success: true,
            checkoutUrl: session.checkoutUrl,
            sessionId: session.sessionId,
            message: 'Complete checkout to activate your 24-hour free trial.',
        });
    } catch (err) {
        console.error('[redeem-beta] Dodo checkout error:', err.message);
        // Roll back the DB claim so user can retry
        await db.run(
            'UPDATE beta_codes SET redeemed_by = NULL, redeemed_at = NULL, redeemed_ip = NULL, user_agent = NULL WHERE code = ? AND redeemed_by = ?',
            [code, userId]
        );
        return res.status(502).json({ error: 'Failed to create trial checkout session' });
    }
}));

// ─── POST /referral/generate — Generate Referral Code ───────────────────────
app.post('/referral/generate', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const userId = req.verifiedUserId || req.body.userId;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    const sub = await stmtSubs.getByUserId(userId);
    if (!sub) {
        return res.status(404).json({ error: 'No subscription found. Subscribe first.' });
    }

    // Return existing code if already generated
    if (sub.referral_code) {
        return res.json({ referralCode: sub.referral_code });
    }

    // Generate unique code: LC-XXXXX (no I/O/0/1 confusion)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    let attempts = 0;
    do {
        code = 'LC-';
        for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
        attempts++;
    } while (await stmtSubs.getReferralByCode(code) && attempts < 10);

    if (attempts >= 10) {
        return res.status(500).json({ error: 'Failed to generate unique code' });
    }

    await stmtSubs.setReferralCode(code, userId);
    logEvent(userId, 'referral_code_generated', { code });

    return res.json({ referralCode: code });
}));

// ─── POST /referral/apply — Apply Referral Code ────────────────────────────
app.post('/referral/apply', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const userId = req.verifiedUserId || req.body.userId;
    const { referralCode } = req.body;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }
    if (!referralCode || typeof referralCode !== 'string') {
        return res.status(400).json({ error: 'referralCode is required' });
    }

    const code = referralCode.toUpperCase().trim();

    // Validate code format
    if (!/^LC-[A-Z2-9]{5}$/.test(code)) {
        return res.status(400).json({ error: 'Invalid referral code format' });
    }

    // Find referrer
    const referrer = await stmtSubs.getReferralByCode(code);
    if (!referrer) {
        return res.status(404).json({ error: 'Referral code not found' });
    }

    // Can't refer yourself
    if (referrer.user_id === userId) {
        return res.status(400).json({ error: 'Cannot use your own referral code' });
    }

    // Ensure user hasn't already been referred
    const userSub = await stmtSubs.getByUserId(userId);
    if (userSub && userSub.referred_by) {
        return res.status(409).json({ error: 'You have already used a referral code' });
    }

    // Ensure user has a subscription record
    if (!userSub) {
        await stmtSubs.upsert({
            user_id: userId,
            dodo_customer_id: null,
            dodo_subscription_id: null,
            plan: 'standard',
            status: 'inactive',
            current_period_start: null,
            current_period_end: null,
        });
    }

    await stmtSubs.setReferredBy(code, userId);
    await stmtSubs.insertReferral(referrer.user_id, userId, code);
    logEvent(userId, 'referral_applied', { code, referrerId: referrer.user_id });

    return res.json({ success: true, message: 'Referral code applied successfully' });
}));

// ─── POST /webhook/dodo — Dodo Payments Lifecycle Webhook ───────────────────
// Receives webhook events from Dodo Payments for subscription and payment lifecycle.
// Events: subscription.active, subscription.on_hold, subscription.cancelled,
//         subscription.plan_changed, subscription.renewed, payment.succeeded, payment.failed
app.post('/webhook/dodo', webhookLimiter, asyncHandler(async (req, res) => {
    let event;
    try {
        // rawBody saved by express.json verify callback
        const rawBody = req.rawBody;
        if (!rawBody) {
            console.error('[webhook/dodo] Missing raw body — cannot verify signature');
            return res.status(400).json({ error: 'Missing raw body' });
        }
        event = dodo.verifyWebhookEvent(rawBody, req.headers);
    } catch (err) {
        console.error('[webhook/dodo] Signature verification failed:', err.message);
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const eventType = event.type;
    const data = event.data;
    console.log(`[webhook/dodo] Event: ${eventType}`);

    // ── Idempotency: deduplicate by webhook-id header ───────────────────
    const webhookId = req.headers['webhook-id'];
    if (webhookId) {
        const dedupKey = `dodo-${webhookId}`;
        if (await stmt.checkEvent(dedupKey)) {
            console.log(`[webhook/dodo] Duplicate webhook ${dedupKey} — skipping`);
            return res.json({ received: true });
        }
        // Mark as processed immediately to prevent concurrent duplicates
        await stmt.markEvent(dedupKey, data?.metadata?.liveclaw_user_id || 'system', 'dodo_webhook');
    }

    // Extract userId from subscription metadata
    const userId = data?.metadata?.liveclaw_user_id;
    const subId = data?.subscription_id;
    const customerId = data?.customer?.customer_id;

    switch (eventType) {
        case 'subscription.active':
        case 'subscription.renewed': {
            if (!userId && !subId) break;
            const target = userId || (subId ? (await stmtSubs.getByDodoSubId(subId))?.user_id : null);
            if (target) {
                await stmtSubs.upsert({
                    user_id: target,
                    dodo_customer_id: customerId || null,
                    dodo_subscription_id: subId || null,
                    plan: 'standard',
                    status: 'active',
                    current_period_start: data.previous_billing_date || new Date().toISOString(),
                    current_period_end: data.next_billing_date || null,
                });

                // Assign early bird spot now that payment is confirmed.
                // Re-check the cap here (better-sqlite3 is sync so this is
                // serialised — no race between concurrent webhook deliveries).
                if (data?.metadata?.early_bird === '1') {
                    // Atomic assignment: only update if the cap hasn't been reached yet.
                    // The correlated sub-SELECT runs within the UPDATE statement, so under
                    // PostgreSQL row-locking semantics the second concurrent UPDATE on the
                    // same user_id row will re-evaluate after the first commits.
                    // For different-user concurrent webhooks, the sub-SELECT provides a
                    // best-effort guard; true atomicity across different rows requires a
                    // serializable transaction but the 500-spot window makes collisions
                    // vanishingly rare in practice.
                    const result = await db.run(
                        `UPDATE subscriptions SET early_bird = 1, updated_at = CURRENT_TIMESTAMP
                         WHERE user_id = ? AND early_bird = 0
                         AND (SELECT COUNT(*) FROM subscriptions
                              WHERE early_bird = 1 AND status IN ('active','trialing','past_due')) < 500`,
                        [target]
                    );
                    if (result.changes > 0) {
                        logEvent(target, 'early_claw_spot_assigned', {});
                    } else {
                        logEvent(target, 'early_claw_cap_exceeded_at_webhook', {});
                    }
                }

                logEvent(target, 'subscription_activated', { subId, eventType });
            }
            break;
        }

        case 'subscription.on_hold':
        case 'subscription.failed': {
            const target = userId || (subId ? (await stmtSubs.getByDodoSubId(subId))?.user_id : null);
            if (target) {
                await stmtSubs.updateStatus('past_due', target);
                logEvent(target, 'subscription_past_due', { subId, eventType });
            }
            break;
        }

        case 'subscription.cancelled':
        case 'subscription.expired': {
            const target = userId || (subId ? (await stmtSubs.getByDodoSubId(subId))?.user_id : null);
            if (target) {
                await stmtSubs.updateStatus('cancelled', target);
                logEvent(target, 'subscription_cancelled', { subId, eventType });

                // Stop any running bots for this user
                const bot = await stmt.getBot(target);
                if (bot && bot.status === 'running') {
                    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
                    if (bot.bifrost_vk_id) {
                        bifrost.deactivateVirtualKey(bot.bifrost_vk_id).catch(err => {
                            console.error(`[webhook] Failed to deactivate VK ${bot.bifrost_vk_id}: ${err.message}`);
                        });
                    }
                    await stmt.updateStatus('stopped', target);
                    logEvent(target, 'bot_stopped_subscription_cancelled', { pid: bot.pid });
                }
            }
            break;
        }

        case 'subscription.updated': {
            const target = userId || (subId ? (await stmtSubs.getByDodoSubId(subId))?.user_id : null);
            if (target) {
                // Sync period dates if provided
                if (data.next_billing_date) {
                    await stmtSubs.upsert({
                        user_id: target,
                        dodo_customer_id: customerId || null,
                        dodo_subscription_id: subId || null,
                        plan: 'standard',
                        status: 'active',
                        current_period_start: data.previous_billing_date || null,
                        current_period_end: data.next_billing_date,
                    });
                }
                logEvent(target, 'subscription_updated', { subId });
            }
            break;
        }

        case 'subscription.plan_changed': {
            const target = userId || (subId ? (await stmtSubs.getByDodoSubId(subId))?.user_id : null);
            if (target) {
                // Unified plan — log the event but plan stays 'standard'
                logEvent(target, 'subscription_plan_changed', { subId });
            }
            break;
        }

        case 'payment.succeeded': {
            // Log successful payment
            const paymentUserId = data?.metadata?.liveclaw_user_id;
            if (paymentUserId) {
                const paymentId = data?.payment_id || `dodo-${Date.now()}`;
                const amountCents = data?.total_amount || 0;
                const currency = data?.currency || 'usd';
                const plan = data?.metadata?.plan || 'standard';
                try {
                    await stmtSubs.insertPayment(paymentUserId, paymentId, amountCents, currency, plan, 'paid');
                } catch (_) { /* duplicate payment_id — idempotent */ }
                logEvent(paymentUserId, 'payment_succeeded', { paymentId, amountCents, currency, plan });

                // ── Activate 24-hour trial if this was a trial product payment ──
                if (plan === 'trial') {
                    const trialEndsAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
                    await stmtSubs.upsert({
                        user_id: paymentUserId,
                        dodo_customer_id: data?.customer?.customer_id || null,
                        dodo_subscription_id: null,
                        plan: 'standard',
                        status: 'trialing',
                        current_period_start: new Date().toISOString(),
                        current_period_end: trialEndsAt,
                    });
                    await db.run(
                        'UPDATE subscriptions SET trial_ends_at = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                        [trialEndsAt, paymentUserId]
                    );

                    // Resolve which beta code (if any) was claimed by this user and record it
                    const betaCodeRecord = await db.get(
                        'SELECT code FROM beta_codes WHERE redeemed_by = ?',
                        [paymentUserId]
                    );
                    if (betaCodeRecord) {
                        await stmtSubs.setBetaCodeUsed(betaCodeRecord.code, paymentUserId);
                        logEvent(paymentUserId, 'trial_activated', { trialEndsAt, paymentId, betaCode: betaCodeRecord.code });
                    } else {
                        logEvent(paymentUserId, 'trial_activated', { trialEndsAt, paymentId });
                    }
                    break;
                }

                // Check if referral should be converted (subscription payments only)
                const pendingRef = await stmtSubs.getPendingReferral(paymentUserId);
                if (pendingRef) {
                    await stmtSubs.updateReferralStatus('converted', 'converted', pendingRef.id);
                    logEvent(pendingRef.referrer_id, 'referral_converted', { refereeId: paymentUserId });

                    // Check if referrer qualifies for reward (3 converted referrals)
                    const converted = await stmtSubs.countConvertedReferrals(pendingRef.referrer_id);
                    const rewarded = await stmtSubs.countRewardedReferrals(pendingRef.referrer_id);
                    if (converted.count >= 3 && rewarded.count < 4) {
                        logEvent(pendingRef.referrer_id, 'referral_reward_eligible', {
                            convertedCount: converted.count,
                            rewardedCount: rewarded.count,
                        });
                    }
                }
            }
            break;
        }

        case 'payment.failed': {
            const paymentUserId = data?.metadata?.liveclaw_user_id;
            if (paymentUserId) {
                logEvent(paymentUserId, 'payment_failed', { paymentId: data?.payment_id });
            }
            break;
        }

        default:
            console.log(`[webhook/dodo] Unhandled event type: ${eventType}`);
    }

    return res.json({ received: true });
}));

// ─── POST /register-chat — Register Telegram Chat ID for Push Notifications ──
// Called by picobot processes on the same server. Requires ADMIN_SECRET for
// authentication (picobot-facing internal API).
app.post('/register-chat', webhookLimiter, adminAuth, asyncHandler(async (req, res) => {
    const { userId, chatId } = req.body;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }
    if (!chatId || (typeof chatId !== 'string' && typeof chatId !== 'number')) {
        return res.status(400).json({ error: 'chatId is required' });
    }

    const bot = await stmt.getBot(userId);
    if (!bot) {
        return res.status(404).json({ error: 'No bot found for this user' });
    }

    await stmt.updateChatId(String(chatId), userId);
    logEvent(userId, 'chat_id_registered', { chatId: String(chatId) });

    return res.json({ success: true });
}));

// ─── POST /notify-low-credits — Send Inline Keyboard Refuel Prompt ──────────
// Called internally when Bifrost returns budget_exceeded.
// Sends an inline keyboard message via the master bot API to the user's Telegram chat.
// Requires ADMIN_SECRET for authentication (internal API).
app.post('/notify-low-credits', webhookLimiter, adminAuth, asyncHandler(async (req, res) => {
    const { userId } = req.body;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    const bot = await stmt.getBot(userId);
    if (!bot) {
        return res.status(404).json({ error: 'No bot found for this user' });
    }

    if (!bot.telegram_chat_id) {
        return res.status(400).json({ error: 'No chat ID registered. Bot must call /register-chat first.' });
    }

    if (!config.masterBotToken) {
        return res.status(500).json({ error: 'TELEGRAM_MASTER_BOT_TOKEN not configured' });
    }

    // Build inline keyboard — link to website for subscription management
    const inlineKeyboard = {
        inline_keyboard: [
            [
                { text: '📊 Manage Subscription', url: 'https://liveclaw.xyz' },
            ],
        ],
    };

    const result = await fetch(`https://api.telegram.org/bot${config.masterBotToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: bot.telegram_chat_id,
            text: '⚡ *Your Claw agent is running low on credits!*\n\nYour AI budget for this billing cycle is nearly depleted. It will automatically reset on your next billing date.\n\nTap below to check your subscription status.',
            parse_mode: 'Markdown',
            reply_markup: inlineKeyboard,
        }),
    });

    const data = await result.json();

    if (data.ok) {
        logEvent(userId, 'low_credit_notification_sent', { chatId: bot.telegram_chat_id });
        return res.json({ success: true, messageId: data.result.message_id });
    }

    console.error(`[NotifyLowCredits] Telegram API error: ${data.description}`);
    return res.status(502).json({ error: 'Failed to send notification', detail: data.description });
}));



// ─── Spawn picobot ──────────────────────────────────────────────────────────
// picobot reads ~/.picobot/config.json — env vars only work in Docker.
// We generate a per-user config.json in an isolated HOME directory.
function spawnPicobot(userId, telegramToken, bifrostVirtualKey, model = 'minimax-m2.5', telegramAllowFrom = [], userMcpServers = null) {
    // Sanitize userId to prevent path traversal (defense-in-depth)
    if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
        throw new Error(`Invalid userId for picobot spawn: ${userId}`);
    }
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

    // ── MCP servers — merge global defaults + per-user overrides ────────────
    let mcpServers = {};
    if (config.mcpServersConfig) {
        try { mcpServers = JSON.parse(config.mcpServersConfig); } catch (_) { /* invalid JSON — skip */ }
    }
    if (userMcpServers && typeof userMcpServers === 'object') {
        mcpServers = { ...mcpServers, ...userMcpServers };
    }
    if (Object.keys(mcpServers).length > 0) {
        picobotConfig.mcp = { servers: mcpServers };
    }

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
    const { userId, telegramToken, model = 'minimax-m2.5', telegramAllowFrom = [], mcpServers = null } = req.body;
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

    // ── Subscription Gate ───────────────────────────────────────────────────
    const sub = await stmtSubs.getByUserId(userId);
    const activeSub = sub && ['active', 'trialing', 'past_due'].includes(sub.status);
    if (!activeSub) {
        logEvent(userId, 'deploy_blocked_no_subscription', {}, ip);
        return res.status(402).json({
            error: 'Active subscription required',
            message: 'Please subscribe to a plan before deploying a bot.',
            pricingUrl: '/pricing',
        });
    }

    // ── Bot Limit Check ─────────────────────────────────────────────────────
    const plan = sub.plan;
    const maxBots = 1; // unified plan: 1 bot per user
    const currentBots = await stmtSubs.countUserBots(userId);
    const runningBots = currentBots ? currentBots.count : 0;
    // Allow re-deploy (stop + start) but not exceeding limit with new bots
    const existingBot = await stmt.getBot(userId);
    const isRedeploy = existingBot && existingBot.status === 'running';
    if (runningBots >= maxBots && !isRedeploy) {
        logEvent(userId, 'deploy_blocked_bot_limit', { plan, maxBots, runningBots }, ip);
        return res.status(403).json({
            error: `Bot limit reached for ${plan} plan`,
            message: `Your ${plan} plan allows ${maxBots} bot(s). Upgrade to deploy more.`,
            currentBots: runningBots,
            maxBots,
        });
    }

    // ── Global Capacity Check ───────────────────────────────────────────────
    const globalRunning = (await stmt.countRunning()).count;
    if (globalRunning >= MAX_CONCURRENT_BOTS && !isRedeploy) {
        logEvent(userId, 'deploy_blocked_server_capacity', { globalRunning, max: MAX_CONCURRENT_BOTS }, ip);
        return res.status(503).json({
            error: 'Server at capacity',
            message: 'All bot slots are currently in use. Please try again later.',
        });
    }

    // ── Plan-based budget — unified $5.00/mo ──────────────────────────────
    const creditLimit = 5.00;

    console.log(`[deploy] userId=${userId} model=${model} plan=${plan} budget=$${creditLimit} ip=${ip}`);
    logEvent(userId, 'deploy_requested', { model, creditLimit, plan }, ip);

    // ── Stop existing bot if running ────────────────────────────────────────
    const existing = await stmt.getBot(userId);
    if (existing && existing.status === 'running') {
        try { process.kill(existing.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
        // Deactivate old Virtual Key before creating a new one
        if (existing.bifrost_vk_id) {
            try { await bifrost.deactivateVirtualKey(existing.bifrost_vk_id); } catch (err) {
                console.error(`[deploy] Failed to deactivate old VK ${existing.bifrost_vk_id}: ${err.message}`);
            }
        }
        await stmt.updateStatus('stopped', userId);
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
        // Validate user MCP servers (if provided) — only allow http URL-based servers
        let safeMcpServers = null;
        if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
            safeMcpServers = {};
            for (const [name, server] of Object.entries(mcpServers)) {
                if (typeof name !== 'string' || name.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(name)) continue;
                // Only allow HTTP-based MCP servers from users (no arbitrary command exec).
                // Block SSRF: reject loopback, private ranges, and cloud metadata endpoints.
                if (server && typeof server.url === 'string' && /^https?:\/\//i.test(server.url) && !isPrivateUrl(server.url)) {
                    safeMcpServers[name] = { url: server.url };
                    if (server.headers && typeof server.headers === 'object') {
                        safeMcpServers[name].headers = server.headers;
                    }
                }
            }
            if (Object.keys(safeMcpServers).length === 0) safeMcpServers = null;
        }
        pid = spawnPicobot(userId, telegramToken, virtualKey.key, model, allowFrom, safeMcpServers);
        logEvent(userId, 'picobot_spawned', { pid, model, allowFrom: allowFrom.length });
    } catch (err) {
        console.error('[deploy] picobot spawn error:', err.message);
        logEvent(userId, 'picobot_error', err.message);
        const detail = isProd ? undefined : err.message;
        return res.status(500).json({ error: 'Failed to spawn agent', detail });
    }

    // ── Persist to SQLite (token encrypted at rest) ─────────────────────────
    await stmt.upsertBot({
        user_id: userId,
        pid,
        model,
        telegram_token: encryptToken(telegramToken),
        bifrost_vk_id: virtualKey.id,
        bifrost_vk: encryptToken(virtualKey.key),
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

    // Ensure authenticated user can only stop their own bot (IDOR prevention)
    if (isProd && req.verifiedUserId && req.verifiedUserId !== userId) {
        return res.status(403).json({ error: 'userId does not match authenticated user' });
    }

    const bot = await stmt.getBot(userId);
    if (!bot) return res.status(404).json({ error: 'No bot found for this user' });

    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }

    // Deactivate the Bifrost Virtual Key so it stops accepting requests
    if (bot.bifrost_vk_id) {
        bifrost.deactivateVirtualKey(bot.bifrost_vk_id).catch(err => {
            console.error(`[stop-bot] Failed to deactivate VK ${bot.bifrost_vk_id}: ${err.message}`);
        });
    }

    await stmt.updateStatus('stopped', userId);
    logEvent(userId, 'bot_stopped_manual', { pid: bot.pid });

    return res.json({ success: true, message: `Agent (pid ${bot.pid}) stopped.` });
}));

// ─── GET /status/:userId ────────────────────────────────────────────────────
app.get('/status/:userId', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const { userId } = req.params;
    // IDOR: only the authenticated user may query their own bot status
    if (isProd && req.verifiedUserId !== userId) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const bot = await stmt.getBot(userId);
    if (!bot) return res.status(404).json({ error: 'No bot found' });

    let alive = false;
    try { process.kill(bot.pid, 0); alive = true; } catch (_) { /* not running */ }

    // Auto-detect crashed bots
    if (bot.status === 'running' && !alive) {
        await stmt.updateStatus('crashed', userId);
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
}));

// ─── GET /health ────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
    // DB check
    let dbOk = false;
    let runningBots = 0;
    try {
        const row = await stmt.countRunning();
        runningBots = row.count;
        dbOk = true;
    } catch (_) { /* DB inaccessible */ }

    // Bifrost check
    let bifrostOk = false;
    try {
        const bfRes = await fetch(`${config.bifrostBase}/health`, { signal: AbortSignal.timeout(2000) });
        bifrostOk = bfRes.ok;
    } catch (_) { /* Bifrost unreachable */ }

    // Picobot version
    let picobotVersion = 'unknown';
    try {
        const versionFile = path.join(path.dirname(config.picobotPath), '.picobot-version');
        picobotVersion = fs.readFileSync(versionFile, 'utf8').trim();
    } catch (_) { /* version file not found */ }

    // OS-level memory
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
    const memUsedPct = Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100);

    // Disk usage (root partition)
    let diskOk = true;
    let diskUsedPct = 0;
    try {
        const dfOut = execSync('df -P / | tail -1', { timeout: 2000 }).toString();
        const parts = dfOut.trim().split(/\s+/);
        diskUsedPct = parseInt(parts[4], 10) || 0;
        if (diskUsedPct > 90) diskOk = false;
    } catch (_) { /* df not available */ }

    const checks = { db: dbOk, bifrost: bifrostOk, disk: diskOk };
    const allOk = Object.values(checks).every(Boolean);
    const status = allOk ? 'ok' : (dbOk ? 'degraded' : 'critical');
    const code = dbOk ? 200 : 503;

    return res.status(code).json({
        status,
        checks,
        service: 'LiveClaw Orchestrator',
        version: '2.0.0',
        picobotVersion,
        env: config.nodeEnv,
        runningBots,
        maxBots: MAX_CONCURRENT_BOTS,
        botCapacityPct: runningBots > 0 ? Math.round((runningBots / MAX_CONCURRENT_BOTS) * 100) : 0,
        memory: { totalMB: totalMemMB, freeMB: freeMemMB, usedPct: memUsedPct },
        disk: { usedPct: diskUsedPct },
        ts: new Date().toISOString(),
    });
});

// ─── Admin Auth Middleware ───────────────────────────────────────────────────
// Accepts either:
//   Authorization: Bearer <JWT>  — human dashboard (TOTP login)
//   X-Admin-Secret: <secret>     — internal picobot→backend calls
function adminAuth(req, res, next) {
    // Option 1: JWT Bearer (dashboard users after TOTP login)
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const jwtSecret = config.adminJwtSecret || (!isProd ? 'dev-secret' : null);
        if (!jwtSecret) return res.status(403).json({ error: 'ADMIN_JWT_SECRET not configured' });
        try {
            jwt.verify(token, jwtSecret);
            return next();
        } catch (_) {
            return res.status(401).json({ error: 'Session expired. Please log in again.' });
        }
    }

    // Option 2: X-Admin-Secret (internal picobot→backend, unchanged)
    const adminSecret = process.env.ADMIN_SECRET;
    if (adminSecret && req.headers['x-admin-secret'] === adminSecret) {
        return next();
    }
    if (adminSecret && req.headers['x-admin-secret'] !== adminSecret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    if (!adminSecret && isProd) {
        return res.status(403).json({ error: 'ADMIN_SECRET not configured' });
    }
    next();
}

// ─── POST /admin/login — Exchange TOTP code for a short-lived JWT ────────────
app.post('/admin/login', adminLoginLimiter, asyncHandler(async (req, res) => {
    const { code } = req.body || {};
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
        return res.status(400).json({ error: 'A 6-digit code is required' });
    }

    const jwtSecret = config.adminJwtSecret || (!isProd ? 'dev-secret' : null);
    if (!jwtSecret) return res.status(403).json({ error: 'ADMIN_JWT_SECRET not configured' });

    if (!config.adminTotpSecret) {
        if (isProd) return res.status(403).json({ error: 'ADMIN_TOTP_SECRET not configured' });
        // Dev fallback: accept ADMIN_SECRET value directly as code (local only)
        const devSecret = process.env.ADMIN_SECRET || '';
        if (!devSecret || code.trim() !== devSecret) {
            return res.status(401).json({ error: 'Invalid code' });
        }
    } else {
        const totp = new TOTP({
            issuer: 'LiveClaw',
            label: 'admin',
            secret: config.adminTotpSecret,
            digits: 6,
            period: 30,
        });
        const delta = totp.validate({ token: code.trim(), window: 1 });
        if (delta === null) {
            return res.status(401).json({ error: 'Invalid code' });
        }
    }

    const token = jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '8h' });
    return res.json({ token });
}));

function calcRequestWindowStats(windowMs) {
    const now = Date.now();
    const rows = requestTelemetry.recent.filter(r => now - r.ts <= windowMs);
    const count = rows.length;
    const errors = rows.filter(r => r.status >= 500).length;
    const avgLatencyMs = count > 0 ? Math.round(rows.reduce((sum, r) => sum + r.ms, 0) / count) : 0;
    const p95LatencyMs = count > 0
        ? (() => {
            const sorted = rows.map(r => r.ms).sort((a, b) => a - b);
            const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
            return sorted[idx];
        })()
        : 0;

    return {
        count,
        reqPerSec: parseFloat((count / (windowMs / 1000)).toFixed(2)),
        errorRatePct: count > 0 ? parseFloat(((errors / count) * 100).toFixed(2)) : 0,
        avgLatencyMs,
        p95LatencyMs,
    };
}

// ─── GET /admin/dashboard-live — Unified live telemetry snapshot ────────────
app.get('/admin/dashboard-live', adminAuth, asyncHandler(async (req, res) => {
    const paymentsLimit = Math.min(Math.max(parseInt(req.query.paymentsLimit, 10) || 50, 1), 200);
    const eventsLimit = Math.min(Math.max(parseInt(req.query.eventsLimit, 10) || 50, 1), 300);

    const [
        bots,
        botCount,
        runningCount,
        stoppedCount,
        crashedCount,
        activeSubs,
        trialingSubs,
        pastDueSubs,
        cancelledSubs,
        totalPayments,
        paidRevenue,
        paymentRows,
        eventRows,
        earlyBirdCount,
        trialEndingSoonCount,
        betaTotalRow,
        betaUsedRow,
        betaAllRows,
    ] = await Promise.all([
        db.all('SELECT user_id, pid, model, status, credit_limit, bifrost_vk_id, telegram_chat_id, created_at, updated_at FROM bots ORDER BY created_at DESC'),
        db.get('SELECT COUNT(*) as c FROM bots'),
        db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'running'"),
        db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'stopped'"),
        db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'crashed'"),
        db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'"),
        db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'trialing'"),
        db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'past_due'"),
        db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'cancelled'"),
        db.get('SELECT COUNT(*) as c FROM payments'),
        db.get("SELECT COALESCE(SUM(amount_cents), 0) as c FROM payments WHERE status = 'paid'"),
        db.all(
            'SELECT user_id, dodo_payment_id, amount_cents, currency, plan, status, created_at FROM payments ORDER BY created_at DESC LIMIT ?',
            [paymentsLimit]
        ),
        db.all('SELECT id, user_id, event, detail, ip, ts FROM event_logs ORDER BY ts DESC LIMIT ?', [eventsLimit]),
        db.get("SELECT COUNT(*) as c FROM subscriptions WHERE early_bird = 1 AND status IN ('active','trialing','past_due')"),
        db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at < datetime('now', '+7 days')"),
        stmtBeta.countTotal(),
        stmtBeta.countUsed(),
        stmtBeta.listAll(),
    ]);

    // OS metrics
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
    const loadAvg = os.loadavg();

    let disk = { totalGB: null, usedGB: null, availGB: null, usedPct: null };
    try {
        const dfOut = execSync('df -P / | tail -1', { timeout: 2000 }).toString();
        const parts = dfOut.trim().split(/\s+/);
        disk = {
            totalGB: Math.round(parseInt(parts[1], 10) / 1024 / 1024),
            usedGB: Math.round(parseInt(parts[2], 10) / 1024 / 1024),
            availGB: Math.round(parseInt(parts[3], 10) / 1024 / 1024),
            usedPct: parseInt(parts[4], 10) || 0,
        };
    } catch (_) { /* df unavailable */ }

    // Health checks
    let dbOk = true;
    try { await db.get('SELECT 1 as ok'); } catch (_) { dbOk = false; }

    let bifrostOk = false;
    try {
        const bfRes = await fetch(`${config.bifrostBase}/health`, { signal: AbortSignal.timeout(2500) });
        bifrostOk = bfRes.ok;
    } catch (_) { /* unreachable */ }

    // Pre-fetch Bifrost VK usage for all bots in parallel (30s cache per vkId)
    const vkUsageMap = new Map();
    await Promise.all(
        bots
            .filter(b => b.bifrost_vk_id)
            .map(async (b) => {
                const cached = vkUsageCache.get(b.bifrost_vk_id);
                if (cached && (Date.now() - cached.ts) < 30000) {
                    vkUsageMap.set(b.bifrost_vk_id, cached.value);
                    return;
                }
                try {
                    const usage = await bifrost.getVirtualKeyUsage(b.bifrost_vk_id);
                    vkUsageCache.set(b.bifrost_vk_id, { value: usage, ts: Date.now() });
                    vkUsageMap.set(b.bifrost_vk_id, usage);
                } catch (_) { /* Bifrost unreachable or VK not found */ }
            })
    );

    // Instance-level telemetry (RAM + workspace disk + LLM cost)
    const instances = [];
    for (const bot of bots) {
        let alive = false;
        let rssMB = null;
        try {
            process.kill(bot.pid, 0);
            alive = true;
            try {
                const rssKB = parseInt(execSync(`ps -o rss= -p ${bot.pid} 2>/dev/null`, { timeout: 1200 }).toString().trim(), 10);
                if (!Number.isNaN(rssKB)) rssMB = Math.round(rssKB / 1024);
            } catch (_) { /* ps unavailable */ }
        } catch (_) { /* dead process */ }

        let romMB = 0;
        const cachedRom = romUsageCache.get(bot.user_id);
        const romFresh = cachedRom && (Date.now() - cachedRom.ts) < 30 * 1000;
        if (romFresh) {
            romMB = cachedRom.value;
        } else {
            try {
                const safeUserId = String(bot.user_id || '').replace(/'/g, "'\\''");
                const duOut = execSync(`du -sk '${config.botsDir}/${safeUserId}' 2>/dev/null | cut -f1 || echo 0`, { timeout: 1200 }).toString().trim();
                const kb = parseInt(duOut, 10) || 0;
                romMB = Math.round((kb / 1024) * 10) / 10;
                romUsageCache.set(bot.user_id, { value: romMB, ts: Date.now() });
            } catch (_) { /* workspace missing */ }
        }

        const vkUsage = bot.bifrost_vk_id ? (vkUsageMap.get(bot.bifrost_vk_id) || null) : null;

        instances.push({
            userId: bot.user_id,
            pid: bot.pid,
            model: bot.model,
            status: bot.status,
            alive,
            rssMB,
            romMB,
            llmSpentUsd: vkUsage ? vkUsage.spentUsd : null,
            llmBudgetUsd: vkUsage ? vkUsage.limitUsd : null,
            llmUsedPct: (vkUsage && vkUsage.limitUsd > 0) ? Math.round((vkUsage.spentUsd / vkUsage.limitUsd) * 100) : null,
            creditRemaining: parseFloat((bot.credit_limit || 0).toFixed(4)),
            hasTelegramChat: !!bot.telegram_chat_id,
            hasBifrostKey: !!bot.bifrost_vk_id,
            createdAt: bot.created_at,
            updatedAt: bot.updated_at,
        });
    }

    const live1m = calcRequestWindowStats(60 * 1000);
    const live5m = calcRequestWindowStats(5 * 60 * 1000);

    const mrrCents = (activeSubs.c * 1299);
    const arrCents = mrrCents * 12;

    return res.json({
        ts: new Date().toISOString(),
        health: {
            overall: dbOk ? (bifrostOk ? 'ok' : 'degraded') : 'critical',
            checks: { db: dbOk, bifrost: bifrostOk, disk: (disk.usedPct || 0) < 90 },
        },
        traffic: {
            sinceStartTotal: requestTelemetry.total,
            sinceStart5xx: requestTelemetry.errors5xx,
            byStatusClass: requestTelemetry.byClass,
            last1m: live1m,
            last5m: live5m,
        },
        system: {
            uptimeSeconds: Math.round(process.uptime()),
            node: {
                version: process.version,
                pid: process.pid,
                rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
                heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            },
            os: {
                platform: os.platform(),
                arch: os.arch(),
                hostname: os.hostname(),
                cpuCount: os.cpus().length,
                loadAvg: {
                    '1m': parseFloat(loadAvg[0].toFixed(2)),
                    '5m': parseFloat(loadAvg[1].toFixed(2)),
                    '15m': parseFloat(loadAvg[2].toFixed(2)),
                },
                memory: {
                    totalMB: totalMemMB,
                    freeMB: freeMemMB,
                    usedPct: Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100),
                },
                disk,
            },
        },
        agents: {
            total: botCount.c,
            running: runningCount.c,
            stopped: stoppedCount.c,
            crashed: crashedCount.c,
            instances,
        },
        billing: {
            subscriptions: {
                active: activeSubs.c,
                trialing: trialingSubs.c,
                pastDue: pastDueSubs.c,
                cancelled: cancelledSubs.c,
                earlyBird: earlyBirdCount.c,
                trialEndingSoon: trialEndingSoonCount.c,
                total: activeSubs.c + trialingSubs.c + pastDueSubs.c + cancelledSubs.c,
            },
            beta: {
                total: betaTotalRow?.count || 0,
                used: betaUsedRow?.count || 0,
                available: (betaTotalRow?.count || 0) - (betaUsedRow?.count || 0),
                recentRedemptions: (betaAllRows || [])
                    .filter(r => r.redeemed_at)
                    .slice(-20)
                    .reverse()
                    .map(r => ({
                        code: r.code,
                        redeemedBy: r.redeemed_by,
                        redeemedAt: r.redeemed_at,
                        ip: r.redeemed_ip,
                    })),
            },
            payments: {
                totalCount: totalPayments.c,
                paidRevenueUsd: parseFloat(((paidRevenue.c || 0) / 100).toFixed(2)),
                mrrUsd: parseFloat((mrrCents / 100).toFixed(2)),
                arrUsd: parseFloat((arrCents / 100).toFixed(2)),
                arpuUsd: activeSubs.c > 0 ? parseFloat((mrrCents / activeSubs.c / 100).toFixed(2)) : 0,
                recent: paymentRows.map(p => ({
                    userId: p.user_id,
                    paymentId: p.dodo_payment_id,
                    amountUsd: parseFloat(((p.amount_cents || 0) / 100).toFixed(2)),
                    currency: p.currency,
                    plan: p.plan,
                    status: p.status,
                    createdAt: p.created_at,
                })),
            },
            llm: {
                totalSpentUsd: parseFloat(instances.reduce((s, i) => s + (i.llmSpentUsd || 0), 0).toFixed(4)),
                totalBudgetUsd: parseFloat(instances.reduce((s, i) => s + (i.llmBudgetUsd || 0), 0).toFixed(4)),
                activeVkCount: instances.filter(i => i.hasBifrostKey).length,
            },
        },
        recentEvents: eventRows,
    });
}));

// ─── GET /admin/metrics/prometheus — Prometheus-style export ───────────────
app.get('/admin/metrics/prometheus', adminAuth, asyncHandler(async (_req, res) => {
    const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
    const usedMemMB = totalMemMB - freeMemMB;
    const live1m = calcRequestWindowStats(60 * 1000);

    const running = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'running'"))?.c || 0;
    const crashed = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'crashed'"))?.c || 0;
    const activeSubs = (await db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'"))?.c || 0;
    const paidRevenueCents = (await db.get("SELECT COALESCE(SUM(amount_cents), 0) as c FROM payments WHERE status = 'paid'"))?.c || 0;

    // Aggregate LLM spend from in-memory VK usage cache (no extra Bifrost calls)
    let totalLlmSpentUsd = 0;
    for (const entry of vkUsageCache.values()) {
        totalLlmSpentUsd += entry.value.spentUsd || 0;
    }

    const lines = [
        '# HELP liveclaw_http_requests_total Total HTTP requests observed by orchestrator',
        '# TYPE liveclaw_http_requests_total counter',
        `liveclaw_http_requests_total ${requestTelemetry.total}`,
        '# HELP liveclaw_http_5xx_total Total HTTP 5xx responses observed by orchestrator',
        '# TYPE liveclaw_http_5xx_total counter',
        `liveclaw_http_5xx_total ${requestTelemetry.errors5xx}`,
        '# HELP liveclaw_http_rps_1m HTTP requests per second over last minute',
        '# TYPE liveclaw_http_rps_1m gauge',
        `liveclaw_http_rps_1m ${live1m.reqPerSec}`,
        '# HELP liveclaw_http_p95_latency_ms_1m P95 request latency in milliseconds over last minute',
        '# TYPE liveclaw_http_p95_latency_ms_1m gauge',
        `liveclaw_http_p95_latency_ms_1m ${live1m.p95LatencyMs}`,
        '# HELP liveclaw_agents_running Running bot instances',
        '# TYPE liveclaw_agents_running gauge',
        `liveclaw_agents_running ${running}`,
        '# HELP liveclaw_agents_crashed Crashed bot instances',
        '# TYPE liveclaw_agents_crashed gauge',
        `liveclaw_agents_crashed ${crashed}`,
        '# HELP liveclaw_subscriptions_active Active subscriptions',
        '# TYPE liveclaw_subscriptions_active gauge',
        `liveclaw_subscriptions_active ${activeSubs}`,
        '# HELP liveclaw_revenue_paid_usd Total paid revenue in USD',
        '# TYPE liveclaw_revenue_paid_usd gauge',
        `liveclaw_revenue_paid_usd ${(paidRevenueCents / 100).toFixed(2)}`,
        '# HELP liveclaw_llm_spent_usd_total Total LLM spend across all Virtual Keys (cached)',
        '# TYPE liveclaw_llm_spent_usd_total gauge',
        `liveclaw_llm_spent_usd_total ${totalLlmSpentUsd.toFixed(4)}`,
        '# HELP liveclaw_os_memory_used_mb OS memory used in MB',
        '# TYPE liveclaw_os_memory_used_mb gauge',
        `liveclaw_os_memory_used_mb ${usedMemMB}`,
    ];

    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.status(200).send(lines.join('\n') + '\n');
}));

// ─── GET /admin/stats — Overview Dashboard ──────────────────────────────────
app.get('/admin/stats', adminAuth, asyncHandler(async (req, res) => {
    try {
        const totalBots = (await db.get('SELECT COUNT(*) as c FROM bots')).c;
        const running = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'running'")).c;
        const stopped = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'stopped'")).c;
        const crashed = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'crashed'")).c;
        const totalCredit = (await db.get('SELECT COALESCE(SUM(credit_limit), 0) as c FROM bots')).c;
        const depleted = (await db.get("SELECT COUNT(*) as c FROM bots WHERE credit_limit <= 0.001 AND status = 'running'")).c;
        const recentEvents = await db.all("SELECT event, COUNT(*) as c FROM event_logs WHERE ts > datetime('now', '-1 hour') GROUP BY event");

        // Node.js process memory
        const memUsage = process.memoryUsage();

        // OS-level resource metrics
        const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
        const loadAvg = os.loadavg(); // [1min, 5min, 15min]
        const cpuCount = os.cpus().length;

        // Disk usage
        let diskInfo = null;
        try {
            const dfOut = execSync('df -P / | tail -1', { timeout: 2000 }).toString();
            const parts = dfOut.trim().split(/\s+/);
            diskInfo = {
                totalGB: Math.round(parseInt(parts[1], 10) / 1024 / 1024),
                usedGB: Math.round(parseInt(parts[2], 10) / 1024 / 1024),
                availGB: Math.round(parseInt(parts[3], 10) / 1024 / 1024),
                usedPct: parseInt(parts[4], 10) || 0,
            };
        } catch (_) { /* df not available */ }

        // Per-bot instance health (PID alive check + RSS via /proc or ps)
        const botInstances = [];
        const runningBots = await db.all("SELECT user_id, pid, model, credit_limit, created_at FROM bots WHERE status = 'running'");
        for (const bot of runningBots) {
            let alive = false;
            let rssMB = null;
            try {
                process.kill(bot.pid, 0);
                alive = true;
                // Try to get RSS from /proc (Linux) or ps (macOS)
                try {
                    const rssKB = parseInt(execSync(`ps -o rss= -p ${bot.pid} 2>/dev/null`, { timeout: 1000 }).toString().trim(), 10);
                    rssMB = Math.round(rssKB / 1024);
                } catch (_) { /* ps unavailable */ }
            } catch (_) { /* process dead */ }
            botInstances.push({
                userId: bot.user_id,
                pid: bot.pid,
                model: bot.model,
                alive,
                rssMB,
                creditRemaining: parseFloat(bot.credit_limit.toFixed(4)),
                uptimeHours: Math.round((Date.now() - new Date(bot.created_at).getTime()) / 3600000),
            });
        }

        return res.json({
            bots: {
                total: totalBots, running, stopped, crashed,
                creditDepleted: depleted,
                maxConcurrent: MAX_CONCURRENT_BOTS,
                capacityPct: running > 0 ? Math.round((running / MAX_CONCURRENT_BOTS) * 100) : 0,
            },
            credits: { totalAllocated: parseFloat(totalCredit.toFixed(4)) },
            recentEventsLastHour: recentEvents,
            botInstances,
            system: {
                uptime: Math.round(process.uptime()),
                node: {
                    version: process.version,
                    rssMB: Math.round(memUsage.rss / 1024 / 1024),
                    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
                    externalMB: Math.round((memUsage.external || 0) / 1024 / 1024),
                },
                os: {
                    platform: os.platform(),
                    arch: os.arch(),
                    totalMemMB: totalMemMB,
                    freeMemMB: freeMemMB,
                    memUsedPct: Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100),
                    cpuCount,
                    loadAvg: {
                        '1m': parseFloat(loadAvg[0].toFixed(2)),
                        '5m': parseFloat(loadAvg[1].toFixed(2)),
                        '15m': parseFloat(loadAvg[2].toFixed(2)),
                    },
                },
                disk: diskInfo,
            },
            ts: new Date().toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ error: 'Stats query failed', detail: err.message });
    }
}));

// ─── GET /admin/revenue — Revenue & Monetization Analytics ──────────────────
app.get('/admin/revenue', adminAuth, asyncHandler(async (req, res) => {
    const { period = '30d' } = req.query;

    // Map period to SQLite datetime modifier
    const periodMap = { '24h': '-1 day', '7d': '-7 days', '30d': '-30 days', '90d': '-90 days', 'all': '-100 years' };
    const modifier = periodMap[period] || '-30 days';

    try {
        // Subscription revenue from payments table
        const subscriptionRevenue = await db.get(`
            SELECT COUNT(*) as count,
                   COALESCE(SUM(amount_cents), 0) as totalCents
            FROM payments WHERE status = 'paid' AND created_at > datetime('now', ?)
        `, [modifier]);

        // Active subscribers
        const activeSubscribers = await db.get(`
            SELECT COUNT(*) as count FROM subscriptions WHERE status IN ('active', 'trialing')
        `);

        // Churned subscribers (cancelled in period)
        const churnedSubscribers = await db.get(`
            SELECT COUNT(*) as count FROM subscriptions
            WHERE status = 'cancelled' AND updated_at > datetime('now', ?)
        `, [modifier]);

        // Daily revenue breakdown
        const dailyRevenue = await db.all(`
            SELECT date(created_at) as day,
                   SUM(amount_cents) as revenueCents,
                   COUNT(*) as payments
            FROM payments
            WHERE status = 'paid' AND created_at > datetime('now', ?)
            GROUP BY date(created_at) ORDER BY day DESC LIMIT 30
        `, [modifier]);

        const totalRevenueCents = subscriptionRevenue.totalCents || 0;
        const mrr = activeSubscribers.count * 999; // $9.99 in cents

        return res.json({
            period,
            subscriptions: {
                active: activeSubscribers.count,
                churned: churnedSubscribers.count,
                mrrCents: mrr,
                mrrUsd: parseFloat((mrr / 100).toFixed(2)),
            },
            revenue: {
                payments: subscriptionRevenue.count,
                totalCents: totalRevenueCents,
                totalUsd: parseFloat((totalRevenueCents / 100).toFixed(2)),
            },
            dailyBreakdown: dailyRevenue.map(d => ({
                day: d.day,
                revenueUsd: parseFloat((d.revenueCents / 100).toFixed(2)),
                payments: d.payments,
            })),
            ts: new Date().toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ error: 'Revenue query failed', detail: err.message });
    }
}));

// ─── GET /admin/system — Deep System Health & Capacity ──────────────────────
// Comprehensive resource monitoring: OS, Docker, per-bot processes, LLM usage
app.get('/admin/system', adminAuth, async (req, res) => {
    try {
        // ── OS Metrics ──────────────────────────────────────────────────────
        const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
        const loadAvg = os.loadavg();
        const cpuCount = os.cpus().length;

        // Disk
        let disk = null;
        try {
            const dfOut = execSync('df -Ph / | tail -1', { timeout: 2000 }).toString();
            const parts = dfOut.trim().split(/\s+/);
            disk = { total: parts[1], used: parts[2], avail: parts[3], usedPct: parseInt(parts[4], 10) };
        } catch (_) { /* non-Linux */ }

        // ── Bifrost Gateway ─────────────────────────────────────────────────
        let bifrost_health = null;
        try {
            const bfRes = await fetch(`${config.bifrostBase}/health`, { signal: AbortSignal.timeout(3000) });
            bifrost_health = { status: bfRes.ok ? 'ok' : 'unhealthy', httpCode: bfRes.status };
        } catch (err) {
            bifrost_health = { status: 'unreachable', error: err.message };
        }

        // Docker container stats (Bifrost)
        let dockerStats = null;
        try {
            const dockerOut = execSync(
                'docker stats bifrost-gateway --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null',
                { timeout: 5000 }
            ).toString().trim();
            const [cpu, mem, memPct] = dockerOut.split('|');
            dockerStats = { cpu: cpu?.trim(), memory: mem?.trim(), memPct: memPct?.trim() };
        } catch (_) { /* docker unavailable */ }

        // ── Per-Bot Instance Metrics ────────────────────────────────────────
        const bots = await db.all("SELECT user_id, pid, model, credit_limit, created_at FROM bots WHERE status = 'running'");
        const instances = [];
        let totalBotRSS = 0;

        for (const bot of bots) {
            const instance = { userId: bot.user_id, pid: bot.pid, model: bot.model, alive: false, rssMB: null };
            try {
                process.kill(bot.pid, 0);
                instance.alive = true;
                try {
                    const rssKB = parseInt(execSync(`ps -o rss= -p ${bot.pid} 2>/dev/null`, { timeout: 1000 }).toString().trim(), 10);
                    instance.rssMB = Math.round(rssKB / 1024);
                    totalBotRSS += instance.rssMB;
                } catch (_) { /* ps unavailable */ }
            } catch (_) { /* process dead */ }
            instance.creditRemaining = parseFloat(bot.credit_limit.toFixed(4));
            instance.uptimeHours = Math.round((Date.now() - new Date(bot.created_at).getTime()) / 3600000);
            instances.push(instance);
        }

        const aliveCount = instances.filter(i => i.alive).length;
        const deadCount = instances.filter(i => !i.alive).length;

        // ── Zombie Detection ────────────────────────────────────────────────
        let orphanedProcesses = [];
        try {
            const psOut = execSync('pgrep -af picobot 2>/dev/null || true', { timeout: 2000 }).toString().trim();
            if (psOut) {
                const trackedPids = new Set(bots.map(b => b.pid));
                const psPids = psOut.split('\n')
                    .map(line => parseInt(line.trim().split(/\s+/)[0], 10))
                    .filter(pid => !isNaN(pid) && !trackedPids.has(pid));
                orphanedProcesses = psPids;
            }
        } catch (_) { /* pgrep unavailable */ }

        // ── Capacity Projection ─────────────────────────────────────────────
        const avgBotMB = totalBotRSS > 0 && aliveCount > 0 ? Math.round(totalBotRSS / aliveCount) : 20;
        const availableForBots = freeMemMB - 200; // 200 MB headroom
        const additionalCapacity = Math.max(0, Math.floor(availableForBots / avgBotMB));

        // ── Node.js Process ─────────────────────────────────────────────────
        const memUsage = process.memoryUsage();

        return res.json({
            os: {
                platform: os.platform(),
                arch: os.arch(),
                hostname: os.hostname(),
                uptimeHours: Math.round(os.uptime() / 3600),
                cpuCount,
                loadAvg: { '1m': +loadAvg[0].toFixed(2), '5m': +loadAvg[1].toFixed(2), '15m': +loadAvg[2].toFixed(2) },
                memory: { totalMB: totalMemMB, freeMB: freeMemMB, usedPct: Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100) },
                disk,
            },
            node: {
                version: process.version,
                pid: process.pid,
                uptimeSeconds: Math.round(process.uptime()),
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            },
            bifrost: bifrost_health,
            docker: dockerStats,
            bots: {
                running: aliveCount,
                stale: deadCount,
                maxConcurrent: MAX_CONCURRENT_BOTS,
                capacityPct: Math.round((aliveCount / MAX_CONCURRENT_BOTS) * 100),
                totalRssMB: totalBotRSS,
                avgRssMB: avgBotMB,
                additionalCapacity,
                orphanedProcesses,
            },
            instances,
            ts: new Date().toISOString(),
        });
    } catch (err) {
        return res.status(500).json({ error: 'System query failed', detail: err.message });
    }
});

// ─── GET /admin/users — User & Bot Listing ──────────────────────────────────
app.get('/admin/users', adminAuth, asyncHandler(async (req, res) => {
    const { status, sort = 'created_at', order = 'desc', limit = 50, offset = 0 } = req.query;

    const allowedSort = ['created_at', 'updated_at', 'credit_limit', 'status'];
    const sortCol = allowedSort.includes(sort) ? sort : 'created_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';
    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    try {
        let query = `SELECT user_id, pid, model, status, credit_limit, created_at, updated_at FROM bots`;
        const params = [];

        if (status && ['running', 'stopped', 'crashed'].includes(status)) {
            query += ' WHERE status = ?';
            params.push(status);
        }

        query += ` ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`;
        params.push(lim, off);

        const users = await db.all(query, params);

        let countQuery = 'SELECT COUNT(*) as c FROM bots';
        const countParams = [];
        if (status && ['running', 'stopped', 'crashed'].includes(status)) {
            countQuery += ' WHERE status = ?';
            countParams.push(status);
        }
        const total = (await db.get(countQuery, countParams)).c;

        return res.json({ users, total, limit: lim, offset: off });
    } catch (err) {
        return res.status(500).json({ error: 'Users query failed', detail: err.message });
    }
}));

// ─── GET /admin/users/:userId — Single User Detail ──────────────────────────
app.get('/admin/users/:userId', adminAuth, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const bot = await stmt.getBot(userId);
    if (!bot) return res.status(404).json({ error: 'User not found' });

    // Check if process is alive
    let alive = false;
    try { process.kill(bot.pid, 0); alive = true; } catch (_) { /* not running */ }

    // Get recent events for this user
    const events = await db.all(
        'SELECT event, detail, ip, ts FROM event_logs WHERE user_id = ? ORDER BY ts DESC LIMIT 50',
        [userId]
    );

    // Revenue for this user
    const userPayments = await db.get(
        "SELECT COUNT(*) as count, COALESCE(SUM(amount_cents), 0) as totalCents FROM payments WHERE user_id = ? AND status = 'paid'",
        [userId]
    );

    // Subscription info
    const userSub = await stmtSubs.getByUserId(userId);

    return res.json({
        user: {
            userId: bot.user_id,
            pid: bot.pid,
            model: bot.model,
            status: bot.status,
            creditLimit: bot.credit_limit,
            createdAt: bot.created_at,
            updatedAt: bot.updated_at,
            alive,
        },
        subscription: userSub ? {
            plan: userSub.plan,
            status: userSub.status,
            currentPeriodEnd: userSub.current_period_end,
        } : null,
        revenue: {
            payments: userPayments.count,
            totalUsd: parseFloat((userPayments.totalCents / 100).toFixed(2)),
        },
        recentEvents: events,
    });
}));

// ─── GET /admin/events — Event Log Viewer ───────────────────────────────────
app.get('/admin/events', adminAuth, asyncHandler(async (req, res) => {
    const { event, userId, limit = 100, offset = 0 } = req.query;
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    try {
        let query = 'SELECT * FROM event_logs WHERE 1=1';
        const params = [];

        if (event) { query += ' AND event = ?'; params.push(event); }
        if (userId) { query += ' AND user_id = ?'; params.push(userId); }

        // Count total matching
        const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as c');
        const total = (await db.get(countQuery, params)).c;

        query += ' ORDER BY ts DESC LIMIT ? OFFSET ?';
        params.push(lim, off);

        const events = await db.all(query, params);

        // Get distinct event types for filter dropdown
        const eventTypes = (await db.all('SELECT DISTINCT event FROM event_logs ORDER BY event')).map(r => r.event);

        return res.json({ events, total, limit: lim, offset: off, eventTypes });
    } catch (err) {
        return res.status(500).json({ error: 'Events query failed', detail: err.message });
    }
}));

// ─── POST /admin/users/:userId/stop — Admin Force Stop ──────────────────────
app.post('/admin/users/:userId/stop', adminAuth, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const bot = await stmt.getBot(userId);
    if (!bot) return res.status(404).json({ error: 'User not found' });

    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
    await stmt.updateStatus('stopped', userId);
    logEvent(userId, 'bot_admin_stopped', { admin: true });

    return res.json({ success: true, message: `Bot for ${userId} stopped by admin.` });
}));

// ─── POST /admin/users/:userId/credit — Admin Credit Adjustment ─────────────
app.post('/admin/users/:userId/credit', adminAuth, asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;

    if (typeof amount !== 'number' || amount === 0) {
        return res.status(400).json({ error: 'amount must be a non-zero number' });
    }

    const bot = await stmt.getBot(userId);
    if (!bot) return res.status(404).json({ error: 'User not found' });

    const newLimit = Math.max(0, bot.credit_limit + amount);
    await stmt.updateCredit(newLimit, userId);
    logEvent(userId, 'admin_credit_adjustment', { amount, oldLimit: bot.credit_limit, newLimit });

    return res.json({ success: true, userId, oldLimit: bot.credit_limit, newLimit });
}));

// ─── POST /admin/beta-codes/generate — Generate Beta Codes ──────────────────
// Idempotent: generates codes until there are exactly 100 in the table.
// Uses crypto.randomBytes for true randomness — XXXX-XXXX-XXXX format (A-Z0-9).
// Each code is also created as a 100% discount coupon in Dodo, restricted to
// the trial product (usage_limit=1). This means beta testers go through the
// full Dodo checkout flow at $0.00, tracked in Dodo analytics.
app.post('/admin/beta-codes/generate', adminAuth, asyncHandler(async (req, res) => {
    const TARGET = 100;
    const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // full alphanumeric

    const existing = (await stmtBeta.countTotal()).count;
    const toCreate = Math.max(0, TARGET - existing);

    /**
     * Generate a XXXX-XXXX-XXXX code using crypto.randomBytes.
     * 12 chars from 36-char alphabet ≈ 62 bits of entropy.
     * Uses rejection sampling to avoid modulo bias (256 % 36 = 4).
     */
    const ACCEPT_LIMIT = Math.floor(256 / CHARSET.length) * CHARSET.length; // 252
    const getUnbiasedChar = () => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const [b] = crypto.randomBytes(1);
            if (b < ACCEPT_LIMIT) return CHARSET[b % CHARSET.length];
        }
    };
    const generateCode = () => {
        const segments = [];
        for (let s = 0; s < 3; s++) {
            let seg = '';
            for (let i = 0; i < 4; i++) seg += getUnbiasedChar();
            segments.push(seg);
        }
        return segments.join('-');
    };

    let created = 0;
    let dodoSynced = 0;
    let dodoErrors = [];
    let attempts = 0;
    while (created < toCreate && attempts < toCreate * 5) {
        const code = generateCode();
        const result = await stmtBeta.insert(code);
        if (result.changes > 0) {
            created++;
            // Create matching 100% discount coupon in Dodo
            try {
                await dodo.createBetaDiscount(code);
                dodoSynced++;
            } catch (err) {
                dodoErrors.push({ code, error: err.message });
                console.error(`[beta-codes] Failed to create Dodo discount for ${code}: ${err.message}`);
            }
        }
        attempts++;
    }
    const allCodes = await stmtBeta.listAll();

    return res.json({
        success: true,
        created,
        dodoSynced,
        dodoErrors: dodoErrors.length > 0 ? dodoErrors : undefined,
        total: allCodes.length,
        codes: allCodes,
    });
}));

// ─── GET /admin/beta-codes — List All Beta Codes with Analytics ─────────────
app.get('/admin/beta-codes', adminAuth, asyncHandler(async (req, res) => {
    const codes = await stmtBeta.listAll();
    const total = (await stmtBeta.countTotal()).count;
    const used = (await stmtBeta.countUsed()).count;

    // Build redemption timeline (codes redeemed per day)
    const timeline = {};
    for (const c of codes) {
        if (c.redeemed_at) {
            const day = c.redeemed_at.slice(0, 10);
            timeline[day] = (timeline[day] || 0) + 1;
        }
    }

    return res.json({
        total,
        used,
        available: total - used,
        redemptionRate: total > 0 ? `${((used / total) * 100).toFixed(1)}%` : '0%',
        timeline,
        codes,
    });
}));

// ─── 404 Catch-All ──────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ─── Global Error Handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
    const status = err.statusCode || 500;
    console.error(`[${req.requestId || '-'}] Error ${status}:`, err.message);
    if (!isProd) console.error(err.stack);

    res.status(status).json({
        error: isProd ? 'Internal server error' : err.message,
    });
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
let server;

async function gracefulShutdown(signal) {
    console.log(`\n[shutdown] Received ${signal}. Cleaning up...`);

    // 1. Stop accepting new connections
    if (server) {
        server.close(() => console.log('[shutdown] HTTP server closed.'));
    }

    // 2. SIGTERM all running bot processes
    try {
        const bots = await stmt.runningBots();
        for (const bot of bots) {
            try {
                process.kill(bot.pid, 'SIGTERM');
                console.log(`[shutdown] Sent SIGTERM to picobot pid=${bot.pid} (user=${bot.user_id})`);
            } catch (_) { /* already dead */ }
            await stmt.updateStatus('stopped', bot.user_id);
        }
    } catch (_) { /* DB may already be closed */ }

    // 3. Close database
    try {
        await db.close();
        console.log('[shutdown] Database closed.');
    } catch (_) { /* noop */ }

    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────────────────────────
// In test mode, DO NOT auto-listen — supertest creates its own ephemeral server.
if (config.nodeEnv !== 'test') {
    initDatabase().then(() => {
    server = app.listen(config.port, () => {
        // Read picobot version for startup banner
        let pbVer = 'unknown';
        try {
            pbVer = fs.readFileSync(path.join(path.dirname(config.picobotPath), '.picobot-version'), 'utf8').trim();
        } catch (_) { /* not installed yet */ }

        console.log(`\n🦀 LiveClaw Orchestrator v2.0.0`);
        console.log(`   Environment: ${config.nodeEnv}`);
        console.log(`   Picobot:     ${pbVer}`);
        console.log(`   Bots dir:    ${config.botsDir}`);
        console.log(`   Listening:   http://localhost:${config.port}`);
        console.log(`   Plan:        $12.99/mo (Early Bird $9.99 w/ EARLYCLAW)`);
        console.log(`   Max bots:    ${MAX_CONCURRENT_BOTS} concurrent`);
        console.log(`   Beta codes:  XXXX-XXXX-XXXX (24h free access, no card)`);
        console.log(`   Endpoints:`);
        console.log(`     POST /deploy-bot`);
        console.log(`     POST /stop-bot`);
        console.log(`     GET  /status/:userId`);
        console.log(`     GET  /health`);
        console.log(`     POST /verify-turnstile`);
        console.log(`   Subscriptions (Dodo Payments):`);
        console.log(`     POST /create-checkout-session  ${config.dodoApiKey ? '(ready)' : '(pending — no DODO_API_KEY)'}`);
        console.log(`     POST /create-portal-session`);
        console.log(`     GET  /subscription/:userId`);
        console.log(`     POST /webhook/dodo`);
        console.log(`     GET  /pricing`);
        console.log(`   Referrals:`);
        console.log(`     POST /referral/generate`);
        console.log(`     POST /referral/apply`);
        console.log(`   Notifications:`);
        console.log(`     POST /register-chat`);
        console.log(`     POST /notify-low-credits`);
        console.log(`   Admin:`);
        console.log(`     GET  /admin/stats`);
        console.log(`     GET  /admin/system`);
        console.log(`     GET  /admin/revenue`);
        console.log(`     GET  /admin/users`);
        console.log(`     GET  /admin/users/:userId`);
        console.log(`     GET  /admin/events`);
        console.log(`     POST /admin/users/:userId/stop`);
        console.log(`     POST /admin/users/:userId/credit\n`);

        // Ensure bots directory exists
        fs.mkdirSync(config.botsDir, { recursive: true });
    });

    // ─── Bot Watchdog ───────────────────────────────────────────────────────
    // Periodically checks running bots and auto-restarts crashed ones.
    // Also expires beta trial subscriptions whose trial_ends_at has passed.
    const watchdogTimer = setInterval(async () => {
        try {
            // ── Expire lapsed beta trials ───────────────────────────────────
            const expiredUsers = await stmtSubs.getExpiredBetaUsers();
            await stmtSubs.expireTrials();
            for (const { user_id } of expiredUsers) {
                const bot = await stmt.getBot(user_id);
                if (bot && bot.status === 'running') {
                    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
                    if (bot.bifrost_vk_id) {
                        bifrost.deactivateVirtualKey(bot.bifrost_vk_id).catch(err => {
                            console.error(`[watchdog] Failed to deactivate VK ${bot.bifrost_vk_id}: ${err.message}`);
                        });
                    }
                    await stmt.updateStatus('stopped', user_id);
                    logEvent(user_id, 'bot_stopped_beta_trial_expired', {});
                }
                logEvent(user_id, 'beta_trial_expired', {});
                console.log(`[watchdog] Beta trial expired for user=${user_id}`);
            }

            // ── Crashed-bot detection & restart ────────────────────────────
            const bots = await stmt.runningBots();
            for (const bot of bots) {
                let alive = false;
                try { process.kill(bot.pid, 0); alive = true; } catch (_) { /* not running */ }

                if (!alive) {
                    // Skip restart if subscription is no longer active
                    const sub = await stmtSubs.getByUserId(bot.user_id);
                    if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) {
                        console.log(`[watchdog] Skipping restart for user=${bot.user_id} — subscription status: ${sub?.status ?? 'none'}`);
                        await stmt.updateStatus('stopped', bot.user_id);
                        continue;
                    }

                    console.warn(`[watchdog] Bot for user=${bot.user_id} pid=${bot.pid} is dead. Auto-restarting...`);

                    try {
                        const decryptedToken = decryptToken(bot.telegram_token);
                        const decryptedVk = decryptToken(bot.bifrost_vk);
                        const newPid = spawnPicobot(bot.user_id, decryptedToken, decryptedVk, bot.model);
                        await stmt.updatePid(newPid, 'running', bot.user_id);
                        logEvent(bot.user_id, 'bot_auto_restarted', { oldPid: bot.pid, newPid });
                        console.log(`[watchdog] Restarted bot for user=${bot.user_id} newPid=${newPid}`);
                    } catch (err) {
                        console.error(`[watchdog] Failed to restart bot for user=${bot.user_id}: ${err.message}`);
                        await stmt.updateStatus('crashed', bot.user_id);
                        logEvent(bot.user_id, 'bot_restart_failed', err.message);
                    }
                }
            }

            // ── Zombie / Orphan Process Cleanup ────────────────────────────
            // Kill picobot processes that exist on the OS but aren't tracked in DB
            try {
                const psOut = execSync('pgrep -a picobot 2>/dev/null || true', { timeout: 2000 }).toString().trim();
                if (psOut) {
                    const trackedPids = new Set(bots.map(b => b.pid));
                    const osPids = psOut.split('\n')
                        .map(line => parseInt(line.trim().split(/\s+/)[0], 10))
                        .filter(pid => !isNaN(pid) && !trackedPids.has(pid));
                    for (const zombiePid of osPids) {
                        try {
                            process.kill(zombiePid, 'SIGTERM');
                            console.warn(`[watchdog] Killed orphaned picobot pid=${zombiePid}`);
                        } catch (_) { /* already dead */ }
                    }
                }
            } catch (_) { /* pgrep unavailable */ }

            // ── Memory Pressure Alert ──────────────────────────────────────
            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            if (freeMemMB < 150) {
                console.warn(`[watchdog] ⚠️  Low memory: ${freeMemMB} MB free`);
            }
        } catch (err) {
            console.error(`[watchdog] Error: ${err.message}`);
        }
    }, config.watchdogIntervalMs);

    // Prevent watchdog from keeping process alive during shutdown
    watchdogTimer.unref();
    }).catch(err => {
        console.error('[startup] Database initialization failed:', err.message);
        process.exit(1);
    });
}

// ─── Module Exports (for testing) ───────────────────────────────────────────
// Export app and db so supertest and test harnesses can use them.
// In production, this export is unused.
const dbReady = config.nodeEnv === 'test' ? initDatabase() : Promise.resolve();
module.exports = { app, dbReady, initDatabase, get db() { return db; }, get stmt() { return stmt; }, get stmtSubs() { return stmtSubs; } };
