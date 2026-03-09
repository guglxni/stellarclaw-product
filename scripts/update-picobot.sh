#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# update-picobot.sh — Download/update picobot to the latest GitHub release
#
# Checks the GitHub API for the latest louisho5/picobot release, compares
# against the currently installed version, and replaces the binary if newer.
#
# After a successful update, running picobot processes are NOT automatically
# restarted. A graceful rolling restart can be triggered by the orchestrator
# or by calling this script with --restart.
#
# Usage:
#   ./scripts/update-picobot.sh                     # Download latest if newer
#   ./scripts/update-picobot.sh --force              # Force re-download
#   ./scripts/update-picobot.sh --check              # Check only, don't download
#   ./scripts/update-picobot.sh --restart             # Update + reload PM2
#   PICOBOT_VARIANT=lite ./scripts/update-picobot.sh  # Use lite build (~10MB)
#
# Environment:
#   PICOBOT_DIR       — Directory for picobot binary (default: /opt/liveclaw/backend)
#   PICOBOT_VARIANT   — "full" (default, ~22MB) or "lite" (~10MB, no WhatsApp)
#   PICOBOT_ARCH      — "amd64" (default) or "arm64"
#   GITHUB_TOKEN      — Optional; avoids API rate limits (60 req/hr unauthenticated)
#
# Exit codes:
#   0 — Success (updated or already up-to-date)
#   1 — Error (network, permissions, etc.)
#   2 — New version available (--check mode only)
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
REPO="louisho5/picobot"
PICOBOT_DIR="${PICOBOT_DIR:-/opt/liveclaw/backend}"
PICOBOT_VARIANT="${PICOBOT_VARIANT:-full}"
PICOBOT_ARCH="${PICOBOT_ARCH:-amd64}"
VERSION_FILE="${PICOBOT_DIR}/.picobot-version"
BINARY_PATH="${PICOBOT_DIR}/picobot"

# GitHub API (with optional auth)
API_URL="https://api.github.com/repos/${REPO}/releases/latest"
AUTH_HEADER=""
if [ -n "${GITHUB_TOKEN:-}" ]; then
    AUTH_HEADER="Authorization: token ${GITHUB_TOKEN}"
fi

# ─── Colors ──────────────────────────────────────────────════════════════════
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${GREEN}[picobot-update]${NC} $*"; }
warn()  { echo -e "${YELLOW}[picobot-update]${NC} $*"; }
error() { echo -e "${RED}[picobot-update]${NC} $*" >&2; }

# ─── Parse Args ──────────────────────────────────────────────────────────────
FORCE=false
CHECK_ONLY=false
RESTART=false

for arg in "$@"; do
    case "$arg" in
        --force)     FORCE=true ;;
        --check)     CHECK_ONLY=true ;;
        --restart)   RESTART=true ;;
        --help|-h)
            echo "Usage: $0 [--force] [--check] [--restart]"
            echo "  --force    Force re-download even if up-to-date"
            echo "  --check    Check for updates without downloading"
            echo "  --restart  Reload PM2 after successful update"
            exit 0
            ;;
    esac
done

# ─── Fetch Latest Release ───────────────────────────────────────────────────
info "Checking for latest picobot release..."

CURL_ARGS=(-s -f --connect-timeout 10 --max-time 30)
if [ -n "$AUTH_HEADER" ]; then
    CURL_ARGS+=(-H "$AUTH_HEADER")
fi

RELEASE_JSON=$(curl "${CURL_ARGS[@]}" "$API_URL") || {
    error "Failed to fetch release info from GitHub API"
    exit 1
}

