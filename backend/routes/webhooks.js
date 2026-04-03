/**
 * LiveClaw — Webhook Routes
 *
 * Extracted from server.js. Uses factory pattern with dependency injection.
 *
 * Routes:
 *   POST   /webhook/dodo
 */

'use strict';

const express = require('express');

// ─── Email helpers ────────────────────────────────────────────────────────────

/** Basic RFC-5322 email validation to avoid sending to garbage addresses. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Escape user-supplied strings rendered inside HTML email bodies. */
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Shared dark-theme email wrapper. */
function emailWrapper(body) {
    return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#09090b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09090b;padding:40px 0;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#18181b;border:1px solid #27272a;border-radius:12px;overflow:hidden;">
        <tr><td style="padding:28px 32px 0;">
          <p style="margin:0 0 24px;font-size:22px;font-weight:700;color:#fafafa;">LiveClaw</p>
        </td></tr>
        <tr><td style="padding:0 32px 32px;">${body}</td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #27272a;background:#0f0f11;">
          <p style="margin:0;font-size:12px;color:#52525b;">LiveClaw &bull; <a href="https://liveclaw.xyz" style="color:#52525b;">liveclaw.xyz</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Send a transactional email via Resend.
 * Silently swallows errors — email delivery must never block webhook processing.
 *
 * OWASP: email validated, user data HTML-escaped before template render,
 *        API key read from env (never hardcoded), errors logged without PII.
 *
 * @param {object} log
 * @param {{ to: string, subject: string, html: string }} opts
 */
async function sendEmail(log, { to, subject, html }) {
    const apiKey = process.env.RESEND_API_KEY;
    const from   = process.env.RESEND_FROM || 'LiveClaw <noreply@notifications.liveclaw.xyz>';
    if (!apiKey || !EMAIL_RE.test(to)) return; // silently skip if unconfigured or bad address
    try {
        const res = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from, to, subject, html }),
        });
        if (!res.ok) {
            const body = await res.text();
            log.webhook.error('Resend delivery error', { status: res.status, code: body.slice(0, 120) });
        }
    } catch (err) {
        log.webhook.error('Resend fetch error', { code: err.message });
    }
}

/**
 * Creates the webhook router with all dependencies injected.
 *
 * @param {object} deps - Shared dependencies from server.js
 * @returns {express.Router}
 */
