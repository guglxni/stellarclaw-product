#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# LiveClaw — Backend Droplet Deployment
#
# Provisions (or updates) the API droplet on DigitalOcean:
#   api.liveclaw.xyz → Node.js + Express + Bifrost + picobot + PostgreSQL
#
# Usage:
#   chmod +x scripts/deploy-backend.sh
#   ./scripts/deploy-backend.sh                 # full provision + deploy
#   ./scripts/deploy-backend.sh --code-only      # rsync + restart PM2 only
#
# Cost: s-2vcpu-8gb-160gb-intel = $48/mo  (~3.2 months on $200 credit)
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
API_DOMAIN="api.liveclaw.xyz"
ADMIN_EMAIL="admin@liveclaw.xyz"
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)/backend"
DROPLET_NAME="liveclaw-prod"
REGION="nyc3"
SIZE="s-2vcpu-8gb-160gb-intel"
IMAGE="ubuntu-24-04-x64"
SSH_KEY_NAME="liveclaw-deploy-key"
REMOTE_BASE="/opt/liveclaw"
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10"
CODE_ONLY=false

# Parse flags
for arg in "$@"; do
    case "$arg" in
        --code-only) CODE_ONLY=true ;;
    esac
done

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }

# ─── Preflight ───────────────────────────────────────────────────────────────
info "Preflight checks..."

for cmd in doctl rsync ssh; do
    command -v "$cmd" &>/dev/null || { error "$cmd not found. Install it first."; exit 1; }
done

doctl account get &>/dev/null || { error "doctl not authenticated. Run: doctl auth init"; exit 1; }

if [ ! -d "$BACKEND_DIR" ]; then
    error "Backend directory not found: $BACKEND_DIR"
    exit 1
fi

# ─── SSH Key ─────────────────────────────────────────────────────────────────
info "Looking up SSH key '${SSH_KEY_NAME}'..."
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | grep "$SSH_KEY_NAME" | awk '{print $1}')

if [ -z "$SSH_KEY_ID" ]; then
    error "SSH key '${SSH_KEY_NAME}' not found."
    echo "  Add it:  doctl compute ssh-key import ${SSH_KEY_NAME} --public-key-file ~/.ssh/id_ed25519.pub"
    exit 1
fi

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
        --tag-name "liveclaw,backend" \
        --wait
    info "Waiting 30s for SSH bootstrapping..."
    sleep 30
else
    warn "Droplet '${DROPLET_NAME}' exists. Reusing."
fi

DROPLET_IP=$(doctl compute droplet get "$DROPLET_NAME" --format PublicIPv4 --no-header)
info "Backend IP: ${DROPLET_IP}"

# Wait for SSH
attempt=0
while ! ssh $SSH_OPTS root@"$DROPLET_IP" "echo ok" &>/dev/null; do
    attempt=$((attempt + 1))
    [ $attempt -gt 12 ] && { error "SSH unreachable after 2 min."; exit 1; }
    echo "  Waiting for SSH... (${attempt}/12)"
    sleep 10
done
info "SSH ready."

# ─── Server Provision (skip with --code-only) ────────────────────────────────
if [ "$CODE_ONLY" = false ]; then
    info "Provisioning server packages..."
    ssh $SSH_OPTS root@"$DROPLET_IP" << 'PROVISION_EOF'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -qq && apt-get upgrade -y -qq

# Node.js 22 LTS
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
fi
echo "  Node.js $(node -v)"

# Nginx, Certbot, Docker, UFW
apt-get install -y -qq nginx certbot python3-certbot-nginx ufw wget docker.io

# PM2
npm install -g pm2 --loglevel warn

# Firewall
ufw --force enable
ufw allow ssh
ufw allow 'Nginx Full'

# Docker
systemctl enable --now docker

