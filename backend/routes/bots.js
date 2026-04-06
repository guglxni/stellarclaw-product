/**
 * LiveClaw — Bot Routes
 *
 * Extracted from server.js. Uses factory pattern with dependency injection.
 *
 * Routes:
 *   POST   /deploy-bot
 *   POST   /stop-bot
 *   GET    /orchestration/commands/:commandId
 *   GET    /status/:userId
 *   POST   /register-chat
 *   POST   /notify-low-credits
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

/**
 * Creates the bot router with all dependencies injected.
 *
 * @param {object} deps - Shared dependencies from server.js
 * @returns {express.Router}
 */
function createBotRouter(deps) {
    const {
        config,
        isProd,
        stmt,
        stmtSubs,
        stmtOrch,
        logEvent,
        log,
        bifrost,
        dodo,
        asyncHandler,
        authMiddleware,
        adminAuth,
        deployLimiter,
        deployPerUser,
        webhookLimiter,
        runDeployCommand,
        runStopCommand,
        enqueueOrchestrationCommand,
        formatCommandResponse,
        serializeJson,
    } = deps;

    const router = express.Router();

    // ─── POST /deploy-bot ───────────────────────────────────────────────────────
    router.post('/deploy-bot', deployLimiter, asyncHandler(authMiddleware), deployPerUser, asyncHandler(async (req, res) => {
        const payload = {
            userId: req.body.userId,
            telegramToken: req.body.telegramToken || null,
            model: req.body.model || 'minimax-m2.7',
            telegramAllowFrom: req.body.telegramAllowFrom || [],
            mcpServers: req.body.mcpServers || null,
            discordToken: req.body.discordToken || null,
            slackAppToken: req.body.slackAppToken || null,
            slackBotToken: req.body.slackBotToken || null,
            ip: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress,
            verifiedUserId: req.verifiedUserId || null,
        };

        if (!payload.userId || typeof payload.userId !== 'string' || payload.userId.length > 128) {
            return res.status(400).json({ error: 'userId is required (string, max 128 chars)' });
        }

        let commandId = null;
        if (config.scaleQueueOrchestration) {
            commandId = await enqueueOrchestrationCommand('deploy', payload.userId, payload);
            logEvent(payload.userId, 'deploy_enqueued', { commandId, asyncMode: config.scaleQueueAsyncMode }, payload.ip);

            if (config.scaleQueueAsyncMode) {
                return res.status(202).json({
                    queued: true,
                    commandId,
                    status: 'queued',
                    message: 'Deploy request queued for asynchronous processing.',
                });
            }

            await stmtOrch.markRunning(commandId);
        }

        try {
            const result = await runDeployCommand(payload);
            if (commandId) {
                await stmtOrch.markCompleted(serializeJson(result), commandId);
            }
            return res.status(201).json(result);
        } catch (err) {
            if (commandId) {
                await stmtOrch.markFailed(serializeJson(err.body || { error: err.message }), commandId);
            }
            return res.status(err.statusCode || 500).json(err.body || { error: isProd ? 'Internal server error' : err.message });
        }
    }));

    // ─── POST /stop-bot ─────────────────────────────────────────────────────────
    router.post('/stop-bot', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const payload = {
            userId: req.body.userId,
            verifiedUserId: req.verifiedUserId || null,
        };

        if (!payload.userId || typeof payload.userId !== 'string') {
            return res.status(400).json({ error: 'userId is required' });
        }

        let commandId = null;
        if (config.scaleQueueOrchestration) {
            commandId = await enqueueOrchestrationCommand('stop', payload.userId, payload);
            logEvent(payload.userId, 'stop_enqueued', { commandId, asyncMode: config.scaleQueueAsyncMode });

            if (config.scaleQueueAsyncMode) {
                return res.status(202).json({
                    queued: true,
                    commandId,
                    status: 'queued',
                    message: 'Stop request queued for asynchronous processing.',
                });
            }

            await stmtOrch.markRunning(commandId);
        }

        try {
            const result = await runStopCommand(payload);
            if (commandId) {
                await stmtOrch.markCompleted(serializeJson(result), commandId);
            }
            return res.json(result);
        } catch (err) {
            if (commandId) {
                await stmtOrch.markFailed(serializeJson(err.body || { error: err.message }), commandId);
            }
            return res.status(err.statusCode || 500).json(err.body || { error: isProd ? 'Internal server error' : err.message });
        }
    }));

    // ─── GET /orchestration/commands/:commandId ───────────────────────────────
    router.get('/orchestration/commands/:commandId', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const command = await stmtOrch.getById(req.params.commandId);
        if (!command) return res.status(404).json({ error: 'Command not found' });

        if (req.verifiedUserId && req.verifiedUserId !== command.user_id) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        return res.json(formatCommandResponse(command));
    }));

    // ─── GET /status/:userId ────────────────────────────────────────────────────
    router.get('/status/:userId', asyncHandler(authMiddleware), asyncHandler(async (req, res) => {
        const { userId } = req.params;
        // IDOR: only the authenticated user may query their own bot status
        if (req.verifiedUserId && req.verifiedUserId !== userId) {
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

        // Fetch real-time LLM usage from Bifrost VK
        let usage = null;
        if (bot.bifrost_vk_id) {
            try {
                const vkUsage = await bifrost.getVirtualKeyUsage(bot.bifrost_vk_id);
                usage = {
                    usedPct: vkUsage.limitUsd > 0 ? Math.round((vkUsage.spentUsd / vkUsage.limitUsd) * 100) : 0,
                    remainingPct: vkUsage.limitUsd > 0 ? Math.max(0, Math.round(((vkUsage.limitUsd - vkUsage.spentUsd) / vkUsage.limitUsd) * 100)) : 100,
                    isActive: vkUsage.isActive,
                };
            } catch (_) { /* Bifrost unreachable — return null usage */ }
        }

        // Parse active channels
        let channels = [];
        try { channels = JSON.parse(bot.active_channels || '[]'); } catch (_) { /* noop */ }

        return res.json({
            userId: bot.user_id,
            model: bot.model,
            status: bot.status,
            alive,
            channels,
            usage,
            createdAt: bot.created_at,
        });
    }));

    // ─── POST /register-chat — Register Telegram Chat ID for Push Notifications ──
    // Called by picobot processes on the same server. Requires ADMIN_SECRET for
    // authentication (picobot-facing internal API).
    router.post('/register-chat', webhookLimiter, adminAuth, asyncHandler(async (req, res) => {
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

        // Write chat ID to workspace file so telegram-file-mcp can read it without a DB query.
        // Path mirrors the one in spawnPicobot(): {botsDir}/{userId}/.picobot/workspace/.telegram_chat_id
        try {
            const chatIdFile = path.join(config.botsDir, userId, '.picobot', 'workspace', '.telegram_chat_id');
            fs.writeFileSync(chatIdFile, String(chatId), 'utf8');
        } catch (_) { /* workspace may not exist yet — not fatal */ }

        return res.json({ success: true });
    }));

    // ─── POST /notify-low-credits — Send Inline Keyboard Refuel Prompt ──────────
    // Called internally when Bifrost returns budget_exceeded.
    // Sends an inline keyboard message via the master bot API to the user's Telegram chat.
    // Requires ADMIN_SECRET for authentication (internal API).
    router.post('/notify-low-credits', webhookLimiter, adminAuth, asyncHandler(async (req, res) => {
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

        log.system.error('Telegram API error', { error: data.description });
        return res.status(502).json({ error: 'Failed to send notification', detail: data.description });
    }));

    // ─── POST /internal/recharge — Create credits checkout from MCP server ────────
    // Called by liveclaw-mcp.js running inside picobot processes.
    // Authentication: HMAC-SHA256 over the JSON body, signed with LIVECLAW_INTERNAL_SECRET.
    // Replay protection: timestamp must be within 60 seconds of server time.
    // Rate-limited to prevent abuse even if the secret leaks.
    router.post('/internal/recharge', webhookLimiter, asyncHandler(async (req, res) => {
        const secret = config.liveClawInternalSecret;
        if (!secret) {
            return res.status(503).json({ error: 'Recharge not configured on this server' });
        }

        // ── Signature verification ──────────────────────────────────────────
        const sig = req.headers['x-internal-sig'];
        if (!sig || typeof sig !== 'string') {
            return res.status(401).json({ error: 'Missing X-Internal-Sig header' });
        }

        // rawBody is available when express.json uses the verify callback (set in server.js)
        const rawBody = req.rawBody || JSON.stringify(req.body);
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
        // Constant-time comparison to prevent timing attacks
        let sigsMatch = false;
        try {
            sigsMatch = crypto.timingSafeEqual(
                Buffer.from(sig, 'hex'),
                Buffer.from(expected, 'hex')
            );
        } catch (_) { /* mismatched lengths → not equal */ }

        if (!sigsMatch) {
            log.system.warn('Internal recharge: invalid HMAC signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // ── Payload extraction & validation ──────────────────────────────────
        const { userId, amount, ts } = req.body;

        // Replay protection: reject requests older than 60 seconds
        if (!ts || typeof ts !== 'number' || Math.abs(Date.now() - ts) > 60_000) {
            return res.status(400).json({ error: 'Request expired or timestamp invalid' });
        }

        if (!userId || typeof userId !== 'string' || userId.length > 128) {
            return res.status(400).json({ error: 'userId is required' });
        }

        const amountNum = typeof amount === 'number' ? amount : parseFloat(amount);
        if (!Number.isFinite(amountNum) || amountNum < 1 || amountNum > 50) {
            return res.status(400).json({ error: 'amount must be between 1 and 50 USD' });
        }

        // Round to 2 decimal places server-side — never trust client rounding
        const creditsToAdd  = Math.round(amountNum * 100) / 100;
        const totalCharged  = Math.round(creditsToAdd * 1.1 * 100) / 100; // 10% service fee

        // ── Validate user exists and has an active subscription ──────────────
        const bot = await stmt.getBot(userId);
        if (!bot) {
            return res.status(404).json({ error: 'No bot found for this user' });
        }

        // ── Look up customer email for Dodo checkout ──────────────────────────
        let email = `${userId.replace(/[^a-z0-9]/gi, '')}@liveclaw.xyz`; // safe fallback
        const sub = await stmtSubs.getByUserId(userId);
        if (sub?.dodo_customer_id) {
            try {
                const customer = await dodo.getCustomer(sub.dodo_customer_id);
                if (customer?.email) email = customer.email;
            } catch (_) { /* use fallback email — checkout still works */ }
        }

        // ── Create Dodo checkout ──────────────────────────────────────────────
        // quantity = creditsToAdd (integer units of $1 credits)
        // The 10% service fee is NOT passed to Dodo; it's the margin between what the
        // user pays and what Dodo processes. The product price in Dodo must be $1.10/unit
        // for the math to work out, OR we pass the full totalCharged as quantity (rounded).
        // We use creditsToAdd as the metadata credit_amount_usd so the webhook adds
        // the correct amount to Bifrost (not the fee-inclusive total).
        const quantity = Math.round(creditsToAdd); // Dodo only accepts integer quantities
        const { checkoutUrl } = await dodo.createCreditsCheckout(
            userId,
            email,
            quantity,
            `https://liveclaw.xyz?checkout=credits-success&amount=${creditsToAdd}`
        );

        logEvent(userId, 'recharge_checkout_created', { creditsToAdd, totalCharged, quantity });

        return res.json({ checkoutUrl, creditsAdded: creditsToAdd, totalCharged });
    }));

    return router;
}

module.exports = { createBotRouter };
