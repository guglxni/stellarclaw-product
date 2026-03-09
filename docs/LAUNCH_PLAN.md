# LiveClaw — Launch Plan & Subscription Revenue Roadmap

**Date:** March 6, 2026
**Goal:** Launch a subscription-based AI agent platform that undercuts SimpleClaw on price while maintaining healthy margins. Telegram-first with Discord + WhatsApp coming soon.

---

## Executive Summary

LiveClaw is 90 % built. The backend, admin dashboard, CI/CD, and testing (95/95) are production-ready. What remains is **Dodo Payments subscription integration**, **pricing page UI**, **referral system**, and standard **production configuration** (DNS, SSL, API keys).

### Monetisation Model — Subscription (Paid)

Previous models (AppLixir ads, Telegram Stars micro-payments) are **deferred**.
- AppLixir requires ≥ 5,000 daily impressions — not viable at launch.
- Stars micro-payments add friction and limit revenue.
- **Subscriptions** align with the market (SimpleClaw, Poe, ChatGPT Plus) and produce predictable recurring revenue.

### Why We Can Undercut SimpleClaw

| Factor | SimpleClaw | LiveClaw |
|--------|-----------|----------|
| LLM Models | Claude Opus 4.5, GPT-5.2, Gemini 3 Flash | MiniMax M2.5 (≈ 50× cheaper per token) |
| LLM Cost / msg | $0.005 – 0.02 | **$0.0004** |
| Infrastructure | Cloud servers (scarcity-marketed) | Lightweight picobot Go binary (~15 MB RAM each) |
| Gateway | Unknown (likely external SaaS) | Self-hosted Bifrost (< 100 µs, $0 cost) |
| Estimated pricing | $10 – 20+/mo (not publicly listed) | **$2.99 – 9.99/mo** |

Our cost advantage is structural: MiniMax M2.5 delivers excellent quality at a fraction of GPT/Claude costs, and picobot + Bifrost are both self-hosted with near-zero overhead.

---

## Pricing Tiers

### Current Pricing (Simplified — Single Plan)

| Plan | Price | Bots | Budget | Channels | Key Features |
|------|-------|------|--------|----------|--------------|
| **Standard** | **$12.99/mo** | 1 | $5.00/mo AI budget | Telegram | Full feature access, SOUL.md, MCP |
| **Early Bird** | **$9.99/mo** | 1 | $5.00/mo AI budget | Telegram | Same features, promo code EARLYCLAW |
| **Trial** | **$0.99** (one-time, 24 h) | 1 | $5.00 pro-rated | Telegram | Full feature access, no commitment |
| **Trial (Early Bird)** | **$0.69** (one-time, 24 h) | 1 | $5.00 pro-rated | Telegram | Promo code EARLYCLAW |

### EARLYCLAW Promo Code

- First **500 subscribers** get early bird pricing ($9.99/mo or $0.69 trial)
- Tracked via `subscriptions.early_bird` column in SQLite
- Validated server-side in `/create-checkout-session` — returns 410 when exhausted
- Uses dedicated Dodo product ID (`DODO_EARLY_BIRD_PRODUCT_ID`)

### Future Pricing Tiers (Post-Launch)

| Plan | Price | Bots | Channels | Key Features |
|------|-------|------|----------|--------------|
| **Starter** | **$3.99/mo** | 1 | Telegram | Custom system prompt |
| **Pro** | **$7.99/mo** | 1 | Telegram | Priority support, analytics dashboard |
| **Business** | **$14.99/mo** | 3 | All (when available) | Multi-bot, webhook integrations, team access |

---

## Unit Economics

### Model Pricing (Confirmed)

| Model | Input | Output | Cache Hit |
|-------|-------|--------|-----------|
| MiniMax M2.5 | $0.30/MTok | $1.20/MTok | $0.03/MTok |
| Kimi K2.5 | $0.60/MTok | $3.00/MTok | $0.10/MTok |

### Per-User Cost Breakdown (with rate limits: 50k tok/day, 100 req/h)

