#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# LiveClaw — Frontend Droplet Deployment
#
# Provisions (or updates) the static-file droplet on DigitalOcean:
#   liveclaw.xyz → Nginx serving static HTML/CSS/JS
#
# Usage:
#   chmod +x scripts/deploy-frontend.sh
#   ./scripts/deploy-frontend.sh                 # full provision + deploy
#   ./scripts/deploy-frontend.sh --code-only      # rsync static files only
#   ./scripts/deploy-frontend.sh --config-only    # regenerate config.js only
#
# Cost: s-1vcpu-512mb-10gb = $4/mo (static files only, minimal resources)
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
DOMAIN="liveclaw.xyz"
ADMIN_EMAIL="admin@${DOMAIN}"
FRONTEND_DIR="$(cd "$(dirname "$0")/.." && pwd)/liveclaw-web"
FRONTEND_WWW="${FRONTEND_DIR}/www"
DROPLET_NAME="liveclaw-web"
REGION="nyc3"
SIZE="s-1vcpu-512mb-10gb"
IMAGE="ubuntu-24-04-x64"
SSH_KEY_NAME="liveclaw-deploy-key"
REMOTE_BASE="/opt/liveclaw"
SSH_KEY_FILE="${SSH_KEY_FILE:-$HOME/.ssh/liveclaw_deploy}"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ${SSH_KEY_FILE}"

CODE_ONLY=false
CONFIG_ONLY=false

# Parse flags
for arg in "$@"; do
    case "$arg" in
        --code-only)   CODE_ONLY=true ;;
        --config-only) CONFIG_ONLY=true ;;
    esac
done

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }

