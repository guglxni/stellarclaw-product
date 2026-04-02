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

    return router;
}

module.exports = { createBotRouter };