| Cost Component | Light (30 msg/day) | Medium (100 msg/day) | Heavy (rate-limited ~24 msg/day) |
|---------------|-------------------|---------------------|--------------------------------|
| LLM — MiniMax M2.5 | $0.36/mo | $0.84/mo | $0.84/mo |
| LLM — Kimi K2.5 | $0.81/mo | $1.94/mo | $1.94/mo |
| Infrastructure (at 100 users) | $0.16/mo | $0.16/mo | $0.16/mo |
| Dodo fee (4.5% + $0.40) | varies | varies | varies |

### Margin Analysis (Current Pricing — Kimi K2.5 worst-case)

| Plan | Price | Dodo Fee | Net Rev | COGS (Kimi heavy) | Margin | Margin % |
|------|-------|----------|---------|-------------------|--------|----------|
| Standard $12.99/mo | $12.99 | $0.98 | $12.01 | $2.10 | $9.91 | **76.3%** |
| Early Bird $9.99/mo | $9.99 | $0.85 | $9.14 | $2.10 | $7.04 | **70.5%** |
| Trial $0.99 | $0.99 | $0.44 | $0.55 | $0.07 | $0.48 | **48.5%** |
| Trial (EB) $0.69 | $0.69 | $0.43 | $0.26 | $0.07 | $0.19 | **27.4%** |

### Margin Analysis (MiniMax M2.5 — lower cost)

| Plan | Price | Net Rev | COGS (MiniMax heavy) | Margin | Margin % |
|------|-------|---------|---------------------|--------|----------|
| Standard $12.99/mo | $12.99 | $12.01 | $1.00 | $11.01 | **84.7%** |
| Early Bird $9.99/mo | $9.99 | $9.14 | $1.00 | $8.14 | **81.5%** |

### Breakeven Analysis

Fixed costs: $16/mo (2 × DigitalOcean droplets).

| Scenario | Avg Revenue/User | Users to Break Even |
|----------|-----------------|---------------------|
| All Early Bird ($9.99) | $9.99 | 2 users |
| All Standard ($12.99) | $12.99 | 2 users |
| Mix (50% EB, 50% Std) | $11.49 | 2 users |

**Breakeven at 4–16 subscribers.** With $200 in DO credits we have 12+ months of runway before even needing revenue.

---

## Referral Program

### Mechanics

| Role | Reward |
|------|--------|
| **Referrer** | 1 free month added to current plan for every **3** paid referrals |
| **Referee** | **3-day trial** (instead of 1-day) + **20 % off first month** |

### Implementation

- Each user gets a unique referral code: `LC-XXXXX` (5 alphanumeric uppercase).
- Code is shown in the success dashboard after deployment.
- Referee enters code during signup (optional field).
- Referral tracked in `referrals` table with status (`pending` → `converted` → `rewarded`).
- Referrer reward only triggers when referee completes first paid month.
- Cap: max 4 free months per calendar year (prevents gaming).

### Referral Growth Model

| Month | Users | Referrals/User | New from Referrals | Total |
|-------|-------|---------------|-------------------|-------|
| 1 | 50 | 0.3 | 15 | 65 |
| 2 | 65 | 0.4 | 26 | 91 |
| 3 | 91 | 0.5 | 46 | 137 |
| 6 | ~300 | 0.5 | ~150 | ~450 |

---

## Channels — Supported via picobot

| Channel | Status | Notes |
|---------|--------|-------|
| **Telegram** | **Active** (launch) | Bot API via BotFather token. Fully integrated. |
| **Discord** | **Coming Soon** | discordgo library, Developer Portal bot token, responds on @mention + DMs. |
| **WhatsApp** | **Coming Soon** | whatsmeow + SQLite session, QR code pairing, LID-based auth. Full picobot build only. |

All three channels are supported by picobot's `config.json` channels section and the `picobot channels login` CLI. Discord and WhatsApp will be enabled for **Business** tier subscribers when ready. picobot's roadmap also includes MCP Servers integration.

---

## Payment Integration — Dodo Payments

### Why Dodo Payments

