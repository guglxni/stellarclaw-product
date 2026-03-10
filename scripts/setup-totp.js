#!/usr/bin/env node
/**
 * LiveClaw — TOTP Setup
 *
 * Generates a TOTP secret + JWT signing key for the admin dashboard.
 * Run once, then add the printed values to backend/.env.
 *
 *   node scripts/setup-totp.js
 */
'use strict';

const { TOTP, Secret } = require('../backend/node_modules/otpauth');
const crypto = require('crypto');

const secret = new Secret({ size: 20 }); // 160-bit → 32 base32 chars
const totp = new TOTP({
    issuer: 'LiveClaw',
    label: 'LiveClaw Admin',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
});

const jwtSecret = crypto.randomBytes(32).toString('hex');
const uri = totp.toString(); // otpauth://totp/...

console.log('\n🦀  LiveClaw TOTP Setup\n');
console.log('───────────────────────────────────────────────────────');
console.log('Step 1 — Scan into your authenticator (iPhone Passwords,');
console.log('         Google Authenticator, Authy, 1Password, etc.)');
console.log('');
console.log('  Option A: Open this URL in Safari/Chrome to see a QR code:');
console.log('  https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=' + encodeURIComponent(uri));
console.log('');
console.log('  Option B: Copy the otpauth URI and paste it into your app:');
console.log('  ' + uri);
console.log('');
console.log('───────────────────────────────────────────────────────');
console.log('Step 2 — Add these two lines to backend/.env:\n');
console.log('ADMIN_TOTP_SECRET=' + secret.base32);
console.log('ADMIN_JWT_SECRET=' + jwtSecret);
console.log('');
console.log('───────────────────────────────────────────────────────');
console.log('Step 3 — Restart the backend:');
console.log('  Local: kill the node process and start it again');
console.log('  Prod:  pm2 reload liveclaw-orchestrator --update-env');
console.log('');
console.log('Current TOTP code (valid for ~30s): ' + totp.generate());
console.log('───────────────────────────────────────────────────────\n');
