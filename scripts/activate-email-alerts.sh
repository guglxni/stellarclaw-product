#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# LiveClaw — Activate Email Monitoring Alerts
#
# Securely sets the Gmail App Password on the production server and
# triggers a redeploy to activate Alertmanager + Grafana email alerts.
#
# Usage:
#   chmod +x scripts/activate-email-alerts.sh
#   ./scripts/activate-email-alerts.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER_IP="45.55.237.181"
SERVER_USER="root"
ENV_FILE="/opt/liveclaw/backend/.env"

BOLD='\033[1m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${BOLD}LiveClaw — Email Alert Activation${NC}"
echo "─────────────────────────────────────────────"
echo ""
echo "This script will:"
echo "  1. Prompt for your Gmail App Password (input hidden)"
echo "  2. Set it securely on the production server via SSH"
echo "  3. Trigger a redeploy to activate email alerts"
echo ""
echo -e "${YELLOW}Get your App Password at:${NC}"
echo "  https://myaccount.google.com/apppasswords"
echo "  → Select 'Mail' → 'Other' → name it 'LiveClaw'"
echo ""

# ── Prompt for password securely (no echo) ───────────────────────────────────
read -rsp "$(echo -e "${BOLD}Paste Gmail App Password (input hidden):${NC} ")" GMAIL_APP_PASSWORD
echo ""

if [[ -z "$GMAIL_APP_PASSWORD" ]]; then
    echo -e "${RED}Error: no password entered. Aborting.${NC}"
    exit 1
fi

# Strip spaces (Google displays it as "xxxx xxxx xxxx xxxx" but the actual
# password has no spaces)
GMAIL_APP_PASSWORD="${GMAIL_APP_PASSWORD// /}"

# Validate: Gmail App Passwords are exactly 16 lowercase letters
if [[ ! "$GMAIL_APP_PASSWORD" =~ ^[a-zA-Z]{16}$ ]]; then
    echo -e "${RED}Error: Gmail App Passwords are exactly 16 letters (no numbers, no spaces).${NC}"
    echo "You entered ${#GMAIL_APP_PASSWORD} characters: '${GMAIL_APP_PASSWORD}'"
    echo "Double-check at https://myaccount.google.com/apppasswords"
    exit 1
fi

echo ""
echo -e "${BOLD}Connecting to server...${NC}"

# ── Detect SSH key ────────────────────────────────────────────────────────────
SSH_KEY_OPTS=""
for key in ~/.ssh/id_ed25519 ~/.ssh/id_rsa ~/.ssh/liveclaw ~/.ssh/do_liveclaw; do
    if [[ -f "$key" ]]; then
        SSH_KEY_OPTS="-i $key"
        echo "  Using SSH key: $key"
        break
    fi
done

SSH_CMD="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 $SSH_KEY_OPTS ${SERVER_USER}@${SERVER_IP}"

# ── Test SSH connectivity ─────────────────────────────────────────────────────
if ! $SSH_CMD "echo connected" &>/dev/null; then
    echo -e "${RED}Error: cannot SSH into ${SERVER_USER}@${SERVER_IP}${NC}"
    echo "Check that your SSH key is correct and the server is reachable."
    exit 1
fi
echo -e "  ${GREEN}✓ SSH connection OK${NC}"

# ── Write the password to the server .env ─────────────────────────────────────
$SSH_CMD bash <<EOF
set -euo pipefail

# Create directory + file if they don't exist yet
mkdir -p "$(dirname "${ENV_FILE}")"
touch "${ENV_FILE}"

# Remove any existing GMAIL_APP_PASSWORD line then append the new one
sed -i '/^GMAIL_APP_PASSWORD=/d' "${ENV_FILE}"
echo "GMAIL_APP_PASSWORD=${GMAIL_APP_PASSWORD}" >> "${ENV_FILE}"

# Verify it was written (show masked)
SAVED=\$(grep '^GMAIL_APP_PASSWORD=' "${ENV_FILE}" | cut -d= -f2-)
MASKED="\${SAVED:0:4}************"
echo "  Saved: GMAIL_APP_PASSWORD=\${MASKED}"
EOF

echo -e "  ${GREEN}✓ App Password written to ${ENV_FILE}${NC}"

# Clear the variable from local memory
unset GMAIL_APP_PASSWORD

# ── Trigger redeploy ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}Triggering redeploy to activate email alerts...${NC}"

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

git commit --allow-empty -m "chore: activate Alertmanager + Grafana email alerts"
git push origin main

echo ""
echo -e "${GREEN}${BOLD}Done!${NC}"
echo ""
echo "The pipeline will deploy in ~2 minutes. Email alerts will fire to:"
echo "  guglaniaaryan@gmail.com"
echo ""
echo "Test endpoints being monitored:"
echo "  • https://liveclaw.xyz"
echo "  • https://api.liveclaw.xyz/health"
echo "  • https://api.liveclaw.xyz/readyz"
echo ""
echo "You'll receive an email if any endpoint is down for >2 minutes."
echo "SSL expiry warnings kick in at 14 days before cert renewal."
