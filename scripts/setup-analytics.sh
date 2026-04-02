#!/usr/bin/env bash
# =============================================================================
# LiveClaw — Analytics Setup Wizard
# =============================================================================
#
# Interactive walkthrough for setting up PostHog and GTM.
# Opens the exact browser pages you need, validates every key,
# and writes everything into liveclaw-web/.env when done.
#
# USAGE
#   bash scripts/setup-analytics.sh
#
# =============================================================================

set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/liveclaw-web/.env"
POSTHOG_CLI="${HOME}/.posthog/bin/posthog-cli"
GTM_CLI="${HOME}/.local/bin/gtm"
GTM_SETUP="$SCRIPT_DIR/setup-gtm.sh"

# ── DigitalOcean (doctl) ──────────────────────────────────────────────────────
BACKEND_DROPLET="liveclaw-prod"
FRONTEND_DROPLET="liveclaw-web"
droctl_ssh() { doctl compute ssh "$BACKEND_DROPLET" --ssh-command "$1" 2>&1; }
get_droplet_ip() { doctl compute droplet get "$1" --format PublicIPv4 --no-header 2>/dev/null; }

# ── Colours ───────────────────────────────────────────────────────────────────
R='\033[0;31m' G='\033[0;32m' C='\033[0;36m' Y='\033[1;33m'
B='\033[0;34m' M='\033[0;35m' BOLD='\033[1m' DIM='\033[2m' RESET='\033[0m'

# ── Helpers ───────────────────────────────────────────────────────────────────
log()    { echo -e "\n${C}▶${RESET} $*"; }
ok()     { echo -e "${G}  ✓${RESET} $*"; }
warn()   { echo -e "${Y}  !${RESET} $*"; }
err()    { echo -e "${R}  ✗${RESET} $*"; }
step()   { echo -e "\n${BOLD}${B}  [$1/$TOTAL_STEPS]${RESET} ${BOLD}$2${RESET}"; echo -e "  ${DIM}$3${RESET}"; }
prompt() { echo -e ""; printf "  ${BOLD}→${RESET} $1: "; }
banner() {
    echo -e "\n${BOLD}${M}╔══════════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${M}║${RESET}  ${BOLD}$1${RESET}"
    echo -e "${BOLD}${M}╚══════════════════════════════════════════════════════╝${RESET}"
}
divider() { echo -e "\n${DIM}  ──────────────────────────────────────────────────────${RESET}"; }
open_url() {
    echo -e "\n  ${C}Opening:${RESET} $1"
    open "$1" 2>/dev/null || xdg-open "$1" 2>/dev/null || echo -e "  ${Y}→ Open manually:${RESET} $1"
    sleep 1
}
pause() {
    echo ""
    read -r -p "  Press Enter when ready to continue... " _
}
write_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" && rm -f "${ENV_FILE}.bak"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
    ok "Saved ${BOLD}${key}${RESET} to .env"
}
skip_step() { warn "Skipping — you can re-run this script anytime to fill this in."; }

TOTAL_STEPS=3
COMPLETED=()

[[ -f "$ENV_FILE" ]] || { err ".env not found at $ENV_FILE"; exit 1; }

# =============================================================================
clear
banner "LiveClaw Analytics Setup Wizard"
echo ""
echo -e "  This wizard sets up ${BOLD}PostHog${RESET} and ${BOLD}GTM${RESET} step by step."
echo -e "  It will open browser pages at exactly the right place and"
echo -e "  write every key into ${BOLD}liveclaw-web/.env${RESET} when done."
echo ""
echo -e "  ${DIM}You can skip any step and re-run later.${RESET}"
divider
pause

# =============================================================================
# STEP 1 — PostHog
# =============================================================================
banner "Step 1 of 3 — PostHog"
step 1 "PostHog" "FOSS product analytics — tracks your funnel, identifies users, session recording"
echo ""
echo -e "  ${DIM}Repo: https://github.com/PostHog/posthog${RESET}"
echo -e "  ${DIM}Free cloud tier: 1M events/mo — enough to start${RESET}"
echo ""
read -r -p "  Skip PostHog? [y/N]: " SKIP_PH
if [[ $(echo "$SKIP_PH" | tr "[:upper:]" "[:lower:]") == "y" ]]; then
    skip_step
