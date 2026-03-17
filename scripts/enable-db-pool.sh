#!/usr/bin/env bash
set -euo pipefail

DB_NAME="liveclaw-db"
POOL_NAME="liveclaw-prod-pool"
POOL_DB="defaultdb"
POOL_USER="doadmin"
POOL_SIZE=20
POOL_MODE="transaction"
APPLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --db-name)
            DB_NAME="$2"
            shift 2
            ;;
        --pool-name)
            POOL_NAME="$2"
            shift 2
            ;;
        --db)
            POOL_DB="$2"
            shift 2
            ;;
        --user)
            POOL_USER="$2"
            shift 2
            ;;
        --size)
            POOL_SIZE="$2"
            shift 2
            ;;
        --mode)
            POOL_MODE="$2"
            shift 2
            ;;
        --apply)
            APPLY=1
            shift
            ;;
        -h|--help)
            cat <<'EOF'
Usage: scripts/enable-db-pool.sh [options]

Options:
  --db-name <name>         Managed DB name (default: liveclaw-db)
  --pool-name <name>       Connection pool name (default: liveclaw-prod-pool)
  --db <name>              Database name (default: defaultdb)
  --user <name>            DB user for pool auth (default: doadmin)
  --size <n>               Pool size (default: 20)
  --mode <mode>            Pool mode: transaction|session|statement
  --apply                  Execute (default is dry run)
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

EXISTS=$(doctl databases pool list "$DB_ID" --output json | jq -r --arg n "$POOL_NAME" '[.[] | select(.name == $n)] | length')
if [[ "$EXISTS" -gt 0 ]]; then
    echo "Pool already exists: $POOL_NAME"
    exit 0
fi

CMD=(doctl databases pool create "$DB_ID" "$POOL_NAME" --db "$POOL_DB" --user "$POOL_USER" --size "$POOL_SIZE" --mode "$POOL_MODE")

echo "Pool create command: ${CMD[*]}"
if [[ "$APPLY" -eq 0 ]]; then
    echo "Dry run only. Re-run with --apply to execute."
    exit 0
fi

"${CMD[@]}"
echo "Pool creation submitted: $POOL_NAME"