# ─── Config.js Generator ─────────────────────────────────────────────────────
# Reads liveclaw-web/.env and substitutes {{VAR}} placeholders in the template
generate_config_js() {
    local env_file="$1"
    local template="$2"
    local output="$3"

    if [ ! -f "$env_file" ]; then
        error ".env file not found: $env_file"
        echo "  Copy the example:  cp liveclaw-web/.env.example liveclaw-web/.env"
        exit 1
    fi
    if [ ! -f "$template" ]; then
        error "Template not found: $template"
        exit 1
    fi

    info "Generating config.js from template..."

    # Source the .env (only LIVECLAW_ prefixed vars)
    local content
    content=$(cat "$template")

    while IFS='=' read -r key value; do
        # Skip comments and blanks
        [[ "$key" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$key" ]] && continue
        # Strip quotes
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        # Replace {{KEY}} in template
        content="${content//\{\{$key\}\}/$value}"
    done < "$env_file"

    echo "$content" > "$output"
    info "config.js written to: $output"
}

# ─── --config-only: regenerate on remote and exit ─────────────────────────────
if [ "$CONFIG_ONLY" = true ]; then
    info "Regenerating config.js on remote..."

    DROPLET_IP=$(doctl compute droplet get "$DROPLET_NAME" --format PublicIPv4 --no-header 2>/dev/null || true)
    if [ -z "$DROPLET_IP" ]; then
        error "Droplet '${DROPLET_NAME}' not found."
        exit 1
    fi

    # Generate locally, then upload
    TMPCONF=$(mktemp /tmp/liveclaw-config.XXXXXX.js)
    generate_config_js "${FRONTEND_DIR}/.env" "${FRONTEND_DIR}/config.js.template" "$TMPCONF"
    rsync -az -e "ssh ${SSH_OPTS}" "$TMPCONF" root@"$DROPLET_IP":${REMOTE_BASE}/frontend/config.js
    rm -f "$TMPCONF"

    info "config.js deployed to ${DROPLET_IP}:${REMOTE_BASE}/frontend/config.js"
    exit 0
fi

# ─── Preflight ───────────────────────────────────────────────────────────────
info "Preflight checks..."

for cmd in doctl rsync ssh; do
    command -v "$cmd" &>/dev/null || { error "$cmd not found."; exit 1; }
done

doctl account get &>/dev/null || { error "doctl not authenticated."; exit 1; }

if [ ! -d "$FRONTEND_WWW" ]; then
    error "Frontend directory not found: $FRONTEND_WWW"
    exit 1
fi

# ─── SSH Key ─────────────────────────────────────────────────────────────────
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | grep "$SSH_KEY_NAME" | awk '{print $1}')
[ -z "$SSH_KEY_ID" ] && { error "SSH key '${SSH_KEY_NAME}' not found."; exit 1; }

# ─── Droplet ─────────────────────────────────────────────────────────────────
EXISTING=$(doctl compute droplet list --format Name --no-header | grep -x "$DROPLET_NAME" || true)

if [ -z "$EXISTING" ] && [ "$CODE_ONLY" = true ]; then
    error "Droplet '${DROPLET_NAME}' does not exist. Run without --code-only first."
    exit 1
fi

if [ -z "$EXISTING" ]; then
    info "Creating droplet ${DROPLET_NAME} (${SIZE}, ${REGION})..."
    doctl compute droplet create "$DROPLET_NAME" \
        --size "$SIZE" \
        --image "$IMAGE" \
        --region "$REGION" \
        --ssh-keys "$SSH_KEY_ID" \
        --tag-name "liveclaw,frontend" \
        --wait
    info "Waiting 30s for SSH..."
    sleep 30
else
    warn "Droplet '${DROPLET_NAME}' exists. Reusing."
fi

DROPLET_IP=$(doctl compute droplet get "$DROPLET_NAME" --format PublicIPv4 --no-header)
info "Frontend IP: ${DROPLET_IP}"

# Wait for SSH
attempt=0
while ! ssh $SSH_OPTS root@"$DROPLET_IP" "echo ok" &>/dev/null; do
    attempt=$((attempt + 1))
    [ $attempt -gt 12 ] && { error "SSH unreachable after 2 min."; exit 1; }
    echo "  Waiting for SSH... (${attempt}/12)"
    sleep 10
done

# ─── Server Provision (skip with --code-only) ────────────────────────────────
if [ "$CODE_ONLY" = false ]; then
    info "Provisioning server..."
    ssh $SSH_OPTS root@"$DROPLET_IP" << 'PROVISION_EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq && apt-get upgrade -y -qq

# Only Nginx + Certbot + UFW — no Node.js needed for static files
apt-get install -y -qq nginx certbot python3-certbot-nginx ufw

# Firewall
ufw --force enable
ufw allow ssh
ufw allow 'Nginx Full'

# Directory
mkdir -p /opt/liveclaw/frontend
PROVISION_EOF
fi

# ─── Generate config.js ─────────────────────────────────────────────────────
TMPCONF=$(mktemp /tmp/liveclaw-config.XXXXXX.js)
generate_config_js "${FRONTEND_DIR}/.env" "${FRONTEND_DIR}/config.js.template" "$TMPCONF"

# ─── Upload Frontend ─────────────────────────────────────────────────────────
info "Uploading static files..."
rsync -az --delete \
    -e "ssh ${SSH_OPTS}" \
    --exclude '.DS_Store' \
    "$FRONTEND_WWW/" root@"$DROPLET_IP":${REMOTE_BASE}/frontend/

info "Uploading config.js..."
rsync -az -e "ssh ${SSH_OPTS}" "$TMPCONF" root@"$DROPLET_IP":${REMOTE_BASE}/frontend/config.js
rm -f "$TMPCONF"

# ─── Nginx (skip with --code-only) ───────────────────────────────────────────
if [ "$CODE_ONLY" = false ]; then
    info "Configuring Nginx..."
    ssh $SSH_OPTS root@"$DROPLET_IP" << NGINX_EOF
cat > /etc/nginx/sites-available/liveclaw << 'CONF'
# LiveClaw Frontend — Nginx static file server
# Auto-generated by deploy-frontend.sh
server_tokens off;

server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    root /opt/liveclaw/frontend;
    index index.html;

    # ── Compression ──────────────────────────────────────────────────────
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_min_length 256;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/json
        application/javascript
        application/xml
        application/rss+xml
        image/svg+xml;

    # ── Static Asset Caching ─────────────────────────────────────────────
    # Hashed chunks from Next.js / Turbopack — immutable, cache forever
    location /_next/static/ {
        expires max;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # Other static assets — 30 days
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        access_log off;
    }

    # config.js — short cache so env changes propagate quickly
    location = /config.js {
        expires 5m;
        add_header Cache-Control "public, must-revalidate";
    }

    # ── Security Headers ─────────────────────────────────────────────────
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # ── SPA Routing ──────────────────────────────────────────────────────
    location / {
        try_files \\\$uri \\\$uri/ /index.html;
    }

    # ── Admin Dashboard ──────────────────────────────────────────────────
    location /admin/ {
        try_files \\\$uri \\\$uri/ /admin/index.html;
    }
    # ── API proxy (fallback when config.js LIVECLAW_API_BASE not set) ────────
    # Strips /api prefix and forwards to the backend droplet (api.liveclaw.xyz).
    # The admin dashboard primarily uses window.LIVECLAW_API_BASE for direct
    # cross-origin calls, but this proxy ensures CI/local testing works too.
    location = /api/admin/login {
        proxy_pass https://api.liveclaw.xyz/admin/login;
        proxy_set_header Host api.liveclaw.xyz;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
        proxy_set_header Authorization \\\$http_authorization;
        proxy_read_timeout 30s;
    }

    location /api/ {
        rewrite ^/api/(.*)\$ /\\\$1 break;
        proxy_pass https://api.liveclaw.xyz;
        proxy_set_header Host api.liveclaw.xyz;
        proxy_set_header X-Real-IP \\\$remote_addr;
        proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
        proxy_set_header Authorization \\\$http_authorization;
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
    }}