- **Merchant of Record:** Dodo legally acts as the seller in all 150+ countries. EU VAT, India GST, US sales tax — all collected and remitted automatically. No separate tax tooling needed.
- Hosted checkout handles the full payment UI (no custom forms needed).
- Customer Portal lets users manage/cancel subscriptions themselves.
- Webhooks notify us of payment events in real-time.
- 4.5 % + $0.40 per subscription transaction — inclusive of tax handling (vs Stripe 2.9 % + $0.30 + Stripe Tax 0.5 % + $10/mo analytics).
- Official Node.js SDK: `npm install @dodopayments/sdk`.

### Dodo Payments Architecture

```
User clicks "Subscribe" on liveclaw.xyz
  ↓
Frontend calls POST /create-checkout-session { plan, referralCode? }
  ↓
Backend calls Dodo API → creates Checkout Session with Product ID
  ↓
User redirected to Dodo-hosted checkout page (150+ countries, 80+ currencies)
  ↓
Payment succeeds → Dodo fires webhook → POST /webhook/dodo
  ↓
Backend: creates/updates subscription record in SQLite
         activates bot deployment capability for user
  ↓
User returns to liveclaw.xyz → success page → deploy bot flow
```

### Subscription Lifecycle

```
subscription.created     → create subscription record, set status=trialing/active
subscription.active      → extend current_period_end, log payment
subscription.on_hold     → set status=past_due, send Telegram warning
subscription.plan_changed → handle plan upgrades/downgrades
subscription.cancelled   → set status=cancelled, stop bots after grace period
payment.succeeded        → log successful payment
payment.failed           → set status=past_due, trigger dunning flow
```

### Grace Period

When a subscription lapses:
1. **Day 0–3:** Dodo retries payment automatically. Bot keeps running.
2. **Day 4–7:** Status → `past_due`. Bot keeps running but user sees warning banner.
3. **Day 7+:** Status → `cancelled`. Bots are stopped. Data retained for 30 days.
4. **Day 37+:** User data eligible for cleanup.

### Required Dodo Resources

| Resource | Purpose |
|----------|---------|
| **4 Products** | Trial, Starter, Pro, Business |
| **Product IDs** | One per plan (format: `pdt_...`). Early bird = separate product or coupon. |
| **Customer Portal** | Self-serve cancel, plan change, payment method update |
| **Webhook Endpoint** | `https://api.liveclaw.xyz/webhook/dodo` |

### Required Environment Variables

```dotenv
DODO_API_KEY=<from Dodo Dashboard>   # Backend only — never expose
DODO_WEBHOOK_SECRET=<from Dodo>       # Verify webhook signatures
DODO_PRODUCT_TRIAL=pdt_...            # $0.99 one-time
DODO_PRODUCT_STARTER=pdt_...          # $3.99/mo recurring
DODO_PRODUCT_PRO=pdt_...              # $7.99/mo recurring
DODO_PRODUCT_BUSINESS=pdt_...         # $14.99/mo recurring
# No frontend key needed — Dodo checkout is fully server-side
```

---

## Implementation Plan

### Phase 0 — Pre-Launch Blockers (Do First)

These are hard blockers. Nothing works in production until they're done.

#### 0.1 DNS Configuration
- [ ] A record: `liveclaw.xyz` → frontend droplet IP
- [ ] A record: `www.liveclaw.xyz` → frontend droplet IP
- [ ] A record: `api.liveclaw.xyz` → backend droplet IP
- [ ] Wait for propagation (`dig liveclaw.xyz +short`).

#### 0.2 SSL Certificate
```bash
# Frontend droplet
certbot --nginx -d liveclaw.xyz -d www.liveclaw.xyz -m admin@liveclaw.xyz --agree-tos --redirect

# Backend droplet
certbot --nginx -d api.liveclaw.xyz -m admin@liveclaw.xyz --agree-tos --redirect
```

#### 0.3 Production Environment Keys
SSH into the backend droplet and fill `backend/.env`:

