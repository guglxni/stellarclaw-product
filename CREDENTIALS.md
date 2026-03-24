# LiveClaw — Credentials & API Keys Guide

Every secret the service needs, where to get it, and exactly where to put it.

---

## Quick Reference

| Key | Source | Location | Required |
|-----|--------|----------|----------|
| `TOKEN_ENCRYPTION_KEY` | Generated locally | Backend `.env` | **Critical** |
| `ADMIN_SECRET` | Generated locally | Backend `.env` | **Critical** |
| `TELEGRAM_MASTER_BOT_TOKEN` | BotFather | Backend `.env` | **Critical** |
| `DODO_API_KEY` | Dodo Payments Dashboard | Backend `.env` | **Critical** |
| `DODO_WEBHOOK_SECRET` | Dodo Payments Dashboard | Backend `.env` | **Critical** |
| `DODO_PRODUCT_ID` | Dodo Product Catalog | Backend `.env` | **Critical** |
| `TURNSTILE_SECRET_KEY` | Cloudflare Dashboard | Backend `.env` | **Critical** |
| `TURNSTILE_SITE_KEY` | Cloudflare Dashboard | Frontend | **Critical** |
| `GOOGLE_CLIENT_ID` | Google Cloud Console | Frontend | **Critical** |
| MiniMax API Key | MiniMax Platform | Bifrost UI | **Critical** |
| `OPENROUTER_API_KEY` | OpenRouter | Backend `.env` + Bifrost UI | **Critical** |
| `VISION_DAILY_LIMIT` | Set locally | Backend `.env` | Optional (default: 20) |
| `VISION_MODEL` | OpenRouter model ID | Backend `.env` | Optional (default: qwen/qwen2.5-vl-72b-instruct:free) |
| `ALLOW_DEV_AUTH_BYPASS` | Local dev only | Backend `.env` (non-prod) | Optional |
| `ALLOW_DEV_ADMIN_LOGIN_FALLBACK` | Local dev only | Backend `.env` (non-prod) | Optional |
| `ADMIN_DEV_TOTP_CODE` | Local dev only | Backend `.env` (non-prod) | Optional |

---

## 1. Generated Keys (No Account Needed)

Two secrets are generated locally and stored in your macOS login Keychain.

```bash
# View current values
bash scripts/keychain-secrets.sh

# Inject into backend/.env
bash scripts/keychain-secrets.sh --inject

# Re-generate all three (e.g., after a security incident)
bash scripts/keychain-secrets.sh --rotate

# Export as shell env vars (for CI or SSH sessions)
bash scripts/keychain-secrets.sh --export-env
```

| Keychain Service | Variable | Description |
|-----------------|----------|-------------|
| `liveclaw.TOKEN_ENCRYPTION_KEY` | 64-char hex | AES-256-GCM key for encrypting Telegram bot tokens at rest |
| `liveclaw.ADMIN_SECRET` | base64url | Auth header for `/admin/*` and internal endpoints |

> **Warning:** Rotating `TOKEN_ENCRYPTION_KEY` invalidates all encrypted Telegram tokens in SQLite. Stop all bots before rotating, then users must re-deploy.

---

## 2. Telegram — Master Bot Token

The master bot sends inline keyboard messages (subscription prompts, low-credit warnings) to users.

### Steps

1. Open Telegram → search for **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot`.
3. Follow the prompts:
   - **Name:** `LiveClaw`
   - **Username:** `liveclaw_bot` (must be unique)
4. Copy the token → `TELEGRAM_MASTER_BOT_TOKEN`.

### Register the Bot

After SSL is live:

```
/setdescription → @liveclaw_bot → "Your AI agent on Telegram — $9.99/mo."
/setuserpic → @liveclaw_bot → (upload logo)
```

---

## 3. Dodo Payments — Subscription Billing

Dodo Payments is the Merchant of Record — handles checkout, recurring billing, global taxes, invoicing, and the Customer Portal.

### Steps

1. Go to **[https://app.dodopayments.com/](https://app.dodopayments.com/)** → create an account.
2. After email verification, head to the **Dashboard**.
3. **Use Test Mode** during development (toggle in sidebar).

#### API Key

4. Go to **Developers → API Keys → Create Key**:
   - Copy the key (starts with `sk_test_...` or `sk_live_...`) → `DODO_API_KEY`
   - Backend only — never expose to frontend.

#### Create Product

5. Go to **Products → + New Product**:

| Field | Value |
|-------|-------|
| Name | LiveClaw Standard |
| Price | $9.99/mo |
| Billing | Recurring monthly |
| Tax Category | SaaS |
| Trial | 1 day free trial |

6. Copy the **Product ID** (format: `pdt_...`) → `DODO_PRODUCT_ID`

#### Webhook

7. Go to **Developers → Webhooks → + Add endpoint**:
   - **URL:** `https://api.liveclaw.xyz/webhook/dodo`
   - **Events:**
     - `subscription.created`
     - `subscription.active`
     - `subscription.on_hold`
     - `subscription.cancelled`
     - `subscription.plan_changed`
     - `payment.succeeded`
     - `payment.failed`