CONF

ln -sf /etc/nginx/sites-available/liveclaw /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo "  Nginx: configured"
NGINX_EOF

    # SSL
    info "Provisioning SSL..."
    ssh $SSH_OPTS root@"$DROPLET_IP" << SSL_EOF
set -euo pipefail
if certbot --nginx \
    -d ${DOMAIN} \
    -d www.${DOMAIN} \
    -m ${ADMIN_EMAIL} \
    --agree-tos \
    --non-interactive \
    --redirect \
    --staple-ocsp 2>/dev/null; then
    echo "  ✅ SSL issued for ${DOMAIN} + www.${DOMAIN}"
else
    echo "  ⚠️  Certbot failed — DNS not pointed yet?"
    echo "  Run later: certbot --nginx -d ${DOMAIN} -d www.${DOMAIN} -m ${ADMIN_EMAIL} --agree-tos"
fi

if ! crontab -l 2>/dev/null | grep -q certbot; then
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --deploy-hook 'systemctl reload nginx'") | crontab -
    echo "  Auto-renewal cron set"
fi
SSL_EOF
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
info "═══════════════════════════════════════════════════"
info "  Frontend deployment complete!"
info "═══════════════════════════════════════════════════"
echo ""
echo "  Droplet:  ${DROPLET_NAME}  (${DROPLET_IP})"
echo "  Domain:   https://${DOMAIN}"
echo "  SSH:      ssh root@${DROPLET_IP}"
echo ""
echo "  Post-deploy checklist:"
echo "  1. DNS A records:"
echo "       ${DOMAIN}     → ${DROPLET_IP}"
echo "       www.${DOMAIN} → ${DROPLET_IP}"
echo "  2. Verify config.js has correct API_BASE:"
echo "       curl https://${DOMAIN}/config.js"
echo "  3. SSL (if skipped):"
echo "       ssh root@${DROPLET_IP} 'certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}'"
echo ""
echo "  Update config.js without full redeploy:"
echo "    ./scripts/deploy-frontend.sh --config-only"
echo ""
echo "  Monthly cost: ~\$4/mo (${SIZE})"
echo ""
