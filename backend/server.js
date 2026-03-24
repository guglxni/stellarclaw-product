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
 * Monetisation: Dodo Payments — $9.99/mo standard ($6.99 Early Claw offer w/ EARLYCLAW code) with 2-day trial at $0.75.
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
const { execFileSync } = require('child_process');
const { createDatabase } = require('./database');
const bifrost = require('./bifrost');
const dodo = require('./dodo');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const createLogger = require('./logger');

// ── Structured loggers (one per subsystem) ──────────────────────────────────
const log = {
    startup:  createLogger('startup'),
    http:     createLogger('http'),
    auth:     createLogger('auth'),
    checkout: createLogger('checkout'),
    webhook:  createLogger('webhook'),
    deploy:   createLogger('deploy'),
    admin:    createLogger('admin'),
    watchdog: createLogger('watchdog'),
    system:   createLogger('system'),
};

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

function parseBooleanEnv(name, defaultValue = false) {
    const raw = process.env[name];
    if (raw === undefined) return defaultValue;
    return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

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
    allowDevAuthBypass: parseBooleanEnv('ALLOW_DEV_AUTH_BYPASS', false),
    allowDevAdminLoginFallback: parseBooleanEnv('ALLOW_DEV_ADMIN_LOGIN_FALLBACK', false),
    adminDevTotpCode: process.env.ADMIN_DEV_TOTP_CODE || '',
    scaleQueueOrchestration: parseBooleanEnv('SCALE_QUEUE_ORCHESTRATION', false),
    scaleQueueAsyncMode: parseBooleanEnv('SCALE_QUEUE_ASYNC_MODE', false),
    scaleQueuePollMs: parseInt(process.env.SCALE_QUEUE_POLL_MS, 10) || 1500,
    // Vision MCP — image analysis tool injected into every picobot instance
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    visionDailyLimit: parseInt(process.env.VISION_DAILY_LIMIT || '80', 10),
    visionModel: process.env.VISION_MODEL || 'qwen/qwen2.5-vl-72b-instruct:free',
});

const isProd = config.nodeEnv === 'production';
const devAuthBypassEnabled = !isProd && config.allowDevAuthBypass;

if (devAuthBypassEnabled) {
    log.startup.warn('Non-production auth bypass is ENABLED via ALLOW_DEV_AUTH_BYPASS. Do not use outside local development.');
}
if (!isProd && config.allowDevAdminLoginFallback) {
    log.startup.warn('Non-production admin login fallback is ENABLED via ALLOW_DEV_ADMIN_LOGIN_FALLBACK.');
}
if (config.scaleQueueOrchestration) {
    log.startup.info('Queue orchestration rollout is enabled.', {
        asyncMode: config.scaleQueueAsyncMode,
        pollMs: config.scaleQueuePollMs,
    });
}

// Token replay protection — reject reused Google ID tokens from different IPs
const usedGoogleTokens = new Map(); // hash → { ip, expiry }
setInterval(() => {
    const now = Date.now();
    for (const [hash, entry] of usedGoogleTokens) {
        if (now > entry.expiry) usedGoogleTokens.delete(hash);
    }
}, 5 * 60 * 1000).unref(); // cleanup every 5 min

// ─── Safe Shell Helpers (no string interpolation → no injection) ────────────
/** Get disk usage for root partition via `df -P /`. Returns parsed object or null. */
function getDiskUsage(humanReadable = false) {
    try {
        const args = humanReadable ? ['-Ph', '/'] : ['-P', '/'];
        const dfOut = execFileSync('df', args, { timeout: 2000 }).toString();
        const lines = dfOut.trim().split('\n');
        const parts = lines[lines.length - 1].trim().split(/\s+/);
        if (humanReadable) {
            return { total: parts[1], used: parts[2], avail: parts[3], usedPct: parseInt(parts[4], 10) };
        }
        return {
            totalGB: Math.round(parseInt(parts[1], 10) / 1024 / 1024),
            usedGB: Math.round(parseInt(parts[2], 10) / 1024 / 1024),
            availGB: Math.round(parseInt(parts[3], 10) / 1024 / 1024),
            usedPct: parseInt(parts[4], 10) || 0,
        };
    } catch (_) { return null; }
}

/** Get RSS (in KB) for a process by PID. Returns integer or null. */
function getProcessRssKB(pid) {
    try {
        const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1200 }).toString().trim();
        const val = parseInt(out, 10);
        return Number.isNaN(val) ? null : val;
    } catch (_) { return null; }
}

/** List picobot PIDs via pgrep. Returns array of integers. */
function listPicobotPids(fullMatch = false) {
    try {
        const args = fullMatch ? ['-af', 'picobot'] : ['-a', 'picobot'];
        const out = execFileSync('pgrep', args, { timeout: 2000 }).toString().trim();
        if (!out) return [];
        return out.split('\n')
            .map(line => parseInt(line.trim().split(/\s+/)[0], 10))
            .filter(pid => !isNaN(pid));
    } catch (_) { return []; }
}

/** Get Docker container stats. Returns object or null. */
function getDockerContainerStats(containerName) {
    try {
        const out = execFileSync('docker', [
            'stats', containerName, '--no-stream',
            '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'
        ], { timeout: 5000 }).toString().trim();
        const [cpu, mem, memPct] = out.split('|');
        return { cpu: cpu?.trim(), memory: mem?.trim(), memPct: memPct?.trim() };
    } catch (_) { return null; }
}

