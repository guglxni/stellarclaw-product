#!/usr/bin/env bash
set -euo pipefail

DB_NAME="liveclaw-db"
REPLICA_NAME="liveclaw-db-standby-1"
REGION=""
SIZE="db-s-1vcpu-1gb"
APPLY=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --db-name)
            DB_NAME="$2"
            shift 2
            ;;
        --replica-name)
            REPLICA_NAME="$2"
            shift 2
            ;;
        --region)
            REGION="$2"
            shift 2
            ;;
        --size)
            SIZE="$2"
            shift 2
            ;;
        --apply)
            APPLY=1
            shift
            ;;
        -h|--help)
            cat <<'EOF'
Usage: scripts/enable-db-replica.sh [options]

Options:
  --db-name <name>         Managed DB name (default: liveclaw-db)
  --replica-name <name>    New replica name (default: liveclaw-db-standby-1)
  --region <slug>          Replica region (default: primary DB region)
  --size <slug>            Replica size slug (default: db-s-1vcpu-1gb)
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

if [[ -z "$REGION" ]]; then
    REGION=$(doctl databases get "$DB_ID" --output json | jq -r '.[0].region')
fi

EXISTS=$(doctl databases replica list "$DB_ID" --output json | jq -r --arg n "$REPLICA_NAME" '[.[] | select(.name == $n)] | length')
if [[ "$EXISTS" -gt 0 ]]; then
    echo "Replica already exists: $REPLICA_NAME"
    exit 0
fi

CMD=(doctl databases replica create "$DB_ID" "$REPLICA_NAME" --region "$REGION" --size "$SIZE")

echo "Replica create command: ${CMD[*]}"
if [[ "$APPLY" -eq 0 ]]; then
    echo "Dry run only. Re-run with --apply to execute."
    exit 0
fi

"${CMD[@]}"
echo "Replica creation submitted: $REPLICA_NAME"