8. Copy the **Signing secret** → `DODO_WEBHOOK_SECRET`

#### Customer Portal

9. Go to **Products → Customer Portal → Collections**:
   - Add the subscription product.
   - Enable cancellation and payment method update.

> **Test Mode:** Use test keys + test card `4242 4242 4242 4242` during development.  
> Switch to **Live Mode** for production.

---

## 4. Cloudflare Turnstile — Bot Protection

Turnstile protects against automated abuse. You get a **Site Key** (frontend) and a **Secret Key** (backend).

### Steps

1. Log in at **[https://dash.cloudflare.com/](https://dash.cloudflare.com/)**.
2. Go to **Turnstile → Add site**:
   - **Site name:** `LiveClaw`
   - **Domain:** `liveclaw.xyz`
   - **Widget type:** **Invisible**
3. Copy both keys:
   - **Site Key** → `TURNSTILE_SITE_KEY` (frontend, safe to expose)
   - **Secret Key** → `TURNSTILE_SECRET_KEY` (backend `.env`)

> **Test keys** (in `tests/setup.js`):  
> Site: `1x00000000000000000000AA` · Secret: `1x0000000000000000000000000000000AA`

---

## 5. Google OAuth — User Sign-In

Google OAuth lets users sign in to deploy bots. Only the Client ID is needed (no secret — backend verifies JWTs via Google's public JWKS).

### Steps

1. Go to **[https://console.cloud.google.com/](https://console.cloud.google.com/)**.
2. Create a project → `LiveClaw`.
3. **APIs & Services → OAuth consent screen:**
   - User type: External
   - App name: `LiveClaw`
   - Authorized domains: `liveclaw.xyz`
4. **APIs & Services → Credentials → + Create Credentials → OAuth 2.0 Client ID:**
   - Application type: Web application
   - Name: `LiveClaw Web`
   - Authorized JavaScript origins:
     - `https://liveclaw.xyz`
     - `https://www.liveclaw.xyz`
     - `http://localhost:3000`
5. Copy the **Client ID** → set in frontend HTML.

---

## 6. OpenRouter — LLM Provider Key

All LLM traffic (MiniMax M2.5, Kimi K2.5) routes through OpenRouter via Bifrost.
The same key is **also** used directly by the Vision MCP server for free image analysis.

### Steps

1. Go to **[https://openrouter.ai/keys](https://openrouter.ai/keys)**.
2. Create account → **Create Key** → name it `LiveClaw`.
3. Copy the key.

### Add to `.env`

```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

### Add to Bifrost UI

```bash
# SSH tunnel to Bifrost UI
ssh -L 8080:localhost:8080 root@<BACKEND_IP>
# Open http://localhost:8080 in browser
# Go to Provider Configuration → add provider named 'openrouter':
#   Type:     OpenAI-compatible
#   Base URL: https://openrouter.ai/api/v1
#   API Key:  (same OPENROUTER_API_KEY value)
# → Save
```

### Vision MCP Server (automatic)

Once `OPENROUTER_API_KEY` is set in `.env`, every deployed bot automatically gets
an `image_analysis` tool powered by `qwen/qwen2.5-vl-72b-instruct:free`.
Usage is capped at `VISION_DAILY_LIMIT` (default: 20) analyses per user per UTC day.
No extra account or key needed — it uses the same OpenRouter key above.

---

## 7. Putting It All Together

### Local Development

```bash
# Inject generated secrets from Keychain
bash scripts/keychain-secrets.sh --inject

# Fill in remaining secrets
nano backend/.env
# Fill: TELEGRAM_MASTER_BOT_TOKEN, TURNSTILE_SECRET_KEY,
#       DODO_API_KEY, DODO_WEBHOOK_SECRET, DODO_PRODUCT_ID
```

### Production Droplet

SSH into the backend droplet and create the `.env`:

```bash
ssh root@<BACKEND_IP>
nano /opt/liveclaw/backend/.env
```

Template:

```dotenv
# ─── Server ──────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000

# ─── Security (from scripts/keychain-secrets.sh) ─────────────────
TOKEN_ENCRYPTION_KEY=<from keychain>
ADMIN_SECRET=<from keychain>

# ─── Telegram ────────────────────────────────────────────────────
TELEGRAM_MASTER_BOT_TOKEN=<from BotFather>

# ─── Dodo Payments ───────────────────────────────────────────────
DODO_API_KEY=<from Dodo Dashboard>
DODO_WEBHOOK_SECRET=<from Dodo Dashboard>
DODO_PRODUCT_ID=<pdt_... from Product Catalog>

# ─── Cloudflare Turnstile ────────────────────────────────────────
TURNSTILE_SECRET_KEY=<from Cloudflare>

# ─── CORS ────────────────────────────────────────────────────────
ALLOWED_ORIGINS=https://liveclaw.xyz,https://www.liveclaw.xyz

# ─── Bifrost ─────────────────────────────────────────────────────
BIFROST_GATEWAY_URL=http://localhost:8080

# ─── Observability (Grafana + Tempo + Prometheus) ────────────────
# Grafana UI: http://localhost:3001 (SSH tunnel to access)
# Default admin login: admin / <GF_ADMIN_PASSWORD>
GF_ADMIN_PASSWORD=<strong password — change from default>

# ─── Paths ───────────────────────────────────────────────────────
DB_PATH=/opt/liveclaw/backend/liveclaw.db
BOTS_DIR=/opt/liveclaw/bots
PICOBOT_PATH=/opt/liveclaw/backend/picobot

# ─── Database (required in production) ───────────────────────────
DATABASE_URL=postgresql://<user>:<pass>@<host>:<port>/<db>

# Optional PostgreSQL pool tuning
PG_POOL_MAX=20
PG_POOL_IDLE_TIMEOUT_MS=30000
PG_POOL_CONNECTION_TIMEOUT_MS=5000
PG_POOL_QUERY_TIMEOUT_MS=15000
PG_SSL_REJECT_UNAUTHORIZED=false
PG_APP_NAME=liveclaw-orchestrator

# Optional queue-orchestration rollout flags
SCALE_QUEUE_ORCHESTRATION=0
SCALE_QUEUE_ASYNC_MODE=0
SCALE_QUEUE_POLL_MS=1500

# ─── Non-prod auth toggles (keep disabled in production) ─────────
ALLOW_DEV_AUTH_BYPASS=0
ALLOW_DEV_ADMIN_LOGIN_FALLBACK=0
# ADMIN_DEV_TOTP_CODE=<6-digit code; only if fallback is explicitly enabled>
```

After saving:

```bash
pm2 reload liveclaw-orchestrator --update-env
```

---

## 8. Frontend Configuration

Frontend keys are set as `window.*` globals in `index.html` (or via `config.js` injection):

```html
<script>
  window.LIVECLAW_API_BASE         = '/api';
  window.LIVECLAW_GOOGLE_CLIENT_ID = 'PASTE_GOOGLE_CLIENT_ID_HERE';
</script>
```

---

## 9. Telegram Webhook Setup

Once DNS and SSL are active:

```bash
ssh root@<BACKEND_IP>
cd /opt/liveclaw
node scripts/set-webhook.js
```

Verify:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_MASTER_BOT_TOKEN}/getWebhookInfo" | jq
```

---

## 10. Verification Checklist

```bash
# 1. Health check
curl -s https://api.liveclaw.xyz/health | jq

# 2. Admin access
curl -s https://api.liveclaw.xyz/admin/stats \
  -H "x-admin-secret: $ADMIN_SECRET" | jq

# 3. Turnstile endpoint
curl -s -X POST https://api.liveclaw.xyz/verify-turnstile \
  -H "Content-Type: application/json" -d '{}' | jq

# 4. Dodo webhook (send test event from Dodo Dashboard)
# Dodo Dashboard → Developer → Webhooks → Send Test Event

# 5. Pricing endpoint
curl -s https://api.liveclaw.xyz/pricing | jq

# 6. Bifrost (from droplet)
ssh root@<BACKEND_IP> 'curl -s http://localhost:8080/health'
```

---

## 11. Key Rotation

| Key | Procedure |
|-----|-----------|
| `TOKEN_ENCRYPTION_KEY` | **Caution** — invalidates all encrypted tokens. Stop all bots, rotate, users re-deploy. |
| `ADMIN_SECRET` | Generate new → update `.env` → `pm2 reload`. Immediate. |
| `TELEGRAM_MASTER_BOT_TOKEN` | BotFather `/revoke` → get new → update `.env` → re-register webhook. |
| `DODO_API_KEY` | Delete old in Dodo Dashboard → create new → update `.env` → `pm2 reload`. |
| `DODO_WEBHOOK_SECRET` | Delete old webhook → create new → copy secret → update `.env` → `pm2 reload`. |
| `TURNSTILE_SECRET_KEY` | Rotate in Cloudflare → update `.env` → `pm2 reload`. |
| Google Client ID | Delete in GCP Console → create new → update frontend HTML. |

```bash
# After any backend key change:
pm2 reload liveclaw-orchestrator --update-env
pm2 logs liveclaw-orchestrator --lines 20
```

---

*Last updated: March 7, 2026*