LATEST_VERSION=$(echo "$RELEASE_JSON" | grep -o '"tag_name":\s*"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -z "$LATEST_VERSION" ]; then
    error "Could not parse version from GitHub API response"
    exit 1
fi

info "Latest release: ${CYAN}${LATEST_VERSION}${NC}"

# ─── Compare with Current Version ───────────────────────────────────────────
CURRENT_VERSION=""
if [ -f "$VERSION_FILE" ]; then
    CURRENT_VERSION=$(cat "$VERSION_FILE" 2>/dev/null || echo "")
fi

if [ -z "$CURRENT_VERSION" ] && [ -x "$BINARY_PATH" ]; then
    # Try to get version from binary itself
    CURRENT_VERSION=$("$BINARY_PATH" version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' || echo "")
fi

if [ -n "$CURRENT_VERSION" ]; then
    info "Current version: ${CYAN}${CURRENT_VERSION}${NC}"
else
    info "Current version: ${YELLOW}not installed${NC}"
fi

# Check if update is needed
if [ "$CURRENT_VERSION" = "$LATEST_VERSION" ] && [ "$FORCE" = false ]; then
    info "Already up-to-date (${LATEST_VERSION})"
    exit 0
fi

if [ "$CHECK_ONLY" = true ]; then
    if [ "$CURRENT_VERSION" != "$LATEST_VERSION" ]; then
        info "Update available: ${CURRENT_VERSION:-none} → ${LATEST_VERSION}"
        exit 2
    fi
    exit 0
fi

# ─── Determine Asset Name ───────────────────────────────────────────────────
# v0.1.5+ uses raw binaries: picobot_linux_amd64, picobot_linux_amd64_lite
# Older versions used: picobot-linux-amd64.tar.gz
ASSET_NAME="picobot_linux_${PICOBOT_ARCH}"
if [ "$PICOBOT_VARIANT" = "lite" ]; then
    ASSET_NAME="${ASSET_NAME}_lite"
fi

# Check if asset exists in the release
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep -o "\"browser_download_url\":\s*\"[^\"]*${ASSET_NAME}\"" | head -1 | cut -d'"' -f4)

if [ -z "$DOWNLOAD_URL" ]; then
    # Fallback: try .tar.gz format (older releases)
    LEGACY_ASSET="picobot-linux-${PICOBOT_ARCH}.tar.gz"
    DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep -o "\"browser_download_url\":\s*\"[^\"]*${LEGACY_ASSET}\"" | head -1 | cut -d'"' -f4)
    if [ -n "$DOWNLOAD_URL" ]; then
        warn "Using legacy .tar.gz asset format"
        ASSET_NAME="$LEGACY_ASSET"
    else
        error "Could not find asset '${ASSET_NAME}' in release ${LATEST_VERSION}"
        error "Available assets:"
        echo "$RELEASE_JSON" | grep -o '"name":\s*"picobot[^"]*"' | sed 's/"name":\s*"//;s/"//' | while read -r name; do
            echo "  - $name"
        done
        exit 1
    fi
fi

info "Downloading ${CYAN}${ASSET_NAME}${NC} (${LATEST_VERSION})..."

# ─── Download ────────────────────────────────────────────────────────────────
mkdir -p "$PICOBOT_DIR"
TMP_FILE="${PICOBOT_DIR}/picobot.download.tmp"

# Clean up temp file on exit
trap 'rm -f "$TMP_FILE"' EXIT

DOWNLOAD_ARGS=(-fSL --connect-timeout 15 --max-time 120 --retry 3 --retry-delay 5 -o "$TMP_FILE")
if [ -n "$AUTH_HEADER" ]; then
    DOWNLOAD_ARGS+=(-H "$AUTH_HEADER")
fi

curl "${DOWNLOAD_ARGS[@]}" "$DOWNLOAD_URL" || {
    error "Download failed from: ${DOWNLOAD_URL}"
    exit 1
}

# Handle .tar.gz vs raw binary
if [[ "$ASSET_NAME" == *.tar.gz ]]; then
    info "Extracting archive..."
    tar -xf "$TMP_FILE" -C "$PICOBOT_DIR" 2>/dev/null || {
        error "Failed to extract tar.gz archive"
        exit 1
    }
    rm -f "$TMP_FILE"
else
    # Raw binary — just move into place
    mv "$TMP_FILE" "$BINARY_PATH"
fi

chmod +x "$BINARY_PATH"

# Verify the binary works
if ! "$BINARY_PATH" version &>/dev/null; then
    error "Downloaded binary failed verification ('picobot version' returned non-zero)"
    exit 1
fi

# Record version
echo "$LATEST_VERSION" > "$VERSION_FILE"

BINARY_SIZE=$(ls -lh "$BINARY_PATH" | awk '{print $5}')
info "Updated picobot: ${CURRENT_VERSION:-none} → ${GREEN}${LATEST_VERSION}${NC} (${BINARY_SIZE})"

# Get SHA256 for audit log
if command -v sha256sum &>/dev/null; then
    SHA=$(sha256sum "$BINARY_PATH" | awk '{print $1}')
    info "SHA256: ${SHA}"
elif command -v shasum &>/dev/null; then
    SHA=$(shasum -a 256 "$BINARY_PATH" | awk '{print $1}')
    info "SHA256: ${SHA}"
fi

# ─── Optional PM2 Restart ───────────────────────────────────────────────────
if [ "$RESTART" = true ]; then
    if command -v pm2 &>/dev/null && pm2 describe liveclaw-orchestrator &>/dev/null; then
        info "Reloading PM2 orchestrator..."
        pm2 reload liveclaw-orchestrator --update-env
        info "PM2 reloaded. Note: running picobot agents keep the old binary until restarted."
    else
        warn "PM2 not available or orchestrator not running — skipping restart"
    fi
fi

info "Done! ✓"
