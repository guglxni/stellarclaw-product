#!/usr/bin/env bash
# LiveClaw Production Smoke Test
# ─────────────────────────────────────────────────────────────────────────────
# Runs after every production deploy to verify all critical endpoints.
# Uses jq to parse JSON bodies — not just HTTP status codes.
#
# Usage:
#   ./scripts/smoke-test.sh
#   API_URL=https://api.liveclaw.xyz FRONTEND_URL=https://liveclaw.xyz ./scripts/smoke-test.sh
#
# Exit code: 0 = all passed, 1 = one or more failures
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

API_URL="${API_URL:-https://api.liveclaw.xyz}"
FRONTEND_URL="${FRONTEND_URL:-https://liveclaw.xyz}"
TIMEOUT="${TIMEOUT:-10}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

# ─── Helper functions ─────────────────────────────────────────────────────────

check_status() {
  local name="$1" url="$2" expected_status="$3"
  local http
  http=$(curl -sf --max-time "$TIMEOUT" -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$http" = "$expected_status" ]; then
    echo -e "${GREEN}PASS${NC} [$name] HTTP $http — $url"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC} [$name] Expected HTTP $expected_status, got $http — $url"
    FAIL=$((FAIL+1))
  fi
}

check_json() {
  local name="$1" url="$2" jq_expr="$3" expected_val="${4:-true}"
  local body http response
  response=$(curl -sf --max-time "$TIMEOUT" -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  http=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$http" != "200" ]; then
    echo -e "${RED}FAIL${NC} [$name] HTTP $http (expected 200) — $url"
    FAIL=$((FAIL+1))
    return
  fi

  local val
  val=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null || echo "__jq_error__")
  if [ "$val" = "$expected_val" ] || [ "$val" = "true" ] && [ "$expected_val" = "true" ]; then
    echo -e "${GREEN}PASS${NC} [$name] $jq_expr = $val"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC} [$name] $jq_expr expected '$expected_val', got '$val'"
    FAIL=$((FAIL+1))
  fi
}

check_json_not_null() {
  local name="$1" url="$2" jq_expr="$3"
  local body http response
  response=$(curl -sf --max-time "$TIMEOUT" -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  http=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  if [ "$http" != "200" ]; then
    echo -e "${RED}FAIL${NC} [$name] HTTP $http — $url"
    FAIL=$((FAIL+1))
    return
  fi

  local val
  val=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null || echo "null")
  if [ "$val" != "null" ] && [ "$val" != "__jq_error__" ] && [ -n "$val" ]; then
    echo -e "${GREEN}PASS${NC} [$name] $jq_expr present: $val"
    PASS=$((PASS+1))
  else
    echo -e "${RED}FAIL${NC} [$name] $jq_expr was null/missing in response"
    FAIL=$((FAIL+1))
  fi
}

warn_json() {
  local name="$1" url="$2" jq_expr="$3" expected_val="${4:-true}"
  local body http response
  response=$(curl -sf --max-time "$TIMEOUT" -w "\n%{http_code}" "$url" 2>/dev/null || echo -e "\n000")
  http=$(echo "$response" | tail -1)
  body=$(echo "$response" | head -n -1)

  local val
  val=$(echo "$body" | jq -r "$jq_expr" 2>/dev/null || echo "__jq_error__")
  if [ "$val" = "$expected_val" ] || [ "$val" = "true" ]; then
    echo -e "${GREEN}PASS${NC} [$name] $jq_expr = $val"
    PASS=$((PASS+1))
  else
    echo -e "${YELLOW}WARN${NC} [$name] $jq_expr expected '$expected_val', got '$val' (non-blocking)"
    WARN=$((WARN+1))
  fi
}

# ─── Tests ────────────────────────────────────────────────────────────────────

echo "=== LiveClaw Smoke Tests ==="
echo "API: $API_URL"
echo "Frontend: $FRONTEND_URL"
echo "Timeout: ${TIMEOUT}s"
echo ""

# ── Backend health (DB must be ok)
check_json  "backend-health"   "$API_URL/health"  '.status'       "ok"
check_json  "backend-db-check" "$API_URL/health"  '.checks.db'    "true"
check_json  "backend-ts"       "$API_URL/health"  '.ts | length > 0' "true"

# ── Readiness probe (DB confirmed accessible)
check_json  "readyz"           "$API_URL/readyz"  '.status'       "ok"
check_json  "readyz-db"        "$API_URL/readyz"  '.checks.db'    "true"

# ── Pricing endpoint (plan catalog must be present)
check_json_not_null "pricing-standard" "$API_URL/pricing" '.plans.standard.id'

# ── 404 handling (route not found must return 404 not 200)
check_status "not-found" "$API_URL/definitely-nonexistent-route-xyz" "404"

# ── Admin endpoints (require auth — must return 401 not 500)
check_status "admin-unauthed-stats"     "$API_URL/admin/stats"          "401"
check_status "admin-unauthed-dashboard" "$API_URL/admin/dashboard-live" "401"

# ── Frontend serving
check_status "frontend" "$FRONTEND_URL/" "200"

# ── Bifrost gateway (checked via health JSON — non-blocking warning)
warn_json "bifrost-health" "$API_URL/health" '.checks.bifrost' "true"

echo ""
echo "=== Results ==="
echo -e "  Passed: ${GREEN}${PASS}${NC}"
[ "$WARN" -gt 0 ] && echo -e "  Warned: ${YELLOW}${WARN}${NC}"
[ "$FAIL" -gt 0 ] && echo -e "  Failed: ${RED}${FAIL}${NC}"

if [ "$FAIL" -gt 0 ]; then
  echo -e "\n${RED}SMOKE TESTS FAILED — $FAIL check(s) failed${NC}"
  exit 1
fi
echo -e "\n${GREEN}All smoke tests passed${NC}"
