# LiveClaw Scaling Migration Guide

Last Updated: March 16, 2026

## Purpose

This guide defines how to evolve LiveClaw from a single-node process manager into a horizontally scalable control plane that can support large user growth without service instability.

It is intentionally staged so you can ship value while reducing migration risk.

## Current State Summary

Today, LiveClaw is optimized for early-stage efficiency:

- One backend process manages API traffic plus bot lifecycle orchestration.
- Bot processes are spawned and supervised locally on the same host.
- Operational state and analytics are partly local-process memory and local host introspection.
- Database abstraction supports PostgreSQL, but SQLite fallback can still be used if misconfigured.

This is good for early traction, but not for sustained high growth.

## Target State (Scale-Ready)

At large scale, operate as a control-plane architecture:

- Stateless API nodes behind a load balancer.
- PostgreSQL as the single source of truth for durable state.
- Redis for distributed coordination, rate limiting, and short-TTL caches.
- Queue-backed asynchronous workers for webhook/event processing and bot lifecycle actions.
- Dedicated runtime pool for bot hosts (or orchestrated workloads), separate from API nodes.
- Centralized metrics, logs, and tracing with SLO-driven alerting.

## Capacity Planning Baselines

Define concrete gates before each stage.

- P95 API latency under 300 ms for normal endpoints.
- P99 webhook acknowledgement under 2 s.
- Error budget target: less than 0.5% 5xx over 30 days.
- Database CPU under 70% at peak and connection saturation below 80%.
- Queue lag under 30 s for control-plane operations.

## Migration Phases

## Phase 0: Hardening Preconditions (Now)

### Goals

- Eliminate accidental single-node assumptions from production config.
- Add observability needed to validate each later migration step.

### Required Changes

1. Make PostgreSQL mandatory in production.
2. Add startup fail-fast checks for all scale-critical infrastructure flags.
3. Instrument endpoint-level latency histograms and queue lag metrics.
4. Define SLO dashboards and alert thresholds.

### Exit Criteria

- Production can no longer boot without DATABASE_URL.
- Dashboards show per-endpoint latency, error rates, DB pool stats, and host utilization.

## Phase 1: Data Layer and Query Scaling

### Goals

- Move all production data access to tuned PostgreSQL.
- Improve query/index shape for growth in logs and admin analytics.

### Required Changes

1. Enforce connection pooling limits and statement timeouts.
2. Add missing indexes for frequent filters/sorts, especially:
   - event logs by timestamp and event type
   - payments by created_at and status
   - subscriptions by status and updated_at
3. Add archival strategy for event_logs and payments analytics data.
4. Add read-only analytics replicas (optional, once needed).

### Data Migration Plan (SQLite to PostgreSQL)

1. Freeze schema changes during migration window.
2. Export SQLite tables in dependency order.
3. Import into PostgreSQL with validation counts per table.
4. Run shadow reads against PostgreSQL for critical endpoints.
5. Flip production read/write to PostgreSQL via DATABASE_URL.
6. Keep SQLite backup immutable for rollback window.

### Validation Checklist

- Row counts match per table.
- Checksum sample on critical columns matches.
- Subscription and bot status parity verified for active users.

## Phase 2: Control Plane Decoupling

### Goals

- Remove host-local process management assumptions from API request path.
- Introduce distributed-safe orchestration.

### Required Changes

1. Replace direct spawn/kill actions inside request handlers with command enqueue.
2. Introduce orchestration workers consuming commands from queue.
3. Add idempotency keys for deploy/stop/restart commands.
4. Record command state transitions in DB (queued, running, succeeded, failed).
5. Move watchdog responsibilities to a single leader worker or distributed lock model.

### Why

This avoids race conditions and duplicate orchestration when API scales to multiple instances.

## Phase 3: Runtime Fleet Separation

### Goals

- Separate API scaling from bot runtime scaling.

### Required Changes