else
    # ── 1a. Account ─────────────────────────────────────────────────────────
    divider
    log "Opening PostHog sign-up / login..."
    echo ""
    echo -e "  ${BOLD}What to do once the page opens:${RESET}"
    echo -e "  ${DIM}1. Create an account (or sign in if you have one)${RESET}"
    echo -e "  ${DIM}2. When asked for a project name → type ${RESET}${BOLD}LiveClaw${RESET}"
    echo -e "  ${DIM}3. Skip the onboarding tour${RESET}"
    open_url "https://us.posthog.com/signup"
    pause

    # ── 1b. CLI auth (stores personal key for future sourcemap uploads) ─────
    divider
    log "Authenticating PostHog CLI..."
    echo ""
    echo -e "  ${BOLD}This stores a personal API key so the CLI can upload${RESET}"
    echo -e "  ${BOLD}sourcemaps later (helps debug production JS errors).${RESET}"
    echo ""
    read -r -p "  Run PostHog CLI login now? [Y/n]: " DO_PH_LOGIN
    if [[ $(echo "$DO_PH_LOGIN" | tr "[:upper:]" "[:lower:]") != "n" ]]; then
        source "$HOME/.posthog/env" 2>/dev/null || true
        echo ""
        "$POSTHOG_CLI" login && ok "PostHog CLI authenticated" || warn "CLI login failed — the JS key below still works fine"
    fi

    # ── 1c. Get the project phc_ key ────────────────────────────────────────
    divider
    log "Now grab your Project API Key (the phc_... key)..."
    echo ""
    echo -e "  ${BOLD}Where to find it:${RESET}"
    echo -e "  ${DIM}PostHog → top-left project name → Project Settings → Project API Key${RESET}"
    echo ""
    open_url "https://us.posthog.com/settings/project"
    echo ""
    echo -e "  ${Y}Look for a key that starts with ${BOLD}phc_${RESET}${Y} — that's the one.${RESET}"
    echo -e "  ${DIM}(Not the Personal API Key — that starts with phx_)${RESET}"
    echo ""

    PH_KEY=""
    while true; do
        prompt "Paste your phc_... Project API Key"
        read -r PH_KEY
        if [[ -z "$PH_KEY" ]]; then
            warn "No key entered."
            read -r -p "  Skip PostHog for now? [y/N]: " skip; [[ $(echo "$skip" | tr "[:upper:]" "[:lower:]") == "y" ]] && { skip_step; break; }
        elif [[ "$PH_KEY" != phc_* ]]; then
            err "That doesn't look right — it should start with ${BOLD}phc_${RESET}"
            echo -e "  ${DIM}(If you pasted a phx_ key that's your personal key — go back and find the Project API Key)${RESET}"
        else
            write_env "LIVECLAW_POSTHOG_KEY" "$PH_KEY"

            # ── Host ────────────────────────────────────────────────────────
            echo ""
            echo -e "  ${DIM}PostHog host — use the default unless you're self-hosting${RESET}"
            prompt "PostHog host [https://us.i.posthog.com]"
            read -r PH_HOST
            PH_HOST="${PH_HOST:-https://us.i.posthog.com}"
            write_env "LIVECLAW_POSTHOG_HOST" "$PH_HOST"
            COMPLETED+=("PostHog ✓")
            break
        fi
    done
fi

# =============================================================================
# STEP 2 — GTM
# =============================================================================
banner "Step 2 of 3 — Google Tag Manager"
step 2 "GTM" "Free tag container — one GTM ID wires up Meta Pixel, Google Ads, TikTok with zero future code changes."
echo ""
echo -e "  ${DIM}The GTM CLI will handle everything: create container, set up all triggers${RESET}"
echo -e "  ${DIM}and placeholder tags, publish, and print your GTM-XXXXXXX ID.${RESET}"
echo ""
read -r -p "  Skip GTM? [y/N]: " SKIP_GTM
if [[ $(echo "$SKIP_GTM" | tr "[:upper:]" "[:lower:]") == "y" ]]; then
    skip_step
