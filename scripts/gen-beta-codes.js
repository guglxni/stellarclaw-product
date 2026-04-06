#!/usr/bin/env node
/**
 * Generate 100 beta access codes for LiveClaw.
 * Usage (offline only): node scripts/gen-beta-codes.js --allow-unsynced > beta-codes.txt
 *
 * IMPORTANT:
 * - This script only generates local codes.
 * - It does NOT create Dodo discounts.
 * - Production codes must be created via backend admin API so they are synced
 *   to Dodo as 100% discounts with usage_limit=1.
 */
'use strict';

const crypto = require('crypto');

if (!process.argv.includes('--allow-unsynced')) {
    process.stderr.write([
        'Refusing to generate UNSYNCED beta codes without explicit flag.',
        'Use one of these production-safe flows instead:',
        '  1) POST /admin/beta-codes/generate (creates DB + Dodo discounts)',
        '  2) POST /admin/beta-codes/import with explicit code list',
        'If you still want offline-only local generation, run:',
        '  node scripts/gen-beta-codes.js --allow-unsynced > beta-codes.txt',
        '',
    ].join('\n'));
    process.exit(1);
}

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ACCEPT_LIMIT = Math.floor(256 / CHARSET.length) * CHARSET.length;

function getUnbiasedChar() {
    while (true) {
        const [b] = crypto.randomBytes(1);
        if (b < ACCEPT_LIMIT) return CHARSET[b % CHARSET.length];
    }
}

function generateCode() {
    const segments = [];
    for (let s = 0; s < 3; s++) {
        let seg = '';
        for (let i = 0; i < 4; i++) seg += getUnbiasedChar();
        segments.push(seg);
    }
    return segments.join('-');
}

const codes = new Set();
while (codes.size < 100) codes.add(generateCode());
const list = [...codes];

const lines = [
    '# LiveClaw Beta Access Codes (Offline, Unsynced)',
    `# Generated: ${new Date().toISOString()}`,
    '# Format: XXXX-XXXX-XXXX (12 alphanumeric chars)',
    '# Total: 100 codes',
    '# Usage: Enter at liveclaw.xyz to get first month for $0.99 (via Dodo checkout)',
    '#',
    '# WARNING: These codes are NOT synced to Dodo Payments by this script.',
    '# Register them via POST /admin/beta-codes/import before production use.',
    '#',
    '# To activate on production: POST /admin/beta-codes/generate',
    '# Or paste these codes into the Admin Dashboard > Beta Codes tab.',
    '#',
    '# ─────────────────────────────────────────────────────────────',
    '',
];

for (let i = 0; i < list.length; i++) {
    lines.push(`${String(i + 1).padStart(3, ' ')}. ${list[i]}`);
}

lines.push('');
lines.push('# ─────────────────────────────────────────────────────────────');
lines.push(`# JSON array for programmatic use:`);
lines.push(`# ${JSON.stringify(list)}`);

process.stdout.write(lines.join('\n') + '\n');