function createWebhookRouter(deps) {
    const {
        db,
        stmt,
        stmtSubs,
        logEvent,
        log,
        dodo,
        bifrost,
        asyncHandler,
        webhookLimiter,
        deactivateVirtualKeyWithRetry,
        spawnPicobot,
        decryptToken,
    } = deps;

    const router = express.Router();

    // ─── POST /webhook/dodo — Dodo Payments Lifecycle Webhook ───────────────────
    // Receives webhook events from Dodo Payments for subscription and payment lifecycle.
    // Events: subscription.active, subscription.on_hold, subscription.cancelled,
    //         subscription.plan_changed, subscription.renewed, payment.succeeded, payment.failed
    router.post('/webhook/dodo', webhookLimiter, asyncHandler(async (req, res) => {
        let event;
        try {
            // rawBody saved by express.json verify callback
            const rawBody = req.rawBody;
            if (!rawBody) {
                log.webhook.error('Missing raw body — cannot verify signature');
                return res.status(400).json({ error: 'Missing raw body' });
            }
            event = dodo.verifyWebhookEvent(rawBody, req.headers);
        } catch (err) {
            log.webhook.error('Signature verification failed', { error: err.message });
            return res.status(401).json({ error: 'Invalid webhook signature' });
        }

        const eventType = event.type;
        const data = event.data;
        log.webhook.info('Event received', { eventType });

        // ── Idempotency: deduplicate by webhook-id header ───────────────────
        const webhookId = req.headers['webhook-id'];
        let dedupKey = null;
        if (webhookId) {
            dedupKey = `dodo-${webhookId}`;
            if (await stmt.checkEvent(dedupKey)) {
                log.webhook.info('Duplicate webhook skipped', { dedupKey });
                return res.json({ received: true });
            }
            // Mark as processed immediately to prevent concurrent duplicates.
            // If processing fails below, the dedup record is cleared so retries work.
            await stmt.markEvent(dedupKey, data?.metadata?.liveclaw_user_id || 'system', 'dodo_webhook');
        }

        // Extract userId from subscription metadata
        const userId = data?.metadata?.liveclaw_user_id;
        const subId = data?.subscription_id;
        const customerId = data?.customer?.customer_id;

        try {

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

                    // ── Auto-restart bot on renewal if it was running/stopped ──
                    // On renewal: if user had a bot deployed (token in DB), restart it.
                    // On new activation: bot hasn't been deployed yet (no token in DB) —
                    // user will manually click Deploy after first setup.
                    if (eventType === 'subscription.renewed') {
                        try {
                            const bot = await stmt.getBot(target);
                            if (bot && bot.telegram_token && bot.bifrost_vk) {
                                const decryptedVk = decryptToken(bot.bifrost_vk);
                                const channelOpts = {
                                    telegramToken: bot.telegram_token ? decryptToken(bot.telegram_token) : undefined,
                                    discordToken: bot.discord_token ? decryptToken(bot.discord_token) : undefined,
                                    slackAppToken: bot.slack_app_token ? decryptToken(bot.slack_app_token) : undefined,
                                    slackBotToken: bot.slack_bot_token ? decryptToken(bot.slack_bot_token) : undefined,
                                };
                                // Kill old process if somehow still alive
                                try { process.kill(bot.pid, 'SIGTERM'); } catch (_) {}
                                const newPid = await spawnPicobot(target, decryptedVk, bot.model, channelOpts);
                                await stmt.updatePid(newPid, 'running', target);
                                logEvent(target, 'bot_auto_restarted_on_renewal', { newPid });
                                log.webhook.info('Bot auto-restarted on subscription renewal', { userId: target, newPid });
                            }
                        } catch (err) {
                            log.webhook.error('Auto-restart on renewal failed', { userId: target, error: err.message });
                        }
                    }

                    // ── Transactional email ──────────────────────────────────
                    const customerEmail = data?.customer?.email;
                    const nextDate = data?.next_billing_date
                        ? new Date(data.next_billing_date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
                        : null;

                    if (eventType === 'subscription.active') {
                        await sendEmail(log, {
                            to: customerEmail,
                            subject: 'Welcome to LiveClaw!',
                            html: emailWrapper(`
                                <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#fafafa;">You're in.</p>
                                <p style="margin:0 0 20px;font-size:15px;color:#a1a1aa;">Your LiveClaw subscription is active. Your personal AI agent is ready to deploy.</p>
                                <a href="https://liveclaw.xyz" style="display:inline-block;padding:12px 24px;background:#fafafa;color:#09090b;font-size:14px;font-weight:600;border-radius:8px;text-decoration:none;">Deploy your agent</a>
                                ${nextDate ? `<p style="margin:24px 0 0;font-size:13px;color:#71717a;">Next billing date: ${escHtml(nextDate)}</p>` : ''}
                            `),
                        });
                    } else {
                        // subscription.renewed
                        await sendEmail(log, {
                            to: customerEmail,
                            subject: 'LiveClaw subscription renewed',
                            html: emailWrapper(`
                                <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#fafafa;">Subscription renewed</p>
                                <p style="margin:0 0 20px;font-size:15px;color:#a1a1aa;">Your LiveClaw subscription has been renewed successfully.</p>
                                ${nextDate ? `<p style="margin:0 0 20px;font-size:14px;color:#a1a1aa;">Next billing date: <strong style="color:#fafafa;">${escHtml(nextDate)}</strong></p>` : ''}
                                <a href="https://liveclaw.xyz" style="display:inline-block;padding:12px 24px;background:#fafafa;color:#09090b;font-size:14px;font-weight:600;border-radius:8px;text-decoration:none;">Go to dashboard</a>
                            `),
                        });
                    }
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
                            deactivateVirtualKeyWithRetry(bot.bifrost_vk_id, target);
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

                    // ── Activate 48-hour trial if this was a trial product payment ──
                    if (plan === 'trial') {
                        const trialEndsAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
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

                    // ── Credits top-up: add budget to user's Bifrost VK ──
                    if (plan === 'credits') {
                        const creditAmountUsd = parseFloat(data?.metadata?.credit_amount_usd || '0');
                        if (creditAmountUsd > 0) {
                            const bot = await db.get('SELECT bifrost_vk_id, credit_limit FROM bots WHERE user_id = ?', [paymentUserId]);
                            if (bot && bot.bifrost_vk_id) {
                                try {
                                    await bifrost.topUpCredits(bot.bifrost_vk_id, bot.credit_limit, creditAmountUsd);
                                    await stmt.updateCredit(bot.credit_limit + creditAmountUsd, paymentUserId);
                                    logEvent(paymentUserId, 'credits_topped_up', { amount: creditAmountUsd, newLimit: bot.credit_limit + creditAmountUsd });
                                } catch (err) {
                                    log.webhook.error('Credit top-up failed', { userId: paymentUserId, error: err.message });
                                }
                            }
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
                    await sendEmail(log, {
                        to: data?.customer?.email,
                        subject: 'Action needed: LiveClaw payment failed',
                        html: emailWrapper(`
                            <p style="margin:0 0 8px;font-size:20px;font-weight:600;color:#fafafa;">Payment unsuccessful</p>
                            <p style="margin:0 0 20px;font-size:15px;color:#a1a1aa;">We couldn't process your LiveClaw subscription payment. Please update your payment method to keep your agent running.</p>
                            <a href="https://liveclaw.xyz" style="display:inline-block;padding:12px 24px;background:#fafafa;color:#09090b;font-size:14px;font-weight:600;border-radius:8px;text-decoration:none;">Update payment method</a>
                            <p style="margin:24px 0 0;font-size:13px;color:#71717a;">If you continue to have issues, contact us at support@liveclaw.xyz</p>
                        `),
                    });
                }
                break;
            }

            default:
                log.webhook.info('Unhandled event type', { eventType });
        }

        } catch (processingErr) {
            // Clear dedup record so Dodo can retry this webhook
            if (dedupKey) {
                try { await db.run('DELETE FROM processed_events WHERE event_id = ?', [dedupKey]); } catch (_) { /* best effort */ }
            }
            throw processingErr; // Re-throw so asyncHandler returns 500, triggering Dodo retry
        }

        return res.json({ received: true });
    }));

    return router;
}

module.exports = { createWebhookRouter };