// ─── Startup Environment Validation ────────────────────────────────────────
// Fail fast in production if critical secrets are missing or still set to
// placeholder values. Prevents accidentally running with insecure defaults.
const REQUIRED_IN_PROD = [
    ['DATABASE_URL',            process.env.DATABASE_URL, null, null],
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
        log.startup.error('FATAL — missing or invalid environment variables in production', { missing });
        process.exit(1);
    }
    log.startup.info('All required environment variables validated.');
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
// NOTE: Nonce validation is handled at the session layer — POST /auth/session
// creates an HttpOnly cookie after Google token verification, preventing replay.
// The raw Google ID token in Authorization header is a legacy path.
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
        log.auth.warn('Google JWT verification failed', { error: err.message });
        return null;
    }
}

/**
 * Middleware that verifies auth via:
 *   1. HttpOnly session cookie (preferred — set by POST /auth/session)
 *   2. Authorization: Bearer <google_id_token> (legacy fallback)
 * Sets req.verifiedUserId and req.verifiedEmail on success.
 * In non-production, bypass requires explicit ALLOW_DEV_AUTH_BYPASS opt-in.
 */
async function authMiddleware(req, res, next) {
    // Option 1: HttpOnly session cookie (secure, not XSS-accessible)
    if (req.cookies && req.cookies.liveclaw_session) {
        try {
            const decoded = jwt.verify(req.cookies.liveclaw_session, config.encryptionKey);
            req.verifiedUserId = decoded.sub;
            req.verifiedEmail = decoded.email;
            return next();
        } catch (_) { /* cookie invalid/expired — fall through to Bearer check */ }
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        if (devAuthBypassEnabled) {
            // Explicit non-production bypass for local development/testing.
            return next();
        }
        return res.status(401).json({ error: 'Authorization header required' });
    }

    const token = authHeader.slice(7);

    // Token replay protection — reject tokens reused from a different IP
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
    if (usedGoogleTokens.has(tokenHash)) {
        const original = usedGoogleTokens.get(tokenHash);
        if (original.ip && original.ip !== req.socket.remoteAddress) {
            return res.status(401).json({ error: 'Token replay detected' });
        }
    }

    const payload = await verifyGoogleToken(token);

    if (!payload) {
        return res.status(401).json({ error: 'Invalid or expired Google token' });
    }

    // Record token usage for replay detection
    usedGoogleTokens.set(tokenHash, {
        ip: req.socket.remoteAddress,
        expiry: Date.now() + 60 * 60 * 1000, // 1h (matches Google token lifetime)
    });

    req.verifiedUserId = payload.sub;
    req.verifiedEmail = payload.email;
    next();
}

// ─── Token Encryption Helpers ───────────────────────────────────────────────
// Encrypt sensitive tokens at rest in SQLite (AES-256-GCM)
const ALGO = 'aes-256-gcm';
const IV_LEN = 16;
let warnedInsecureTokenStorage = false;