else
    # ── 3a. Create a GTM account if needed ──────────────────────────────────
    divider
    log "Checking if you have a GTM account..."
    echo ""
    echo -e "  ${BOLD}If you don't have one:${RESET}"
    echo -e "  ${DIM}1. Click ${RESET}${BOLD}Create Account${RESET}${DIM} → Account Name: ${RESET}${BOLD}LiveClaw${RESET}"
    echo -e "  ${DIM}2. Container Name: ${RESET}${BOLD}liveclaw.xyz${RESET}${DIM} → Target: ${RESET}${BOLD}Web${RESET}"
    echo -e "  ${DIM}3. Accept terms → you'll get a GTM-XXXXXXX ID (you won't need it — the CLI grabs it)${RESET}"
    echo ""
    open_url "https://tagmanager.google.com"
    pause

    # ── 3b. GTM CLI auth ────────────────────────────────────────────────────
    divider
    log "Authenticating GTM CLI..."
    echo ""
    echo -e "  ${DIM}This will open a browser window for Google OAuth.${RESET}"
    echo -e "  ${DIM}Sign in with the Google account that owns your GTM account.${RESET}"
    echo ""
    pause
    "$GTM_CLI" auth login || { err "GTM auth failed — check your Google account has GTM access"; exit 1; }
    ok "GTM CLI authenticated"

    # ── 3c. Run setup-gtm.sh ────────────────────────────────────────────────
    divider
    log "Provisioning GTM container (triggers, variables, tags)..."
    echo ""

    # Capture the GTM-XXXXXXX from setup-gtm.sh output
    GTM_OUTPUT=$(bash "$GTM_SETUP" 2>&1 | tee /dev/tty)
    GTM_ID=$(echo "$GTM_OUTPUT" | grep -oE 'GTM-[A-Z0-9]+' | head -1)

    if [[ -n "$GTM_ID" ]]; then
        write_env "LIVECLAW_GTM_ID" "$GTM_ID"
        COMPLETED+=("GTM ✓ ($GTM_ID)")
    else
        echo ""
        prompt "Paste your GTM-XXXXXXX container ID (shown above)"
        read -r GTM_ID_MANUAL
        if [[ -n "$GTM_ID_MANUAL" ]]; then
            write_env "LIVECLAW_GTM_ID" "$GTM_ID_MANUAL"
            COMPLETED+=("GTM ✓ ($GTM_ID_MANUAL)")
        else
            skip_step
        fi
    fi
fi

# =============================================================================
# STEP 3 — Dodo GTM toggle
# =============================================================================
banner "Step 3 of 3 — Wire GTM into Dodo Checkout"
step 3 "Dodo → GTM" "Enables GTM on Dodo's hosted checkout page so ad conversions fire when customers pay."
echo ""
echo -e "  ${DIM}This is a one-toggle change in the Dodo dashboard — 30 seconds.${RESET}"
echo ""
read -r -p "  Skip this? [y/N]: " SKIP_DODO
if [[ $(echo "$SKIP_DODO" | tr "[:upper:]" "[:lower:]") == "y" ]]; then
    skip_step
else
    CURRENT_GTM_ID=$(grep "^LIVECLAW_GTM_ID=" "$ENV_FILE" | cut -d= -f2)
    divider
    log "Opening Dodo settings..."
    echo ""
    echo -e "  ${BOLD}What to do:${RESET}"
    echo -e "  ${DIM}1. Find ${RESET}${BOLD}Google Tag Manager${RESET}${DIM} → toggle it ON${RESET}"
    echo -e "  ${DIM}2. Paste your GTM ID:${RESET} ${BOLD}${CURRENT_GTM_ID:-GTM-XXXXXXX}${RESET}"
    echo -e "  ${DIM}3. Also toggle ${RESET}${BOLD}Customer Portal Return URL${RESET}${DIM} ON → set it to ${RESET}${BOLD}https://liveclaw.xyz${RESET}"
    echo -e "  ${DIM}4. Toggle ${RESET}${BOLD}3D Secure${RESET}${DIM} ON${RESET}"
    echo ""
    open_url "https://app.dodopayments.com/settings"
    pause
    ok "Dodo settings updated"
    COMPLETED+=("Dodo ✓")
fi

# =============================================================================
# DONE — Summary
# =============================================================================
banner "Setup Complete"
echo ""
echo -e "  ${BOLD}Completed:${RESET}"
for item in "${COMPLETED[@]}"; do
    echo -e "  ${G}✓${RESET} $item"
done
echo ""

divider
log "Current analytics values in .env:"
echo ""
grep -E "^LIVECLAW_(POSTHOG|GTM)" "$ENV_FILE" | while IFS= read -r line; do
    key="${line%%=*}"
    val="${line#*=}"
    if [[ -z "$val" ]]; then
        echo -e "  ${Y}${key}=${RESET}${DIM}(empty)${RESET}"
    else
        echo -e "  ${G}${key}=${RESET}${val}"
    fi
done

echo ""
divider
echo ""
echo -e "  ${BOLD}Final step — redeploy frontend config:${RESET}"
echo ""
echo -e "  ${C}  bash scripts/deploy-frontend.sh --config-only${RESET}"
echo ""
echo -e "  ${DIM}This regenerates config.js on your server with the new keys.${RESET}"
echo -e "  ${DIM}Analytics goes live as soon as that completes.${RESET}"
echo ""
read -r -p "  Run deploy now? [y/N]: " DO_DEPLOY
if [[ $(echo "$DO_DEPLOY" | tr "[:upper:]" "[:lower:]") == "y" ]]; then
    bash "$SCRIPT_DIR/deploy-frontend.sh" --config-only
    ok "Frontend redeployed — analytics is live!"
else
    echo ""
    echo -e "  ${DIM}Run it manually when ready:${RESET}"
    echo -e "  ${C}  bash scripts/deploy-frontend.sh --config-only${RESET}"
fi

echo ""