| Key | Source | Priority |
|-----|--------|----------|
| `TOKEN_ENCRYPTION_KEY` | `scripts/keychain-secrets.sh` | Critical |
| `ADMIN_SECRET` | `scripts/keychain-secrets.sh` | Critical |
| `MINI_APP_SECRET` | `scripts/keychain-secrets.sh` | Critical |
| `TELEGRAM_MASTER_BOT_TOKEN` | @BotFather (already stored in Keychain) | Critical |
| `TURNSTILE_SECRET_KEY` | [Cloudflare Dashboard](https://dash.cloudflare.com/) | Critical |
| `DODO_API_KEY` | [Dodo Payments Dashboard](https://app.dodopayments.com/) | Critical |
| `DODO_WEBHOOK_SECRET` | Dodo Webhooks settings | Critical |
| `DODO_PRODUCT_*` | Dodo Product Catalog | Critical |
| `GOOGLE_CLIENT_ID` | [Google Cloud Console](https://console.cloud.google.com/) | Critical |

```bash
pm2 reload liveclaw-orchestrator --update-env
```

#### 0.4 Bifrost LLM Provider Key
```bash
ssh -L 8080:localhost:8080 root@<BACKEND_IP>
# Open http://localhost:8080 → Provider Config → add MINIMAX_API_KEY
```

#### 0.5 Telegram Webhook
```bash
cd /opt/liveclaw && node scripts/set-webhook.js
```

#### 0.6 Google OAuth Setup
1. [Google Cloud Console](https://console.cloud.google.com/) → Credentials → OAuth 2.0 Client ID.
2. Authorized origins: `https://liveclaw.xyz`, `https://www.liveclaw.xyz`.
3. Copy Client ID → set in frontend `config.js`.

#### 0.7 Dodo Payments Setup
1. Create Dodo Payments account → [app.dodopayments.com](https://app.dodopayments.com/).
2. Create 4 Products (Trial, Starter, Pro, Business) with correct prices and Tax Category = SaaS.
3. Configure Webhook endpoint: `https://api.liveclaw.xyz/webhook/dodo`.
4. Subscribe to events: `subscription.active`, `subscription.on_hold`, `subscription.cancelled`, `subscription.plan_changed`, `payment.succeeded`, `payment.failed`.
5. Copy `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, and Product IDs to `backend/.env`.

---

### Phase 1 — Dodo Payments Subscription Integration (Week 1)

#### 1.1 Backend — New `dodo.js` Module

Create `backend/dodo.js` to encapsulate all Dodo SDK operations:

```javascript
// backend/dodo.js — Dodo Payments subscription management
const { DodoPayments } = require('@dodopayments/sdk');
const client = new DodoPayments({ bearerToken: process.env.DODO_API_KEY });

module.exports = {
    createCheckoutSession(plan, userId, email, referralCode) { /* ... */ },
    createPortalSession(dodoCustomerId) { /* ... */ },
    constructWebhookEvent(body, headers, secret) { /* ... */ },
    cancelSubscription(subscriptionId) { /* ... */ },
};
```

Install dependency:
```bash
cd backend && npm install @dodopayments/sdk
```

#### 1.2 Backend — Database Schema Changes

New `subscriptions` table:

```sql
CREATE TABLE IF NOT EXISTS subscriptions (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id               TEXT    NOT NULL UNIQUE,
    dodo_customer_id      TEXT    UNIQUE,
    dodo_subscription_id  TEXT    UNIQUE,
    plan                  TEXT    NOT NULL DEFAULT 'trial'
                          CHECK(plan IN ('trial','starter','pro','business')),
    status                TEXT    NOT NULL DEFAULT 'inactive'
                          CHECK(status IN ('active','past_due','cancelled','inactive','trialing')),
    trial_ends_at         DATETIME,
    current_period_start  DATETIME,
    current_period_end    DATETIME,
    early_bird            INTEGER NOT NULL DEFAULT 0,
    referral_code         TEXT    UNIQUE,
    referred_by           TEXT,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referrals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id  TEXT    NOT NULL,
    referee_id   TEXT    NOT NULL,
    code         TEXT    NOT NULL,
    status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK(status IN ('pending','converted','rewarded')),
    rewarded_at  DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           TEXT    NOT NULL,
    dodo_payment_id   TEXT    UNIQUE,
    amount_cents      INTEGER NOT NULL,
    currency          TEXT    NOT NULL DEFAULT 'usd',
    plan              TEXT    NOT NULL,
    status            TEXT    NOT NULL DEFAULT 'paid',
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### 1.3 Backend — New API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/create-checkout-session` | Google JWT | Create Dodo Payments Checkout Session for a plan |
| POST | `/create-portal-session` | Google JWT | Create Dodo Customer Portal session |
| GET | `/subscription/:userId` | Google JWT | Get user's subscription status |
| POST | `/webhook/dodo` | Dodo sig | Handle all Dodo webhook events |
| POST | `/referral/generate` | Google JWT | Generate referral code for user |
| POST | `/referral/apply` | Google JWT | Apply referral code during signup |
| GET | `/pricing` | None | Return current pricing tiers (public) |

#### 1.4 Backend — Subscription Gate on Deploy

Modify `POST /deploy-bot` to check subscription status:

```javascript
// In deploy-bot handler, before spawning picobot:
const sub = stmtSubs.getByUserId.get(userId);
if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status)) {
    return res.status(402).json({
        error: 'Active subscription required',
        redirect: '/pricing',
    });
}

// Check bot limit by plan
const botLimits = { trial: 1, starter: 1, pro: 1, business: 3 };
const maxBots = botLimits[sub.plan] || 1;
const activeBots = stmtSubs.countUserBots.get(userId)?.count || 0;
if (activeBots >= maxBots) {
    return res.status(403).json({
        error: `Plan allows max ${maxBots} bot(s). Upgrade to deploy more.`,
    });
}
```

#### 1.5 Backend — Bifrost Budget by Plan

Replace the fixed $0.05 credit limit with plan-based budgets:

| Plan | Monthly Bifrost Budget | Rationale |
|------|----------------------|-----------|
| Trial | $0.50 (24 h only) | ~1,250 messages — enough for a full day |
| Starter | $1.50/mo | ~3,750 msgs → covers 3,000 cap + buffer |
| Pro | $5.00/mo | Unlimited — auto-topped up if depleted |
| Business | $15.00/mo (shared) | Unlimited × 3 bots |

For Pro/Business, the orchestrator runs a daily cron that checks Bifrost budget and auto-refills when balance drops below $0.50.

#### 1.6 Backend — Defer Stars/Ads

The existing Stars and AppLixir code paths remain in `server.js` but are **gated**:
- Stars endpoints (`/create-invoice`, `/webhook/telegram-stars`): keep functional but hidden from user flow. Re-enable as supplementary payment later.
- AppLixir endpoint (`/webhook/applixir-reward`): gated behind `APPLIXIR_SECRET_KEY`.
- `notify-low-credits` inline keyboard updated — shows "Top Up" with Stars link only as a fallback; primary path is subscription renewal via Dodo Customer Portal.

---

### Phase 2 — Frontend Changes (Week 1-2)

#### 2.1 Pricing Section on Landing Page

Add a pricing section to `index.html` below the deploy flow. Shows:
- 4 plan cards (Trial, Starter, Pro, Business)
- Early bird badge on applicable plans
- "Subscribe" button → calls `POST /create-checkout-session` → redirects to Dodo hosted checkout
- Feature comparison table
- Referral code input field

#### 2.2 Update `liveclaw.js`

- **Pre-deploy check:** Before deploy flow, verify subscription via `GET /subscription/:userId`.
  - If no subscription → show pricing modal.
  - If expired → show "Renew" prompt.
- **Success dashboard:** Replace ad/Stars text with subscription info:
  - Plan name + badge
  - Days remaining in current period
  - "Manage Subscription" link → Dodo Customer Portal
  - Referral code with copy button
- **Remove all ad/Stars references** from dashboard text.

#### 2.3 Update Recharge Mini App → Subscription Portal

Convert `mini-app/recharge/index.html` from ad-watching to **subscription status + upgrade**:
- Show current plan and remaining period.
- "Upgrade" → creates checkout session for next tier.
- "Manage" → opens Dodo Customer Portal.
- Keep Turnstile for bot protection.
- Remove AppLixir SDK.

#### 2.4 Update `index.html` Meta Descriptions

```
Old: "Deploy your own Claw agent in under 1 minute for free. Ad-supported, with Telegram Stars upgrade."
New: "Deploy your own AI agent on Telegram in under 1 minute. Plans from $0.99. Cheaper than SimpleClaw."
```

#### 2.5 Channel UI

No changes needed — `index.html` already shows Telegram as active, Discord + WhatsApp as "Coming Soon" with disabled buttons.

---

### Phase 3 — Referral System (Week 2)

#### 3.1 Code Generation

```javascript
function generateReferralCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 confusion
    let code = 'LC-';
    for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
    return code;
}
```

#### 3.2 Application Flow

1. Referee enters code during checkout (optional field in `create-checkout-session`).
2. Backend validates code, creates `referrals` record → `pending`.
3. On referee's first `invoice.paid` → mark referral `converted`.
4. When referrer accumulates 3 `converted` referrals → grant 1 free month, mark as `rewarded`.

#### 3.3 Referral Dashboard

In success dashboard show:
- Referral code with one-click copy
- Share link: `https://liveclaw.xyz?ref=LC-XXXXX`
- "X of 3 referrals → next free month"
- Progress bar toward reward

---

### Phase 4 — Pre-Launch Hardening (Week 2)

#### 4.1 Security Checklist
- [ ] Rotate all placeholder keys in production `.env`.
- [ ] CORS locked to `https://liveclaw.xyz` only.
- [ ] Rate limiters tested — 20× rapid deploy → 429.
- [ ] Admin dashboard IP-restricted or behind Cloudflare Access.
- [ ] Helmet headers confirmed.
- [ ] Token encryption confirmed.
- [ ] Firewall: SSH + Nginx Full only.
- [ ] Dodo webhook signature verification tested.

#### 4.2 Monitoring
- [ ] [UptimeRobot](https://uptimerobot.com/) → `https://api.liveclaw.xyz/health`.
- [ ] PM2 log rotation configured.
- [ ] Dodo webhook delivery monitoring.
- [ ] Admin dashboard daily revenue check.

#### 4.3 Backups
```bash
0 4 * * * sqlite3 /opt/liveclaw/backend/liveclaw.db \
  ".backup '/opt/liveclaw/backups/liveclaw-$(date +\%Y\%m\%d).db'" && \
  find /opt/liveclaw/backups -mtime +7 -delete
```

---

### Phase 5 — Launch (Week 3)

#### Pre-Launch Checklist
- [ ] `npm test` — all 95+ tests pass.
- [ ] CI/CD green on `main`.
- [ ] Both droplets healthy.
- [ ] Full user flow tested (Google sign-in → Dodo checkout → deploy → message → stop → manage subscription → cancel).
- [ ] Early bird pricing active in Dodo Products.
- [ ] Referral system tested.

#### Launch Day
- [ ] Post on Telegram groups + Reddit + Product Hunt + Hacker News + X.
- [ ] Monitor admin dashboard + Dodo Payments dashboard.
- [ ] Watch `pm2 logs` for errors.

---

### Phase 6 — Growth & Distribution

#### 6.1 Launch Channels

| Channel | Strategy |
|---------|----------|
| Telegram groups | 30 s demo video in AI/bot communities |
| Reddit | r/Telegram, r/artificial, r/SideProject |
| Product Hunt | "Deploy your AI agent on Telegram in 30 s — from $0.99" |
| Hacker News | "Show HN: Subscription AI agent hosting — $1.99/mo early bird" |
| Twitter/X | Demo thread + SimpleClaw cost comparison |
| Dev.to | "How I Built a Self-Hosted AI Agent Platform" |

#### 6.2 Retention Hooks
- Telegram notification 3 days before renewal.
- Weekly usage digest via master bot.
- Referral nudge after first deployment.

#### 6.3 Pricing Evolution
- **Phase A:** Trial + 3 tiers + early bird.
- **Phase B (200+ subs):** Annual plans (2 months free).
- **Phase C (500+ subs):** Enterprise tier ($29.99/mo), API access, custom models.
- **Phase D (1000+ subs):** Re-evaluate ad-based free tier (AppLixir volume should qualify).

---

## Revenue Projections

### Conservative (Organic Growth)

| Month | Subs | Avg Rev | MRR | LLM Cost | Dodo Fees | Server | **Net** |
|-------|------|---------|-----|----------|-----------|--------|---------|
| 1 | 15 | $3.50 | $53 | $5 | $8 | $16 | **+$24** |
| 2 | 40 | $4.00 | $160 | $16 | $23 | $16 | **+$105** |
| 3 | 80 | $4.50 | $360 | $32 | $48 | $16 | **+$264** |
| 6 | 200 | $5.00 | $1,000 | $80 | $126 | $24 | **+$770** |
| 12 | 500 | $5.50 | $2,750 | $200 | $325 | $48 | **+$2,177** |

### Optimistic (Viral Launch)

| Month | Subs | Avg Rev | MRR | LLM Cost | Dodo Fees | Server | **Net** |
|-------|------|---------|-----|----------|-----------|--------|---------|
| 1 | 80 | $4.00 | $320 | $32 | $46 | $16 | **+$226** |
| 3 | 300 | $5.00 | $1,500 | $120 | $189 | $24 | **+$1,167** |
| 6 | 800 | $5.50 | $4,400 | $320 | $520 | $48 | **+$3,512** |
| 12 | 2,000 | $6.00 | $12,000 | $800 | $1,340 | $96 | **+$9,764** |

---

## Deferred Monetisation (Post-Traction)

### AppLixir Rewarded Video Ads
- Requirement: ≥ 5,000 daily impressions.
- Revisit at ~200+ DAU (Phase D).
- Already fully implemented — S2S handler, 6-layer anti-fraud, Refuel Mini App.

### Telegram Stars Micro-Payments
- Use case: Supplementary top-up for pay-as-you-go users.
- Already implemented — invoice creation, webhook, credit system.
- Revisit when user feedback indicates demand.

---

## Infrastructure & Capacity

| Resource | Cost | Capacity |
|----------|------|----------|
| Frontend droplet | $4/mo | Static files, unlimited traffic |
| Backend droplet | $12/mo | 75–150 concurrent bots |
| Domain | ~$10/yr | liveclaw.xyz |
| SSL | Free | Let's Encrypt |
| Bifrost | Free | Self-hosted Docker |
| Dodo Payments | 4.5 % + $0.40/tx (MoR, all taxes included) | Pay-as-you-go |
| **Total fixed** | **$16/mo** | |

Scale at: 100 bots → $24/mo, 250 bots → $48/mo.

---

## Implementation Checklist

| # | Task | Effort | Status |
|---|------|--------|--------|
| 1 | Dodo Payments account + products | 30 min | To Do |
| 2 | `npm install @dodopayments/sdk` | 1 min | To Do |
| 3 | `backend/dodo.js` module | 2 h | To Do |
| 4 | `subscriptions`, `referrals`, `payments` tables | 1 h | To Do |
| 5 | Checkout, portal, subscription, pricing endpoints | 3–4 h | To Do |
| 6 | Dodo webhook handler | 2 h | To Do |
| 7 | Gate `deploy-bot` behind active subscription | 30 min | To Do |
| 8 | Plan-based Bifrost budgets | 1 h | To Do |
| 9 | Referral code gen + validation | 1 h | To Do |
| 10 | Frontend pricing section / modal | 3–4 h | To Do |
| 11 | Update success dashboard | 2 h | To Do |
| 12 | Rewrite mini-app/recharge → subscription portal | 2 h | To Do |
| 13 | Update `.env` files + config template | 30 min | To Do |
| 14 | Update meta descriptions | 15 min | To Do |
| 15 | Tests for Dodo + subscription endpoints | 3–4 h | To Do |
| **Total** | | **~20–24 h** | |

---
**End of Launch Plan.**