function deriveKey() {
    const raw = config.encryptionKey || '';
    const valid = /^[a-fA-F0-9]{64}$/.test(raw);
    if (!valid) {
        if (isProd) {
            throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars in production');
        }
        if (!warnedInsecureTokenStorage) {
            warnedInsecureTokenStorage = true;
            log.startup.warn('TOKEN_ENCRYPTION_KEY is missing/invalid in non-production. Falling back to plaintext token storage.');
        }
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
    try {
        const [ivHex, tagHex, encHex] = String(ciphertext).split(':');
        if (!ivHex || !tagHex || !encHex) return ciphertext; // plaintext legacy
        const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        let dec = decipher.update(encHex, 'hex', 'utf8');
        dec += decipher.final('utf8');
        return dec;
    } catch (err) {
        throw new Error(`Encrypted token decryption failed: ${err.message}`, { cause: err });
    }
}

// ─── Database ───────────────────────────────────────────────────────────────
let db, stmt, stmtSubs, stmtBeta, stmtOrch;
let orchestrationWorkerBusy = false;

async function initDatabase() {
db = createDatabase({
    databaseUrl: process.env.DATABASE_URL,
    dbPath: config.dbPath,
});

if (isProd && db.type !== 'postgres') {
    throw new Error('Production requires PostgreSQL (DATABASE_URL must be configured)');
}

await db.exec(`
    CREATE TABLE IF NOT EXISTS bots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         TEXT    NOT NULL UNIQUE,
        pid             INTEGER NOT NULL,
        model           TEXT    NOT NULL DEFAULT 'minimax-m2.7',
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

    CREATE TABLE IF NOT EXISTS vision_usage (
        user_id TEXT NOT NULL,
        day     TEXT NOT NULL,
        count   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, day)
    );

    CREATE INDEX IF NOT EXISTS idx_bots_status    ON bots(status);
    CREATE INDEX IF NOT EXISTS idx_logs_user      ON event_logs(user_id, ts);
    CREATE INDEX IF NOT EXISTS idx_logs_ts        ON event_logs(ts);
    CREATE INDEX IF NOT EXISTS idx_logs_event_ts  ON event_logs(event, ts);
    CREATE INDEX IF NOT EXISTS idx_pe_user        ON processed_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_vision_user_day ON vision_usage(user_id, day);
`);

// ── Subscription & Referral Tables ──────────────────────────────────────────
await db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id               TEXT    NOT NULL UNIQUE,
        dodo_customer_id      TEXT    UNIQUE,
        dodo_subscription_id  TEXT    UNIQUE,
        plan                  TEXT    NOT NULL DEFAULT 'standard'
                              CHECK(plan IN ('standard','trial')),
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

    CREATE TABLE IF NOT EXISTS orchestration_commands (
        command_id   TEXT PRIMARY KEY,
        command_type TEXT NOT NULL CHECK(command_type IN ('deploy', 'stop')),
        user_id      TEXT NOT NULL,
        payload      TEXT,
        status       TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed')),
        error        TEXT,
        result       TEXT,
        created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at   DATETIME,
        finished_at  DATETIME,
        updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_subs_user     ON subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_subs_dodo     ON subscriptions(dodo_subscription_id);
    CREATE INDEX IF NOT EXISTS idx_subs_status_updated ON subscriptions(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_subs_trial_ends ON subscriptions(trial_ends_at);
    CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(code);
    CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_beta_code     ON beta_codes(code);
    CREATE INDEX IF NOT EXISTS idx_orch_status_created ON orchestration_commands(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_orch_user_created ON orchestration_commands(user_id, created_at);
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

stmtOrch = {
    enqueue: (params) => db.run(
        'INSERT INTO orchestration_commands (command_id, command_type, user_id, payload, status) VALUES (@command_id, @command_type, @user_id, @payload, @status)',
        params
    ),
    getById: (commandId) => db.get('SELECT * FROM orchestration_commands WHERE command_id = ?', [commandId]),
    getNextQueued: () => db.get("SELECT * FROM orchestration_commands WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"),
    markRunning: (commandId) => db.run(
        "UPDATE orchestration_commands SET status = 'running', started_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE command_id = ? AND status = 'queued'",
        [commandId]
    ),
    markCompleted: (result, commandId) => db.run(
        "UPDATE orchestration_commands SET status = 'completed', result = ?, error = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?",
        [result, commandId]
    ),
    markFailed: (error, commandId) => db.run(
        "UPDATE orchestration_commands SET status = 'failed', error = ?, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE command_id = ?",
        [error, commandId]
    ),
};
    // Populate the admin router placeholder now that all deps are ready
    const adminRouter = createAdminRouter({
        config, isProd, db, stmt, stmtSubs, stmtBeta,
        logEvent, log, bifrost, dodo, asyncHandler, adminAuth, adminLoginLimiter,
        requestTelemetry, calcRequestWindowStats,
        vkUsageCache, romUsageCache,
        getDiskUsage, getProcessRssKB,
        listPicobotPids, getDockerContainerStats,
        decryptToken, spawnPicobot, encryptToken,
        deactivateVirtualKeyWithRetry,
        MAX_CONCURRENT_BOTS,
    });
    adminRouterPlaceholder.use(adminRouter);

    // Mount extracted route modules
    const subscriptionRouter = createSubscriptionRouter({
        config, isProd, db, stmt, stmtSubs, stmtBeta,
        logEvent, log, dodo, asyncHandler, authMiddleware, deployLimiter, checkoutPerUser,
    });
    subscriptionRouterPlaceholder.use(subscriptionRouter);

    const webhookRouter = createWebhookRouter({
        db, stmt, stmtSubs, logEvent, log, dodo, bifrost,
        asyncHandler, webhookLimiter,
        deactivateVirtualKeyWithRetry,
    });
    webhookRouterPlaceholder.use(webhookRouter);

    const botRouter = createBotRouter({
        config, isProd, stmt, stmtSubs, stmtOrch,
        logEvent, log, bifrost, asyncHandler, authMiddleware, adminAuth,
        deployLimiter, deployPerUser, webhookLimiter,
        runDeployCommand, runStopCommand, enqueueOrchestrationCommand,
        formatCommandResponse, serializeJson,
    });
    botRouterPlaceholder.use(botRouter);
} // end initDatabase

function logEvent(userId, event, detail = null, ip = null) {
    stmt.insertLog(userId, event, typeof detail === 'object' ? JSON.stringify(detail) : detail, ip).catch(err => {
        log.system.error('logEvent failed', { error: err.message });
    });
}

// ─── Bifrost Circuit Breaker ─────────────────────────────────────────────
// Retries VK deactivation up to 3 times with exponential backoff.
// Logs all failures for admin visibility.
async function deactivateVirtualKeyWithRetry(vkId, userId = 'system') {
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await bifrost.deactivateVirtualKey(vkId);
            return true;
        } catch (err) {
            log.deploy.error('Bifrost VK deactivation failed', {
                vkId, attempt, maxRetries: MAX_RETRIES, error: err.message,
            });

            if (attempt < MAX_RETRIES) {
                const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                logEvent(userId, 'bifrost_deactivation_failed', {
                    vkId, attempts: MAX_RETRIES, lastError: err.message,
                });
                return false;
            }
        }
    }
    return false;
}

function httpError(statusCode, body) {
    const err = new Error((body && body.error) || 'Request failed');
    err.statusCode = statusCode;
    err.body = body;
    return err;
}

function serializeJson(value) {
    try {
        return JSON.stringify(value);
    } catch (_) {
        return null;
    }
}

function parseJson(value, fallback) {
    try {
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

async function runDeployCommand({ userId, telegramToken, model = 'minimax-m2.7', telegramAllowFrom = [], mcpServers = null, ip = null, verifiedUserId = null }) {
    if (!verifiedUserId || verifiedUserId !== userId) {
        throw httpError(403, { error: 'userId does not match authenticated user' });
    }

    if (!userId || typeof userId !== 'string' || userId.length > 128) {
        throw httpError(400, { error: 'userId is required (string, max 128 chars)' });
    }
    if (!telegramToken || typeof telegramToken !== 'string') {
        throw httpError(400, { error: 'telegramToken is required' });
    }
    if (!/^\d+:[A-Za-z0-9_-]{30,50}$/.test(telegramToken)) {
        throw httpError(400, { error: 'Invalid Telegram bot token format' });
    }

    const ALLOWED_MODELS = ['minimax-m2.7', 'minimax-m2.5', 'kimi-k2.5'];
    if (!ALLOWED_MODELS.includes(model)) {
        throw httpError(400, { error: `Invalid model. Allowed: ${ALLOWED_MODELS.join(', ')}` });
    }

    const sub = await stmtSubs.getByUserId(userId);
    const activeSub = sub && ['active', 'trialing', 'past_due'].includes(sub.status);
    if (!activeSub) {
        logEvent(userId, 'deploy_blocked_no_subscription', {}, ip);
        throw httpError(402, {
            error: 'Active subscription required',
            message: 'Please subscribe to a plan before deploying a bot.',
            pricingUrl: '/pricing',
        });
    }

    const plan = sub.plan;
    const maxBots = 1;
    const currentBots = await stmtSubs.countUserBots(userId);
    const runningBots = currentBots ? currentBots.count : 0;
    const existingBot = await stmt.getBot(userId);
    const isRedeploy = existingBot && existingBot.status === 'running';
    if (runningBots >= maxBots && !isRedeploy) {
        logEvent(userId, 'deploy_blocked_bot_limit', { plan, maxBots, runningBots }, ip);
        throw httpError(403, {
            error: `Bot limit reached for ${plan} plan`,
            message: `Your ${plan} plan allows ${maxBots} bot(s). Upgrade to deploy more.`,
            currentBots: runningBots,
            maxBots,
        });
    }

    const globalRunning = (await stmt.countRunning()).count;
    if (globalRunning >= MAX_CONCURRENT_BOTS && !isRedeploy) {
        logEvent(userId, 'deploy_blocked_server_capacity', { globalRunning, max: MAX_CONCURRENT_BOTS }, ip);
        throw httpError(503, {
            error: 'Server at capacity',
            message: 'All bot slots are currently in use. Please try again later.',
        });
    }

    const tokenCheck = await verifyTelegramBotToken(telegramToken);
    if (!tokenCheck.ok) {
        logEvent(userId, 'deploy_blocked_invalid_telegram_token', { error: tokenCheck.error }, ip);
        throw httpError(tokenCheck.status, {
            error: tokenCheck.error,
            message: 'Please connect a valid Telegram bot token from @BotFather.',
        });
    }

    const creditLimit = dodo.PLAN_BUDGET;

    log.deploy.info('Deploy bot', { userId, model, plan, bot: tokenCheck.bot?.username || 'unknown', budget: creditLimit, ip });
    logEvent(userId, 'deploy_requested', { model, creditLimit, plan, botUsername: tokenCheck.bot?.username || null }, ip);

    const existing = await stmt.getBot(userId);
    if (existing && existing.status === 'running') {
        try { process.kill(existing.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
        if (existing.bifrost_vk_id) {
            await deactivateVirtualKeyWithRetry(existing.bifrost_vk_id, userId);
        }
        await stmt.updateStatus('stopped', userId);
        logEvent(userId, 'existing_bot_stopped', { pid: existing.pid });
    }

    let virtualKey;
    try {
        virtualKey = await bifrost.createVirtualKey(userId, model, creditLimit);
        logEvent(userId, 'bifrost_vk_created', { id: virtualKey.id });
    } catch (err) {
        log.deploy.error('Bifrost error', { error: err.message });
        logEvent(userId, 'bifrost_error', err.message);
        const detail = isProd ? undefined : err.message;
        throw httpError(502, { error: 'Failed to create API key', detail });
    }

    let pid;
    try {
        const allowFrom = Array.isArray(telegramAllowFrom)
            ? telegramAllowFrom.map(String).filter(s => /^\d+$/.test(s))
            : [];

        let safeMcpServers = null;
        if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
            safeMcpServers = {};
            for (const [name, server] of Object.entries(mcpServers)) {
                if (typeof name !== 'string' || name.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(name)) continue;
                if (server && typeof server.url === 'string' && /^https?:\/\//i.test(server.url) && !isPrivateUrl(server.url)) {
                    safeMcpServers[name] = { url: server.url };
                    if (server.headers && typeof server.headers === 'object') {
                        const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'accept', 'x-api-key', 'user-agent']);
                        const sanitized = {};
                        for (const [key, val] of Object.entries(server.headers)) {
                            const lowerKey = String(key).toLowerCase();
                            if (ALLOWED_HEADERS.has(lowerKey) && typeof val === 'string' && !/[\r\n\0]/.test(val)) {
                                sanitized[lowerKey] = val;
                            }
                        }
                        safeMcpServers[name].headers = sanitized;
                    }
                }
            }
            if (Object.keys(safeMcpServers).length === 0) safeMcpServers = null;
        }

        pid = spawnPicobot(userId, telegramToken, virtualKey.key, model, allowFrom, safeMcpServers);
        logEvent(userId, 'picobot_spawned', { pid, model, allowFrom: allowFrom.length });
    } catch (err) {
        log.deploy.error('picobot spawn error', { error: err.message });
        logEvent(userId, 'picobot_error', err.message);
        const detail = isProd ? undefined : err.message;
        throw httpError(500, { error: 'Failed to spawn agent', detail });
    }

    await stmt.upsertBot({
        user_id: userId,
        pid,
        model,
        telegram_token: encryptToken(telegramToken),
        bifrost_vk_id: virtualKey.id,
        bifrost_vk: encryptToken(virtualKey.key),
        credit_limit: creditLimit,
    });

    return {
        success: true,
        pid,
        model,
        creditLimit,
        message: 'Your Claw agent is live on Telegram!',
    };
}

async function runStopCommand({ userId, verifiedUserId = null }) {
    if (!userId || typeof userId !== 'string') {
        throw httpError(400, { error: 'userId is required' });
    }

    if (!verifiedUserId || verifiedUserId !== userId) {
        throw httpError(403, { error: 'userId does not match authenticated user' });
    }

    const bot = await stmt.getBot(userId);
    if (!bot) throw httpError(404, { error: 'No bot found for this user' });

    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }

    if (bot.bifrost_vk_id) {
        deactivateVirtualKeyWithRetry(bot.bifrost_vk_id, userId);
    }

    await stmt.updateStatus('stopped', userId);
    logEvent(userId, 'bot_stopped_manual', { pid: bot.pid });

    return { success: true, message: `Agent (pid ${bot.pid}) stopped.` };
}

async function enqueueOrchestrationCommand(commandType, userId, payload) {
    const commandId = crypto.randomUUID();
    await stmtOrch.enqueue({
        command_id: commandId,
        command_type: commandType,
        user_id: userId,
        payload: serializeJson(payload),
        status: 'queued',
    });
    return commandId;
}

function formatCommandResponse(row) {
    if (!row) return null;
    return {
        commandId: row.command_id,
        commandType: row.command_type,
        userId: row.user_id,
        status: row.status,
        payload: parseJson(row.payload, null),
        result: parseJson(row.result, row.result),
        error: parseJson(row.error, row.error),
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,
    };
}

async function processQueuedOrchestrationCommand() {
    if (!config.scaleQueueOrchestration || !config.scaleQueueAsyncMode || orchestrationWorkerBusy) return;

    orchestrationWorkerBusy = true;
    try {
        const next = await stmtOrch.getNextQueued();
        if (!next) return;

        const claim = await stmtOrch.markRunning(next.command_id);
        if (!claim.changes) return;

        try {
            const payload = parseJson(next.payload, {}) || {};
            let result;
            if (next.command_type === 'deploy') {
                result = await runDeployCommand({ ...payload, verifiedUserId: null });
            } else if (next.command_type === 'stop') {
                result = await runStopCommand({ ...payload, verifiedUserId: null });
            } else {
                throw new Error(`Unsupported command type: ${next.command_type}`);
            }
            await stmtOrch.markCompleted(serializeJson(result), next.command_id);
        } catch (err) {
            const errorBody = err && err.body ? err.body : { error: err.message || 'Unknown queue processing error' };
            await stmtOrch.markFailed(serializeJson(errorBody), next.command_id);
            log.deploy.error('Queue orchestration command failed', { commandId: next.command_id, commandType: next.command_type, error: errorBody.error || String(errorBody) });
        }
    } finally {
        orchestrationWorkerBusy = false;
    }
}

// ─── SSRF Guard ─────────────────────────────────────────────────────────────
// Rejects URLs that target loopback, private, or cloud-metadata addresses.
// Used to prevent SSRF via user-supplied MCP server URLs.
function isPrivateUrl(url) {
    try {
        // Block @ in URL authority (userinfo bypass)
        if (url.includes('@')) return true;
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
        // IPv6 private/reserved ranges
        if (hostname === '::1') return true;                            // loopback
        if (/^fe80:/i.test(hostname)) return true;                     // link-local
        if (/^fc00:/i.test(hostname) || /^fd/i.test(hostname)) return true; // unique local (fc00::/7)
        if (/^2001:db8:/i.test(hostname)) return true;                 // documentation prefix
        if (hostname === '::' || /^\[?::ffff:/i.test(hostname)) return true; // mapped IPv4 / unspecified
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

// Trust proxy — in production, only trust the local Nginx reverse proxy
// In development, trust one hop (for local testing)
if (config.nodeEnv === 'production') {
    app.set('trust proxy', 'loopback'); // Only trust 127.0.0.1/::1
} else {
    app.set('trust proxy', 1);
}

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS, etc.)
app.use(helmet());

// Prevent caching of sensitive API responses
app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    next();
});

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
app.use(cookieParser());

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

        log.http.info(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`, { requestId: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms });
    });
    next();
});

// ─── Rate Limiters ──────────────────────────────────────────────────────────
const isTest = config.nodeEnv === 'test';
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/health', '/readyz']);

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
    skip: (req) => isTest || RATE_LIMIT_EXEMPT_PATHS.has(req.path),
});

// Admin login: 7 attempts per 15 min per IP — locks out on 8th attempt
const adminLoginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 7,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.socket.remoteAddress || '127.0.0.1',
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
    skip: () => isTest,
});

// ─── Per-User Rate Limiters ────────────────────────────────────────────────
// Prevents a single authenticated user from abusing deploy/checkout endpoints
// even if they rotate IPs. Uses in-memory sliding window.
const perUserWindows = new Map(); // userId → [timestamps]
const PER_USER_CLEANUP_INTERVAL = 5 * 60 * 1000; // cleanup every 5 min

function perUserRateLimit({ windowMs = 60000, max = 3, message = 'Too many requests' } = {}) {
    return (req, res, next) => {
        const userId = req.verifiedUserId || req.body?.userId;
        if (!userId || isTest) return next();

        const now = Date.now();
        let timestamps = perUserWindows.get(userId);
        if (!timestamps) {
            timestamps = [];
            perUserWindows.set(userId, timestamps);
        }

        // Remove expired timestamps
        while (timestamps.length > 0 && timestamps[0] <= now - windowMs) {
            timestamps.shift();
        }

        if (timestamps.length >= max) {
            return res.status(429).json({ error: message });
        }

        timestamps.push(now);
        next();
    };
}

// Cleanup stale entries periodically
const perUserCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [userId, timestamps] of perUserWindows) {
        while (timestamps.length > 0 && timestamps[0] <= now - 120000) {
            timestamps.shift();
        }
        if (timestamps.length === 0) perUserWindows.delete(userId);
    }
}, PER_USER_CLEANUP_INTERVAL);
perUserCleanupTimer.unref();

const deployPerUser = perUserRateLimit({ windowMs: 60000, max: 3, message: 'Too many deploy requests. Please try again in a minute.' });
const checkoutPerUser = perUserRateLimit({ windowMs: 300000, max: 5, message: 'Too many checkout attempts. Please try again later.' });

app.use(generalLimiter);

// ─── Telegram Bot Token Verification ───────────────────────────────────────
// Calls Telegram Bot API getMe to ensure token is valid and reachable.
async function verifyTelegramBotToken(token) {
    if (!token || typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,50}$/.test(token)) {
        return { ok: false, status: 400, error: 'Invalid Telegram bot token format' };
    }

    const endpoint = `https://api.telegram.org/bot${token}/getMe`;
    let resp;
    try {
        resp = await fetch(endpoint, {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
            headers: { 'User-Agent': 'LiveClaw/2.0 token-verifier' },
        });
    } catch (err) {
        return { ok: false, status: 502, error: `Telegram API unavailable: ${err.message}` };
    }

    let data;
    try {
        data = await resp.json();
    } catch (_) {
        return { ok: false, status: 502, error: 'Telegram API returned invalid JSON' };
    }

    if (!resp.ok || !data?.ok || !data?.result) {
        const description = data?.description || 'Invalid Telegram bot token';
        if (/unauthorized|invalid token/i.test(description)) {
            return { ok: false, status: 400, error: description };
        }
        return { ok: false, status: 502, error: description };
    }

    return {
        ok: true,
        bot: {
            id: data.result.id,
            username: data.result.username || null,
            name: data.result.first_name || null,
        },
    };
}

// ─── Cloudflare Turnstile Verification ──────────────────────────────────────
app.post('/verify-turnstile', asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, error: 'Token is required' });
    }

    if (!config.turnstileSecret) {
        log.auth.error('TURNSTILE_SECRET_KEY not configured');
        return res.status(500).json({ success: false, error: 'Turnstile not configured' });
    }

    const formData = new URLSearchParams();
    formData.append('secret', config.turnstileSecret);
    formData.append('response', token);

    // Omit remoteip — Cloudflare determines the client IP server-side,
    // avoiding reliance on the spoofable X-Forwarded-For header.


    const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        body: formData,
    });

    const outcome = await result.json();

    if (outcome.success) {
        return res.json({ success: true });
    }

    log.auth.warn('Turnstile verification failed', { ip: req.socket.remoteAddress, errors: outcome['error-codes'] });
    return res.status(403).json({ success: false, error: 'CAPTCHA verification failed' });
}));

