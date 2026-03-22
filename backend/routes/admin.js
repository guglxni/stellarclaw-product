/**
 * LiveClaw — Admin Routes
 *
 * Extracted from server.js. Uses factory pattern with dependency injection.
 *
 * Routes:
 *   POST   /admin/login              — TOTP → JWT exchange
 *   GET    /admin/health             — Detailed system health (admin-only)
 *   GET    /admin/dashboard-live     — Unified live telemetry snapshot
 *   GET    /admin/metrics/prometheus — Prometheus-style export
 *   GET    /admin/stats              — Overview Dashboard
 *   GET    /admin/revenue            — Revenue & Monetization Analytics
 *   GET    /admin/system             — Deep System Health & Capacity
 *   GET    /admin/users              — User & Bot Listing
 *   GET    /admin/users/:userId      — Single User Detail
 *   GET    /admin/events             — Event Log Viewer
 *   POST   /admin/users/:userId/stop         — Admin Force Stop
 *   POST   /admin/users/:userId/credit       — Admin Credit Adjustment
 *   POST   /admin/users/:userId/subscription — Admin Subscription Management
 *   POST   /admin/users/:userId/delete       — Admin Delete User Data
 *   POST   /admin/system/kill-orphans        — Kill Orphaned Picobot Processes
 *   POST   /admin/users/:userId/restart      — Admin Force Restart Bot
 *   GET    /admin/audit              — Admin Action Audit Log
 *   GET    /admin/subscriptions      — Full Subscription List
 *   POST   /admin/beta-codes/import  — Bulk Import Beta Codes
 *   POST   /admin/beta-codes/generate — Generate Beta Codes
 *   GET    /admin/beta-codes         — List All Beta Codes with Analytics
 */

'use strict';

