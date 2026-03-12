#!/usr/bin/env node
/**
 * Generate 100 beta access codes for LiveClaw.
 * Usage: node scripts/gen-beta-codes.js > beta-codes.txt
 */
'use strict';

const crypto = require('crypto');

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
    '# LiveClaw Beta Access Codes',
    `# Generated: ${new Date().toISOString()}`,
    '# Format: XXXX-XXXX-XXXX (12 alphanumeric chars)',
    '# Total: 100 codes',
    '# Usage: Enter at liveclaw.xyz to get 24h free trial ($0.00 via Dodo checkout)',
    '#',
    '# These codes are synced to Dodo Payments as 100% discount coupons',
    '# restricted to the Trial product (usage_limit=1 per code).',
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
