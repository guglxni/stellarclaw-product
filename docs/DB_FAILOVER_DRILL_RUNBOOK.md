# DB Failover Drill Runbook

Last Updated: March 16, 2026

## Purpose

Validate that LiveClaw can tolerate managed PostgreSQL failover events without prolonged user impact.

## Preconditions

1. Managed PostgreSQL standby is online.
2. Connection pooling is enabled and backend uses pooled endpoint.
3. On-call owner and observer are assigned.
4. Maintenance window announced.

## Safety Rules

1. Never run this drill during active incident response.
2. Keep rollback owner on standby.
3. Capture all timestamps in UTC.

## SLO Targets During Drill

1. API p95 latency under 300 ms.
2. API 5xx rate under 0.5%.
3. No prolonged deploy/stop outage longer than 2 minutes.

## Drill Steps

1. Baseline checks:
- Run scripts/scale-readiness-check.sh.
- Capture baseline health endpoint and error-rate metrics.

2. Warm-up load:
- Run scripts/run-load-test.sh --url https://api.liveclaw.xyz/health --connections 50 --duration 60.
- Save summary artifact path.

3. Trigger failover event:
- Initiate managed DB failover in DigitalOcean control plane.
- Keep backend and worker services running; do not restart first.

4. Observe and record:
- Timestamp failover start and finish.
- Track API health, error spikes, queue depth, and DB reconnect behavior.

5. Functional checks during failover:
- Execute one deploy flow and one stop flow from test account.
- Verify command completion and bot status transitions.

6. Post-failover load check:
- Re-run scripts/run-load-test.sh with same parameters.
- Compare p95, non-2xx, and error counts with baseline.

7. Gate decision:
- Pass if all SLO targets are met and no manual intervention was required.
- Fail if outage exceeds thresholds or manual restarts were needed.

## Rollback Plan

1. If error budget is burning rapidly, shift traffic to maintenance mode.
2. Restart backend process only after failover stabilizes.
3. If necessary, revert to previous release image and re-run health checks.

## Evidence to Store

1. Pre/post readiness output.
2. Pre/post load test summary JSON files.
3. Timeline of failover state changes.
4. Any operator actions taken.

## Post-Drill Review Template

1. What failed first?
2. What auto-recovered versus needed manual intervention?
3. Which alert fired first and was it timely?
4. What config/code change is required before next drill?
