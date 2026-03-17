# LiveClaw — Security Audit & Product Readiness Assessment

**Last Updated:** March 16, 2026  
**Original Review:** March 6, 2026  
**Reviewer:** GitHub Copilot  
**Methodology:** OWASP Top 10 (2021), Node.js security best practices, full-stack review

---

## March 16, 2026 Security Delta (Comprehensive Re-audit)

### New Findings (Validated)

| ID | Severity | Finding | Location | Status |
|----|----------|---------|----------|--------|
| S-2026-01 | High | `adminAuth` could fall through in non-prod when `ADMIN_SECRET` was unset | [backend/server.js](backend/server.js#L1839) | Fixed |
| S-2026-02 | Medium | Hardcoded JWT fallback (`dev-secret`) for admin bearer auth | [backend/server.js](backend/server.js#L1844) | Fixed |
| S-2026-03 | Medium | Token encryption key validation was too lax (`< 32` chars, no strict hex validation) | [backend/server.js](backend/server.js#L228) | Fixed |
| S-2026-04 | Medium | `decryptToken` had no guarded failure path for malformed encrypted payloads | [backend/server.js](backend/server.js#L247) | Fixed |
| S-2026-05 | Medium | Shell command interpolation for per-user disk usage in admin telemetry (`du` via shell string) | [backend/server.js](backend/server.js#L2042) | Fixed |
| S-2026-06 | Medium | Path traversal hardening missing in local static admin server | [admin-server.js](admin-server.js#L54) | Fixed |
| S-2026-07 | Low (Dev-only) | `flatted` transitive dev dependency advisory (GHSA-25h7-pfq9-p65f) | [backend/package.json](backend/package.json) | Mitigated via override |
| S-2026-08 | Medium (Non-prod model) | User auth middleware allowed unauthenticated requests by default outside production | [backend/server.js](backend/server.js#L217) | Fixed |

### Implemented Remediations

- Hardened `adminAuth` to require valid admin credentials consistently; removed permissive non-prod fallthrough.
- Removed admin JWT fallback secret and now require explicit `ADMIN_JWT_SECRET` for bearer-based admin sessions.
- Enforced strict `TOKEN_ENCRYPTION_KEY` format (`64` hex chars). Non-production now warns once on insecure fallback.
- Added safe decryption error handling path for malformed encrypted token payloads.
- Replaced shell-interpolated `du` command with `execFileSync('du', ['-sk', ...])` argument form.
- Added explicit static-root boundary check in local admin server using `path.resolve(...)` containment.
- Added npm `overrides` for `flatted` to move to patched range.
- Made non-production user auth bypass opt-in via `ALLOW_DEV_AUTH_BYPASS` (default deny).
- Made non-production admin login fallback opt-in via `ALLOW_DEV_ADMIN_LOGIN_FALLBACK` with required 6-digit `ADMIN_DEV_TOTP_CODE`.
- Enforced user/token identity checks whenever `req.verifiedUserId` is present, regardless of environment.

### Residual Risk / Deferred Items

- Non-production bypass modes remain available for local workflows, but now require explicit env opt-in and are startup-warned.
- Test suites currently opt into non-production bypass in `tests/setup.js`; this is intentional for integration coverage and should stay test-only.

---

## Executive Summary

| Category | Score | Verdict |
|----------|-------|---------|
| **Security** | 8.5/10 | Strong — 4 real issues fixed this session |
| **Code Quality** | 8.5/10 | Consistent async patterns, thorough error handling |
| **Test Coverage** | 7/10 | 96/96 pass, ~68% line coverage |
| **Product Completeness** | 8.5/10 | Backend complete, payments wired, CI/CD ready |
| **Infrastructure** | 9/10 | Managed PG + firewall, deployable end-to-end |

**Overall Verdict: READY for initial production deployment.** All critical/high blocking issues resolved. Remaining items are medium/low priority and do not block launch.

---

## Current Severity Summary

| Severity | Count | Notes |
|----------|-------|-------|
| **Critical** | 0 | — |
| **High** | 0 | All resolved |
| **Medium** | 3 | Fix within launch sprint |
| **Low** | 5 | Fix when convenient |
| **Info** | 4 | Best-practice recommendations |

---

## Issues Resolved (March 6 → March 9, 2026)

| ID | Issue | Resolution |
|----|-------|------------|
| C1 | Mini-App still serves AppLixir flow | Removed entirely |
| C2 | Webhook missing auth for Stars/AppLixir | Removed |
| H1 | `earlyBirdRemaining` hardcoded to 200 | Now DB-queried; 500-spot cap on confirmed payers |
| H2 | No webhook idempotency for Dodo events | `processed_events` table + `webhook-id` dedup |
| H3 | Admin routes exposed in dev without auth | Accepted dev behaviour; prod enforces ADMIN_SECRET |
| H4 | Admin revenue ignores Dodo payments table | `/admin/revenue` now reads `payments` table |
| H5 | CI only runs api.test.js (not subscription.test.js) | `test:integration` updated; lint now covers dodo.js |
| **NEW** | **SSRF via user-supplied MCP server URLs** | **Fixed — `isPrivateUrl()` blocks loopback/RFC-1918/metadata** |
| **NEW** | **EARLYCLAW race condition under PostgreSQL** | **Fixed — atomic `UPDATE … WHERE early_bird = 0 AND (SELECT COUNT(*)) < 500`** |
| **NEW** | **Modulo bias in beta code generation** | **Fixed — rejection sampling for uniform distribution** |
| **NEW** | **`state.botPid` unescaped in dashboard innerHTML** | **Fixed — wrapped in `escapeHtml()`** |
| M3 | `_resetClient()` exported in production | Fixed — conditional export: `NODE_ENV === 'test'` only |
| L4 | `.env` templates missing Dodo/DB vars | Fixed — CI bootstrap template updated |
| L8 | `fetchSubscription()` missing auth header | Fixed — `Authorization: Bearer` header sent |

---

## Remaining Medium Findings

### [M1] Telegram Token Written to Disk in Plaintext
**Severity:** Medium  
**Category:** OWASP A02 · Cryptographic Failures  
**File:** `backend/server.js` — `spawnPicobot()`

The token is stored AES-256-GCM encrypted in the database, but `spawnPicobot()` writes the plaintext token into `{botsDir}/{userId}/.picobot/config.json` for picobot to read.

**Impact:** Filesystem compromise (without DB key) exposes all user bot tokens.

**Fix:**
```js
fs.chmodSync(path.join(configDir, 'config.json'), 0o600);
fs.chmodSync(configDir, 0o700);
fs.chmodSync(userDir, 0o700);
```
Add after `fs.writeFileSync()` in `spawnPicobot()`.

---

### [M2] Picobot Binary Downloaded Without Integrity Verification
**Severity:** Medium  
**Category:** OWASP A08 · Software and Data Integrity Failures  
**Files:** `deploy.sh`, `scripts/deploy-backend.sh`

```bash
curl -fSL -o picobot "https://github.com/louisho5/picobot/releases/latest/download/picobot_linux_amd64"
```
No SHA256 checksum verification before `chmod +x`.

**Fix:** Download accompanying `.sha256` file and verify before executing:
```bash
curl -fSL -o picobot.sha256 ".../picobot_linux_amd64.sha256"
echo "$(cat picobot.sha256)  picobot.tmp" | sha256sum -c - || { rm picobot.tmp; exit 1; }
```

---

### [M3] `execSync` with Template Literal Containing DB-Sourced PID
**Severity:** Medium (defense-in-depth)  
**Category:** OWASP A03 · Injection  
**Files:** `backend/server.js` — `/admin/stats`, `/admin/system`, watchdog

```js
execSync(`ps -o rss= -p ${bot.pid} 2>/dev/null`, { timeout: 1000 })
```

`bot.pid` is always an INTEGER from the database and from `child.pid`. Safe in practice, but the pattern is dangerous if the source ever changes.

**Fix:** Use `spawnSync` with args as array (no shell interpolation):
```js
const result = spawnSync('ps', ['-o', 'rss=', '-p', String(parseInt(bot.pid, 10))], { timeout: 1000 });
rssKB = parseInt(result.stdout?.toString().trim(), 10);
```

---

## Remaining Low Findings

### [L1] `/health` Exposes System Details Publicly
The public `/health` endpoint returns version, picobot version, bot count, memory %, disk %. Attackers can fingerprint system state and timing.

**Fix:** Return only `{ status, ts }` from `/health`. Move detailed metrics behind `adminAuth` (already in `/admin/system`).

---

### [L2] Admin Actions Don't Log the Admin's IP
```js
logEvent(userId, 'bot_admin_stopped', { admin: true }); // no IP
```
**Fix:** Pass `req.ip` to `logEvent()` for admin stop/credit actions.

---

### [L3] MCP Server User-Provided Headers Not Validated
```js
if (server.headers && typeof server.headers === 'object') {
    safeMcpServers[name].headers = server.headers;
}
```
No constraints on header names/count/values. Low risk (user controls their own picobot only).

**Fix:** Allowlist header key names: `/^[a-zA-Z0-9-]{1,64}$/`, cap at 10 headers.

---

### [L4] Synchronous `execSync` Calls Block Event Loop
`execSync('df ...')` in `/health`, `/admin/stats`, `/admin/system` blocks the Node.js event loop during execution. Under high request concurrency this causes latency spikes.

**Fix:** Replace with `spawnSync` (already done for `ps`) or cache disk stats with a 30s TTL.

---

### [L5] `idToken` Persisted in `localStorage`
The Google ID token is persisted to `localStorage`. If XSS is achieved via third-party scripts, the token is readable. ID tokens expire in 1 hour, limiting the window.

**Fix:** Store only metadata (userId, userName, etc.) in localStorage. Keep the live `idToken` in memory only; re-prompt Google sign-in after page refresh.

---

## Informational

### [I1] No Structured JSON Logging
`console.log('[tag] ...')` works but doesn't integrate with Loki/Datadog. Consider `pino`.

### [I2] No Content-Security-Policy Header
Helmet defaults set `X-Content-Type-Options` etc., but no CSP. Add at minimum:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'`

### [I3] Webhook Replay Protection (Timestamp Validation)
Dodo sends `webhook-timestamp` headers. Validate within ±5 minutes of `Date.now()` to prevent replay of expired but valid signatures.

### [I4] DigitalOcean Managed PG Backup Verification
DO Managed PG has daily automated backups (7-day retention). Verify this is enabled in the DO dashboard and consider enabling Point-in-Time Recovery (PITR).

---

## Test Coverage

```
Tests: 96/96 passing (3 test files)
Line coverage: ~68% (server.js: ~67%, bifrost.js: 100%)
```

**Untested areas:**
- `spawnPicobot()` — needs real binary
- `isPrivateUrl()` — newly added, should have unit tests
- Watchdog timer — only runs outside test mode
- Webhook branches: `subscription.on_hold`, `plan_changed`, `expired`, `payment.failed`

**Target:** 80% before beta launch.

---

## Dependency Health

```
npm audit (production deps): 0 vulnerabilities
```

All production dependencies are current (`express` 5.2.1, `helmet` 8.1.0, `pg`, `better-sqlite3` 12.6.2, `dodopayments` 2.23.1).

---

## Infrastructure Summary

| Resource | Spec | Cost | Status |
|----------|------|------|--------|
| Droplet `liveclaw-prod` | s-2vcpu-8gb-160gb-intel, nyc3, `104.248.11.29` | $48/mo | Active |
| Managed PG `liveclaw-db` | PostgreSQL 17, 1 vCPU / 1 GB, nyc3 | $15/mo | Online |
| DB Firewall | Droplet-only access | — | Applied |
| **Total** | | **$63/mo** | ~3.2 months on $200 credit |

---

## Pre-Deploy Checklist

- [ ] Add `DO_DROPLET_IP`, `DO_SSH_KEY`, `DATABASE_URL` to GitHub repo secrets
- [ ] SSH into droplet, copy `.env` (one-time bootstrap)
- [ ] `pm2 reload liveclaw-orchestrator --update-env` after `.env` is set
- [ ] Confirm managed PG tables created on first server start
- [ ] Set Dodo webhook URL to `https://api.liveclaw.xyz/webhook/dodo`
- [ ] Verify DO Managed PG automated backups are enabled
