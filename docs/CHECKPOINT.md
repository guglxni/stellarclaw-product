# 🏁 LiveClaw Project Checkpoint

**Date:** July 6, 2025
**Project Phase:** Subscription Model Pivot — Documentation & Planning Complete, Dodo Payments Implementation Pending.

This document serves as a comprehensive handoff for any incoming agent to understand the current architecture, recent progress, and immediate next steps for the LiveClaw platform.

---

## 1. Project Overview & Architecture

LiveClaw is a **subscription-based** AI agent platform native to Telegram (with Discord and WhatsApp coming soon). It allows users to deploy isolated, high-performance AI agents to their own messaging bots — plans start at **$0.99**.

### Core Stack
*   **Orchestrator:** Node.js 22 (Express 5) backend (`server.js`). Handles user onboarding, process management, webhooks, subscription management, and comprehensive admin API.
*   **AI Agent Engine:** `picobot` (Go binary). Extremely lightweight; one isolated instance is spawned per user.
*   **AI Gateway:** **Bifrost** (Go). Fully self-hosted. Handles LLM traffic routing, virtual key management, and strict budget enforcement (< 100µs latency).
*   **Database:** SQLite (`liveclaw.db`) in WAL mode for concurrent access.
*   **Infrastructure:** Two DigitalOcean Droplets — Frontend (`liveclaw.xyz`, $4/mo) + Backend (`api.liveclaw.xyz`, $12/mo).
*   **Monetization:** **Dodo Payments subscriptions** — Trial ($0.99/24h), Starter ($3.99/mo), Pro ($7.99/mo), Business ($14.99/mo). Early Bird pricing active for first 200 subscribers. Dodo acts as Merchant of Record (handles global tax/VAT automatically).
*   **Security:** Cloudflare Turnstile (bot protection), Google Auth (JWT validation for deployment).
*   **Admin:** Full admin dashboard SPA with revenue analytics, user management, event logs, and system monitoring.
*   **Channels:** Telegram (active) • Discord (coming soon) • WhatsApp (coming soon).

### Monetization History
1. **v1 (Ad-supported):** AppLixir rewarded video ads + Telegram Stars top-ups. ❌ AppLixir requires 5,000 daily impressions minimum — not viable pre-scale.
2. **v2 (Stars-only):** Telegram Stars micro-payments only. ❌ Too much friction, limited revenue potential.
3. **v3 (Subscriptions — CURRENT):** Dodo Payments-powered SaaS subscriptions. ✅ Predictable MRR, 53-79% gross margins, undercuts SimpleClaw pricing. Dodo as MoR removes tax complexity globally.

---

## 2. Recent Major Milestones

### A. Subscription Model Pivot (Current — Documentation Phase)
Pivoted from ad/Stars monetization to **Dodo Payments subscription billing**. Full pricing model designed, all documentation updated:
*   **LAUNCH_PLAN.md:** Complete rewrite (~500 lines) — pricing tiers, unit economics, Dodo Payments architecture, referral program, 15-item implementation checklist, revenue projections.
*   **README.md:** Updated tagline, tech stack (Dodo Payments replaces AppLixir+Stars), endpoints (new Subscriptions section, legacy deferred), project structure.
*   **CREDENTIALS.md:** Added Dodo Payments section (§3) with setup steps, AppLixir demoted to "Deferred", updated .env templates, verification checklist, key rotation table.
*   **Implementation status:** Documentation and planning complete. Dodo Payments SDK integration pending (~20-24h estimated effort).

### B. Bifrost Gateway Transition (Completed)
Migrated from Portkey.ai SaaS to fully self-hosted Bifrost AI Gateway.
*   `backend/bifrost.js` manages Virtual Keys (`POST /api/governance/virtual-keys`) per user.
*   Zero latency overhead, strict per-user dollar limits, Bifrost runs locally in Docker on port 8080.

### C. Production CI/CD Pipeline (Completed)
4-stage gated deployment via GitHub Actions:
1. Test Suite (Vitest) → 2. Lint & Validate (ESLint) → 3. Security Audit (`npm audit`) → 4. Deploy (main-only, SCP + PM2 reload).

### D. Comprehensive Testing Framework (Completed)
*   **95/95 tests** passing in ~1.0s (Vitest + Supertest).
*   19 unit tests (Bifrost, 100% coverage) + 76 integration tests (all 19 endpoints).
*   In-memory SQLite database in tests with bypassed rate limiters.

### E. Brand Cleanup — SimpleClaw → LiveClaw (Completed)
Full rebrand across all files. Zero SimpleClaw references remaining (verified by grep audit).