const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
        dodo,
        asyncHandler,
        adminAuth,
        adminLoginLimiter,
        requestTelemetry,
        calcRequestWindowStats,
        vkUsageCache,
        romUsageCache,
        getDiskUsage,
        getProcessRssKB,
        listPicobotPids,
        getDockerContainerStats,
        decryptToken,
        spawnPicobot,
        encryptToken,
        deactivateVirtualKeyWithRetry,
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

    // ─── GET /admin/metrics/prometheus — Prometheus-style export ───────────────
    router.get('/metrics/prometheus', adminAuth, asyncHandler(async (_req, res) => {
        const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
        const usedMemMB = totalMemMB - freeMemMB;
        const live1m = calcRequestWindowStats(60 * 1000);

        const running = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'running'"))?.c || 0;
        const crashed = (await db.get("SELECT COUNT(*) as c FROM bots WHERE status = 'crashed'"))?.c || 0;
        const activeSubsCount = (await db.get("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'"))?.c || 0;
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
            `liveclaw_subscriptions_active ${activeSubsCount}`,
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
    router.get('/stats', adminAuth, asyncHandler(async (req, res) => {
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
            const diskInfo = getDiskUsage();

            // Per-bot instance health (PID alive check + RSS via /proc or ps)
            const botInstances = [];
            const runningBots = await db.all("SELECT user_id, pid, model, credit_limit, created_at FROM bots WHERE status = 'running'");
            for (const bot of runningBots) {
                let alive = false;
                let rssMB = null;
                try {
                    process.kill(bot.pid, 0);
                    alive = true;
                    const rssKB = getProcessRssKB(bot.pid);
                    if (rssKB !== null) rssMB = Math.round(rssKB / 1024);
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
    router.get('/revenue', adminAuth, asyncHandler(async (req, res) => {
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
    router.get('/system', adminAuth, async (req, res) => {
        try {
            // ── OS Metrics ──────────────────────────────────────────────────────
            const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            const loadAvg = os.loadavg();
            const cpuCount = os.cpus().length;

            // Disk
            const disk = getDiskUsage(true);

            // ── Bifrost Gateway ─────────────────────────────────────────────────
            let bifrost_health = null;
            try {
                const bfRes = await fetch(`${config.bifrostBase}/health`, { signal: AbortSignal.timeout(3000) });
                bifrost_health = { status: bfRes.ok ? 'ok' : 'unhealthy', httpCode: bfRes.status };
            } catch (err) {
                bifrost_health = { status: 'unreachable', error: err.message };
            }

            // Docker container stats (Bifrost)
            const dockerStats = getDockerContainerStats('bifrost-gateway');

            // ── Per-Bot Instance Metrics ────────────────────────────────────────
            const bots = await db.all("SELECT user_id, pid, model, credit_limit, created_at FROM bots WHERE status = 'running'");
            const instances = [];
            let totalBotRSS = 0;

            for (const bot of bots) {
                const instance = { userId: bot.user_id, pid: bot.pid, model: bot.model, alive: false, rssMB: null };
                try {
                    process.kill(bot.pid, 0);
                    instance.alive = true;
                    const rssKB = getProcessRssKB(bot.pid);
                    if (rssKB !== null) {
                        instance.rssMB = Math.round(rssKB / 1024);
                        totalBotRSS += instance.rssMB;
                    }
                } catch (_) { /* process dead */ }
                instance.creditRemaining = parseFloat(bot.credit_limit.toFixed(4));
                instance.uptimeHours = Math.round((Date.now() - new Date(bot.created_at).getTime()) / 3600000);
                instances.push(instance);
            }

            const aliveCount = instances.filter(i => i.alive).length;
            const deadCount = instances.filter(i => !i.alive).length;

            // ── Zombie Detection ────────────────────────────────────────────────
            const allPicobotPids = listPicobotPids(true);
            const trackedPidSet = new Set(bots.map(b => b.pid));
            const orphanedProcesses = allPicobotPids.filter(pid => !trackedPidSet.has(pid));

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
    router.get('/users', adminAuth, asyncHandler(async (req, res) => {
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
    router.get('/users/:userId', adminAuth, asyncHandler(async (req, res) => {
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
    router.get('/events', adminAuth, asyncHandler(async (req, res) => {
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
    router.post('/users/:userId/stop', adminAuth, asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const bot = await stmt.getBot(userId);
        if (!bot) return res.status(404).json({ error: 'User not found' });

        try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* already dead */ }
        await stmt.updateStatus('stopped', userId);
        logEvent(userId, 'bot_admin_stopped', { admin: true });

        return res.json({ success: true, message: `Bot for ${userId} stopped by admin.` });
    }));

    // ─── POST /admin/users/:userId/credit — Admin Credit Adjustment ─────────────
    router.post('/users/:userId/credit', adminAuth, asyncHandler(async (req, res) => {
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

    // ─── POST /admin/users/:userId/subscription — Admin Subscription Management ─
    router.post('/users/:userId/subscription', adminAuth, asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const { action, trialHours } = req.body;

        if (!action || !['cancel', 'activate', 'extend_trial', 'reset_trial'].includes(action)) {
            return res.status(400).json({ error: 'action must be: cancel, activate, extend_trial, or reset_trial' });
        }

        const sub = await stmtSubs.getByUserId(userId);
        if (!sub) return res.status(404).json({ error: 'No subscription found for this user' });

        switch (action) {
            case 'cancel': {
                await stmtSubs.updateStatus('cancelled', userId);
                const bot = await stmt.getBot(userId);
                if (bot && bot.status === 'running') {
                    try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* best-effort */ }
                    if (bot.bifrost_vk_id) deactivateVirtualKeyWithRetry(bot.bifrost_vk_id, userId);
                    await stmt.updateStatus('stopped', userId);
                }
                logEvent(userId, 'admin_subscription_cancelled', { previousStatus: sub.status });
                return res.json({ success: true, action: 'cancelled', userId });
            }
            case 'activate': {
                await stmtSubs.upsert({
                    user_id: userId,
                    dodo_customer_id: sub.dodo_customer_id,
                    dodo_subscription_id: sub.dodo_subscription_id,
                    plan: 'standard',
                    status: 'active',
                    current_period_start: new Date().toISOString(),
                    current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                });
                logEvent(userId, 'admin_subscription_activated', { previousStatus: sub.status });
                return res.json({ success: true, action: 'activated', userId });
            }
            case 'extend_trial': {
                const hours = Math.min(Math.max(parseInt(trialHours, 10) || 24, 1), 720);
                const newEnd = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
                await db.run(
                    'UPDATE subscriptions SET status = ?, trial_ends_at = ?, current_period_end = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                    ['trialing', newEnd, newEnd, userId]
                );
                logEvent(userId, 'admin_trial_extended', { hours, newEnd, previousStatus: sub.status });
                return res.json({ success: true, action: 'trial_extended', userId, trialEndsAt: newEnd });
            }
            case 'reset_trial': {
                await db.run(
                    'UPDATE subscriptions SET trial_ends_at = NULL, status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?',
                    ['inactive', userId]
                );
                logEvent(userId, 'admin_trial_reset', { previousStatus: sub.status });
                return res.json({ success: true, action: 'trial_reset', userId });
            }
        }
    }));

    // ─── DELETE /admin/users/:userId — Admin Delete User Data ───────────────────
    router.post('/users/:userId/delete', adminAuth, asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const { confirm } = req.body;
        if (confirm !== 'DELETE') {
            return res.status(400).json({ error: 'Must pass { confirm: "DELETE" } to confirm' });
        }

        const bot = await stmt.getBot(userId);
        if (bot && bot.status === 'running') {
            try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* best-effort */ }
            if (bot.bifrost_vk_id) deactivateVirtualKeyWithRetry(bot.bifrost_vk_id, userId);
        }

        await db.run('DELETE FROM bots WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM subscriptions WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM payments WHERE user_id = ?', [userId]);
        await db.run('DELETE FROM referrals WHERE referrer_id = ? OR referee_id = ?', [userId, userId]);
        // Keep event_logs for audit trail

        logEvent(userId, 'admin_user_deleted', { deletedBy: 'admin' });
        return res.json({ success: true, message: `All data for ${userId} deleted (event logs preserved).` });
    }));

    // ─── POST /admin/system/kill-orphans — Kill Orphaned Picobot Processes ──────
    router.post('/system/kill-orphans', adminAuth, asyncHandler(async (req, res) => {
        const killed = [];
        const allPids = listPicobotPids();
        if (allPids.length > 0) {
            const bots = await stmt.runningBots();
            const trackedPids = new Set(bots.map(b => b.pid));
            const orphanPids = allPids.filter(pid => !trackedPids.has(pid));
            for (const pid of orphanPids) {
                try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch (_) { /* best-effort */ }
            }
        }
        logEvent('system', 'admin_kill_orphans', { killed });
        return res.json({ success: true, killed, count: killed.length });
    }));

    // ─── POST /admin/users/:userId/restart — Admin Force Restart Bot ────────────
    router.post('/users/:userId/restart', adminAuth, asyncHandler(async (req, res) => {
        const { userId } = req.params;
        const bot = await stmt.getBot(userId);
        if (!bot) return res.status(404).json({ error: 'User not found' });

        const sub = await stmtSubs.getByUserId(userId);
        if (!sub || !['active', 'trialing'].includes(sub.status)) {
            return res.status(403).json({ error: 'User subscription is not active' });
        }

        // Kill existing if running
        try { process.kill(bot.pid, 'SIGTERM'); } catch (_) { /* best-effort */ }

        try {
            const decryptedToken = decryptToken(bot.telegram_token);
            const decryptedVk = decryptToken(bot.bifrost_vk);
            const newPid = spawnPicobot(bot.user_id, decryptedToken, decryptedVk, bot.model);
            await stmt.updatePid(newPid, 'running', userId);
            logEvent(userId, 'admin_bot_restarted', { oldPid: bot.pid, newPid });
            return res.json({ success: true, userId, oldPid: bot.pid, newPid });
        } catch (err) {
            await stmt.updateStatus('crashed', userId);
            logEvent(userId, 'admin_bot_restart_failed', { error: err.message });
            return res.status(500).json({ error: 'Restart failed: ' + err.message });
        }
    }));

    // ─── GET /admin/audit — Admin Action Audit Log ──────────────────────────────
    router.get('/audit', adminAuth, asyncHandler(async (req, res) => {
        const { limit = 100, offset = 0 } = req.query;
        const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
        const off = Math.max(parseInt(offset, 10) || 0, 0);

        const events = await db.all(
            "SELECT * FROM event_logs WHERE event LIKE 'admin_%' ORDER BY ts DESC LIMIT ? OFFSET ?",
            [lim, off]
        );
        const total = (await db.get("SELECT COUNT(*) as c FROM event_logs WHERE event LIKE 'admin_%'")).c;

        return res.json({ events, total, limit: lim, offset: off });
    }));

    // ─── GET /admin/subscriptions — Full Subscription List ──────────────────────
    router.get('/subscriptions', adminAuth, asyncHandler(async (req, res) => {
        const { status, limit = 100, offset = 0 } = req.query;
        const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
        const off = Math.max(parseInt(offset, 10) || 0, 0);

        let query = 'SELECT * FROM subscriptions';
        const params = [];
        if (status && ['active', 'trialing', 'past_due', 'cancelled', 'inactive'].includes(status)) {
            query += ' WHERE status = ?';
            params.push(status);
        }
        query += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
        params.push(lim, off);

        const subs = await db.all(query, params);

        let countQuery = 'SELECT COUNT(*) as c FROM subscriptions';
        const countParams = [];
        if (status && ['active', 'trialing', 'past_due', 'cancelled', 'inactive'].includes(status)) {
            countQuery += ' WHERE status = ?';
            countParams.push(status);
        }
        const total = (await db.get(countQuery, countParams)).c;

        return res.json({ subscriptions: subs, total, limit: lim, offset: off });
    }));

    // ─── POST /admin/beta-codes/import — Bulk Import Beta Codes ─────────────────
    router.post('/beta-codes/import', adminAuth, asyncHandler(async (req, res) => {
        const { codes } = req.body;
        if (!Array.isArray(codes) || codes.length === 0) {
            return res.status(400).json({ error: 'codes must be a non-empty array of XXXX-XXXX-XXXX strings' });
        }
        const valid = codes.filter(c => typeof c === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c.toUpperCase().trim()));
        let imported = 0;
        let dodoSynced = 0;
        for (const code of valid) {
            const result = await stmtBeta.insert(code.toUpperCase().trim());
            if (result.changes > 0) {
                imported++;
                try {
                    await dodo.createBetaDiscount(code.toUpperCase().trim());
                    dodoSynced++;
                } catch (_) { /* Dodo sync optional */ }
            }
        }
        logEvent('system', 'admin_beta_codes_imported', { count: imported, dodoSynced, invalid: codes.length - valid.length });
        return res.json({ success: true, imported, dodoSynced, rejected: codes.length - valid.length, total: valid.length });
    }));

    // ─── POST /admin/beta-codes/generate — Generate Beta Codes ──────────────────
    // Idempotent: generates codes until there are exactly 100 in the table.
    // Uses crypto.randomBytes for true randomness — XXXX-XXXX-XXXX format (A-Z0-9).
    // Each code is also created as a 100% discount coupon in Dodo, restricted to
    // the trial product (usage_limit=1). This means beta testers go through the
    // full Dodo checkout flow at $0.00, tracked in Dodo analytics.
    router.post('/beta-codes/generate', adminAuth, asyncHandler(async (req, res) => {
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
        const dodoErrors = [];
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
                    log.admin.error('Failed to create Dodo discount', { code, error: err.message });
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
    router.get('/beta-codes', adminAuth, asyncHandler(async (req, res) => {
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

    return router;
}

module.exports = { createAdminRouter };
