# 🏁 LiveClaw Project Checkpoint

**Date:** March 4, 2026
**Project Phase:** Production MVP Ready (Backend logic complete, CI/CD operational, Testing Framework in place. Awaiting final frontend integration & env config).

This document serves as a comprehensive handoff for any incoming agent to understand the current architecture, recent progress, and immediate next steps for the LiveClaw platform.

---

## 1. Project Overview & Architecture

LiveClaw is a freemium, ad-supported AI agent platform native to Telegram. It allows users to quickly deploy isolated, high-performance AI agents to their own Telegram bots.

### Core Stack
*   **Orchestrator:** Node.js (Express) backend (`server.js`). Handles user onboarding, process management, webhooks, and payments.
*   **AI Agent Engine:** `picobot` (Go binary). Extremely lightweight; one isolated instance is spawned per user.
*   **AI Gateway:** **Bifrost** (Go). Fully self-hosted, replacing Portkey. Handles LLM traffic routing, virtual key management, and strict budget enforcement (< 100µs latency).
*   **Database:** SQLite (`liveclaw.db`) in WAL mode for concurrent access.
*   **Infrastructure:** DigitalOcean Droplet (`104.248.11.29`).
*   **Monetization:** AppLixir (Rewarded Video Ads - S2S callback) & Telegram Stars (Webhooks).
*   **Security:** Cloudflare Turnstile (bot protection), Google Auth (JWT validation for deployment).

---

## 2. Recent Major Milestones

### A. Bifrost Gateway Transition (Completed)
We successfully migrated from the SaaS-dependent Portkey.ai to the fully self-hosted, open-source Bifrost AI Gateway.
*   **Implementation:** `backend/bifrost.js` manages programmatic creation of Virtual Keys (`POST /api/governance/virtual-keys`) when a user deploys a bot.
*   **Benefits:** Zero latency overhead, strict per-user dollar limits (default $0.05), and no external SaaS API key required. Bifrost runs locally in Docker on port 8080.
*   **Configuration:** The Node.js orchestrator passes a generated Bifrost Virtual Key (`sk-bf-...`) to the `picobot` instance, which sends requests to `http://localhost:8080/v1`.

### B. Production CI/CD Pipeline (Completed)
A robust, 4-stage gated deployment pipeline is active via GitHub Actions (`.github/workflows/main.yml`).
1.  **Test Suite:** Runs Vitest unit and integration suites. Fails if coverage drops below defined thresholds.
2.  **Lint & Validate:** ESLint checks (security-focused rules), syntax validation, and automated secret scanning.
3.  **Security Audit:** Runs `npm audit` to block critical vulnerabilities.
4.  **Deploy (main-only):** Idempotent droplet bootstrapping (installs Node, Docker, Bifrost, Nginx, ufw), SCP code upload (works perfectly for private repos), and zero-downtime PM2 orchestrator reload.

### C. Comprehensive Testing Framework (Completed)
*   **Framework:** Vitest + Supertest built into `backend/`.
*   **Unit Tests (`bifrost.test.js`):** 19 tests with 100% coverage of the Bifrost integration module.
*   **Integration Tests (`api.test.js`):** 29 tests covering all 9 Express endpoints using an in-memory SQLite database and bypassed rate limiters.
*   **Status:** Currently passing 48/48 tests in < 1s.

---

## 3. Current Codebase State

*   **`backend/server.js`:** The core orchestrator. Refactored to export `app` and `db` without auto-listening when `NODE_ENV=test`. Handles Google JWT auth, AppLixir webhook verification, Telegram Stars webhook processing, and `picobot` process spawning.
*   **`backend/bifrost.js`:** The Bifrost API wrapper.
*   **`deploy.sh`:** Legacy manual deploy script (still viable, but superseded by GitHub Actions for routine deploys).
*   **`liveclaw-web/`:** The frontend directory (currently served via `python3 -m http.server 8080` locally by the user). This needs wiring to the backend endpoints.
*   **`scripts/set-webhook.js`:** Utility to configure the Telegram master bot webhook.

---

## 4. Immediate Next Steps (For the Incoming Agent)

> **Agent Instruction:** Start here to continue progress.

### Priority 1: Frontend Wiring (liveclaw-web)
The frontend UI exists but needs to be hooked up to the production-ready backend endpoints.
*   **Auth:** Ensure Google Sign-In correctly extracts the ID token and passes it to the backend.
*   **API Calls:** Update the frontend code (likely `liveclaw.js` or similar) to call the actual backend endpoints:
    *   `POST /deploy-bot` (Pass Google JWT in `Authorization: Bearer <token>`)
    *   `POST /stop-bot`
    *   `GET /status/:userId`
    *   `POST /verify-turnstile`
    *   `POST /create-invoice` (for Telegram Stars top-ups)

### Priority 2: Environment Configuration (Production Droplet)
The backend is running on the droplet (`104.248.11.29`), but it was deployed with placeholder `.env` values.
1.  SSH into the droplet (`root@104.248.11.29`).
2.  Access the Bifrost web UI (`http://localhost:8080` or via SSH tunnel) and input the real `MINIMAX_API_KEY` (or Kimi key) into Bifrost's provider configuration.
3.  Edit `/opt/liveclaw/backend/.env` and replace placeholders with vital production keys:
    *   `TURNSTILE_SECRET_KEY`
    *   `APPLIXIR_SECRET_KEY`
    *   `TELEGRAM_MASTER_BOT_TOKEN`
    *   `TOKEN_ENCRYPTION_KEY`
    *   `ADMIN_SECRET`
4.  Run `pm2 reload liveclaw-orchestrator --update-env`.

### Priority 3: Nginx and SSL Configuration
The droplet needs a domain attached and SSL configured.
*   Point a domain/subdomain (e.g., `api.liveclaw.xyz`) to the droplet IP.
*   Configure Nginx (template exists in `deploy.sh`) to reverse proxy port 80/443 to PM2 running on port 3000.
*   Run `certbot` for automated Let's Encrypt SSL certificates.

### Priority 4: Telegram Webhook Configuration
Once the domain has SSL (Priority 3), run `node scripts/set-webhook.js` (with the correct `.env` loaded) to tell Telegram to send `pre_checkout_query` and payment events to `https://<DOMAIN>/webhook/telegram-stars`.

### Priority 5 (Ongoing): Test Coverage Ratchet
As new frontend integrations or backend logic are added, update `vitest.config.js` to slowly ratchet up the coverage thresholds (currently set at a baseline of 50% lines/statements).

---
**End of Checkpoint.**