### F. Admin Dashboard & API (Completed)
6 admin endpoints + full SPA dashboard at `/admin/`:
*   Revenue analytics (period filtering, daily breakdowns)
*   User management (paginate, filter, force-stop, credit adjustment)
*   Event log viewer (type/user filtering, pagination)
*   Auto-refresh, dark theme, responsive design.

### G. Frontend Auth Wiring (Completed)
Google JWT stored in `state.idToken`, sent as `Authorization: Bearer` on deploy/stop. Persisted in localStorage.

### H. Anti-Fraud System (Completed — Partially Deferred)
6-layer anti-fraud pipeline built for ad flow. Layers 1-4 (Turnstile, daily cap, IP rate limiting, cooldown) remain useful for subscription abuse prevention. Layers 5-6 (AppLixir eventId dedup, HMAC-signed URLs) are ad-specific and deferred.

---

## 3. Current Codebase State

### Backend Files
*   **`backend/server.js`** (~1358 lines): Core Express orchestrator. Exports `app`, `db`, `stmt`, `generateMiniAppToken`, `verifyMiniAppToken`. Handles Google JWT auth, picobot spawning, 6 admin endpoints, notification endpoints, HMAC helpers. AppLixir/Stars code present but will be superseded by Dodo Payments subscription endpoints.
*   **`backend/bifrost.js`**: Bifrost API wrapper for Virtual Key management.
*   **`backend/.env.example`**: Environment template. AppLixir vars commented out. Dodo Payments vars added (`DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_PRODUCT_*`).
*   **`backend/tests/api.test.js`**: 76 integration tests covering all 19 Express endpoints.
*   **`backend/tests/bifrost.test.js`**: 19 unit tests (100% coverage of Bifrost module).

### Frontend Files
*   **`liveclaw-web/www/index.html`**: Main landing page (Next.js compiled bundle + LiveClaw branding). Meta descriptions reference ads — **needs update**.
*   **`liveclaw-web/www/liveclaw.js`**: Frontend integration — Google auth, deploy/stop bot, success dashboard. Refuel text references ads — **needs update**.
*   **`liveclaw-web/www/admin/index.html`**: Full admin dashboard SPA.
*   **`liveclaw-web/www/mini-app/recharge/index.html`**: Currently an AppLixir ad flow. **Needs complete rewrite** as subscription status/portal page.

### Documentation Files
*   **`LAUNCH_PLAN.md`**: ✅ Fully rewritten — subscription pricing, Dodo Payments architecture, implementation plan.
*   **`README.md`**: ✅ Updated — subscription model, Dodo Payments tech stack, new endpoints.
*   **`CREDENTIALS.md`**: ✅ Updated — Dodo Payments section added (§3), AppLixir deferred, verification checklist updated.
*   **`CHECKPOINT.md`**: ✅ This file — updated for subscription pivot.

---

## 4. Immediate Next Steps (For the Incoming Agent)

> **Agent Instruction:** Start here to continue progress. The subscription model is designed and documented. Now it needs to be **implemented**.

### Priority 1: Dodo Payments Integration (Backend)
This is the core implementation task. See `LAUNCH_PLAN.md` §6 for full architecture.

1.  Install Dodo SDK: `cd backend && npm install @dodopayments/sdk`
2.  Add Dodo config to `server.js`: already done (`config.dodoApiKey`, `config.dodoProducts`, etc.)
3.  Create new database tables:
    *   `subscriptions` — user_id, dodo_customer_id, dodo_subscription_id, plan, status, current_period_end, trial_end, created_at
    *   `referrals` — referrer_id, referee_id, code, status (pending/converted/rewarded), created_at
4.  Implement new endpoints:
    *   `POST /create-checkout-session` — Creates Dodo Checkout session for plan selection
    *   `POST /create-portal-session` — Creates Dodo Customer Portal session (manage subscription)
    *   `GET /subscription/:userId` — Returns subscription status and plan details
    *   `POST /webhook/dodo` — Handles Dodo lifecycle events (subscription.active, subscription.on_hold, subscription.cancelled, payment.succeeded, payment.failed)
    *   `POST /referral/generate` — Generate referral code (LC-XXXXX format)
    *   `POST /referral/apply` — Apply referral code at checkout
    *   `GET /pricing` — Return pricing tiers (public endpoint)
5.  Gate `deploy-bot` on active subscription (reject with 402 if no active plan)
6.  Set Bifrost budgets per plan: Trial $0.50, Starter $1.50, Pro $5.00, Business $15.00

### Priority 2: Environment Configuration
1.  Update `backend/.env.example` with Dodo vars (already done: `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_PRODUCT_*`)
2.  Set up Dodo Payments account, create products, configure webhook endpoint
3.  SSH into backend droplet → add Dodo keys to `/opt/liveclaw/backend/.env`
4.  Reload: `pm2 reload liveclaw-orchestrator --update-env`