// ─── POST /verify-telegram-token — Validate Telegram Bot Token ─────────────
app.post('/verify-telegram-token', deployLimiter, asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
    const { userId, telegramToken } = req.body;

    if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId is required' });
    }

    if (req.verifiedUserId && req.verifiedUserId !== userId) {
        return res.status(403).json({ error: 'userId does not match authenticated user' });
    }

    const result = await verifyTelegramBotToken(telegramToken);
    if (!result.ok) {
        return res.status(result.status).json({ success: false, error: result.error });
    }

    return res.json({
        success: true,
        bot: result.bot,
        message: result.bot.username
            ? `Connected to @${result.bot.username}`
            : 'Telegram bot token verified',
    });
}));

// ─── Spawn picobot ──────────────────────────────────────────────────────────
// picobot reads ~/.picobot/config.json — env vars only work in Docker.
// We generate a per-user config.json in an isolated HOME directory.
function spawnPicobot(userId, telegramToken, bifrostVirtualKey, model = 'minimax-m2.7', telegramAllowFrom = [], userMcpServers = null) {
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

    // ── MCP servers — vision built-in + global defaults + per-user overrides ─
    let mcpServers = {};

    // Vision MCP server — injected for every bot when OPENROUTER_API_KEY is set.
    // Runs as a child of picobot, gets userId so the DB cap is per-user.
    if (config.openrouterApiKey) {
        mcpServers.vision = {
            command: 'node',
            args: [path.join(__dirname, 'vision-mcp.js')],
            env: {
                VISION_USER_ID: userId,
                VISION_DAILY_LIMIT: String(config.visionDailyLimit),
                VISION_MODEL: config.visionModel,
                OPENROUTER_API_KEY: config.openrouterApiKey,
                DB_PATH: config.dbPath,
                ...(process.env.DATABASE_URL ? { DATABASE_URL: process.env.DATABASE_URL } : {}),
            },
        };
    }

    if (config.mcpServersConfig) {
        try { mcpServers = { ...mcpServers, ...JSON.parse(config.mcpServersConfig) }; } catch (_) { /* invalid JSON — skip */ }
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
        log.deploy.error('picobot spawn error', { pid: child.pid, error: err.message });
    });

    return child.pid;
}

