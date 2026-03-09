#!/usr/bin/env node
/**
 * LiveClaw — Set Telegram Webhook
 *
 * Registers the production webhook URL with Telegram's Bot API so that
 * payment events (successful_payment / pre_checkout_query) are forwarded
 * to our orchestrator at /webhook/telegram-stars.
 *
 * Usage:
 *   node scripts/set-webhook.js                       # uses .env values
 *   node scripts/set-webhook.js --delete              # removes the webhook
 *   DOMAIN_NAME=https://liveclaw.xyz node scripts/set-webhook.js
 *
 * Requires: TELEGRAM_MASTER_BOT_TOKEN and DOMAIN_NAME in .env or environment.
 */

'use strict';

// Load env from backend/.env (canonical location), fall back to root .env
const path = require('path');
const fs   = require('fs');

const backendEnv = path.resolve(__dirname, '..', 'backend', '.env');
const rootEnv    = path.resolve(__dirname, '..', '.env');
const envPath    = fs.existsSync(backendEnv) ? backendEnv : rootEnv;

require('dotenv').config({ path: envPath });

const BOT_TOKEN = process.env.TELEGRAM_MASTER_BOT_TOKEN;
const DOMAIN = process.env.DOMAIN_NAME;
const DELETE_MODE = process.argv.includes('--delete');

// ─── Validation ─────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_MASTER_BOT_TOKEN is not set.');
    console.error('   Set it in .env or pass as environment variable.');
    process.exit(1);
}

if (!DELETE_MODE && !DOMAIN) {
    console.error('❌ DOMAIN_NAME is not set.');
    console.error('   Example: DOMAIN_NAME=https://liveclaw.xyz');
    process.exit(1);
}

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
    if (DELETE_MODE) {
        console.log('🗑  Deleting webhook...');
        const res = await fetch(`${TG_API}/deleteWebhook`);
        const data = await res.json();
        console.log(data.ok ? '✅ Webhook deleted.' : `❌ Failed: ${data.description}`);
        return;
    }

    const webhookUrl = `${DOMAIN}/api/webhook/telegram-stars`;
    console.log(`🔗 Setting webhook to: ${webhookUrl}`);

    const res = await fetch(`${TG_API}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            url: webhookUrl,
            allowed_updates: ['message', 'pre_checkout_query'],
            drop_pending_updates: true,
            secret_token: process.env.ADMIN_SECRET || undefined, // optional extra auth
        }),
    });

    const data = await res.json();

    if (data.ok) {
        console.log('✅ Webhook registered successfully!');
    } else {
        console.error(`❌ Telegram API error: ${data.description}`);
        process.exit(1);
    }

    // Verify
    console.log('\n📋 Verifying current webhook info...');
    const infoRes = await fetch(`${TG_API}/getWebhookInfo`);
    const info = await infoRes.json();

    if (info.ok) {
        console.log(`   URL:              ${info.result.url || '(none)'}`);
        console.log(`   Pending updates:  ${info.result.pending_update_count}`);
        console.log(`   Last error:       ${info.result.last_error_message || '(none)'}`);
        console.log(`   Allowed updates:  ${(info.result.allowed_updates || []).join(', ') || '(all)'}`);
        console.log(`   Max connections:  ${info.result.max_connections || 40}`);
    }
}

main().catch((err) => {
    console.error('❌ Unexpected error:', err.message);
    process.exit(1);
});
