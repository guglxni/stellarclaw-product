/**
 * LiveClaw — Admin Routes (Phase 1 extraction)
 *
 * Extracted from server.js to begin decomposing the monolith.
 * Uses factory pattern: receives all shared dependencies via createAdminRouter().
 *
 * Currently extracted routes:
 *   POST   /admin/login      — TOTP → JWT exchange
 *   GET    /admin/health      — Detailed system health (admin-only)
 *   GET    /admin/dashboard-live — Unified live telemetry snapshot
 *
 * Remaining admin routes stay in server.js and will be migrated incrementally.
 */

'use strict';

const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { TOTP } = require('otpauth');
const jwt = require('jsonwebtoken');

/**
 * Creates the admin router with all dependencies injected.
 *
 * @param {object} deps - Shared dependencies from server.js
 * @returns {express.Router}
 */
function createAdminRouter(deps) {
    const {
        config,
        isProd,
        db,
        stmt,
        stmtSubs,
        stmtBeta,
        logEvent,
        log,
        bifrost,
        asyncHandler,
        adminAuth,
        adminLoginLimiter,
        requestTelemetry,
        calcRequestWindowStats,
        vkUsageCache,
        romUsageCache,
        getDiskUsage,
        getProcessRssKB,
        MAX_CONCURRENT_BOTS,
    } = deps;

    const router = express.Router();

    // ─── POST /admin/login — Exchange TOTP code for a short-lived JWT ────
    router.post('/login', adminLoginLimiter, asyncHandler(async (req, res) => {
        const { code } = req.body || {};
        if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
            return res.status(400).json({ error: 'A 6-digit code is required' });
        }

        const jwtSecret = config.adminJwtSecret || null;
        if (!jwtSecret) return res.status(403).json({ error: 'ADMIN_JWT_SECRET not configured' });

        if (!config.adminTotpSecret) {
            if (!isProd && config.allowDevAdminLoginFallback) {
                const devCode = (config.adminDevTotpCode || '').trim();
                if (!/^\d{6}$/.test(devCode)) {
                    return res.status(403).json({ error: 'ADMIN_DEV_TOTP_CODE must be a 6-digit code when ALLOW_DEV_ADMIN_LOGIN_FALLBACK is enabled' });
                }
                if (code.trim() !== devCode) {
                    return res.status(401).json({ error: 'Invalid code' });
                }
            } else {
                return res.status(403).json({ error: 'ADMIN_TOTP_SECRET not configured' });
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

    // ─── GET /admin/health — Detailed Health (admin only) ───────────────
    router.get('/health', adminAuth, async (_req, res) => {
        let dbOk = false;
        let runningBots = 0;
        try {
            const row = await stmt.countRunning();
            runningBots = row.count;
            dbOk = true;
        } catch (_) { /* DB inaccessible */ }

        let bifrostOk = false;
        try {
            const bfRes = await fetch(`${config.bifrostBase}/health`, { signal: AbortSignal.timeout(2000) });
            bifrostOk = bfRes.ok;
        } catch (_) { /* Bifrost unreachable */ }

        let picobotVersion = 'unknown';
        try {
            const versionFile = path.join(path.dirname(config.picobotPath), '.picobot-version');
            picobotVersion = fs.readFileSync(versionFile, 'utf8').trim();
        } catch (_) { /* version file not found */ }

        const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
        const memUsedPct = Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100);

        const diskResult = getDiskUsage();
        const diskOk = !diskResult || diskResult.usedPct <= 90;

        const checks = { db: dbOk, bifrost: bifrostOk, disk: diskOk };
        const allOk = Object.values(checks).every(Boolean);
        const status = allOk ? 'ok' : (dbOk ? 'degraded' : 'critical');

        return res.status(dbOk ? 200 : 503).json({
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
            disk: diskResult || { usedPct: 0 },
            ts: new Date().toISOString(),
        });
    });

    // ─── GET /admin/dashboard-live — Unified live telemetry snapshot ─────
    router.get('/dashboard-live', adminAuth, asyncHandler(async (req, res) => {
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
        const diskResult = getDiskUsage();
        if (diskResult) disk = diskResult;

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
                const rssKB = getProcessRssKB(bot.pid);
                if (rssKB !== null) rssMB = Math.round(rssKB / 1024);
            } catch (_) { /* dead process */ }

            let romMB = 0;
            const cachedRom = romUsageCache.get(bot.user_id);
            const romFresh = cachedRom && (Date.now() - cachedRom.ts) < 30 * 1000;
            if (romFresh) {
                romMB = cachedRom.value;
            } else {
                try {
                    const userPath = path.resolve(config.botsDir, String(bot.user_id || ''));
                    const duOut = execFileSync('du', ['-sk', userPath], { timeout: 1200 }).toString().trim();
                    const kb = parseInt(duOut.split(/\s+/)[0], 10) || 0;
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
            health: { db: dbOk, bifrost: bifrostOk },
            bots: {
                total: botCount.c,
                running: runningCount.c,
                stopped: stoppedCount.c,
                crashed: crashedCount.c,
                maxConcurrent: MAX_CONCURRENT_BOTS,
                capacityPct: runningCount.c > 0 ? Math.round((runningCount.c / MAX_CONCURRENT_BOTS) * 100) : 0,
            },
            subscriptions: {
                active: activeSubs.c,
                trialing: trialingSubs.c,
                pastDue: pastDueSubs.c,
                cancelled: cancelledSubs.c,
                trialEndingSoon: trialEndingSoonCount.c,
                earlyBird: earlyBirdCount.c,
            },
            revenue: {
                totalPayments: totalPayments.c,
                paidCents: paidRevenue.c,
                paidUsd: (paidRevenue.c / 100).toFixed(2),
                mrrCents,
                mrrUsd: (mrrCents / 100).toFixed(2),
                arrCents,
                arrUsd: (arrCents / 100).toFixed(2),
            },
            betaCodes: {
                total: betaTotalRow.count,
                used: betaUsedRow.count,
                available: betaTotalRow.count - betaUsedRow.count,
                codes: betaAllRows,
            },
            instances,
            payments: paymentRows,
            events: eventRows,
            system: {
                uptime: Math.round(process.uptime()),
                memory: { totalMB: totalMemMB, freeMB: freeMemMB, usedPct: Math.round(((totalMemMB - freeMemMB) / totalMemMB) * 100) },
                loadAvg: { '1m': parseFloat(loadAvg[0].toFixed(2)), '5m': parseFloat(loadAvg[1].toFixed(2)), '15m': parseFloat(loadAvg[2].toFixed(2)) },
                disk,
            },
            traffic: { '1m': live1m, '5m': live5m },
        });
    }));

    return router;
}

module.exports = { createAdminRouter };