// ─── GET /readyz ────────────────────────────────────────────────────────────
// Minimal readiness probe: verifies API can reach its primary datastore.
// Cached for 5 seconds to avoid DB round-trip on every LB probe.
let readyzCache = { ts: 0, status: 503, body: null };
const READYZ_CACHE_TTL_MS = 5000;

app.get('/readyz', async (_req, res) => {
    const now = Date.now();
    if (readyzCache.body && (now - readyzCache.ts) < READYZ_CACHE_TTL_MS) {
        return res.status(readyzCache.status).json(readyzCache.body);
    }

    let dbOk = false;
    try {
        await stmt.countRunning();
        dbOk = true;
    } catch (_) { /* DB inaccessible */ }

    const status = dbOk ? 200 : 503;
    const body = {
        status: dbOk ? 'ok' : 'critical',
        checks: { db: dbOk },
        ts: new Date().toISOString(),
    };

    readyzCache = { ts: now, status, body };
    return res.status(status).json(body);
});

// ─── GET /health ────────────────────────────────────────────────────────────
// Public: minimal status + dependency checks only (no system details).
// Detailed telemetry moved to GET /admin/health (adminAuth required).
app.get('/health', async (_req, res) => {
    let dbOk = false;
    try {
        await stmt.countRunning();
        dbOk = true;
    } catch (_) { /* DB inaccessible */ }

    let bifrostOk = false;
    try {
        const bfRes = await fetch(`${config.bifrostBase}/health`, { signal: AbortSignal.timeout(2000) });
        bifrostOk = bfRes.ok;
    } catch (_) { /* Bifrost unreachable */ }

    const diskResult = getDiskUsage();
    const diskOk = !diskResult || diskResult.usedPct <= 90;

    const checks = { db: dbOk, bifrost: bifrostOk, disk: diskOk };
    const allOk = Object.values(checks).every(Boolean);
    const status = allOk ? 'ok' : (dbOk ? 'degraded' : 'critical');

    return res.status(dbOk ? 200 : 503).json({
        status,
        checks,
        ts: new Date().toISOString(),
    });
});

