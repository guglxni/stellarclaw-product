# 🦀 LiveClaw

**Deploy your personal AI agent on Telegram in under 1 minute — for free.**

LiveClaw is a freemium, ad-supported AI agent platform native to Telegram. Each user gets their own isolated AI agent powered by the lightweight [picobot](https://github.com/louisho5/picobot) engine, managed by a Node.js orchestrator with financial governance via [Portkey.ai](https://portkey.ai).

## Architecture

```
┌──────────────┐     ┌──────────────────────┐     ┌───────────────┐
│   Frontend   │────▶│  Nginx (SSL/Proxy)   │────▶│  Node.js API  │
│  Static HTML │     │  :443 → :3000        │     │  (Express)    │
└──────────────┘     └──────────────────────┘     └───────┬───────┘
                                                          │
                    ┌─────────────────────────────────────┤
                    │                                     │
              ┌─────▼─────┐   ┌──────────┐   ┌──────────▼──────────┐
              │  SQLite    │   │ Portkey  │   │  picobot (Go)       │
              │  (state)   │   │ (billing)│   │  per-user process   │
              └────────────┘   └──────────┘   └─────────────────────┘
```

## Tech Stack

| Layer       | Technology                              |
|-------------|-----------------------------------------|
| Frontend    | Static HTML/CSS/JS (cloned & rebranded) |
| Backend     | Node.js 22 + Express 5                  |
| AI Engine   | [picobot](https://github.com/louisho5/picobot) (Go binary) |
| LLM         | MiniMax M2.5 via Portkey.ai             |
| Database    | SQLite (WAL mode, better-sqlite3)       |
| Hosting     | DigitalOcean ($12/mo droplet)           |
| SSL         | Let's Encrypt via Certbot               |
| CI/CD       | GitHub Actions → SSH deploy             |
| Ads         | AppLixir Rewarded Video (S2S)           |
| CAPTCHA     | Cloudflare Turnstile (Invisible)        |
| Payments    | Telegram Stars                          |

## Quick Start

```bash
# Clone
git clone https://github.com/guglxni/liveclaw.git
cd liveclaw

# Backend
cd backend
cp .env.example .env   # fill in your API keys
npm install
npm run dev             # starts on :3000 with --watch

# Frontend (separate terminal)
cd liveclaw-web/www.simpleclaw.com
python3 -m http.server 8080
```

## Production Deployment

```bash
# 1. Set up .env with real keys
cp .env.example .env && nano .env

# 2. Deploy to DigitalOcean
chmod +x deploy.sh && ./deploy.sh

# 3. Register Telegram webhook
node scripts/set-webhook.js
```

See [deploy.sh](deploy.sh) for the full provisioning script.

## Project Structure

```
liveclaw/
├── backend/
│   ├── server.js          # Express orchestrator (main entry)
│   ├── portkey.js          # Portkey.ai financial governance
│   ├── package.json
│   └── .env.example
├── liveclaw-web/
│   └── www.simpleclaw.com/ # Static frontend
│       ├── index.html
│       ├── liveclaw.js     # Frontend ↔ backend integration
│       └── mini-app/
│           └── recharge/   # Telegram Mini App (ad recharge)
├── scripts/
│   └── set-webhook.js      # Telegram webhook registration
├── .github/
│   └── workflows/
│       └── main.yml        # CI/CD pipeline
├── deploy.sh               # DigitalOcean provisioning
├── .env.example             # All env vars documented
└── .gitignore
```

## API Endpoints

| Method | Path                           | Description                         |
|--------|--------------------------------|-------------------------------------|
| POST   | `/deploy-bot`                  | Spawn a picobot agent for a user    |
| POST   | `/stop-bot`                    | Stop a user's agent                 |
| GET    | `/status/:userId`              | Check agent status & credits        |
| GET    | `/health`                      | Health check (DB + running bots)    |
| POST   | `/verify-turnstile`            | Cloudflare Turnstile verification   |
| GET    | `/webhook/applixir-reward`     | AppLixir S2S ad reward callback     |
| POST   | `/webhook/telegram-stars`      | Telegram Stars payment webhook      |

## Environment Variables

See [`.env.example`](.env.example) for the full list with descriptions.

## License

MIT — Built by [Aaryan Guglani](https://x.com/guglaniaaryan)