# Bifrost AI Gateway
if ! docker ps --format '{{.Names}}' | grep -q bifrost-gateway; then
    docker stop portkey-gateway 2>/dev/null || true
    docker rm portkey-gateway 2>/dev/null || true
    docker pull maximhq/bifrost:latest
    docker run -d \
        --name bifrost-gateway \
        --restart unless-stopped \
        -p 127.0.0.1:8080:8080 \
        -v /opt/liveclaw/bifrost-data:/app/data \
        maximhq/bifrost:latest
    echo "  Bifrost running on localhost:8080"
else
    echo "  Bifrost already running — pulling latest"
    docker pull maximhq/bifrost:latest 2>/dev/null || true
fi

# Directories
mkdir -p /opt/liveclaw/{backend,bots,bifrost-data,scripts}

# picobot binary (always update to latest)
cd /opt/liveclaw/backend
CURRENT_VER=""
if [ -f ".picobot-version" ]; then
    CURRENT_VER=$(cat .picobot-version 2>/dev/null || echo "")
fi
LATEST_VER=$(curl -sf https://api.github.com/repos/louisho5/picobot/releases/latest | grep -o '"tag_name":\s*"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

if [ -n "$LATEST_VER" ] && [ "$CURRENT_VER" != "$LATEST_VER" ]; then
    echo "  Updating picobot: ${CURRENT_VER:-none} → ${LATEST_VER}"
    curl -fSL --retry 3 -o picobot.tmp \
        "https://github.com/louisho5/picobot/releases/download/${LATEST_VER}/picobot_linux_amd64" 2>/dev/null
    if [ -s picobot.tmp ]; then
        mv picobot.tmp picobot
        chmod +x picobot
        echo "$LATEST_VER" > .picobot-version
        echo "  picobot ${LATEST_VER}: $(ls -lh picobot | awk '{print $5}')"
    else
        rm -f picobot.tmp
        echo "  ⚠️ Download failed — keeping existing binary"
    fi
elif [ ! -f picobot ]; then
    echo "  Downloading picobot (first install)..."
    curl -fSL --retry 3 -o picobot \
        "https://github.com/louisho5/picobot/releases/latest/download/picobot_linux_amd64" 2>/dev/null || touch picobot
    chmod +x picobot
    [ -n "$LATEST_VER" ] && echo "$LATEST_VER" > .picobot-version
    echo "  picobot: $(ls -lh picobot | awk '{print $5}')"
else
    echo "  picobot up-to-date: ${CURRENT_VER}"
fi
PROVISION_EOF
fi

# ─── Upload Backend Code ─────────────────────────────────────────────────────
info "Uploading backend..."
rsync -az --delete \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude 'liveclaw.db' \
    --exclude 'picobot' \
    --exclude 'tests' \
    "$BACKEND_DIR/" root@"$DROPLET_IP":${REMOTE_BASE}/backend/

# Upload utility scripts
info "Uploading scripts..."
rsync -az "$(dirname "$0")/" root@"$DROPLET_IP":${REMOTE_BASE}/scripts/

# ─── Install & Start ─────────────────────────────────────────────────────────
info "Installing deps & starting PM2..."
ssh $SSH_OPTS root@"$DROPLET_IP" << 'START_EOF'
set -euo pipefail
cd /opt/liveclaw/backend

npm install --omit=dev --loglevel warn

# Create .env from example if missing
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
    fi
    echo "  ⚠️  .env created from template — fill in CHANGE_ME values!"
fi

# PM2
if pm2 describe liveclaw-orchestrator &>/dev/null; then
    pm2 reload liveclaw-orchestrator
    echo "  PM2: reloaded"
else
    pm2 start server.js \
        --name "liveclaw-orchestrator" \
        --max-memory-restart 512M \
        --merge-logs \
        --log-date-format "YYYY-MM-DD HH:mm:ss Z"
    echo "  PM2: started"
fi

pm2 save
pm2 startup 2>/dev/null | tail -n 1 | bash 2>/dev/null || true
START_EOF

# ─── Nginx (skip with --code-only) ───────────────────────────────────────────
if [ "$CODE_ONLY" = false ]; then
    info "Configuring Nginx (reverse proxy)..."

    ssh $SSH_OPTS root@"$DROPLET_IP" << NGINX_EOF
cat > /etc/nginx/sites-available/liveclaw-api << 'CONF'
# LiveClaw API — Nginx reverse proxy to Node.js
# Auto-generated by deploy-backend.sh
server_tokens off;

# Rate-limit zone: 10 req/s per IP, 10 MB zone
limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=10r/s;

server {
    listen 80;
    server_name ${API_DOMAIN};

    # No static file serving — all traffic proxied to Node.js

    location / {
        limit_req zone=api_limit burst=20 nodelay;

        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Headers for correct IP detection (trust proxy)
        proxy_set_header Host              \\\$host;
        proxy_set_header X-Real-IP         \\\$remote_addr;
        proxy_set_header X-Forwarded-For   \\\$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \\\$scheme;
        proxy_set_header X-Request-Id      \\\$request_id;

        # Timeouts
        proxy_read_timeout    30s;
        proxy_connect_timeout 10s;
        proxy_send_timeout    30s;

        # Disable buffering for SSE/streaming
        proxy_buffering off;
    }

    # Health check — bypass rate limit
    location = /health {
        proxy_pass http://127.0.0.1:3000/health;
        proxy_set_header Host \\\$host;
        access_log off;
    }
}
CONF

ln -sf /etc/nginx/sites-available/liveclaw-api /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx
echo "  Nginx: configured"
NGINX_EOF

    # SSL
    info "Provisioning SSL..."
    ssh $SSH_OPTS root@"$DROPLET_IP" << SSL_EOF
set -euo pipefail
if certbot --nginx \
    -d ${API_DOMAIN} \
    -m ${ADMIN_EMAIL} \
    --agree-tos \
    --non-interactive \
    --redirect \
    --staple-ocsp 2>/dev/null; then
    echo "  ✅ SSL issued for ${API_DOMAIN}"
else
    echo "  ⚠️  Certbot failed — DNS not pointed yet?"
    echo "  Run later: certbot --nginx -d ${API_DOMAIN} -m ${ADMIN_EMAIL} --agree-tos"
fi

# Auto-renewal cron
if ! crontab -l 2>/dev/null | grep -q certbot; then
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --deploy-hook 'systemctl reload nginx'") | crontab -
    echo "  Auto-renewal cron set"
fi
SSL_EOF
fi

# ─── Webhook ─────────────────────────────────────────────────────────────────
info "Setting Telegram webhook..."
ssh $SSH_OPTS root@"$DROPLET_IP" << 'WEBHOOK_EOF'
cd /opt/liveclaw
if [ -f backend/.env ] && grep -q "TELEGRAM_MASTER_BOT_TOKEN" backend/.env; then
    node scripts/set-webhook.js 2>&1 || echo "  ⚠️  Webhook deferred — check bot token"
else
    echo "  ⚠️  Skipped webhook — add TELEGRAM_MASTER_BOT_TOKEN to backend/.env first"
fi
WEBHOOK_EOF

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
info "═══════════════════════════════════════════════════"
info "  Backend deployment complete!"
info "═══════════════════════════════════════════════════"
echo ""
echo "  Droplet:  ${DROPLET_NAME}  (${DROPLET_IP})"
echo "  Domain:   https://${API_DOMAIN}"
echo "  SSH:      ssh root@${DROPLET_IP}"
echo "  PM2:      ssh root@${DROPLET_IP} 'pm2 status'"
echo "  Logs:     ssh root@${DROPLET_IP} 'pm2 logs liveclaw-orchestrator'"
echo ""
echo "  Post-deploy checklist:"
echo "  1. DNS A record: ${API_DOMAIN} → ${DROPLET_IP}"
echo "  2. Edit .env:    ssh root@${DROPLET_IP} 'nano /opt/liveclaw/backend/.env'"
echo "  3. Restart:      ssh root@${DROPLET_IP} 'pm2 restart liveclaw-orchestrator'"
echo "  4. SSL:          ssh root@${DROPLET_IP} 'certbot --nginx -d ${API_DOMAIN}'"
echo ""
echo "  Monthly cost: ~\$12/mo (${SIZE})"
echo ""