1. Create dedicated bot runtime nodes (or containerized workload pool).
2. Track placement in DB: host_id, runtime_version, last_heartbeat.
3. Add scheduler logic for capacity-aware placement.
4. Implement graceful draining for runtime node maintenance.
5. Add automatic host replacement and bot rehydration workflows.

### Operational Model

- API nodes are stateless and replaceable.
- Runtime nodes are stateful executors with strict heartbeats and fencing.

## Phase 4: High-Volume Reliability

### Goals

- Ensure predictable behavior under spikes and partial outages.

### Required Changes

1. Queue-first webhook handling:
   - Verify signature synchronously.
   - Persist event and ack quickly.
   - Process asynchronously with retries and dead-letter queue.
2. Circuit breakers and bulkheads for external calls (Telegram, Bifrost, Dodo).
3. Distributed rate limiting via Redis.
4. Backpressure controls for deploy operations.
5. Disaster recovery playbooks (DB failover, runtime fleet failover).

## Phase 5: Multi-Region (Optional)

### Goals

- Improve resilience and latency for global growth.

### Required Changes

1. Active-passive control plane initially.
2. Regional runtime pools with geo-routing.
3. Region-scoped queues and failover rules.
4. Data residency and compliance review by geography.

## Cutover Playbooks

## Playbook A: Enable PostgreSQL-Only Production

1. Add DATABASE_URL to production secrets manager.
2. Deploy build with production fail-fast requiring DATABASE_URL.
3. Validate DB connectivity, migrations, and pool metrics.
4. Monitor 30 minutes for latency/error regression.
5. Roll back app version if DB saturation or query errors spike.

## Playbook B: Introduce Queue-Based Deploy Control

1. Deploy queue infrastructure and worker service.
2. Dual-path mode: write command to queue and execute existing direct path in shadow mode.
3. Compare outcomes for parity.
4. Flip API to enqueue-only mode.
5. Disable direct orchestration path behind feature flag.

## Playbook C: Runtime Fleet Split

1. Register first runtime node pool and heartbeat system.
2. Route a small percentage of new deploys to runtime pool.
3. Validate restart semantics, low-credit notifications, and stop actions.
4. Increase rollout gradually with canary gates.
5. Decommission local API-host runtime execution path.

## Rollback Strategy

For each phase, keep one-click rollback criteria and paths.

- Preserve previous app image and config bundle.
- Keep feature flags for old orchestration path until phase completion.
- Keep SQLite snapshots and PostgreSQL backups through migration window.
- Define abort thresholds before rollout starts:
  - 5xx rate increase above 1.5x baseline
  - webhook lag above threshold
  - DB connection errors above threshold

## Operational Readiness Checklist

Before claiming scale readiness, verify all items:

- PostgreSQL-only production with tested backups and restore drills.
- Queue-backed orchestration with idempotency and replay safety.
- Runtime fleet heartbeats and fencing in place.
- Centralized metrics/logs/traces with pager alerts.
- Load tests at at least 3x current peak.
- Incident runbooks tested in game-day exercises.

## Recommended 90-Day Execution Plan

## Days 1-15

- Phase 0 complete.
- Add fail-fast production config checks.
- Add SLO dashboards and alerting.

## Days 16-35

- Phase 1 complete.
- PostgreSQL migration and index hardening.
- Query profiling and regression fixes.

## Days 36-60

- Phase 2 complete.
- Queue-based orchestration and idempotent command model.

## Days 61-90

- Phase 3 complete.
- Runtime fleet separation and canary rollout.
- Run resilience drills and finalize runbooks.

## Appendix: Suggested Feature Flags

- SCALE_REQUIRE_POSTGRES
- SCALE_QUEUE_ORCHESTRATION
- SCALE_RUNTIME_POOL_ENABLED
- SCALE_DISABLE_LOCAL_WATCHDOG
- SCALE_WEBHOOK_ASYNC_PROCESSING

These flags should be environment-specific and support instant rollback.
