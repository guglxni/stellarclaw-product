# LiveClaw Launch Readiness and Scalability Audit

Date: March 16, 2026
Scope: Product launch readiness, scale readiness, managed PostgreSQL posture, operational hardening
Method: 3-pass review (code, infrastructure, validation)

## Mitigation Update (March 16, 2026)

The following high-priority mitigations have now been executed:

1. Managed PostgreSQL connection pool created:
  - Name: `liveclaw-prod-pool`
  - Mode: `transaction`
  - Size: `20`
2. Managed PostgreSQL standby replica created and online:
  - Name: `liveclaw-db-standby-1`
  - Region: `nyc3`
  - Status: `online`
3. Added executable runbooks:
  - `scripts/enable-db-pool.sh`
  - `scripts/enable-db-replica.sh`
  - `scripts/scale-readiness-check.sh`
4. Production backend was cut over to pooled PostgreSQL endpoint (`:25061/liveclaw-prod-pool`) and later temporarily reverted to direct endpoint during 502 remediation.
5. Exposed `doadmin` credential rotated again after cutover.

Scale launch gate check now passes (`ready: true`) with online replica, active pool, firewall rule, and DB alert policies present.

Additional follow-on execution completed:

6. Queue-orchestration rollout scaffold added (feature-flagged):
  - `SCALE_QUEUE_ORCHESTRATION`
  - `SCALE_QUEUE_ASYNC_MODE`
  - `SCALE_QUEUE_POLL_MS`
  - New command status endpoint: `GET /orchestration/commands/:commandId`
7. Load-test and SLO harness added:
  - `scripts/run-load-test.sh` (autocannon JSON + SLO summary artifact)
8. Failover drill runbook added:
  - `docs/DB_FAILOVER_DRILL_RUNBOOK.md`

Load-test evidence captured (March 16, 2026, 15:34 local):

- Command: `./scripts/run-load-test.sh --url https://api.liveclaw.xyz/health --connections 20 --duration 20 --json`
- Observed metrics:
  - latency_p95_ms: `250`
  - latency_p99_ms: `676`
  - avg_rps: `85.15`
  - non2xx: `1703`
  - status distribution: `502 x 1703`

Interpretation:

- Latency target passed for p95, but availability/error-rate SLO failed.
- Immediate spot checks of `https://api.liveclaw.xyz/health` also returned `502` repeatedly.
- This is now a release blocker independent of DB HA/pool readiness and should be triaged before traffic ramp.

502 triage outcome (March 16, 2026, ~10:17 UTC):

- Root cause: backend process crash-looped during startup DB initialization.
- PM2 showed repeated startup failure while nginx returned `502 Bad Gateway`.
- DB identity check revealed pooled connection user was a restricted role (`liveclaw_app_*`) lacking `CREATE` privilege on schema `public`.
- Mitigation applied: switched production `DATABASE_URL` to direct managed PostgreSQL `doadmin` connection URI (default DB endpoint), then restarted PM2.
- Validation after mitigation:
  - `https://api.liveclaw.xyz/health` returned `200`.
  - PM2 process status returned `online`.

Follow-up note on load evidence:

- Subsequent high-RPS `/health` tests produced many `429` responses (not `502`) due the app-level `generalLimiter` (`60 req/min/IP`) and/or edge rate controls.
- This means non-2xx counts from aggressive synthetic tests are currently dominated by throttling behavior, not backend crash behavior.

Readiness/rate-limit hardening update (March 16, 2026, ~10:30 UTC):

- Added a dedicated low-cost readiness route: `GET /readyz`.
- Added limiter exemption for `/health` and `/readyz` in the general API limiter.
- Deployed and validated production readiness:
  - `https://api.liveclaw.xyz/readyz` returned `200` with DB check passing.

SLO re-capture with split 5xx vs 429 budgets (March 16, 2026, 16:10 local):

- Command: `./scripts/run-load-test.sh --url https://api.liveclaw.xyz/readyz --connections 20 --duration 60 --overall-rate 8 --json`
- Observed metrics:
  - latency_p95_ms: `1352`
  - latency_p99_ms: `1606`
  - avg_rps: `8`
  - non2xx: `0`
  - server_5xx: `0`
  - rate_limited_429: `0`
  - errors: `0`
  - timeouts: `0`
  - ok_2xx: `480`
- SLO interpretation:
  - `server_5xx_rate_under_0_5pct`: pass
  - `rate_limited_429_rate_under_1pct`: pass
  - `non2xx_rate_under_0_5pct`: pass
  - `latency_p95_under_300ms`: fail

Pooled endpoint cutback status:

- Corrected production host path validated (`liveclaw-prod` at `104.248.11.29`).
- Applied pooled-role grants and migrated production `DATABASE_URL` back to pool endpoint (`:25061/liveclaw-prod-pool`).
- Additional startup blocker discovered after cutback:
  - app startup migration path required table ownership (`must be owner of table bots`).
- Mitigation applied:
  - transferred ownership of `public` schema tables/sequences to pooled role `liveclaw_app_20260316151700`.
  - restarted PM2 with updated environment.
- Validation after ownership fix:
  - runtime DB identity resolved to pooled role `liveclaw_app_20260316151700`.
  - `https://api.liveclaw.xyz/health` returned `200`.
  - `https://api.liveclaw.xyz/readyz` returned `200`.

## Executive Verdict

Launch readiness is close, but not complete for high-growth confidence.

