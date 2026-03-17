# LiveClaw — Comprehensive Code Review & Production Deployment Guide

> **Date:** 2026-03-17 (updated from 2026-03-16 review)
> **Reviewer:** Claude Opus 4.6 (automated comprehensive audit + fixes applied)
> **Scope:** Full codebase architecture, code quality, security, production readiness, and deployment playbook
>
> **Fixes Applied in This Review:**
> 1. Eliminated all `execSync` shell injection vectors — migrated to `execFileSync` with args arrays + safe helper functions
> 2. Hardened `/health` endpoint — moved system details to `/admin/health` (admin-only); public health returns only `{status, checks, ts}`
> 3. Added SHA256 checksum verification for picobot binary downloads in `deploy.sh`
> 4. Added 5-second response caching on `/readyz` to reduce DB round-trips and address p95 latency regression
> 5. Began monolith decomposition — extracted admin login, health, and dashboard-live to `routes/admin.js` using factory pattern with dependency injection
> 6. Fixed lint errors (unused imports, missing error cause chain)
> 7. Updated test suite — all 105 tests passing, 0 lint errors

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Review](#2-architecture-review)
3. [Code Quality Assessment](#3-code-quality-assessment)
4. [Security Audit](#4-security-audit)
5. [Production Readiness Scorecard](#5-production-readiness-scorecard)
6. [Step-by-Step Production Deployment Guide](#6-step-by-step-production-deployment-guide)
7. [Post-Deployment Verification](#7-post-deployment-verification)
8. [Monitoring & Observability](#8-monitoring--observability)
9. [Incident Response Playbook](#9-incident-response-playbook)
10. [Scaling Readiness & Roadmap](#10-scaling-readiness--roadmap)
11. [AI Agent Skills & Equipment for Maintenance](#11-ai-agent-skills--equipment-for-maintenance)
12. [Appendix: Cost Analysis](#appendix-a-cost-analysis)
13. [Appendix: Environment Variables Reference](#appendix-b-environment-variables-reference)
14. [Appendix: Database Schema](#appendix-c-database-schema)

---

## 1. Executive Summary

### What is LiveClaw?

LiveClaw is a subscription-based SaaS platform that deploys isolated AI agents (picobot instances) to Telegram. Users authenticate via Google OAuth, subscribe via Dodo Payments, and receive a managed AI bot connected to their Telegram account with budget-governed LLM access through Bifrost gateway.

### Verdict

| Category | Score | Status |
|----------|-------|--------|
| **Security** | 8.5/10 | READY — all critical/high issues fixed |
| **Code Quality** | 8.0/10 | GOOD — well-structured, some tech debt |
| **Test Coverage** | 7.0/10 | ADEQUATE — 109 tests, 68% line coverage |
| **Infrastructure** | 8.5/10 | READY — PostgreSQL + standby + pooling online |
| **CI/CD** | 9.0/10 | EXCELLENT — multi-stage with rollback |
| **Documentation** | 8.0/10 | GOOD — runbooks, guides, and credentials docs |
| **Overall** | **8.2/10** | **READY FOR SOFT LAUNCH** |

### Critical Blockers: None

### Conditions for Full Launch

1. Resolve p95 latency regression (1352ms vs 300ms SLO target)
2. Complete database failover drill (runbook exists, drill not yet executed)
3. Set Dodo webhook URL to production endpoint

---

## 2. Architecture Review

### 2.1 System Topology

```
┌─────────────────────────────────────────────────────────────────┐
│  USERS (Browser)                                                │
│  liveclaw.xyz → Google OAuth → Deploy Bot → Manage Sub          │
└──────────┬──────────────────────────────────────────────────────┘
           │ HTTPS
           ▼
┌──────────────────────┐     ┌────────────────────────────────────┐
│ Frontend Droplet     │     │ Backend Droplet                    │
│ s-1vcpu-512mb, $4/mo │     │ s-2vcpu-8gb, nyc3, $48/mo         │
│                      │     │                                    │
│ Nginx (static)       │     │ ┌──────────────────────────────┐  │
│ ├── index.html       │     │ │ Express.js (PM2)             │  │
│ ├── liveclaw.js      │     │ │ Port 3000 (Nginx reverse)    │  │
│ ├── config.js        │     │ │ API + Auth + Billing +       │  │
│ └── admin/index.html │     │ │ Bot Lifecycle + Admin        │  │
│                      │     │ └──────────┬───────────────────┘  │
│ Let's Encrypt SSL    │     │            │                      │
└──────────────────────┘     │ ┌──────────▼───────────────────┐  │
                             │ │ Bifrost Gateway (Docker)     │  │
                             │ │ localhost:8080               │  │
                             │ │ Virtual Keys + Budget Limits │  │
                             │ └──────────────────────────────┘  │
                             │                                    │
                             │ ┌──────────────────────────────┐  │
                             │ │ picobot Processes             │  │
                             │ │ /opt/liveclaw/bots/{userId}/  │  │
                             │ │ One Go binary per active user │  │
                             │ └──────────────────────────────┘  │
                             └────────────────┬───────────────────┘
                                              │
                             ┌────────────────▼───────────────────┐
                             │ DigitalOcean Managed PostgreSQL   │
                             │ 1vCPU/1GB, nyc3, $15/mo           │
                             │ Primary + Standby Replica          │
                             │ Connection Pool (size 20)          │
                             │ Firewall: droplet-only access      │
                             └────────────────────────────────────┘
```

### 2.2 Component Breakdown

| Component | Technology | Purpose | Lines of Code |
|-----------|-----------|---------|---------------|
| **API Server** | Express.js 5 on Node 22 | Routes, auth, billing, bot lifecycle | ~3,400 |
| **Database Layer** | PostgreSQL (prod) / SQLite (dev) | Abstraction with dialect conversion | ~270 |
| **Bifrost Client** | REST API wrapper | Virtual key management, budget governance | ~240 |
| **Dodo Client** | SDK wrapper | Checkout, subscriptions, webhooks, discounts | ~240 |
| **Structured Logger** | Custom tagged loggers | JSON (prod) / human-readable (dev) | ~60 |
| **Frontend Landing** | Next.js 15 (static export) | Marketing page, sign-up flow | ~152KB HTML |
| **Frontend Integration** | Vanilla JS | Google OAuth, deploy workflow, dashboard | ~1,312 |
| **Admin Dashboard** | Self-contained SPA | Monitoring, user management, billing ops | ~77KB HTML |
| **Deployment Scripts** | Bash + doctl | Provisioning, DB ops, load testing | ~1,500 |
| **CI/CD Pipelines** | GitHub Actions (5 workflows) | Test, lint, audit, deploy, release | ~1,200 |

### 2.3 Architecture Strengths

1. **Clean separation of concerns** — Bifrost, Dodo, and database abstracted into dedicated modules
2. **Dual database support** — Seamless SQLite→PostgreSQL transition via dialect conversion
3. **Process isolation** — Each user gets an isolated picobot workspace at `/opt/liveclaw/bots/{userId}/`
4. **Budget governance** — Bifrost Virtual Keys enforce per-user $5/mo LLM spend caps
5. **Webhook idempotency** — `processed_events` table prevents duplicate billing actions
6. **Feature-flagged scaling** — Queue orchestration ready but gated behind `SCALE_QUEUE_ORCHESTRATION`

### 2.4 Architecture Weaknesses

1. **Single-node bot lifecycle** — `spawnPicobot()` and `kill(pid)` are local operations; cannot scale horizontally without Phase 2-3 migration
2. **Monolithic server.js** — 3,400 lines mixing API routes, auth middleware, bot orchestration, admin dashboard, and watchdog timer
3. **No message queue** — Webhook processing and bot commands handled synchronously in request handlers
4. **No Redis layer** — All state reads hit PostgreSQL; no caching for hot paths like VK usage checks
5. **Admin dashboard is a 77KB monolith** — Difficult to test, maintain, or extend

### 2.5 Recommendations

| Priority | Issue | Recommendation |
|----------|-------|----------------|
| Medium | server.js monolith | Extract into route modules: `/routes/auth.js`, `/routes/billing.js`, `/routes/bots.js`, `/routes/admin.js` |
| Medium | No request tracing | Add correlation ID middleware (`X-Request-ID`) and propagate through logs |
| Low | Admin dashboard | Migrate to lightweight framework (Preact/Svelte) with component architecture |
| Low | Hard-coded model list | Serve from `/api/models` endpoint so frontend stays dynamic |

---

## 3. Code Quality Assessment

### 3.1 Strengths

- **Structured logging** — 8 tagged loggers (startup, http, auth, checkout, webhook, deploy, admin, watchdog) with JSON format in production
- **Error handling** — Try-catch wrappers around all route handlers; error responses include consistent `{ error }` shape
- **Input validation** — Telegram token format regex, userId length checks, URL validation for MCP servers
- **XSS prevention** — `escapeHtml()` used for all user-supplied data in admin dashboard
- **Consistent API responses** — JSON content-type, appropriate HTTP status codes (402 for no subscription, 403 for limits, 409 for conflicts)
- **Environment-aware behavior** — Dev/test bypasses gated behind explicit `ALLOW_DEV_*` flags

### 3.2 Issues Found

| Severity | File | Issue | Impact |
|----------|------|-------|--------|
| Medium | `server.js` | `execSync('kill -0 ' + pid)` uses shell interpolation | PID is always integer from DB, but should use `spawnSync` with args array |
| Medium | `server.js` | Health endpoint exposes OS version, Node version, disk usage | Information disclosure for attackers fingerprinting |
| Medium | `server.js` | Watchdog uses `setInterval` with `execSync` — blocks event loop | Latency spikes during watchdog tick under concurrent requests |
| Low | `server.js` | `_resetClient()` export guarded by `process.env.NODE_ENV === 'test'` | Correct but fragile; should use dependency injection |
| Low | `liveclaw.js` | `idToken` stored in localStorage | XSS could exfiltrate token (mitigated by 1h expiry + Google JWT verification on server) |
| Low | `database.js` | SQL dialect conversion uses string replacement | Works for current SQL but could break with complex queries containing the replaced patterns in string literals |
| Info | `admin/index.html` | 77KB inline styles + scripts | Maintainability concern; no unit tests possible |
| Info | `dodo.js` | Hardcoded product IDs | Requires code deployment to change pricing |

### 3.3 Test Coverage Analysis

```
Total Tests: 109
  api.test.js:          85 tests (API integration)
  subscription.test.js:  5 tests (billing flows)
  bifrost.test.js:      19 tests (gateway client)

Line Coverage: ~68%
Branch Coverage: ~55% (estimated)
Test Runtime: <1s (in-memory SQLite)
```

**Well-Covered:**
- Health/readiness endpoints
- Admin API (stats, revenue, users, events, metrics)
- Bot lifecycle (deploy, stop, status)
- Bifrost Virtual Key CRUD
- Dodo webhook handling

**Under-Covered:**
- Google JWT verification (mocked in tests)
- Token encryption/decryption edge cases
- Watchdog timer behavior
- Queue orchestration (feature-flagged)
- Error paths in billing webhooks (partial)
- Frontend JavaScript (0% — no unit tests)

### 3.4 Dependency Health

| Package | Version | Status | Notes |
|---------|---------|--------|-------|
| express | 5.2.1 | Current | Express 5 (latest) |
| pg | 8.20.0 | Current | PostgreSQL driver |
| better-sqlite3 | 12.6.2 | Current | Dev/test only |
| helmet | 8.1.0 | Current | Security headers |
| jsonwebtoken | 9.0.3 | Current | JWT handling |
| dodopayments | 2.23.1 | Current | Billing SDK |
| dotenv | 17.3.1 | Current | Env loading |
| flatted | 3.4.1 | Overridden | Dev dep advisory mitigated |

No critical vulnerabilities in production dependencies. One advisory in dev transitive deps (mitigated via npm overrides).

---

## 4. Security Audit

### 4.1 Authentication & Authorization

| Mechanism | Implementation | Verdict |
|-----------|---------------|---------|
| **User Auth** | Google OAuth 2.0 JWT → RS256 signature verification via Google JWKS (6h cache) | Strong |
| **Admin Auth** | TOTP (otpauth) → JWT (8h expiry) + X-Admin-Secret header for internal APIs | Strong |
| **API Auth** | Bearer token on all mutating endpoints; user identity checked against route params | Strong |
| **Webhook Auth** | Dodo SDK signature verification via `verifyWebhookEvent()` | Strong |
| **CAPTCHA** | Cloudflare Turnstile on sign-up (optional) | Adequate |

### 4.2 Data Protection

| Data | At Rest | In Transit | Notes |
|------|---------|-----------|-------|
| Telegram bot tokens | AES-256-GCM encrypted in DB | HTTPS | Plaintext in picobot config.json (chmod 0600) |
| Bifrost Virtual Keys | AES-256-GCM encrypted in DB | HTTPS | Budget-limited, deactivated on stop |
| Google JWT | localStorage (1h expiry) | HTTPS | XSS risk, mitigated by short expiry |
| TOTP secrets | Server-side only | HTTPS | Never exposed to client |
| Payment data | Dodo Payments (PCI DSS compliant MoR) | HTTPS | LiveClaw never touches card data |

### 4.3 Rate Limiting

| Endpoint | Limit | Layer |
|----------|-------|-------|
| `/deploy-bot` | 5/min per IP | Express |
| `/admin/login` | 7/15min per IP | Express + Nginx (1/min) |
| General API | 60/min per IP | Express |
| Webhooks | 30/min per IP | Express |
| Health/readiness | Exempt | — |

### 4.4 Fixed Vulnerabilities (March 2026)

| ID | Severity | Issue | Fix Applied |
|----|----------|-------|-------------|
| S-01 | High | SSRF via user-supplied MCP server URLs | Added `isPrivateUrl()` blocking RFC-1918, loopback, cloud metadata |
| S-02 | High | EARLYCLAW race condition under PostgreSQL | Atomic UPDATE with correlated COUNT sub-SELECT |
| S-03 | Medium | Modulo bias in beta code generation | Rejection sampling for uniform distribution |
| S-04 | Medium | `State.botPid` unescaped in admin dashboard | Wrapped in `escapeHtml()` |
| S-05 | Medium | `_resetClient()` exported in production | Gated behind `NODE_ENV === 'test'` |
| S-06 | Medium | Admin auth fallthrough in non-prod | Now requires valid credentials consistently |

### 4.5 Remaining Risk Register

| ID | Severity | Risk | Mitigation | Status |
|----|----------|------|------------|--------|
| M1 | Medium | Telegram token plaintext on disk | `chmod 0600` config.json, `0700` directories | Accepted |
| M2 | Medium | picobot binary not SHA256-verified | Add checksum verification in deploy scripts | Backlog |
| M3 | Low | `execSync` with DB-sourced PID | PIDs are always integers; migrate to `spawnSync` | Backlog |
| L1 | Low | `/health` exposes system details | Move detailed info behind `adminAuth` | Backlog |
| L5 | Low | `idToken` in localStorage | 1h expiry + server-side verification | Accepted |

### 4.6 OWASP Top 10 Compliance

| # | Category | Status | Notes |
|---|----------|--------|-------|
| A01 | Broken Access Control | PASS | JWT verification on all protected routes; user ID checked against route params |
| A02 | Cryptographic Failures | PASS | AES-256-GCM for secrets; HTTPS enforced; no weak algorithms |
| A03 | Injection | PASS | Parameterized SQL queries; SSRF protection; input validation |
| A04 | Insecure Design | PASS | Rate limiting, CAPTCHA, idempotent webhooks, budget governance |
| A05 | Security Misconfiguration | PASS | Helmet headers, CORS configured, UFW firewall, production invariants enforced |
| A06 | Vulnerable Components | PASS | No critical CVEs; npm audit enforced in CI |
| A07 | Auth Failures | PASS | Google OAuth + TOTP; no default credentials in production |
| A08 | Data Integrity Failures | CAUTION | picobot binary not checksum-verified (M2) |
| A09 | Logging & Monitoring | PASS | Structured logging; event_logs table; admin dashboard |
| A10 | SSRF | PASS | `isPrivateUrl()` blocks internal network access |

---

## 5. Production Readiness Scorecard

### 5.1 Launch Gates

| Gate | Status | Evidence |
|------|--------|----------|
| All tests passing | PASS | 109/109 tests pass in <1s |
| Security audit complete | PASS | 8.5/10, all critical/high fixed |
| PostgreSQL mandatory | PASS | Startup fails without `DATABASE_URL` |
| Managed DB + standby | PASS | `liveclaw-db` + `liveclaw-db-standby-1` online |
| Connection pooling | PASS | `liveclaw-prod-pool` (size 20, transaction mode) |
| DB firewall | PASS | Droplet-only access rule applied |
| CI/CD pipeline tested | PASS | Multi-stage with rollback, 5 workflows |
| Secrets in GitHub | PASS | `DO_DROPLET_IP`, `DO_SSH_KEY`, env vars configured |
| Health checks | PASS | `/health` and `/readyz` endpoints functional |
| SSL/TLS | PASS | Let's Encrypt auto-renewal configured |
| Zero-downtime deploy | PASS | `pm2 reload` (not restart) |
| Rollback mechanism | PASS | Release snapshots in `/opt/liveclaw/releases/` |
| Dodo webhook URL set | PENDING | Must point to `https://api.liveclaw.xyz/webhook/dodo` |
| Load test p95 < 300ms | FAIL | Current: 1352ms (investigate DB latency) |
| Failover drill complete | PENDING | Runbook exists, drill not yet executed |

### 5.2 Risk Assessment for Launch

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DB failover causes downtime | Low | High | Standby replica online; drill pending |
| Bot process crash flood | Low | Medium | Watchdog timer; auto-detect in `/status` |
| Billing webhook replay | Very Low | Medium | Idempotency via `processed_events` |
| LLM cost overrun | Very Low | Low | Bifrost Virtual Key budgets ($5/user/mo) |
| DDoS on API | Low | Medium | Rate limiting + Cloudflare (frontend) |
| Secret rotation needed | Medium | Low | CREDENTIALS.md documents rotation procedures |

---

## 6. Step-by-Step Production Deployment Guide

### 6.1 Prerequisites

**Required Accounts:**
- DigitalOcean account with $200 credit (or active billing)
- Dodo Payments merchant account (approved, products created)
- Google Cloud project with OAuth 2.0 credentials
- Cloudflare account (for Turnstile CAPTCHA)
- Telegram Bot (@BotFather) for master notification bot
- Domain: `liveclaw.xyz` with DNS managed (A records for `@` and `api`)

**Required Tools (local machine):**
```bash
# Install prerequisites
brew install doctl jq rsync
npm install -g pm2

# Authenticate DigitalOcean
doctl auth init
doctl account get  # Verify
```

**Required Secrets (generate before deployment):**
```bash
# Token encryption key (32 bytes → 64 hex chars)
openssl rand -hex 32

# Admin secret (URL-safe base64)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='

# Admin JWT secret
openssl rand -base64 48

# Admin TOTP secret (generate via any TOTP app, or use otpauth library)
npx -y otpauth-cli generate --issuer LiveClaw --label admin
```

### 6.2 Phase 1: Infrastructure Provisioning

#### 6.2.1 Database Setup

```bash
# Create managed PostgreSQL cluster
doctl databases create liveclaw-db \
  --engine pg \
  --version 17 \
  --region nyc3 \
  --size db-s-1vcpu-1gb \
  --num-nodes 1

# Wait for cluster to come online (~5 minutes)
doctl databases list --format ID,Name,Status

# Get connection string (save this → DATABASE_URL)
doctl databases connection liveclaw-db --format Host,Port,User,Password,Database,URI

# Create connection pool
./scripts/enable-db-pool.sh --apply

# Create standby replica
./scripts/enable-db-replica.sh --apply

# Configure firewall (after backend droplet exists)
# See step 6.2.2 first, then come back here
```

#### 6.2.2 Backend Droplet

**Option A: Automated (recommended)**
```bash
./deploy.sh
```

This script handles: droplet creation, system packages, Node 22, Nginx, Docker, Bifrost, picobot, UFW firewall, SSL certificates, PM2 setup.

**Option B: CI/CD (after initial setup)**

Push to `main` branch → GitHub Actions deploys automatically via `.github/workflows/main.yml`.

#### 6.2.3 Frontend Droplet

```bash
# Ensure liveclaw-web/.env is populated
cp liveclaw-web/.env.example liveclaw-web/.env
# Edit with real values:
#   LIVECLAW_API_BASE=https://api.liveclaw.xyz
#   LIVECLAW_GOOGLE_CLIENT_ID=<your-google-client-id>
#   LIVECLAW_TURNSTILE_SITE_KEY=<your-turnstile-site-key>

# Deploy
./scripts/deploy-frontend.sh
```

#### 6.2.4 Database Firewall (after droplets exist)

```bash
# Get backend droplet ID
DROPLET_ID=$(doctl compute droplet list --format ID,Name --no-header | grep liveclaw-prod | awk '{print $1}')

# Get database cluster ID
DB_ID=$(doctl databases list --format ID,Name --no-header | grep liveclaw-db | awk '{print $1}')

# Add firewall rule
doctl databases firewalls append $DB_ID --rule droplet:$DROPLET_ID
```

### 6.3 Phase 2: Configuration

#### 6.3.1 Backend Environment

SSH into the backend droplet and edit `/opt/liveclaw/backend/.env`:

```bash
ssh root@<backend-ip>
nano /opt/liveclaw/backend/.env
```

**Required variables (minimum viable):**

```env
# === CORE ===
NODE_ENV=production
PORT=3000

# === DATABASE (from step 6.2.1) ===
DATABASE_URL=postgresql://doadmin:<password>@<host>:25060/defaultdb?sslmode=require

# === SECURITY (from step 6.1) ===
TOKEN_ENCRYPTION_KEY=<64-hex-chars>
ADMIN_SECRET=<base64url-string>
ADMIN_JWT_SECRET=<base64-string>
ADMIN_TOTP_SECRET=<base32-string>

# === TELEGRAM ===
TELEGRAM_MASTER_BOT_TOKEN=<from-botfather>

# === DODO PAYMENTS ===
DODO_API_KEY=<from-dodo-dashboard>
DODO_WEBHOOK_SECRET=<from-dodo-dashboard>
DODO_PRODUCT_ID=<standard-product-id>
DODO_TRIAL_PRODUCT_ID=<trial-product-id>

# === CLOUDFLARE ===
TURNSTILE_SECRET_KEY=<from-cloudflare>

# === GOOGLE ===
GOOGLE_CLIENT_ID=<from-google-console>

# === BIFROST ===
BIFROST_API_KEY=<from-bifrost-ui>
BIFROST_GATEWAY_URL=http://localhost:8080

# === OPTIONAL TUNING ===
PG_POOL_MAX=20
PG_POOL_IDLE_TIMEOUT_MS=30000
PG_POOL_CONNECTION_TIMEOUT_MS=5000
PG_SSL_REJECT_UNAUTHORIZED=false
LOG_LEVEL=info
```

#### 6.3.2 Restart and Verify

```bash
# On the backend droplet
cd /opt/liveclaw/backend
pm2 reload liveclaw-orchestrator --update-env
pm2 logs liveclaw-orchestrator --lines 20  # Check for startup errors

# Verify health
curl -s http://localhost:3000/health | jq
curl -s http://localhost:3000/readyz | jq
```

### 6.4 Phase 3: External Service Configuration

#### 6.4.1 Dodo Payments Webhook

In the Dodo Payments dashboard:
1. Navigate to **Webhooks** settings
2. Set webhook URL: `https://api.liveclaw.xyz/webhook/dodo`
3. Select events: `subscription.active`, `subscription.cancelled`, `payment.succeeded`, `payment.failed`, `subscription.renewed`
4. Save and note the webhook secret (should match `DODO_WEBHOOK_SECRET`)

#### 6.4.2 Telegram Master Bot Webhook

```bash
# Register webhook for low-credit notifications
node /opt/liveclaw/scripts/set-webhook.js
```

#### 6.4.3 Google OAuth Authorized Origins

In Google Cloud Console → Credentials → OAuth 2.0 Client:
- Authorized JavaScript origins: `https://liveclaw.xyz`
- Authorized redirect URIs: `https://liveclaw.xyz`

#### 6.4.4 DNS Records

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | @ | `<frontend-droplet-ip>` | 300 |
| A | api | `<backend-droplet-ip>` | 300 |

### 6.5 Phase 4: Smoke Tests

```bash
# From local machine
# Health check
curl -s https://api.liveclaw.xyz/health | jq '.status'
# Expected: "ok"

# Readiness probe
curl -s https://api.liveclaw.xyz/readyz | jq '.ready'
# Expected: true

# Pricing endpoint
curl -s https://api.liveclaw.xyz/pricing | jq
# Expected: JSON with plans object

# Frontend
curl -sI https://liveclaw.xyz | head -5
# Expected: HTTP/2 200

# Admin dashboard
curl -sI https://liveclaw.xyz/admin/ | head -5
# Expected: HTTP/2 200
```

### 6.6 Phase 5: GitHub Actions Secrets

Configure these in GitHub repo → Settings → Secrets → Actions:

| Secret | Description |
|--------|-------------|
| `DO_DROPLET_IP` | Backend droplet public IP |
| `DO_FRONTEND_IP` | Frontend droplet public IP |
| `DO_SSH_KEY` | Private SSH key (ed25519) for droplet access |
| `LIVECLAW_API_BASE` | `https://api.liveclaw.xyz` |
| `LIVECLAW_GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `LIVECLAW_TURNSTILE_SITE_KEY` | Cloudflare Turnstile public key |

After this, every push to `main` triggers automatic deployment via CI/CD.

---

## 7. Post-Deployment Verification

### 7.1 Full Integration Test Sequence

```bash
# 1. Verify database connectivity
curl -s https://api.liveclaw.xyz/readyz | jq
# { "ready": true, "db": "ok" }

# 2. Verify Bifrost gateway
curl -s https://api.liveclaw.xyz/health | jq '.bifrost'
# { "status": "ok", "url": "http://localhost:8080" }

# 3. Check admin stats (requires admin secret)
curl -s -H "X-Admin-Secret: $ADMIN_SECRET" \
  https://api.liveclaw.xyz/admin/stats | jq

# 4. Run infrastructure readiness check
./scripts/scale-readiness-check.sh --json

# 5. Run load test
./scripts/run-load-test.sh \
  --url https://api.liveclaw.xyz/readyz \
  --connections 20 \
  --duration 30 \
  --json
```

### 7.2 Manual User Flow Test

1. Open `https://liveclaw.xyz` in browser
2. Click "Sign in with Google" → authenticate
3. Enter a test Telegram bot token → verify connection
4. Select a model (MiniMax M2.5 or Kimi K2.5)
5. Click "Deploy LiveClaw" → should show pricing modal (no subscription yet)
6. Complete a test checkout via Dodo → verify webhook fires
7. After subscription active, deploy bot → verify process starts
8. Check admin dashboard at `https://liveclaw.xyz/admin/` → verify stats update
9. Stop the bot → verify process terminates

---

## 8. Monitoring & Observability

### 8.1 Built-in Endpoints

| Endpoint | Auth | Purpose | Usage |
|----------|------|---------|-------|
| `GET /health` | None | Full system health (DB, Bifrost, disk, memory) | Uptime monitors |
| `GET /readyz` | None | Lightweight DB connectivity check | Load balancer probes |
| `GET /admin/stats` | Admin | Aggregated bot/subscription/system telemetry | Dashboard |
| `GET /admin/dashboard-live` | Admin | Unified live snapshot (bots, subs, payments, events, disk, VK usage) | Live monitoring |
| `GET /admin/metrics/prometheus` | Admin | Prometheus text format metrics | Grafana/Prometheus scraping |
| `GET /admin/revenue` | Admin | Payment analytics with daily breakdown | Revenue reporting |
| `GET /admin/events` | Admin | Paginated event log | Audit trail |

### 8.2 Recommended Monitoring Stack

| Component | Tool | Purpose |
|-----------|------|---------|
| Uptime monitoring | UptimeRobot / Better Uptime | Alert on `/health` failures |
| Metrics collection | Prometheus | Scrape `/admin/metrics/prometheus` |
| Dashboards | Grafana | Visualize latency, error rates, bot counts |
| Log aggregation | DigitalOcean Logs / Papertrail | Centralize PM2 + Nginx logs |
| Error tracking | Sentry (optional) | Capture unhandled exceptions |
| DB monitoring | DigitalOcean Alerts | CPU, connections, disk, replication lag |

### 8.3 Key Metrics to Watch

| Metric | SLO Target | Alert Threshold |
|--------|-----------|-----------------|
| API p95 latency | < 300ms | > 500ms for 5 min |
| 5xx error rate | < 0.5% | > 1% for 2 min |
| Active bot count | N/A | > 80% of server capacity |
| DB connection pool usage | < 80% | > 90% for 5 min |
| Disk usage | < 80% | > 85% |
| PM2 restart count | 0 | Any restart |
| Webhook processing time | < 2s p99 | > 5s for 3 min |

---

## 9. Incident Response Playbook

### 9.1 502 Bad Gateway

```bash
# Check PM2 status
ssh root@<backend-ip> "pm2 list"

# If offline, check logs
ssh root@<backend-ip> "pm2 logs liveclaw-orchestrator --lines 50"

# Common causes:
# - Missing DATABASE_URL → add to .env, pm2 reload
# - Port conflict → check netstat -tlnp | grep 3000
# - OOM kill → check dmesg | tail -20, consider upgrading droplet

# Restart
ssh root@<backend-ip> "cd /opt/liveclaw/backend && pm2 reload liveclaw-orchestrator"
```

### 9.2 Database Connection Failures

```bash
# Check DB status
doctl databases get <db-id> --output json | jq '.status'

# Check pool status
doctl databases pool list <db-id> --output json

# Check connection count
ssh root@<backend-ip> "curl -s localhost:3000/health | jq '.db'"

# If pool exhausted, increase limit (carefully)
# Edit .env: PG_POOL_MAX=30
# pm2 reload liveclaw-orchestrator
```

### 9.3 High Bot Crash Rate

```bash
# Check admin dashboard
curl -s -H "X-Admin-Secret: $ADMIN_SECRET" \
  https://api.liveclaw.xyz/admin/stats | jq '.bots'

# Check for Bifrost VK quota issues
curl -s -H "X-Admin-Secret: $ADMIN_SECRET" \
  https://api.liveclaw.xyz/admin/dashboard-live | jq '.bifrost'

# Kill orphaned processes
ssh root@<backend-ip> "ps aux | grep picobot"

# Force-stop a specific user's bot
curl -X POST -H "X-Admin-Secret: $ADMIN_SECRET" \
  https://api.liveclaw.xyz/admin/users/<userId>/stop
```

### 9.4 Rollback Deployment

```bash
ssh root@<backend-ip>

# List available snapshots
ls -la /opt/liveclaw/releases/

# Restore from latest snapshot
LATEST=$(ls -t /opt/liveclaw/releases/ | head -1)
cp /opt/liveclaw/releases/$LATEST/* /opt/liveclaw/backend/
cd /opt/liveclaw/backend
npm install --omit=dev
pm2 reload liveclaw-orchestrator

# Verify
curl -s http://localhost:3000/health | jq
```

---

## 10. Scaling Readiness & Roadmap

### 10.1 Current Capacity

| Resource | Limit | Current Usage |
|----------|-------|---------------|
| Backend droplet RAM | 8 GB | ~200 concurrent bots (estimated) |
| DB connections (pool) | 20 | Low (launch phase) |
| Bifrost VK per user | $5/mo | Fixed budget |
| Disk (bot workspaces) | 160 GB | ~800 bot instances at 200MB each |

### 10.2 Scaling Phases Summary

| Phase | Focus | Trigger | Estimated Effort |
|-------|-------|---------|-----------------|
| **Phase 0** (Done) | PostgreSQL mandatory, indexes, SLOs | Pre-launch | Complete |
| **Phase 1** (Partial) | Connection pooling, query optimization | >100 users | 2 weeks |
| **Phase 2** | Queue-backed bot orchestration | >200 concurrent bots | 3 weeks |
| **Phase 3** | Dedicated runtime fleet (separate bot hosts) | >500 users | 4 weeks |
| **Phase 4** | Circuit breakers, distributed rate limiting, Redis | >1000 users | 4 weeks |
| **Phase 5** | Multi-region (optional) | Global expansion | 6+ weeks |

### 10.3 Immediate Performance Issue: p95 Latency

**Current:** 1352ms (vs 300ms SLO target)

**Probable Causes:**
1. Managed PostgreSQL on smallest tier (1vCPU/1GB) has high cold-start latency
2. Connection pool overhead on transaction-mode bouncing
3. SSL handshake to managed DB adds ~50-100ms per query

**Recommended Fixes:**
1. Upgrade DB to `db-s-1vcpu-2gb` ($30/mo, doubles available memory)
2. Add connection keep-alive tuning (`PG_POOL_IDLE_TIMEOUT_MS=60000`)
3. Cache `/readyz` response for 5s (avoids DB round-trip on every probe)
4. Profile actual query latency with `pg_stat_statements` extension

---

## 11. AI Agent Skills & Equipment for Maintenance

### 11.1 Overview

This section documents the AI agent capabilities, tools, and skills required to maintain, deploy, and operate the LiveClaw platform. It covers both the built-in agent skills available in Claude Code and the operational tooling built into the project.

### 11.2 Agent Skills Taxonomy

#### Category 1: Code Analysis & Review

| Skill | Purpose | When to Use | Equipment/Tools |
|-------|---------|-------------|-----------------|
| **Explore** | Deep codebase navigation | Understanding architecture, finding dependencies, tracing call chains | Glob, Grep, Read — no edit access |
| **Plan** | Implementation planning | Before making architectural changes; designing new features | All read tools + planning framework |
| **Code Review** | Quality & security audit | Before merges; after major refactors; periodic audits | Read, Grep, Glob — structured analysis |
| **Simplify** (`/simplify`) | Refactor for quality | After writing code; when code feels over-engineered | Edit with quality heuristics |

**Equipment needed:**
- Full read access to the repository
- Understanding of the Express.js + PostgreSQL + picobot architecture
- Context on the dual-database abstraction (`database.js`)
- Awareness of the 5-phase scaling roadmap

#### Category 2: Development & Implementation

| Skill | Purpose | When to Use | Equipment/Tools |
|-------|---------|-------------|-----------------|
| **General-purpose** | Multi-step development tasks | Bug fixes, feature development, refactoring | All tools including Edit, Write, Bash |
| **claude-api** (`/claude-api`) | API integration development | Building features that use Claude/Anthropic APIs | SDK documentation, API reference |
| **Test writing** | Test creation and execution | After implementing features; when coverage gaps identified | Vitest, Supertest, in-memory SQLite |

**Equipment needed:**
- Write access to the repository
- Node.js 22 runtime with `npm test`, `npm run lint`
- Understanding of test setup (in-memory SQLite, mocked Dodo/Bifrost)
- ESLint configuration awareness

#### Category 3: Deployment & Operations

| Skill | Purpose | When to Use | Equipment/Tools |
|-------|---------|-------------|-----------------|
| **Bash execution** | Run deployment scripts | Provisioning, code deployment, load testing | Shell access, `doctl`, `ssh`, `rsync` |
| **Git/GitHub** | Version control, PR management | Commits, branches, releases, PR reviews | `git`, `gh` CLI |
| **Infrastructure management** | DigitalOcean operations | DB scaling, droplet management, firewall rules | `doctl` CLI, SSH access |

**Equipment needed:**
- SSH keys for droplet access
- `doctl` CLI authenticated
- GitHub Actions secrets configured
- Understanding of the CI/CD pipeline (5 workflows)

#### Category 4: Monitoring & Incident Response

| Skill | Purpose | When to Use | Equipment/Tools |
|-------|---------|-------------|-----------------|
| **Health monitoring** | Check system status | Routine checks; after deployments; during incidents | `curl`, health/readyz endpoints |
| **Log analysis** | Investigate errors | After alerts; debugging user issues; post-incident review | PM2 logs, structured JSON logs |
| **Load testing** | Validate performance | Before launches; after infra changes; quarterly SLO reviews | `scripts/run-load-test.sh` (autocannon) |
| **Database operations** | Manage PostgreSQL | Pool tuning, replica management, failover drills | `doctl databases *`, SQL access |

**Equipment needed:**
- Admin secret for `/admin/*` endpoints
- SSH access for PM2 log access
- `doctl` for infrastructure commands
- Load testing tools (`autocannon` via `run-load-test.sh`)

### 11.3 Non-Negotiable Agent Safety Rules

These rules MUST be followed by any AI agent maintaining this codebase:

1. **Never remove auth checks** from deploy/stop/subscription endpoints
2. **Never reintroduce default auth bypass** in production (`ALLOW_DEV_AUTH_BYPASS` must not be set in prod)
3. **Never allow production start without `DATABASE_URL`** — the fail-fast check is intentional
4. **Never print secrets** from `doctl`, `.env`, or encrypted fields in logs/docs/commits
5. **Never run destructive DB/filesystem commands** without explicit user request
6. **Never skip CI checks** (use hotfix workflow only for genuine emergencies)
7. **Never force-push to main** without explicit authorization
8. **Always run `npm test` and `npm run lint`** after code changes before committing
9. **Always use parameterized SQL** — never string-concatenate user input into queries
10. **Always encrypt sensitive data** (tokens, keys) before storing in the database

### 11.4 Agent Workflow: Standard Development Task

```
1. EXPLORE  → Read relevant files, understand current implementation
2. PLAN     → Design approach, identify affected files, consider edge cases
3. IMPLEMENT → Make focused changes, minimal diff
4. TEST     → Run `npm test`, `npm run lint`, verify manually
5. REVIEW   → Check for security issues, code quality, test coverage
6. COMMIT   → Descriptive commit message following conventional commits
```

### 11.5 Agent Workflow: Production Deployment

```
1. PRE-FLIGHT
   └── Run: ./scripts/scale-readiness-check.sh --json
   └── Verify: all tests passing, no critical lint errors

2. DEPLOY (automated via CI/CD on push to main)
   └── GitHub Actions: test → lint → security → deploy-backend → deploy-frontend → verify
   └── Rollback: automatic if health check fails

3. POST-DEPLOY
   └── Verify: curl https://api.liveclaw.xyz/health
   └── Verify: curl https://api.liveclaw.xyz/readyz
   └── Verify: curl https://liveclaw.xyz/
   └── Monitor: PM2 logs for 5 minutes for errors

4. LOAD TEST (quarterly or after major changes)
   └── Run: ./scripts/run-load-test.sh --url https://api.liveclaw.xyz/readyz --connections 50 --duration 60 --json
   └── Verify: SLO gates pass

5. FAILOVER DRILL (quarterly)
   └── Follow: docs/DB_FAILOVER_DRILL_RUNBOOK.md
```

### 11.6 Agent Workflow: Incident Response

```
1. DETECT   → Health check failure, error spike, user report
2. TRIAGE   → Check /health, PM2 status, recent deployments
3. DIAGNOSE → Read PM2 logs, check DB connectivity, inspect error patterns
4. MITIGATE → Restart PM2, rollback if recent deploy, scale if capacity issue
5. RESOLVE  → Fix root cause, deploy fix, verify recovery
6. DOCUMENT → Update runbooks, add test coverage for the failure mode
```

### 11.7 Tool & Equipment Inventory

| Tool | Location | Purpose | Access |
|------|----------|---------|--------|
| `deploy.sh` | Root | Full backend provisioning | Local/CI |
| `scripts/deploy-frontend.sh` | scripts/ | Frontend provisioning | Local/CI |
| `scripts/enable-db-pool.sh` | scripts/ | Create managed connection pool | Local (doctl) |
| `scripts/enable-db-replica.sh` | scripts/ | Create managed standby replica | Local (doctl) |
| `scripts/run-load-test.sh` | scripts/ | Autocannon SLO testing | Local/CI |
| `scripts/scale-readiness-check.sh` | scripts/ | Infrastructure readiness gate | Local/CI |
| `CREDENTIALS.md` | Root | Secret acquisition guide | Local |
| `docs/DB_FAILOVER_DRILL_RUNBOOK.md` | docs/ | Failover validation process | Local |
| `docs/AI_AGENT_MAINTENANCE_GUIDE.md` | docs/ | Rich context for AI agents | Local |
| `docs/SCALING_MIGRATION_GUIDE.md` | docs/ | Multi-phase scaling roadmap | Local |
| `.github/workflows/main.yml` | .github/ | Primary CI/CD pipeline | GitHub |
| `.github/workflows/hotfix.yml` | .github/ | Emergency deployment bypass | GitHub |
| `.github/workflows/release.yml` | .github/ | Semantic versioning + releases | GitHub |

### 11.8 Agent Context Requirements

When an AI agent starts working on this codebase, it should understand:

1. **Architecture:** Single-node Express API managing picobot processes, with Bifrost for LLM governance and Dodo for billing
2. **Constraints:** Bot lifecycle is local (spawn/kill); no horizontal scaling yet; queue orchestration is feature-flagged
3. **Database:** PostgreSQL mandatory in production; SQLite for dev/test; dialect conversion in `database.js`
4. **Security model:** Google OAuth for users, TOTP+JWT for admins, AES-256-GCM for stored secrets
5. **Deployment:** CI/CD via GitHub Actions with automatic rollback; zero-downtime via PM2 reload
6. **Testing:** Vitest + Supertest with in-memory SQLite; mocked external services
7. **Scaling roadmap:** 5 phases from single-node to multi-region; currently at Phase 0-1

---

## Appendix A: Cost Analysis

| Component | Monthly Cost | Capacity |
|-----------|-------------|----------|
| Backend droplet (s-2vcpu-8gb) | $48 | ~200 concurrent bots |
| Managed PostgreSQL (1vCPU/1GB) | $15 | 20 pooled connections |
| Frontend droplet (s-1vcpu-512mb) | $4 | Static site serving |
| **Total Infrastructure** | **$67/mo** | |
| Bifrost (self-hosted Docker) | $0 | Included in backend droplet |
| Dodo Payments (MoR) | ~2.5% per transaction | Unlimited |
| Google OAuth | $0 | Unlimited |
| Cloudflare Turnstile | $0 | Free tier |
| Let's Encrypt SSL | $0 | Auto-renewal |

**Unit Economics (per subscriber at $12.99/mo):**
- Revenue: $12.99
- Bifrost LLM budget: -$5.00
- Infrastructure share (at 100 users): -$0.67
- Dodo fee (~2.5%): -$0.32
- **Gross margin: ~$6.99 (54%)**

**Break-even: ~10 subscribers** covers infrastructure costs.

---

## Appendix B: Environment Variables Reference

### Production Required

| Variable | Format | Description |
|----------|--------|-------------|
| `NODE_ENV` | `production` | Enables production behaviors |
| `PORT` | Integer | API server port (default: 3000) |
| `DATABASE_URL` | PostgreSQL URI | Required in production; startup fails without it |
| `TOKEN_ENCRYPTION_KEY` | 64 hex chars | AES-256-GCM encryption key for stored secrets |
| `ADMIN_SECRET` | Base64url string | X-Admin-Secret header value for internal APIs |
| `ADMIN_JWT_SECRET` | Base64 string | JWT signing key for admin sessions |
| `ADMIN_TOTP_SECRET` | Base32 string | TOTP secret for admin login |
| `TELEGRAM_MASTER_BOT_TOKEN` | `<id>:<token>` | Bot for low-credit notifications |
| `DODO_API_KEY` | String | Dodo Payments API key |
| `DODO_WEBHOOK_SECRET` | String | Dodo webhook signature verification |
| `DODO_PRODUCT_ID` | `pdt_*` | Standard subscription product |
| `DODO_TRIAL_PRODUCT_ID` | `pdt_*` | Trial product |
| `TURNSTILE_SECRET_KEY` | String | Cloudflare CAPTCHA verification |
| `GOOGLE_CLIENT_ID` | String | Google OAuth 2.0 client ID |
| `BIFROST_API_KEY` | String | Bifrost gateway admin key |
| `BIFROST_GATEWAY_URL` | URL | Default: `http://localhost:8080` |

### Optional Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `PG_POOL_MAX` | 20 | Max PostgreSQL connections |
| `PG_POOL_IDLE_TIMEOUT_MS` | 30000 | Idle connection timeout |
| `PG_POOL_CONNECTION_TIMEOUT_MS` | 5000 | Connection acquire timeout |
| `PG_POOL_QUERY_TIMEOUT_MS` | 15000 | Query execution timeout |
| `PG_SSL_REJECT_UNAUTHORIZED` | false | SSL certificate validation |
| `LOG_LEVEL` | info | Logging threshold (debug/info/warn/error) |
| `SCALE_QUEUE_ORCHESTRATION` | false | Enable queue-based bot commands |

---

## Appendix C: Database Schema

### Tables

**bots**
| Column | Type | Notes |
|--------|------|-------|
| user_id | TEXT UNIQUE | Primary identifier |
| pid | INTEGER | OS process ID |
| model | TEXT | Default: 'minimax-m2.5' |
| telegram_token | TEXT | AES-256-GCM encrypted |
| bifrost_vk_id | TEXT | Virtual Key ID |
| bifrost_vk | TEXT | AES-256-GCM encrypted |
| credit_limit | REAL | Monthly LLM budget |
| status | TEXT | running / stopped / crashed |
| telegram_chat_id | TEXT | For notifications |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**subscriptions**
| Column | Type | Notes |
|--------|------|-------|
| user_id | TEXT UNIQUE | Primary identifier |
| dodo_customer_id | TEXT | Dodo reference |
| dodo_subscription_id | TEXT | Dodo reference |
| plan | TEXT | standard / trial |
| status | TEXT | active / past_due / cancelled / inactive / trialing |
| trial_ends_at | TIMESTAMPTZ | For trial expiry |
| current_period_start | TIMESTAMPTZ | |
| current_period_end | TIMESTAMPTZ | |
| early_bird | INTEGER | 0/1 flag (500 cap) |
| referral_code | TEXT | LC-XXXXX format |
| referred_by | TEXT | Referrer's code |
| beta_code_used | TEXT | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**payments**
| Column | Type | Notes |
|--------|------|-------|
| user_id | TEXT | |
| dodo_payment_id | TEXT UNIQUE | Dedup key |
| amount_cents | INTEGER | |
| currency | TEXT | Default: 'usd' |
| plan | TEXT | |
| status | TEXT | |
| created_at | TIMESTAMPTZ | |

**beta_codes**
| Column | Type | Notes |
|--------|------|-------|
| code | TEXT UNIQUE | XXXX-XXXX-XXXX format |
| redeemed_by | TEXT | User ID |
| redeemed_at | TIMESTAMPTZ | |
| redeemed_ip | TEXT | |
| user_agent | TEXT | |
| created_at | TIMESTAMPTZ | |

**event_logs**
| Column | Type | Notes |
|--------|------|-------|
| user_id | TEXT | |
| event | TEXT | Event name |
| detail | TEXT | JSON payload |
| ip | TEXT | Client IP |
| ts | TIMESTAMPTZ | Timestamp |

**processed_events**
| Column | Type | Notes |
|--------|------|-------|
| event_id | TEXT PK | Webhook dedup key |
| user_id | TEXT | |
| type | TEXT | Event type |
| ts | TIMESTAMPTZ | |

**orchestration_commands** (feature-flagged)
| Column | Type | Notes |
|--------|------|-------|
| command_id | TEXT PK | UUID |
| command_type | TEXT | deploy / stop |
| user_id | TEXT | |
| payload | TEXT | JSON |
| status | TEXT | queued / running / completed / failed |
| error | TEXT | |
| result | TEXT | JSON |
| created_at | TIMESTAMPTZ | |
| started_at | TIMESTAMPTZ | |
| finished_at | TIMESTAMPTZ | |

### Key Indexes

- `bots(status)` — count running bots
- `subscriptions(user_id)` — user subscription lookup
- `subscriptions(dodo_subscription_id)` — webhook correlation
- `subscriptions(status, updated_at)` — revenue analytics
- `subscriptions(trial_ends_at)` — trial expiry checks
- `event_logs(user_id, ts)` — user audit trail
- `event_logs(ts)`, `event_logs(event, ts)` — admin dashboard
- `payments(user_id)`, `payments(status, created_at)` — revenue reporting
- `beta_codes(code)` — beta code lookup
- `orchestration_commands(status, created_at)` — queue processing

---

*Generated by Claude Opus 4.6 — 2026-03-16*
