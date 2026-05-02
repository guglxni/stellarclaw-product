# Deployment

End-to-end runbook for taking a fresh box to a working `api.stellarclaw.xyz`.

## Prerequisites

- A Linux box (Ubuntu 24.04 LTS recommended), 2 vCPU / 2 GB RAM minimum
- Root SSH access
- A domain pointing at the box (`api.stellarclaw.xyz` → droplet IP, A record)
- A Postgres database (managed instance recommended)
- The CLI tools below on your local machine: `doctl`, `gh`, `pm2` (only on the box), `psql`

## 1. Bootstrap the box

```bash
ssh root@<droplet-ip> 'bash -s' < scripts/bootstrap.sh
```

`bootstrap.sh` installs:

| Component | Why |
|---|---|
| Node.js 22 LTS via NodeSource | Required by the orchestrator |
| Docker + compose | Runs the Bifrost gateway |
| Caddy | TLS-terminating reverse proxy in front of the orchestrator |
| UFW | Allows only `22/80/443`, denies the rest |
| `pm2` | Process manager for the orchestrator |
| 2 GB swap file | Headroom for Bifrost + N picobots |

## 2. Clone the repo on the box

```bash
ssh root@<droplet-ip>
mkdir -p /opt && cd /opt
git clone https://github.com/guglxni/stellarclaw-product.git stellarclaw
cd stellarclaw
```

## 3. Provision secrets

Every secret lives in `/opt/stellarclaw/backend/.env` (perms `0600`, owned by the deploy user). Copy the example and fill in real values:

```bash
cp backend/.env.example backend/.env
chmod 600 backend/.env
nano backend/.env
```

### Required keys

