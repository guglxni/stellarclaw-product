# LiveClaw — Maintenance & Operations Guide

Operational runbook for monitoring, maintaining, and troubleshooting the LiveClaw platform.

---

## Table of Contents

1. [Infrastructure Overview](#1-infrastructure-overview)
2. [Monitoring & Health Checks](#2-monitoring--health-checks)
3. [Common Operations](#3-common-operations)
4. [Picobot Management](#4-picobot-management)
5. [Database Maintenance](#5-database-maintenance)
6. [Deployment Procedures](#6-deployment-procedures)
7. [Troubleshooting](#7-troubleshooting)
8. [Security Operations](#8-security-operations)
9. [Backup & Recovery](#9-backup--recovery)

---

## 1. Infrastructure Overview

| Component | Host | Port | Process Manager |
|-----------|------|------|----------------|
| Frontend (Nginx) | `liveclaw.xyz` | 443 | systemd |
| Backend (Node.js) | `api.liveclaw.xyz` | 3000 | PM2 |
| Bifrost AI Gateway | `api.liveclaw.xyz` | 8080 | Docker |
| picobot (per user) | `api.liveclaw.xyz` | — | spawned by server.js |
| SQLite DB | `api.liveclaw.xyz` | — | file: `/opt/liveclaw/backend/liveclaw.db` |

### SSH Access

```bash
# Backend droplet
ssh root@<BACKEND_IP>

# Frontend droplet
ssh root@<FRONTEND_IP>
```

---

## 2. Monitoring & Health Checks

### Health Endpoint

```bash
curl -s https://api.liveclaw.xyz/health | jq
```

Returns: `status` (ok/degraded), `version`, `picobotVersion`, `runningBots`, `env`, `ts`.

### PM2 Status

```bash
ssh root@<BACKEND_IP>
pm2 status                          # overview of all processes
pm2 logs liveclaw-orchestrator      # live log stream
pm2 logs liveclaw-orchestrator --lines 100  # last 100 lines
pm2 monit                           # real-time metrics (CPU, memory)
```

### Bifrost Gateway

```bash
ssh root@<BACKEND_IP>
curl -s http://localhost:8080/health
docker ps | grep bifrost
docker logs bifrost --tail 50
```

### Admin Dashboard

```bash
# Quick stats
curl -s https://api.liveclaw.xyz/admin/stats \
  -H "x-admin-secret: $ADMIN_SECRET" | jq

# Revenue
curl -s https://api.liveclaw.xyz/admin/revenue \
  -H "x-admin-secret: $ADMIN_SECRET" | jq

# Active users
curl -s "https://api.liveclaw.xyz/admin/users?status=running" \
  -H "x-admin-secret: $ADMIN_SECRET" | jq
```

---

## 3. Common Operations

### Restart the Backend

```bash
ssh root@<BACKEND_IP>
pm2 reload liveclaw-orchestrator --update-env   # zero-downtime reload
# OR
pm2 restart liveclaw-orchestrator               # hard restart
```

### Update Environment Variables

```bash
ssh root@<BACKEND_IP>
nano /opt/liveclaw/backend/.env
pm2 reload liveclaw-orchestrator --update-env
```

### Force-Stop a User's Bot

```bash
# Via admin API
curl -X POST https://api.liveclaw.xyz/admin/users/<userId>/stop \
  -H "x-admin-secret: $ADMIN_SECRET"

# Via PM2 (if API is down)
ssh root@<BACKEND_IP>
kill <pid>    # find PID from the database or pm2 logs
```

### Adjust User Credits

```bash
curl -X POST https://api.liveclaw.xyz/admin/users/<userId>/credit \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"amount": 5.00, "reason": "manual adjustment"}'
```

### Beta Codes (Critical)

Source of truth for production beta codes is Dodo Discounts, not a local text file.

Required policy:

1. Generate production beta codes only through backend admin endpoints:

```bash
curl -X POST https://api.liveclaw.xyz/admin/beta-codes/generate \
  -H "Authorization: Bearer <admin_jwt>"
```

or import explicit codes:

```bash
curl -X POST https://api.liveclaw.xyz/admin/beta-codes/import \
  -H "Authorization: Bearer <admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"codes":["ABCD-EFGH-IJKL"]}'
```

2. Verify in Dodo before distributing codes (MCP or SDK):

```ts
await client.discounts.retrieveByCode('ABCD-EFGH-IJKL')
```

Expected configuration per beta code:

- `type = percentage`
- `amount = 10000` (100%)
- `usage_limit = 1`
- `restricted_to = [pdt_0Na2dJtFAS8lvKgRaT7Qs]` (trial product)

3. If `beta-codes.txt` is exported, it must be an export from Dodo-backed discounts.
Do not treat offline-generated code lists as production-ready.

### SSL Certificate Renewal

Certbot auto-renews via systemd timer. To check status:

```bash
ssh root@<BACKEND_IP>
certbot certificates                  # list certs and expiry dates
certbot renew --dry-run               # test renewal
systemctl status certbot.timer        # check auto-renewal timer
```

---

## 4. Picobot Management

### Check Picobot Version

```bash
ssh root@<BACKEND_IP>
cat /opt/liveclaw/backend/.picobot-version
/opt/liveclaw/backend/picobot version 2>/dev/null || echo "picobot binary not found"
```

### Manual Picobot Update

```bash
# Option 1: Use update script
scp scripts/update-picobot.sh root@<BACKEND_IP>:/opt/liveclaw/scripts/
ssh root@<BACKEND_IP> "bash /opt/liveclaw/scripts/update-picobot.sh --restart"

# Option 2: Direct download
ssh root@<BACKEND_IP>
cd /opt/liveclaw/backend
curl -fsSL -o picobot_new "https://github.com/louisho5/picobot/releases/latest/download/picobot_linux_amd64"
chmod +x picobot_new
mv picobot picobot.bak && mv picobot_new picobot
pm2 reload liveclaw-orchestrator
```

### Automated Updates

The `.github/workflows/picobot-update.yml` workflow checks for picobot updates every 6 hours. It can also be triggered manually from GitHub Actions.

### Watchdog

The server.js watchdog runs every 30 seconds (configurable via `WATCHDOG_INTERVAL_MS`). It checks all `running` bot PIDs and auto-restarts any crashed processes. Check watchdog activity:

```bash
pm2 logs liveclaw-orchestrator --lines 500 | grep watchdog
```

---

## 5. Database Maintenance

### Location

```
/opt/liveclaw/backend/liveclaw.db      # main database
/opt/liveclaw/backend/liveclaw.db-wal   # write-ahead log
/opt/liveclaw/backend/liveclaw.db-shm   # shared memory
```

### Query the Database

```bash
ssh root@<BACKEND_IP>
sqlite3 /opt/liveclaw/backend/liveclaw.db

# Useful queries:
.tables                                    # list all tables
SELECT COUNT(*) FROM bots WHERE status='running';  # active bots
SELECT * FROM subscriptions WHERE status='active';  # active subs
SELECT * FROM events ORDER BY created_at DESC LIMIT 20;  # recent events
.quit
```

### WAL Checkpoint

SQLite WAL mode auto-checkpoints, but you can force one:

```bash
sqlite3 /opt/liveclaw/backend/liveclaw.db 'PRAGMA wal_checkpoint(TRUNCATE);'
```

### Database Size

```bash
ls -lh /opt/liveclaw/backend/liveclaw.db*
sqlite3 /opt/liveclaw/backend/liveclaw.db 'PRAGMA page_count; PRAGMA page_size;'
```

---

## 6. Deployment Procedures

### Code-Only Deploy (Most Common)

```bash
# Backend: rsync code + PM2 reload (no provisioning)
./scripts/deploy-backend.sh --code-only

# Frontend: rsync static files
./scripts/deploy-frontend.sh --code-only
```

### Full Provision Deploy

Only needed for new droplets or major infrastructure changes:

```bash
./scripts/deploy-backend.sh    # full provision
./scripts/deploy-frontend.sh   # full provision
```

### CI/CD Pipeline

Pushes to `main` trigger the GitHub Actions pipeline:

1. **Test** — `npm test` (109 tests via Vitest)
2. **Lint** — `npm run lint` (ESLint) + `node -c` syntax validation
3. **Security** — `npm audit --audit-level=moderate`
4. **Deploy** — SCP + PM2 reload (main branch only)

### Rollback

```bash
ssh root@<BACKEND_IP>
cd /opt/liveclaw

# Option 1: Git revert
git log --oneline -5           # find the commit to revert to
git revert HEAD                # revert last commit
pm2 reload liveclaw-orchestrator

# Option 2: Previous deploy archive (if using rsync)
# Restore from backup, then reload PM2
```

---

## 7. Troubleshooting

### Bot Won't Start

```bash
# Check server logs for spawn errors
pm2 logs liveclaw-orchestrator --lines 100 | grep -i "spawn\|picobot\|error"

# Verify picobot binary exists and is executable
ssh root@<BACKEND_IP>
ls -la /opt/liveclaw/backend/picobot
file /opt/liveclaw/backend/picobot

# Check disk space
df -h /opt/liveclaw

# Verify Bifrost is running
curl -s http://localhost:8080/health
```

### Subscription Not Working

```bash
# Check Dodo webhook logs
pm2 logs liveclaw-orchestrator --lines 200 | grep -i dodo

# Verify webhook endpoint
curl -s -o /dev/null -w "%{http_code}" https://api.liveclaw.xyz/webhook/dodo

# Check subscription status in DB
sqlite3 /opt/liveclaw/backend/liveclaw.db \
  "SELECT * FROM subscriptions WHERE user_id='<userId>';"
```

### High Memory Usage

```bash
# Check per-process memory
pm2 monit
ps aux --sort=-%mem | head -20

# Count running picobot processes
pgrep -c picobot

# Emergency: stop all bots
sqlite3 /opt/liveclaw/backend/liveclaw.db \
  "UPDATE bots SET status='stopped' WHERE status='running';"
pm2 reload liveclaw-orchestrator
```

### Telegram Notifications Not Sending

```bash
# Verify master bot token
curl -s "https://api.telegram.org/bot${TELEGRAM_MASTER_BOT_TOKEN}/getMe" | jq

# Check webhook status
curl -s "https://api.telegram.org/bot${TELEGRAM_MASTER_BOT_TOKEN}/getWebhookInfo" | jq
```

---

## 8. Security Operations

### Key Rotation

See [CREDENTIALS.md](../CREDENTIALS.md) §13 for detailed rotation procedures.

```bash
# Rotate generated secrets (TOKEN_ENCRYPTION_KEY, ADMIN_SECRET)
bash scripts/keychain-secrets.sh --rotate

# Re-inject into .env
bash scripts/keychain-secrets.sh --inject
```

> **Warning:** Rotating `TOKEN_ENCRYPTION_KEY` invalidates all encrypted Telegram tokens. Stop all bots first, then users must re-deploy.

### Security Headers Check

```bash
curl -sI https://api.liveclaw.xyz/health | grep -iE "x-content|x-frame|strict|x-xss"
```

### Dependency Audit

```bash
cd backend && npm audit
npm audit fix          # auto-fix where possible
```

---

## 9. Backup & Recovery

### Database Backup

```bash
# Manual backup
ssh root@<BACKEND_IP>
sqlite3 /opt/liveclaw/backend/liveclaw.db ".backup /opt/liveclaw/backups/liveclaw-$(date +%Y%m%d).db"

# Verify backup
sqlite3 /opt/liveclaw/backups/liveclaw-*.db "PRAGMA integrity_check;"
```

### Automated Backup (cron)

Add to `crontab -e` on the backend droplet:

```cron
# Daily database backup at 3 AM UTC
0 3 * * * sqlite3 /opt/liveclaw/backend/liveclaw.db ".backup /opt/liveclaw/backups/liveclaw-$(date +\%Y\%m\%d).db" && find /opt/liveclaw/backups -name "*.db" -mtime +30 -delete
```

### .env Backup

```bash
# Backup production .env (encrypted)
ssh root@<BACKEND_IP> 'cat /opt/liveclaw/backend/.env' | gpg --symmetric --cipher-algo AES256 -o liveclaw-env-backup.gpg
```

---

*Last updated: March 7, 2026*