// ── Session cookie auth ──────────────────────────────────────────────────────
app.post('/auth/session', async (req, res) => {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    try {
        const payload = await verifyGoogleToken(idToken);
        if (!payload) return res.status(401).json({ error: 'Invalid Google token' });

        const sessionToken = jwt.sign(
            { sub: payload.sub, email: payload.email },
            config.encryptionKey,  // reuse existing key
            { expiresIn: '1h' }
        );

        res.cookie('liveclaw_session', sessionToken, {
            httpOnly: true,
            secure: config.nodeEnv === 'production',
            sameSite: 'strict',
            maxAge: 60 * 60 * 1000, // 1 hour
            path: '/',
        });

        res.json({ ok: true, userId: payload.sub, email: payload.email });
    } catch (_err) {
        res.status(401).json({ error: 'Token verification failed' });
    }
});

app.post('/auth/logout', (_req, res) => {
    res.clearCookie('liveclaw_session', { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/' });
    res.json({ ok: true });
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
        const jwtSecret = config.adminJwtSecret || null;
        if (!jwtSecret) return res.status(403).json({ error: 'ADMIN_JWT_SECRET not configured' });
        try {
            const decoded = jwt.verify(token, jwtSecret);
            if (decoded.jti && revokedAdminTokens.has(decoded.jti)) {
                return res.status(401).json({ error: 'Token revoked' });
            }
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
    if (!adminSecret) {
        return res.status(403).json({ error: 'ADMIN_SECRET not configured' });
    }
    return res.status(401).json({ error: 'Unauthorized' });
}

// ─── Route Modules (extracted from server.js) ──────────────────────────────
const { createAdminRouter, revokedAdminTokens } = require('./routes/admin');
const { createSubscriptionRouter } = require('./routes/subscriptions');
const { createWebhookRouter } = require('./routes/webhooks');
const { createBotRouter } = require('./routes/bots');
// Note: routers are mounted later in initDatabase() after db/stmt are ready.

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

// ─── Router Mount Points (populated by initDatabase()) ─────────────────────
// Mounted here to ensure they sit before the 404 catch-all in the middleware stack.
const subscriptionRouterPlaceholder = express.Router();
const webhookRouterPlaceholder = express.Router();
const botRouterPlaceholder = express.Router();
const adminRouterPlaceholder = express.Router();
app.use(subscriptionRouterPlaceholder);
app.use(webhookRouterPlaceholder);
app.use(botRouterPlaceholder);
app.use('/admin', adminRouterPlaceholder);

// ─── 404 Catch-All ──────────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ─── Global Error Handler ───────────────────────────────────────────────────
app.use((err, req, res, _next) => {
    const status = err.statusCode || 500;
    log.system.error(`Error ${status}`, { requestId: req.requestId, error: err.message, status });
    if (!isProd) log.system.debug('Stack trace', { stack: err.stack });

    res.status(status).json({
        error: isProd ? 'Internal server error' : err.message,
    });
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
let server;

async function gracefulShutdown(signal) {
    log.system.info('Shutting down', { signal });

    // 1. Stop accepting new connections
    if (server) {
        server.close(() => log.system.info('HTTP server closed'));
    }

    // 2. SIGTERM all running bot processes
    try {
        const bots = await stmt.runningBots();
        for (const bot of bots) {
            try {
                process.kill(bot.pid, 'SIGTERM');
                log.system.info('Sent SIGTERM to picobot', { pid: bot.pid, userId: bot.user_id });
            } catch (_) { /* already dead */ }
            await stmt.updateStatus('stopped', bot.user_id);
        }
    } catch (_) { /* DB may already be closed */ }

    // 3. Close database
    try {
        await db.close();
        log.system.info('Database closed');
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

        log.startup.info('LiveClaw Orchestrator v2.0.0 started', {
            env: config.nodeEnv,
            picobot: pbVer,
            botsDir: config.botsDir,
            port: config.port,
            maxBots: MAX_CONCURRENT_BOTS,
            dodoReady: !!config.dodoApiKey,
        });

        // Ensure bots directory exists
        fs.mkdirSync(config.botsDir, { recursive: true });

    });

    if (config.scaleQueueOrchestration && config.scaleQueueAsyncMode) {
        const queueWorkerTimer = setInterval(() => {
            processQueuedOrchestrationCommand().catch(err => {
                log.deploy.error('Queue worker loop failed', { error: err.message });
            });
        }, config.scaleQueuePollMs);
        queueWorkerTimer.unref();
        log.startup.info('Queue orchestration worker started', { pollMs: config.scaleQueuePollMs });
    }

    // ─── Bot Watchdog ───────────────────────────────────────────────────────
    // Periodically checks running bots and auto-restarts crashed ones.
    // Also expires beta trial subscriptions whose trial_ends_at has passed.
    let lastPruneTs = 0;
    const watchdogTimer = setInterval(async () => {
        // Only run heavy cleanup once per hour
        const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
        if (Date.now() - lastPruneTs > PRUNE_INTERVAL_MS) {
            lastPruneTs = Date.now();

            // ── Prune old event logs (keep 90 days) ───────────────────────
            try {
                const pruned = await db.run(
                    "DELETE FROM event_logs WHERE ts < datetime('now', '-90 days')"
                );
                if (pruned.changes > 0) {
                    log.watchdog.info('Pruned old event logs', { deleted: pruned.changes });
                }
            } catch (err) {
                log.watchdog.error('Event log pruning failed', { error: err.message });
            }

            // ── Prune old processed_events (keep 30 days) ────────────────
            try {
                const prunedPe = await db.run(
                    "DELETE FROM processed_events WHERE ts < datetime('now', '-30 days')"
                );
                if (prunedPe.changes > 0) {
                    log.watchdog.info('Pruned old processed events', { deleted: prunedPe.changes });
                }
            } catch (_) { /* best-effort */ }
        }

        try {
            // ── Expire lapsed beta trials ───────────────────────────────────
            const expiredUsers = await stmtSubs.getExpiredBetaUsers();
            await stmtSubs.expireTrials();
            for (const { user_id } of expiredUsers) {
                const bot = await stmt.getBot(user_id);
                if (bot && bot.status === 'running') {
                    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
                    if (bot.bifrost_vk_id) {
                        deactivateVirtualKeyWithRetry(bot.bifrost_vk_id, user_id);
                    }
                    await stmt.updateStatus('stopped', user_id);
                    logEvent(user_id, 'bot_stopped_beta_trial_expired', {});
                }
                logEvent(user_id, 'beta_trial_expired', {});
                log.watchdog.info('Beta trial expired', { userId: user_id });
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
                        log.watchdog.info('Skipping restart — no active subscription', { userId: bot.user_id, subStatus: sub?.status ?? 'none' });
                        await stmt.updateStatus('stopped', bot.user_id);
                        continue;
                    }

                    log.watchdog.warn('Dead bot detected, auto-restarting', { userId: bot.user_id, pid: bot.pid });

                    try {
                        const decryptedToken = decryptToken(bot.telegram_token);
                        const decryptedVk = decryptToken(bot.bifrost_vk);
                        const newPid = spawnPicobot(bot.user_id, decryptedToken, decryptedVk, bot.model);
                        await stmt.updatePid(newPid, 'running', bot.user_id);
                        logEvent(bot.user_id, 'bot_auto_restarted', { oldPid: bot.pid, newPid });
                        log.watchdog.info('Bot restarted', { userId: bot.user_id, newPid });
                    } catch (err) {
                        log.watchdog.error('Failed to restart bot', { userId: bot.user_id, error: err.message });
                        await stmt.updateStatus('crashed', bot.user_id);
                        logEvent(bot.user_id, 'bot_restart_failed', err.message);
                    }
                }
            }

            // ── Zombie / Orphan Process Cleanup ────────────────────────────
            // Kill picobot processes that exist on the OS but aren't tracked in DB
            const allPicobotPids = listPicobotPids();
            const trackedPids = new Set(bots.map(b => b.pid));
            for (const zombiePid of allPicobotPids.filter(pid => !trackedPids.has(pid))) {
                try {
                    process.kill(zombiePid, 'SIGTERM');
                    log.watchdog.warn('Killed orphaned picobot', { pid: zombiePid });
                } catch (_) { /* already dead */ }
            }

            // ── Memory Pressure Alert ──────────────────────────────────────
            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            if (freeMemMB < 150) {
                log.watchdog.warn('Low memory', { freeMemMB });
            }
        } catch (err) {
            log.watchdog.error('Watchdog error', { error: err.message });
        }
    }, config.watchdogIntervalMs);

    // Prevent watchdog from keeping process alive during shutdown
    watchdogTimer.unref();
    }).catch(err => {
        log.startup.error('Database initialization failed', { error: err.message });
        process.exit(1);
    });
}

// ─── Module Exports (for testing) ───────────────────────────────────────────
// Export app and db so supertest and test harnesses can use them.
// In production, this export is unused.
const dbReady = config.nodeEnv === 'test' ? initDatabase() : Promise.resolve();
module.exports = { app, dbReady, initDatabase, get db() { return db; }, get stmt() { return stmt; }, get stmtSubs() { return stmtSubs; }, get stmtOrch() { return stmtOrch; } };