| Key | Source | Notes |
|---|---|---|
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` | AES-256-GCM key for encrypting Stellar secrets and Telegram tokens. Rotation invalidates all stored tokens. |
| `ADMIN_SECRET` | `openssl rand -base64 32` | Bearer for `/admin/*` endpoints. |
| `JWT_SECRET` | `openssl rand -base64 64` | Signs session JWTs. |
| `DATABASE_URL` | Your Postgres connection string | Must be a writeable role with permission to create tables on first boot. **Use a database dedicated to StellarClaw — never share a database namespace with another service.** |
| `TELEGRAM_MASTER_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) | The master bot that sends inline keyboard messages. |
| `GOOGLE_CLIENT_ID` | [Google Cloud Console → OAuth 2.0 Client IDs](https://console.cloud.google.com/apis/credentials) | Web Client. Add `https://stellarclaw.xyz` to authorised origins. |
| `TURNSTILE_SECRET_KEY` | [Cloudflare → Turnstile](https://dash.cloudflare.com) | Used server-side. |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | Default LLM router. |
| `BIFROST_BASE_URL` | `http://127.0.0.1:8080` if Bifrost runs on the same box | The gateway endpoint the orchestrator uses for VK creation and routing. |

### Stellar configuration

| Key | Default | Notes |
|---|---|---|
| `STELLARCLAW_DEFAULT_NETWORK` | `mainnet` | The network that fresh wallets are provisioned on. |
| `STELLAR_NETWORK` | `mainnet` | Legacy fallback; should match the above. |
| `STELLAR_PER_SEND_CAP_USDC` | `25` | Per-tx send cap, oracle-priced. |
| `STELLAR_LIFETIME_CAP_USDC` | `100` | Cumulative send cap. |
| `SOROSWAP_BASE_URL` | `https://api.soroswap.finance/v1` | Soroswap REST API root. |
| `STELLAR_DEMO_BOT_SECRET` | (optional) | If set, `userId='demo'` uses this pre-funded mainnet wallet instead of provisioning a fresh one. |

### Cards402 configuration

```bash
# 1. Mint an agent at https://cards402.com/dashboard → Agents → Create Agent
# 2. Copy the c402_… claim code
# 3. On the box, run:
bash scripts/cards402-claim.sh <claim_code>
```

The script onboards via `npx -y cards402@latest onboard --claim …`, extracts the API key, writes it to `.env`, and restarts pm2.

| Key | Source | Notes |
|---|---|---|
| `CARDS402_API_KEY` | Set by the claim script | Lives in `~/.cards402/config.json`. |
| `CARDS402_BASE_URL` | Set by the claim script | Defaults to `https://api.cards402.com/v1`. |
| `CARDS402_WEBHOOK_SECRET` | Set by the claim script | For future async-confirm path. |
| `CARDS402_PER_PURCHASE_CAP_USD` | `10` | Maximum face value of a single card. |
| `CARDS402_LIFETIME_PURCHASES` | `1` | Maximum cards a single bot can ever issue. Bump for production. |

### x402 configuration

| Key | Default | Notes |
|---|---|---|
| `X402_ALLOWLIST` | `https://x402.stellar.org/,https://api.cards402.com/` | Comma-separated URL prefixes the bot is allowed to pay. |

## 4. Install dependencies

```bash
cd /opt/stellarclaw/backend
npm install --omit=dev --legacy-peer-deps

# the Stellar MCPs live in a sibling project
cd /opt/StellarClaw-design/mvp
npm install --legacy-peer-deps
```

`--legacy-peer-deps` is required because `cards402` and `x402-stellar` ship with slightly different `@stellar/stellar-sdk` peer ranges; the `overrides` block in `mvp/package.json` pins the resolved version.

## 5. Bring up Bifrost

```bash
cd /opt/stellarclaw
docker compose -f docker-compose.bifrost.yml up -d
```

Confirm:

```bash
docker compose -f docker-compose.bifrost.yml ps
curl -fsS http://127.0.0.1:8080/healthz
```

If the container fails to write to its data volume:

```bash
chown -R 1000:1000 /opt/stellarclaw/bifrost-data
chmod -R 755 /opt/stellarclaw/bifrost-data
docker compose -f docker-compose.bifrost.yml restart
```

## 6. Start the orchestrator

```bash
cd /opt/stellarclaw/backend
pm2 start server.js --name stellarclaw --update-env
pm2 save
pm2 startup            # one-time, configures systemd to bring pm2 up on reboot
```

## 7. Configure Caddy

```caddyfile
api.stellarclaw.xyz {
    reverse_proxy 127.0.0.1:4001
    encode gzip
    log {
        output file /var/log/caddy/api.stellarclaw.log
        format json
    }
}
```

```bash
sudo systemctl reload caddy
```

## 8. Smoke test

```bash
curl -fsS https://api.stellarclaw.xyz/healthz | jq
```

Expected:

```json
{
  "ok": true,
  "uptime_sec": 12,
  "db": { "ok": true, "round_trip_ms": 4 },
  "bifrost": { "ok": true }
}
```

Spawn a test bot from the pilot UI at `https://stellarclaw.xyz/pilot/`, copy the returned Stellar address, send `2.5 XLM` to it on mainnet, then ask the bot in Telegram for its balance. The full end-to-end flow should resolve in under a minute.

## 9. Database migrations

The orchestrator creates all tables it needs on first boot if they don't exist (idempotent `CREATE TABLE IF NOT EXISTS`). Tables it owns:

- `users`, `bots`, `subscriptions` — core
- `stellar_wallets`, `stellar_intents`, `stellar_audit` — Stellar plane

If you need to evolve the schema, write a SQL file in `/opt/stellarclaw/migrations/` and apply with `psql $DATABASE_URL -f migrations/NNN_name.sql`.

The most common migration after a fresh deploy: bumping `INTEGER` timestamp columns to `BIGINT`. The orchestrator's `apply-patch.js` already lays the schema down with `BIGINT`, but if you imported from an older schema:

```sql
ALTER TABLE stellar_wallets   ALTER COLUMN created_at  TYPE BIGINT;
ALTER TABLE stellar_wallets   ALTER COLUMN updated_at  TYPE BIGINT;
ALTER TABLE stellar_intents   ALTER COLUMN created_at  TYPE BIGINT;
ALTER TABLE stellar_intents   ALTER COLUMN expires_at  TYPE BIGINT;
ALTER TABLE stellar_intents   ALTER COLUMN consumed_at TYPE BIGINT;
ALTER TABLE stellar_audit     ALTER COLUMN created_at  TYPE BIGINT;
```

## 10. Backups

The Postgres provider takes daily snapshots automatically. Verify the schedule is on. Local backup of `~/.cards402/config.json` and `~/.ows/wallets/.vault` (only relevant if you're using the OWS path; StellarClaw bots use per-bot wallets in the database):

```bash
tar czf cards402-secrets-$(date +%Y%m%d).tgz ~/.cards402 ~/.ows
gpg -c cards402-secrets-*.tgz
shred -u cards402-secrets-*.tgz   # keep only the .gpg
```

Move the encrypted tarball off the box.

## 11. Rollback

If a deploy goes bad:

```bash
cd /opt/stellarclaw
git log --oneline -10
git checkout <previous-good-sha>
cd backend && npm install --omit=dev --legacy-peer-deps
pm2 restart stellarclaw --update-env
```

The intent ledger and audit table are append-only, so a rollback never loses operational history.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ECONNREFUSED localhost:5432` in logs | Disabled side-job is still pointing at a non-existent local Postgres | `unset` `DODO_SYNC_DATABASE_URI` in `.env`, restart |
| `value … is out of range for type integer` | Old `INTEGER` timestamp columns | Migrate to `BIGINT` (see section 9) |
| `log.error is not a function` | Some patch wrote `log.error()` directly instead of via a scoped logger | Use `(log.startup \|\| log.system \|\| console).info(…)` |
| Picobot fails to start, no error in pm2 logs | `PICOBOT_PATH` points at the wrong binary | Verify `which picobot` and update `.env` |
| Cards402 returns 401 | API key not loaded into env | `pm2 restart stellarclaw --update-env` after editing `.env` |
| New bot wallet generated on every restart | The per-bot wallet code is using SQLite-style `db.prepare(...)` against a Postgres wrapper | Use `await db.get(...)` / `await db.run(...)` (already fixed in `main`) |

## Cost envelope

| Line item | Monthly |
|---|---|
| DigitalOcean droplet (`s-2vcpu-2gb`) | `$12` |
| DigitalOcean managed Postgres (`db-s-1vcpu-1gb`) | `$15` |
| GitHub Pages (frontend hosting) | `$0` |
| LLM tokens (varies by usage; MiniMax M2.7 default ≈ `$0.30/M-input`, `$1.50/M-output`) | usage-based |
| Stellar fees (mainnet, ~`100 stroops` per op) | < `$0.01/month` per active bot |
| Cards402 fees (per card issued) | passed through to user |
| x402 micropayments | passed through to user |

A single droplet comfortably runs 100+ bots before vertical scaling becomes attractive.
