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
        if (webhookId) {
            const dedupKey = `dodo-${webhookId}`;
            if (await stmt.checkEvent(dedupKey)) {
                log.webhook.info('Duplicate webhook skipped', { dedupKey });
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
                log.webhook.info('Unhandled event type', { eventType });
        }

        return res.json({ received: true });
    }));

    return router;
}

module.exports = { createWebhookRouter };
