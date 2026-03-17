#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:3000/health"
CONNECTIONS=50
DURATION=30
OUTPUT_DIR="./artifacts/load-tests"
OUTPUT_JSON=0
OVERALL_RATE=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --url)
            URL="$2"
            shift 2
            ;;
        --connections)
            CONNECTIONS="$2"
            shift 2
            ;;
        --duration)
            DURATION="$2"
            shift 2
            ;;
        --overall-rate)
          OVERALL_RATE="$2"
          shift 2
          ;;
        --output-dir)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --json)
            OUTPUT_JSON=1
            shift
            ;;
        -h|--help)
            cat <<'EOF'
Usage: scripts/run-load-test.sh [options]

Options:
  --url <url>            Target URL (default: http://127.0.0.1:3000/health)
  --connections <n>      Concurrent connections (default: 50)
  --duration <sec>       Test duration in seconds (default: 30)
  --overall-rate <n>     Total request rate cap across all connections
  --output-dir <path>    Output directory (default: ./artifacts/load-tests)
  --json                 Print machine-readable summary JSON
EOF
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            exit 2
            ;;
    esac
done

for cmd in npx jq date; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "Missing required command: $cmd" >&2
        exit 2
    }
done

mkdir -p "$OUTPUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
RAW_FILE="$OUTPUT_DIR/autocannon-${STAMP}.json"
SUMMARY_FILE="$OUTPUT_DIR/summary-${STAMP}.json"

AUTOCANNON_ARGS=(
  --json
  --connections "$CONNECTIONS"
  --duration "$DURATION"
)

if [[ -n "$OVERALL_RATE" ]]; then
  AUTOCANNON_ARGS+=(--overallRate "$OVERALL_RATE")
fi

npx --yes autocannon "${AUTOCANNON_ARGS[@]}" "$URL" > "$RAW_FILE"

jq -n \
    --arg url "$URL" \
    --arg stamp "$STAMP" \
    --arg raw_file "$RAW_FILE" \
    --slurpfile raw "$RAW_FILE" \
    '
      ($raw[0]) as $r |
      ($r.latency.p95 // $r.latency.p97_5 // $r.latency.p99 // $r.latency.average // 0) as $lat_p95 |
      ($r.latency.p99 // $r.latency.p99_9 // $r.latency.average // 0) as $lat_p99 |
      ($r.requests.average // 0) as $rps |
      ($r.errors // 0) as $errors |
      ($r.timeouts // 0) as $timeouts |
      ($r["2xx"] // 0) as $ok2xx |
      ($r.non2xx // 0) as $non2xx |
      ($r.statusCodeStats // {}) as $stats |
      ($stats["429"].count // 0) as $rateLimited429 |
      ([($stats | to_entries[]? | select(.key | test("^5")) | .value.count)] | add // 0) as $server5xx |
      {
        target: $url,
        timestamp: $stamp,
        source_file: $raw_file,
        metrics: {
          latency_p95_ms: $lat_p95,
          latency_p99_ms: $lat_p99,
          avg_rps: $rps,
          non2xx: $non2xx,
          server_5xx: $server5xx,
          rate_limited_429: $rateLimited429,
          errors: $errors,
          timeouts: $timeouts,
          ok_2xx: $ok2xx
        },
        slo: {
          latency_p95_under_300ms: ($lat_p95 < 300),
          server_5xx_rate_under_0_5pct: (
            if (($ok2xx + $server5xx) > 0)
            then (($server5xx / ($ok2xx + $server5xx)) < 0.005)
            else false
            end
          ),
          rate_limited_429_rate_under_1pct: (
            if (($ok2xx + $rateLimited429) > 0)
            then (($rateLimited429 / ($ok2xx + $rateLimited429)) < 0.01)
            else false
            end
          ),
          non2xx_rate_under_0_5pct: (
            if (($ok2xx + $non2xx) > 0)
            then (($non2xx / ($ok2xx + $non2xx)) < 0.005)
            else false
            end
          )
        }
      }
    ' > "$SUMMARY_FILE"

if [[ "$OUTPUT_JSON" -eq 1 ]]; then
    cat "$SUMMARY_FILE"
    exit 0
fi

echo "Load Test Summary"
echo "  Raw: $RAW_FILE"
echo "  Summary: $SUMMARY_FILE"
echo "  URL: $URL"
echo "  p95 latency (ms): $(jq -r '.metrics.latency_p95_ms' "$SUMMARY_FILE")"
echo "  p99 latency (ms): $(jq -r '.metrics.latency_p99_ms' "$SUMMARY_FILE")"
echo "  avg RPS: $(jq -r '.metrics.avg_rps' "$SUMMARY_FILE")"
echo "  non-2xx: $(jq -r '.metrics.non2xx' "$SUMMARY_FILE")"
echo "  server 5xx: $(jq -r '.metrics.server_5xx' "$SUMMARY_FILE")"
echo "  rate-limited 429: $(jq -r '.metrics.rate_limited_429' "$SUMMARY_FILE")"
echo "  errors: $(jq -r '.metrics.errors' "$SUMMARY_FILE")"
echo "  timeouts: $(jq -r '.metrics.timeouts' "$SUMMARY_FILE")"
echo "  SLO p95<300ms: $(jq -r '.slo.latency_p95_under_300ms' "$SUMMARY_FILE")"
echo "  SLO 5xx<0.5%: $(jq -r '.slo.server_5xx_rate_under_0_5pct' "$SUMMARY_FILE")"
echo "  SLO 429<1%: $(jq -r '.slo.rate_limited_429_rate_under_1pct' "$SUMMARY_FILE")"
echo "  SLO non-2xx<0.5%: $(jq -r '.slo.non2xx_rate_under_0_5pct' "$SUMMARY_FILE")"