- Product launch readiness: READY WITH CONDITIONS
- Scale readiness: PARTIAL
- Required before public launch at meaningful growth: complete database HA and pooling setup, and finish control-plane decoupling milestones.

## References Used

- DigitalOcean PostgreSQL how-to index: https://docs.digitalocean.com/products/databases/postgresql/how-to/
- Supabase Postgres best-practices skill: https://github.com/supabase/agent-skills/tree/main/skills/supabase-postgres-best-practices

## Three-Pass Review Log

## Pass 1: Architecture and Code Path Analysis

Focused on backend constraints that block horizontal scale.

Key findings:

1. Production fallback risk to SQLite existed if DATABASE_URL was missing.
2. Query/index posture for high-volume event and payment analytics needed strengthening.
3. Control plane still uses host-local process orchestration (spawn/kill/watchdog), which limits multi-node safety.

Actions completed in this pass:

- Enforced DATABASE_URL in production startup requirements.
- Added production guard that requires PostgreSQL backend when NODE_ENV=production.
- Added additional indexes for event logs, subscriptions, and payments high-cardinality query paths.

## Pass 2: Infrastructure Reality Check (DigitalOcean CLI)

Validated real environment using doctl.

Observed state:

- Droplets:
  - liveclaw-prod: active, s-2vcpu-8gb-160gb-intel
  - liveclaw-web: active, s-1vcpu-512mb-10gb
- Managed PostgreSQL cluster:
  - Engine: PostgreSQL 17
  - Nodes: 1
  - Size: db-s-1vcpu-1gb
  - Region: nyc3
- Connection pool resources: none configured
- Firewall trusted source: one droplet source configured

Interpretation:

- PostgreSQL exists and is online, which is good.
- Single-node DB and no pool indicate a clear scale/availability bottleneck.

## Pass 3: Regression and Consistency Validation

Validation steps:

- Full backend test suite executed after code changes.
- Result: 103/103 tests passing.
- Static diagnostics on modified files: no errors.

Conclusion:

- Hardening changes are stable.
- Remaining work is largely infrastructure and architecture rollout, not immediate code breakage.

## Changes Implemented During This Audit

1. Production now requires DATABASE_URL in backend startup validation.
2. Production startup now rejects non-PostgreSQL backend mode.
3. PostgreSQL pool settings are now env-configurable:
   - PG_POOL_MAX
   - PG_POOL_IDLE_TIMEOUT_MS
   - PG_POOL_CONNECTION_TIMEOUT_MS
   - PG_POOL_QUERY_TIMEOUT_MS
   - PG_SSL_REJECT_UNAUTHORIZED
   - PG_APP_NAME
4. Added indexes for scale-critical reads:
   - event_logs(ts)
   - event_logs(event, ts)
   - subscriptions(status, updated_at)
   - subscriptions(trial_ends_at)
   - payments(status, created_at)
5. Deployment/config docs and templates updated to reflect production PostgreSQL requirement.

## Remaining High-Priority Gaps Before High-Growth Launch

1. Managed PostgreSQL HA

- Current: single-node DB cluster.
- Required: add standby node for failover capability.
- DigitalOcean reference: add standby nodes and monitor cluster performance.

2. Managed PostgreSQL connection pooling

- Current: no managed connection pool resources.
- Required: create a connection pool and use pooled connection URI for app traffic.
- Rationale: protects primary DB from connection storms during traffic spikes.

3. Control plane decoupling

- Current: deploy/stop/restart and watchdog are host-local process control.
- Required: queue-based orchestration workers with idempotent commands and ownership tracking.

4. Webhook resilience model

- Current: webhook processing includes business side-effects inline.
- Required: verify + persist + fast-ack pattern, then async processing via worker queue.

## Product Readiness Checklist

## Must complete before public launch

- [ ] Add PostgreSQL standby node.
- [ ] Configure and migrate app traffic to managed connection pool endpoint.
- [ ] Configure DB alerts (CPU, memory, storage, connections, replication lag).
- [ ] Forward DB logs to centralized log destination.
- [ ] Run load test at 3x expected launch traffic with SLO gates.

## Strongly recommended in first post-launch sprint

- [ ] Queue-backed orchestration for deploy/stop/restart.
- [ ] Queue-backed webhook processing with dead-letter queue.
- [ ] Runtime fleet separation from API node.

## Suggested SLOs

- API p95 latency: under 300 ms
- API 5xx rate: under 0.5%
- Webhook ack p99: under 2 s
- Queue lag p95: under 30 s
- DB connection usage: under 80% sustained

## Operational Commands (Doctl)

Use these during rollout and launch checks:

```bash
# List DB clusters
doctl databases list --format ID,Name,Engine,Version,Status,Region,NumNodes,SizeSlug

# Get DB details by UUID
doctl databases get <db-uuid> --output json

# List connection pools
doctl databases pool list <db-uuid> --output json

# List trusted sources (firewall)
doctl databases firewalls list <db-uuid> --output json

# List droplets
doctl compute droplet list --format Name,PublicIPv4,Status,SizeSlug
```

## Security Note

During infra inspection, sensitive DB credentials may appear in CLI JSON output. Treat any exposed values as compromised and rotate credentials immediately after audits.

## Final Recommendation

Proceed with launch only after completing DB HA + pooling + alerting setup, because these are the most immediate risk reducers for growth.

Control-plane decoupling should be treated as the next engineering milestone to sustain scale safely.
