#!/usr/bin/env bash
set -euo pipefail

DB_NAME="liveclaw-db"
REQUIRE_REPLICAS=1
REQUIRE_POOLS=1
MIN_DB_ALERTS=3
OUTPUT_JSON=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --db-name)
            DB_NAME="$2"
            shift 2
            ;;
        --require-replicas)
            REQUIRE_REPLICAS="$2"
            shift 2
            ;;
        --require-pools)
            REQUIRE_POOLS="$2"
            shift 2
            ;;
        --min-db-alerts)
            MIN_DB_ALERTS="$2"
            shift 2
            ;;
        --json)
            OUTPUT_JSON=1
            shift
            ;;
        -h|--help)
            cat <<'EOF'
Usage: scripts/scale-readiness-check.sh [options]

Options:
  --db-name <name>            Managed DB name (default: liveclaw-db)
    --require-replicas <n>      Minimum ONLINE replica count (default: 1)
  --require-pools <n>         Minimum pool count (default: 1)
  --min-db-alerts <n>         Minimum DB alert policies (default: 3)
  --json                      Emit JSON output
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

for cmd in doctl jq; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "Missing required command: $cmd" >&2
        exit 2
    }
done

DB_ID=$(doctl databases list --output json | jq -r --arg name "$DB_NAME" '.[] | select(.name == $name) | .id' | head -n1)
if [[ -z "$DB_ID" ]]; then
    echo "Database not found: $DB_NAME" >&2
    exit 2
fi

DB_JSON=$(doctl databases get "$DB_ID" --output json | jq '.[0]')
DB_STATUS=$(jq -r '.status' <<<"$DB_JSON")
DB_NODES=$(jq -r '.num_nodes // 0' <<<"$DB_JSON")
REPLICA_JSON=$(doctl databases replica list "$DB_ID" --output json)
REPLICA_COUNT=$(jq 'length' <<<"$REPLICA_JSON")
ONLINE_REPLICA_COUNT=$(jq '[.[] | select(.status == "online")] | length' <<<"$REPLICA_JSON")
POOL_COUNT=$(doctl databases pool list "$DB_ID" --output json | jq 'length')
FIREWALL_COUNT=$(doctl databases firewalls list "$DB_ID" --output json | jq 'length')
DB_ALERT_COUNT=$(doctl monitoring alert list --output json | jq '[.[] | select(.type | startswith("v1/dbaas/alerts/"))] | length')

HAS_DB_ONLINE=$([[ "$DB_STATUS" == "online" ]] && echo 1 || echo 0)
HAS_REPLICAS=$([[ "$ONLINE_REPLICA_COUNT" -ge "$REQUIRE_REPLICAS" ]] && echo 1 || echo 0)
HAS_POOLS=$([[ "$POOL_COUNT" -ge "$REQUIRE_POOLS" ]] && echo 1 || echo 0)
HAS_FIREWALL=$([[ "$FIREWALL_COUNT" -ge 1 ]] && echo 1 || echo 0)
HAS_ALERTS=$([[ "$DB_ALERT_COUNT" -ge "$MIN_DB_ALERTS" ]] && echo 1 || echo 0)

READY=1
if [[ "$HAS_DB_ONLINE" -ne 1 || "$HAS_REPLICAS" -ne 1 || "$HAS_POOLS" -ne 1 || "$HAS_FIREWALL" -ne 1 || "$HAS_ALERTS" -ne 1 ]]; then
    READY=0
fi

if [[ "$OUTPUT_JSON" -eq 1 ]]; then
    jq -n \
      --arg db_name "$DB_NAME" \
      --arg db_id "$DB_ID" \
      --arg db_status "$DB_STATUS" \
      --argjson db_nodes "$DB_NODES" \
      --argjson replica_count "$REPLICA_COUNT" \
    --argjson online_replica_count "$ONLINE_REPLICA_COUNT" \
      --argjson pool_count "$POOL_COUNT" \
      --argjson firewall_count "$FIREWALL_COUNT" \
      --argjson db_alert_count "$DB_ALERT_COUNT" \
      --argjson require_replicas "$REQUIRE_REPLICAS" \
      --argjson require_pools "$REQUIRE_POOLS" \
      --argjson min_db_alerts "$MIN_DB_ALERTS" \
      --argjson ready "$READY" \
      '{
        database: { name: $db_name, id: $db_id, status: $db_status, nodes: $db_nodes },
        checks: {
          requires: {
            min_replicas: $require_replicas,
            min_pools: $require_pools,
            min_db_alerts: $min_db_alerts
          },
          actual: {
            replicas: $replica_count,
                        online_replicas: $online_replica_count,
            pools: $pool_count,
            firewalls: $firewall_count,
            db_alert_policies: $db_alert_count
          }
        },
        ready: ($ready == 1)
      }'
else
    echo "Scale Readiness Check"
    echo "  DB: $DB_NAME ($DB_ID)"
    echo "  Status: $DB_STATUS"
    echo "  Nodes: $DB_NODES"
    echo "  Replicas: $REPLICA_COUNT"
    echo "  Online Replicas: $ONLINE_REPLICA_COUNT (required >= $REQUIRE_REPLICAS)"
    echo "  Pools: $POOL_COUNT (required >= $REQUIRE_POOLS)"
    echo "  Firewalls: $FIREWALL_COUNT (required >= 1)"
    echo "  DB Alert Policies: $DB_ALERT_COUNT (required >= $MIN_DB_ALERTS)"
    if [[ "$READY" -eq 1 ]]; then
        echo "  Verdict: READY"
    else
        echo "  Verdict: NOT READY"
    fi
fi

if [[ "$READY" -eq 1 ]]; then
    exit 0
fi
exit 1
