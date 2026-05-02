# StellarClaw

> Deploy your personal AI agent on Telegram in 60 seconds — $9.99/mo.

StellarClaw is a subscription-based AI agent platform. Each subscriber gets an isolated [picobot](https://github.com/louisho5/picobot) agent instance managed by a Node.js orchestrator with financial governance via [Bifrost AI Gateway](https://github.com/maximhq/bifrost).

**Channels:** Telegram (active) · Discord (planned) · WhatsApp (planned)

---

## Architecture

```
                         ┌─────────────────────────────────────┐
                         │        Frontend Droplet             │
  Users ────────────────▶│  stellarclaw.xyz  (Nginx, static)      │
                         │  $4/mo · s-1vcpu-512mb              │
                         └────────────┬────────────────────────┘
                                      │ HTTPS
                                      ▼
                         ┌─────────────────────────────────────┐
                         │        Backend Droplet              │
                         │  api.stellarclaw.xyz  (Nginx → Node)   │
                         │  $12/mo · s-2vcpu-2gb               │
                         │                                     │
                         │  ┌─────────┐    ┌──────────┐       │
                         │  │ Express  │    │ Bifrost  │       │
                         │  │ :3000    │    │ (Docker) │       │
                         │  └────┬─────┘   └──────────┘       │
                         │       │                             │
                         │  ┌────▼─────┐   ┌───────────────┐  │
                         │  │ SQLite   │   │ picobot ×N    │  │
                         │  │ (WAL)    │   │ (1 per user)  │  │
                         │  └──────────┘   └───────────────┘  │
                         └─────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Static HTML/CSS/JS · Nginx |
| Backend | Node.js 22 · Express 5 |
| AI Engine | [picobot](https://github.com/louisho5/picobot) (Go binary) |
| AI Gateway | [Bifrost](https://github.com/maximhq/bifrost) (<100 µs overhead) |
| LLM | MiniMax M2.5 via Bifrost |
| Database | SQLite (WAL mode, better-sqlite3) |
| Payments | Dodo Payments (MoR — subscriptions) |
| Auth | Google OAuth 2.0 (JWT) |
| CAPTCHA | Cloudflare Turnstile (Invisible) |
| Hosting | DigitalOcean (2 droplets, $16/mo total) |
| CI/CD | GitHub Actions (test → lint → audit → deploy) |
| SSL | Let's Encrypt via Certbot |

## Quick Start

```bash
git clone https://github.com/guglxni/liveclaw.git && cd liveclaw

# Backend
cd backend
cp .env.example .env     # fill in CHANGE_ME values (see CREDENTIALS.md)
npm install
npm run dev               # starts on :3000 with --watch

# Frontend (separate terminal)
cd liveclaw-web/www
python3 -m http.server 8080
```

## Production Deployment

```bash
# 1. Configure environment
cp backend/.env.example backend/.env && nano backend/.env
cp liveclaw-web/.env.example liveclaw-web/.env && nano liveclaw-web/.env

# 2. Deploy
./scripts/deploy-backend.sh          # provisions + deploys backend
./scripts/deploy-frontend.sh         # provisions + deploys frontend

# Quick code-only updates (no full provision):
./scripts/deploy-backend.sh --code-only
./scripts/deploy-frontend.sh --code-only

# Scale readiness checks + infra mitigation
./scripts/scale-readiness-check.sh
./scripts/enable-db-replica.sh --apply
./scripts/enable-db-pool.sh --apply

# Load-test + SLO evidence capture
./scripts/run-load-test.sh --url https://api.stellarclaw.xyz/health --connections 50 --duration 60
```

See [CREDENTIALS.md](CREDENTIALS.md) for step-by-step key setup.

## Project Structure

```
liveclaw/
├── backend/
│   ├── server.js            # Express orchestrator (~1700 lines)
│   ├── bifrost.js           # Bifrost AI Gateway client
│   ├── dodo.js              # Dodo Payments subscription module
│   ├── .env.example         # Backend env vars (canonical)
│   ├── eslint.config.mjs    # ESLint flat config
│   ├── vitest.config.js     # Vitest test config
│   └── tests/
│       ├── api.test.js      # 85 API integration tests
│       ├── bifrost.test.js  # 19 Bifrost unit tests
│       ├── subscription.test.js  # 5 subscription tests
│       └── setup.js         # Test env bootstrap
├── liveclaw-web/
│   ├── .env.example         # Frontend public keys
│   ├── config.js.template   # Runtime config injection
│   └── www/                 # Static files (Nginx)
│       ├── index.html       # Landing page
│       ├── liveclaw.js      # Frontend JS
│       └── admin/           # Admin dashboard SPA
├── scripts/
│   ├── deploy-backend.sh    # Backend droplet provisioning
│   ├── deploy-frontend.sh   # Frontend droplet provisioning
│   ├── deploy-single-droplet.sh  # Legacy single-droplet deploy
│   ├── update-picobot.sh    # Picobot binary auto-updater
│   ├── keychain-secrets.sh  # macOS Keychain secret management
│   ├── scale-readiness-check.sh # Validates scale launch gates (HA/pool/alerts)
│   ├── enable-db-replica.sh # Creates managed PostgreSQL standby/replica
│   ├── enable-db-pool.sh    # Creates managed PostgreSQL connection pool
│   ├── run-load-test.sh      # Autocannon-based SLO/load test harness
│   └── set-webhook.js       # Telegram webhook registration
├── .github/workflows/
│   ├── main.yml             # CI/CD pipeline (test → deploy)
│   └── picobot-update.yml   # Automated picobot version updates
├── docs/
│   ├── LAUNCH_PLAN.md       # Pricing, unit economics, revenue model
│   ├── CHECKPOINT.md        # Development progress tracker
│   ├── LAUNCH_READINESS_SCALE_AUDIT_2026-03-16.md # 3-pass launch and scale audit
│   ├── SCALING_MIGRATION_GUIDE.md # Large-scale growth and migration playbook
│   ├── AI_AGENT_MAINTENANCE_GUIDE.md # Rich context guide for maintenance agents
│   ├── DB_FAILOVER_DRILL_RUNBOOK.md # Database failover drill process and evidence checklist
│   └── security-review.md   # Security audit findings
├── CREDENTIALS.md           # Credentials acquisition guide
├── LICENSE                  # Proprietary
└── README.md                # This file
```

## API Endpoints

### Core

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/deploy-bot` | Google JWT | Spawn a picobot agent |
| `POST` | `/stop-bot` | Google JWT | Stop a user's agent |
| `GET` | `/orchestration/commands/:commandId` | Google JWT | Queue command status lookup |
| `GET` | `/status/:userId` | — | Check agent status |
| `GET` | `/readyz` | — | Low-cost readiness probe (DB reachability) |
| `GET` | `/health` | — | Health check |
| `POST` | `/verify-turnstile` | — | Cloudflare Turnstile verification |
| `GET` | `/pricing` | — | Public pricing info |

### Subscriptions (Dodo Payments)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/create-checkout-session` | Google JWT | Create checkout session |
| `POST` | `/create-portal-session` | Google JWT | Customer portal link |
| `GET` | `/subscription/:userId` | Google JWT | Subscription status |
| `POST` | `/webhook/dodo` | Dodo signature | Payment webhook handler |
| `POST` | `/referral/generate` | Google JWT | Generate referral code |
| `POST` | `/referral/apply` | Google JWT | Apply referral code |

### Internal (requires `X-Admin-Secret`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/register-chat` | Register Telegram chat ID |
| `POST` | `/notify-low-credits` | Send low-credit notification |

### Admin (requires `X-Admin-Secret`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin/stats` | Dashboard metrics |
| `GET` | `/admin/revenue` | Revenue analytics |
| `GET` | `/admin/users` | User listing (paginated) |
| `GET` | `/admin/users/:userId` | User detail |
| `GET` | `/admin/events` | Audit event log |
| `POST` | `/admin/users/:userId/stop` | Force-stop a bot |
| `POST` | `/admin/users/:userId/credit` | Adjust credits |

## Testing

```bash
cd backend
npm test              # 109 tests in ~1s (Vitest + Supertest)
npm run lint          # ESLint
npm audit             # Dependency vulnerability scan
```

## Environment Variables

- **Backend:** [`backend/.env.example`](backend/.env.example)
- **Frontend:** [`liveclaw-web/.env.example`](liveclaw-web/.env.example)
- **Credentials guide:** [`CREDENTIALS.md`](CREDENTIALS.md)

## License

Proprietary — © 2026 [Aaryan Guglani](https://x.com/guglaniaaryan). All rights reserved.
