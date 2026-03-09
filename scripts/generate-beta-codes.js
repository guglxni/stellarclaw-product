#!/usr/bin/env node
/**
 * LiveClaw — Generate Beta Access Codes
 *
 * Calls POST /admin/beta-codes/generate on the running server to generate
 * 100 cryptographically random XXXX-XXXX-XXXX beta codes and prints them.
 *
 * Usage:
 *   node scripts/generate-beta-codes.js                         # localhost:3000
 *   node scripts/generate-beta-codes.js --url https://api.liveclaw.xyz
 *   node scripts/generate-beta-codes.js --output codes.txt      # save to file
 *   ADMIN_SECRET=xxx node scripts/generate-beta-codes.js
 *
 * Requires: ADMIN_SECRET in backend/.env or environment.
 */

'use strict';

const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const http   = require('http');

// ─── Load .env ───────────────────────────────────────────────────────────────
const backendEnv = path.resolve(__dirname, '..', 'backend', '.env');
const rootEnv    = path.resolve(__dirname, '..', '.env');
const envPath    = fs.existsSync(backendEnv) ? backendEnv : rootEnv;

// Resolve dotenv from backend's node_modules (scripts/ has no own deps)
const dotenvPath = path.resolve(__dirname, '..', 'backend', 'node_modules', 'dotenv');
require(dotenvPath).config({ path: envPath });

// ─── Args ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const urlFlag    = args.indexOf('--url');
const outputFlag = args.indexOf('--output');

const BASE_URL  = urlFlag    !== -1 ? args[urlFlag + 1]    : 'http://localhost:3000';
const OUT_FILE  = outputFlag !== -1 ? args[outputFlag + 1] : null;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

// ─── Validation ──────────────────────────────────────────────────────────────
if (!ADMIN_SECRET) {
    console.error('❌  ADMIN_SECRET is not set.');
    console.error('    Set it in backend/.env or pass as: ADMIN_SECRET=xxx node scripts/generate-beta-codes.js');
    process.exit(1);
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────
function post(urlString, headers) {
    return new Promise((resolve, reject) => {
        const url     = new URL(urlString);
        const driver  = url.protocol === 'https:' ? https : http;
        const options = {
            hostname: url.hostname,
            port:     url.port || (url.protocol === 'https:' ? 443 : 80),
            path:     url.pathname,
            method:   'POST',
            headers:  { 'Content-Length': '0', ...headers },
        };
        const req = driver.request(options, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, body: JSON.parse(body) });
                } catch {
                    resolve({ status: res.statusCode, body });
                }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
    const endpoint = `${BASE_URL}/admin/beta-codes/generate`;
    console.log(`\n🦀 LiveClaw — Beta Code Generator`);
    console.log(`   Endpoint: ${endpoint}\n`);

    let result;
    try {
        result = await post(endpoint, { 'x-admin-secret': ADMIN_SECRET });
    } catch (err) {
        console.error(`❌  Request failed: ${err.message}`);
        console.error('    Is the server running? Use --url to specify a different host.');
        process.exit(1);
    }

    if (result.status !== 200) {
        console.error(`❌  Server returned HTTP ${result.status}:`);
        console.error('   ', JSON.stringify(result.body, null, 2));
        process.exit(1);
    }

    const { created, total, available, codes } = result.body;

    console.log(`✅  ${created > 0 ? `Created ${created} new code(s).` : 'No new codes needed — already at target.'}`);
    console.log(`   Total: ${total}  |  Used: ${total - available}  |  Available: ${available}\n`);

    // Print all available (unclaimed) codes
    const unclaimed = codes.filter((c) => !c.redeemed_by);
    if (unclaimed.length === 0) {
        console.log('⚠️   All codes have already been redeemed.');
    } else {
        console.log(`─── ${unclaimed.length} Available Code(s) ──────────────────────────────────`);
        for (const c of unclaimed) {
            console.log(`  ${c.code}`);
        }
        console.log('─────────────────────────────────────────────────────────────\n');

        // Optionally save to file
        if (OUT_FILE) {
            const outPath = path.resolve(OUT_FILE);
            fs.writeFileSync(
                outPath,
                unclaimed.map((c) => c.code).join('\n') + '\n',
                'utf8'
            );
            console.log(`📄  Saved ${unclaimed.length} code(s) to: ${outPath}\n`);
        }
    }

    // Print redeemed codes summary
    const redeemed = codes.filter((c) => c.redeemed_by);
    if (redeemed.length > 0) {
        console.log(`─── ${redeemed.length} Redeemed Code(s) ───────────────────────────────────`);
        for (const c of redeemed) {
            const when = c.redeemed_at ? new Date(c.redeemed_at).toLocaleString() : 'unknown';
            console.log(`  ${c.code}  →  user: ${c.redeemed_by.slice(0, 16)}...  (${when})`);
        }
        console.log('─────────────────────────────────────────────────────────────\n');
    }
}

main().catch((err) => {
    console.error(`\n❌  Unexpected error: ${err.message}`);
    process.exit(1);
});
