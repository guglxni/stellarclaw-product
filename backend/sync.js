/**
 * Dodo Payments — Database Sync Module
 *
 * Syncs payments, customers, subscriptions, and licences from Dodo Payments
 * into a local database using the `dodo-sync` package.
 *
 * Supports MongoDB, PostgreSQL, MySQL, and ClickHouse.
 *
 * Usage:
 *   Standalone:  node sync.js              (one-shot sync)
 *   Continuous:  node sync.js --interval   (repeating sync loop)
 *   Programmatic: require('./sync').startSync()
 */

'use strict';

require('dotenv').config();

const { DodoSync } = require('dodo-sync');

const SYNC_DATABASE = process.env.DODO_SYNC_DATABASE || 'postgres';
const SYNC_DATABASE_URI = process.env.DODO_SYNC_DATABASE_URI || '';
const SYNC_INTERVAL = parseInt(process.env.DODO_SYNC_INTERVAL, 10) || 600;
const SYNC_SCOPES = (process.env.DODO_SYNC_SCOPES || 'payments,customers,subscriptions').split(',');
const DODO_API_KEY = process.env.DODO_API_KEY || '';
const DODO_ENV = process.env.NODE_ENV === 'production' ? 'live_mode' : 'test_mode';

/**
 * Run a single one-shot sync.
 */
async function runOnce() {
    if (!SYNC_DATABASE_URI) {
        console.warn('[dodo-sync] DODO_SYNC_DATABASE_URI not set — skipping sync');
        return;
    }
    const sync = new DodoSync({
        database: SYNC_DATABASE,
        databaseURI: SYNC_DATABASE_URI,
        scopes: SYNC_SCOPES,
        dodoPaymentsOptions: {
            bearerToken: DODO_API_KEY,
            environment: DODO_ENV,
        },
    });
    await sync.init();
    await sync.run();
    console.log('[dodo-sync] One-shot sync complete');
}

/**
 * Start a continuous sync loop at DODO_SYNC_INTERVAL seconds.
 */
async function startSync() {
    if (!SYNC_DATABASE_URI) {
        console.warn('[dodo-sync] DODO_SYNC_DATABASE_URI not set — skipping sync');
        return null;
    }
    const sync = new DodoSync({
        interval: SYNC_INTERVAL,
        database: SYNC_DATABASE,
        databaseURI: SYNC_DATABASE_URI,
        scopes: SYNC_SCOPES,
        dodoPaymentsOptions: {
            bearerToken: DODO_API_KEY,
            environment: DODO_ENV,
        },
    });
    await sync.init();
    sync.start();
    console.log(`[dodo-sync] Continuous sync started — every ${SYNC_INTERVAL}s, scopes: ${SYNC_SCOPES.join(', ')}`);
    return sync;
}

// ─── CLI entrypoint ─────────────────────────────────────────────────────────
if (require.main === module) {
    const continuous = process.argv.includes('--interval');
    (continuous ? startSync() : runOnce()).catch(err => {
        console.error('[dodo-sync] Fatal:', err);
        process.exit(1);
    });
}

module.exports = { runOnce, startSync };
