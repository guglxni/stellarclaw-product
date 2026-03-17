# LiveClaw AI Agent Maintenance Guide

Date: March 16, 2026
Audience: AI coding/ops agents maintaining this repository

## Purpose

This guide gives AI agents enough project context to safely maintain, harden, and operate LiveClaw without introducing regressions.

## System Overview

LiveClaw is a Telegram-first AI agent platform with:

- Static frontend on liveclaw-web/www
- Node.js backend orchestrator in backend/server.js
- Per-user picobot process model
- Bifrost gateway integration for model usage governance
- Dodo Payments for billing/subscriptions
- Managed PostgreSQL in production, SQLite in tests/dev fallback

## Repository Map

- backend/server.js: core API + orchestration + admin + watchdog
- backend/database.js: DB backend abstraction (SQLite/Postgres)
- backend/tests/: regression suite (Vitest + Supertest)
- scripts/deploy-backend.sh: backend provisioning/deploy
- deploy.sh: monolithic production deployment helper
- docs/: launch/security/maintenance plans

## Current Architecture Constraints

1. Bot lifecycle operations are currently host-local (spawn/kill/watchdog).
2. Admin telemetry includes host-level shell probes.
3. Control plane is not yet fully decoupled for multi-node orchestration.

Agents must avoid assuming horizontally scalable bot control exists today.

## Non-Negotiable Safety Rules

1. Never remove auth checks from deploy/stop/subscription endpoints.
2. Never reintroduce default non-prod auth bypass; bypass must remain explicit opt-in.
3. Never make production start without DATABASE_URL.
4. Never print secrets from doctl or .env in logs or docs.
5. Never run destructive DB or filesystem commands without explicit operator request.

## Production Configuration Invariants

- NODE_ENV=production
- DATABASE_URL is required
- TOKEN_ENCRYPTION_KEY must be valid 64-hex
- ADMIN_SECRET, ADMIN_TOTP_SECRET, ADMIN_JWT_SECRET required
- DODO_API_KEY and DODO_WEBHOOK_SECRET required

## Testing and Validation Workflow

After backend changes:

```bash
cd backend
npm test
```

For targeted API regression:

```bash
cd backend
npm test -- tests/api.test.js
```

Always confirm no editor diagnostics for modified files.

## Migration and Scale Work Priorities

When asked to improve scalability, execute in this order:

1. Database reliability first
- PostgreSQL mandatory in production
- indexes for heavy reads
- connection pool tuning and observability

2. Infrastructure controls
- standby node
- connection pooling
- DB/firewall/alerts/log forwarding

3. Control-plane decoupling
- queue for deploy/stop/restart commands
- idempotency keys and command state machine

4. Runtime fleet separation
- move bot execution from API host to dedicated runtime workers

## DigitalOcean Operational Commands

```bash
# Infra inventory
doctl compute droplet list --format Name,PublicIPv4,Status,SizeSlug

# DB inventory
doctl databases list --format ID,Name,Engine,Version,Status,Region,NumNodes,SizeSlug

# DB detail
doctl databases get <db-uuid> --output json

# Pools
doctl databases pool list <db-uuid> --output json

# Firewall trusted sources
doctl databases firewalls list <db-uuid> --output json
```

Use output carefully. Redact secrets before documenting.

## Known Project-Specific Gotchas

1. Minified static frontend file can be hard to patch reliably; prefer targeted edits and verify with searches.
2. Subscription and webhook logic is sensitive to idempotency; preserve dedup semantics.
3. Event logs can grow quickly; avoid introducing broad scans without indexes.
4. Watchdog logic can interfere with manual process operations; reason through side-effects before patching.

## Documentation Requirements for Any Significant Change

When agents make non-trivial changes, update:

1. docs/security-review.md for security behavior changes.
2. docs/SCALING_MIGRATION_GUIDE.md for architecture/migration changes.
3. CREDENTIALS.md and backend/.env.example for new env variables.
4. README.md docs tree if new key docs were added.

## Agent Change Template

For each major maintenance task, include:

1. Problem statement
2. Risk if unchanged
3. Code/files modified
4. Validation commands and outcome
5. Rollback instructions

## Rollback Principles

- Prefer feature flags and reversible config toggles.
- Keep schema migrations additive before destructive cleanup.
- For infra changes, retain previous app image and connection details until stability window passes.

## Launch Gate for AI Agents

Before marking the system launch-ready, verify all gates:

- Tests passing
- Production PostgreSQL enforced
- DB standby configured
- DB pool configured
- Monitoring and alerts configured
- Known critical risks documented with owner and ETA

If any gate is missing, do not claim full readiness; report conditional readiness.
