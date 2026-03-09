#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# LiveClaw — macOS Keychain Secret Manager
#
# All generated secrets (TOKEN_ENCRYPTION_KEY, ADMIN_SECRET)
# are stored in your login.keychain-db, which is
# protected by your macOS login password.
#
# Usage:
#   ./scripts/keychain-secrets.sh              # print all keys to stdout
#   ./scripts/keychain-secrets.sh --inject     # merge into backend/.env
#   ./scripts/keychain-secrets.sh --rotate     # generate new values, re-store
#   ./scripts/keychain-secrets.sh --export-env # export as shell env vars
#
# Keychain items:
#   liveclaw.TOKEN_ENCRYPTION_KEY
#   liveclaw.ADMIN_SECRET
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }
label() { echo -e "${CYAN}$*${NC}"; }

KEYCHAIN_ITEMS=(TOKEN_ENCRYPTION_KEY ADMIN_SECRET TELEGRAM_MASTER_BOT_TOKEN)
BACKEND_ENV="$(cd "$(dirname "$0")/.." && pwd)/backend/.env"

# ─── Retrieve a value from Keychain ──────────────────────────────────────────
keychain_get() {
    local key="liveclaw.$1"
    security find-generic-password -a "$USER" -s "$key" -w 2>/dev/null || true
}

# ─── Store a value in Keychain ───────────────────────────────────────────────
keychain_set() {
    local key="liveclaw.$1"
    local value="$2"
    security add-generic-password -a "$USER" -s "$key" -w "$value" -U 2>/dev/null
}

# ─── Check all items exist ───────────────────────────────────────────────────
check_all() {
    local missing=()
    for item in "${KEYCHAIN_ITEMS[@]}"; do
        val=$(keychain_get "$item")
        [ -z "$val" ] && missing+=("$item")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        error "Missing Keychain items: ${missing[*]}"
        echo "  Run:  ./scripts/keychain-secrets.sh --rotate"
        echo "  This will generate and store fresh values."
        exit 1
    fi
}

# ─── --rotate: generate new values and store ─────────────────────────────────
if [[ "${1:-}" == "--rotate" ]]; then
    warn "Rotating all generated secrets..."
    warn "⚠️  After rotating TOKEN_ENCRYPTION_KEY all existing encrypted bot"
    warn "   tokens in the database become invalid. Stop all bots first."
    echo ""
    read -r -p "  Type YES to confirm rotation: " confirm
    [ "$confirm" != "YES" ] && { echo "Aborted."; exit 0; }

    TOKEN_ENC=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    ADMIN_SEC=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")

    keychain_set "TOKEN_ENCRYPTION_KEY" "$TOKEN_ENC" && info "TOKEN_ENCRYPTION_KEY rotated"
    keychain_set "ADMIN_SECRET"          "$ADMIN_SEC" && info "ADMIN_SECRET rotated"

    warn "TELEGRAM_MASTER_BOT_TOKEN was NOT rotated — revoke via @BotFather first, then:"
    warn "  security add-generic-password -a \"\$USER\" -s liveclaw.TELEGRAM_MASTER_BOT_TOKEN -w NEW_TOKEN -U"

    echo ""
    warn "Keys rotated. Re-inject into .env:"
    echo "  ./scripts/keychain-secrets.sh --inject"
    exit 0
fi

# ─── Require all items before any other command ──────────────────────────────
check_all

TOKEN_ENC=$(keychain_get "TOKEN_ENCRYPTION_KEY")
ADMIN_SEC=$(keychain_get "ADMIN_SECRET")
TG_TOKEN=$(keychain_get "TELEGRAM_MASTER_BOT_TOKEN")

# ─── --export-env: print as export statements ────────────────────────────────
if [[ "${1:-}" == "--export-env" ]]; then
    echo "export TOKEN_ENCRYPTION_KEY='${TOKEN_ENC}'"
    echo "export ADMIN_SECRET='${ADMIN_SEC}'"
    echo "export TELEGRAM_MASTER_BOT_TOKEN='${TG_TOKEN}'"
    exit 0
fi

# ─── --inject: merge generated keys into backend/.env ────────────────────────
if [[ "${1:-}" == "--inject" ]]; then
    if [ ! -f "$BACKEND_ENV" ]; then
        info "No backend/.env found — copying from .env.example"
        cp "$(dirname "$BACKEND_ENV")/.env.example" "$BACKEND_ENV"
    fi

    inject_or_append() {
        local key="$1" value="$2" file="$3"
        if grep -q "^${key}=" "$file" 2>/dev/null; then
            # Replace existing line (handles CHANGE_ME placeholders)
            sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
        else
            # Append if missing
            echo "${key}=${value}" >> "$file"
        fi
    }

    inject_or_append "TOKEN_ENCRYPTION_KEY" "$TOKEN_ENC" "$BACKEND_ENV"
    inject_or_append "ADMIN_SECRET"          "$ADMIN_SEC" "$BACKEND_ENV"
    inject_or_append "TELEGRAM_MASTER_BOT_TOKEN" "$TG_TOKEN" "$BACKEND_ENV"

    # Lock down permissions — owner read/write only
    chmod 600 "$BACKEND_ENV"

    info "Injected 3 keys into backend/.env (chmod 600)"
    warn "Remaining CHANGE_ME values still need to be filled in manually."
    echo ""
    grep "CHANGE_ME" "$BACKEND_ENV" | awk -F= '{print "  Still needed: " $1}' || true
    exit 0
fi

# ─── Default: print all keys ─────────────────────────────────────────────────
echo ""
label "  LiveClaw — Generated Secrets (from macOS Keychain)"
label "  ──────────────────────────────────────────────────"
echo ""
echo "  TOKEN_ENCRYPTION_KEY=${TOKEN_ENC}"
echo "  ADMIN_SECRET=${ADMIN_SEC}"
echo "  TELEGRAM_MASTER_BOT_TOKEN=${TG_TOKEN}"
echo ""
warn "These values are stored in ~/Library/Keychains/login.keychain-db"
warn "Protected by your macOS login password."
echo ""
echo "  To write them directly into backend/.env:"
echo "    ./scripts/keychain-secrets.sh --inject"
echo ""