### Priority 3: Frontend Updates
1.  Update `liveclaw.js` — change refuel text (line ~344) from ad/Stars info to subscription management
2.  Update `index.html` meta descriptions — remove "Ad-supported" / "Stars" references
3.  Rewrite `mini-app/recharge/index.html` — subscription status + Dodo portal redirect (remove AppLixir SDK)
4.  Update `config.js.template` — no Dodo frontend key needed (server-side checkout)
4.  Update `liveclaw-web/.env.example` — remove APPLIXIR_ZONE_ID (no Dodo frontend key needed — checkout is server-side)

### Priority 4: SSL & Domain (If Not Already Done)
*   Point `liveclaw.xyz` to frontend droplet, `api.liveclaw.xyz` to backend droplet
*   Configure Nginx reverse proxy on both droplets
*   Run `certbot` for automated Let's Encrypt SSL

### Priority 5: Test Updates
*   Add tests for new Dodo Payments endpoints (checkout session, portal session, subscription status, webhook)
*   Add tests for referral code generation and application
*   Add tests for subscription-gated bot deployment
*   Target: maintain 95+ test count, add 20-30 new tests

### Priority 6: Referral System
*   Implement referral code generation (LC-XXXXX format, excludes I/O/0/1)
*   Referee benefits: 3-day trial (vs 1-day) + 20% off first month
*   Referrer rewards: 1 free month for every 3 paid referrals (max 4 rewards/year)
*   Tracking dashboard in admin panel

---

## 5. API Endpoint Reference

### Core Endpoints (Active)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Health check with service info |
| POST | `/verify-turnstile` | None | Cloudflare Turnstile token verification |
| POST | `/deploy-bot` | Google JWT | Deploy a picobot instance (requires active subscription) |
| POST | `/stop-bot` | Google JWT | Stop a user's picobot instance |
| GET | `/status/:userId` | None | Get bot status for a user |
| POST | `/register-chat` | Rate-limited | Register Telegram chat ID for push notifications |
| POST | `/notify-low-credits` | Rate-limited | Send subscription renewal prompt to user |
| GET | `/generate-refuel-url` | Rate-limited | Generate HMAC-signed Mini App URL |
| POST | `/verify-refuel-token` | Rate-limited | Validate HMAC token from Mini App URL |
| GET | `/admin/stats` | Admin secret | Legacy basic stats endpoint |

### Subscription Endpoints (Planned — Dodo Payments)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/create-checkout-session` | Google JWT | Create Dodo Payments Checkout session |
| POST | `/create-portal-session` | Google JWT | Create Dodo Customer Portal session |
| GET | `/subscription/:userId` | Google JWT | Get subscription status and plan |
| POST | `/webhook/dodo` | Dodo signature | Handle Dodo payment lifecycle events |
| POST | `/referral/generate` | Google JWT | Generate user's referral code |
| POST | `/referral/apply` | Google JWT | Apply referral code at checkout |
| GET | `/pricing` | None | Return pricing tiers (public) |

### Admin Endpoints (Active)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/admin/revenue` | X-Admin-Secret | Revenue analytics with period filtering |
| GET | `/admin/users` | X-Admin-Secret | Paginated user listing + status filter |
| GET | `/admin/users/:userId` | X-Admin-Secret | Single user detail with revenue |
| GET | `/admin/events` | X-Admin-Secret | Event log viewer with filtering |
| POST | `/admin/users/:userId/stop` | X-Admin-Secret | Force-stop a user's bot |
| POST | `/admin/users/:userId/credit` | X-Admin-Secret | Adjust user credit balance |

### Legacy Endpoints (Deferred — will be removed or left dormant)
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/create-invoice` | None | Telegram Stars invoice link |
| GET | `/webhook/applixir-reward` | S2S secret | AppLixir ad reward callback |
| POST | `/webhook/telegram-stars` | Telegram | Telegram Stars payment webhook |

---

## 6. Subscription Pricing Summary

| Plan | Price | Early Bird | Bots | Messages | Bifrost Budget |
|------|-------|-----------|------|----------|----------------|
| Trial | $0.99 one-time | — | 1 | Unlimited (24h) | $0.50 |
| Starter | $3.99/mo | $1.99/mo | 1 | 3,000/mo | $1.50 |
| Pro | $7.99/mo | $4.99/mo | 1 | Unlimited | $5.00 |
| Business | $14.99/mo | $9.99/mo | 3 | Unlimited | $15.00 |

*Early Bird ends after 6 months or 200 subscribers (whichever comes first).*
*Gross margins: 53-79% depending on plan and usage.*
*See LAUNCH_PLAN.md for full unit economics and revenue projections.*

---
**End of Checkpoint.**
