#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# LiveClaw — Production Deployment Script
#
# Provisions a DigitalOcean droplet, sets up the Node.js orchestrator,
# downloads the picobot binary, and configures Nginx with SSL.
#
# Optimized for $200 startup credits:
#   s-2vcpu-8gb-160gb-intel = $48/mo → ~3.2 months on $200 credit
#   Each picobot process uses ~10-20MB idle → 200 concurrent bots/instance (8 GB RAM)
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
DOMAIN="liveclaw.xyz"
ADMIN_EMAIL="admin@${DOMAIN}"
FRONTEND_DIR="./liveclaw-web/www"
BACKEND_DIR="./backend"
DROPLET_NAME="liveclaw-prod"
REGION="nyc3"
SIZE="s-2vcpu-8gb-160gb-intel"
IMAGE="ubuntu-24-04-x64"
SSH_KEY_NAME="liveclaw-deploy-key"
REMOTE_BASE="/opt/liveclaw"

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*" >&2; }

# ─── Preflight Checks ───────────────────────────────────────────────────────
info "Running preflight checks..."

for cmd in doctl rsync ssh; do
    if ! command -v "$cmd" &>/dev/null; then
        error "$cmd is required but not found. Please install it."
        exit 1
    fi
done

# Verify doctl is authenticated
if ! doctl account get &>/dev/null; then
    error "doctl is not authenticated. Run: doctl auth init"
    exit 1
fi

# ─── SSH Key ─────────────────────────────────────────────────────────────────
info "Looking up SSH key '${SSH_KEY_NAME}'..."
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | grep "$SSH_KEY_NAME" | awk '{print $1}')

if [ -z "$SSH_KEY_ID" ]; then
    error "SSH key '${SSH_KEY_NAME}' not found in DigitalOcean."
    echo "  Add your key:  doctl compute ssh-key import ${SSH_KEY_NAME} --public-key-file ~/.ssh/id_ed25519.pub"
    exit 1
fi
info "SSH key found: ID=${SSH_KEY_ID}"

# ─── Droplet Provisioning ───────────────────────────────────────────────────
info "Checking for existing droplet..."
EXISTING=$(doctl compute droplet list --format Name --no-header | grep -x "$DROPLET_NAME" || true)

if [ -z "$EXISTING" ]; then
    info "Creating droplet ${DROPLET_NAME} (${SIZE}, ${REGION})..."
    doctl compute droplet create "$DROPLET_NAME" \
        --size "$SIZE" \
        --image "$IMAGE" \
        --region "$REGION" \
        --ssh-keys "$SSH_KEY_ID" \
        --tag-name "liveclaw" \
        --wait
    info "Droplet created. Waiting 30s for SSH to come up..."
    sleep 30
else
    warn "Droplet '${DROPLET_NAME}' already exists. Skipping creation."
fi

DROPLET_IP=$(doctl compute droplet get "$DROPLET_NAME" --format PublicIPv4 --no-header)
info "Droplet IP: ${DROPLET_IP}"

# Wait for SSH availability
SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ~/.ssh/liveclaw_deploy"

attempt=0
while ! ssh $SSH_OPTS root@"$DROPLET_IP" "echo ok" &>/dev/null; do
    attempt=$((attempt + 1))
    if [ $attempt -gt 12 ]; then
        error "SSH not available after 2 minutes. Check the droplet console."
        exit 1
    fi
    echo "  Waiting for SSH... (attempt $attempt/12)"
    sleep 10
done
info "SSH is ready."

# ─── Server Setup ────────────────────────────────────────────────────────────
info "Configuring server packages..."

ssh $SSH_OPTS root@"$DROPLET_IP" << 'SETUP_EOF'
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

# System update
apt-get update -qq
apt-get upgrade -y -qq

# Node.js 22 LTS
if ! command -v node &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
fi
echo "  Node.js: $(node -v)"

# Nginx, Certbot, Docker, UFW
apt-get install -y -qq nginx certbot python3-certbot-nginx ufw wget docker.io

# Nginx rate-limit zone for admin login (must live in http context)
cat > /etc/nginx/conf.d/rate-limits.conf << 'RATEEOF'
# Admin login brute-force protection: burst of 7 requests, then 1/min per IP
# (Node.js enforces the 7-per-15-min hard window; Nginx adds a network layer)
limit_req_zone $binary_remote_addr zone=admin_login:10m rate=1r/m;
RATEEOF

# PM2 (process manager)
npm install -g pm2 --loglevel warn

# Firewall
ufw --force enable
ufw allow ssh
ufw allow 'Nginx Full'

# ── Bifrost AI Gateway + Observability Stack (Docker Compose) ─────────────
# Bifrost: high-performance Go AI gateway with native Virtual Key management
# Observability: OTel Collector → Grafana Tempo (traces) + Prometheus (metrics) + Grafana (dashboards)
# Docs: https://github.com/maximhq/bifrost
systemctl enable --now docker

# Install docker compose v2 plugin if not present
if ! docker compose version &>/dev/null; then
    DOCKER_CONFIG=${DOCKER_CONFIG:-/usr/local/lib/docker}
    mkdir -p "$DOCKER_CONFIG/cli-plugins"
    COMPOSE_VERSION=$(curl -sf https://api.github.com/repos/docker/compose/releases/latest | grep -o '"tag_name":\s*"[^"]*"' | head -1 | cut -d'"' -f4)
    COMPOSE_VERSION=${COMPOSE_VERSION:-v2.32.4}
    curl -fSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" -o "$DOCKER_CONFIG/cli-plugins/docker-compose"
    chmod +x "$DOCKER_CONFIG/cli-plugins/docker-compose"
    echo "  Installed docker compose ${COMPOSE_VERSION}"
fi

# Stop legacy standalone Bifrost container (migrated to compose)
docker stop portkey-gateway 2>/dev/null || true
docker rm portkey-gateway 2>/dev/null || true
if docker ps -a --format '{{.Names}}' | grep -q '^bifrost-gateway$'; then
    if ! docker inspect bifrost-gateway --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null | grep -q .; then
        echo "  Migrating standalone Bifrost container to compose stack..."
        docker stop bifrost-gateway 2>/dev/null || true
        docker rm bifrost-gateway 2>/dev/null || true
    fi
fi

# ── Step 1: Start Bifrost (critical path) ─────────────────────────────────
cd /opt/liveclaw
export BIFROST_DATA_DIR=/opt/liveclaw/bifrost-data
export GF_ADMIN_PASSWORD="${GF_ADMIN_PASSWORD:-liveclaw-obs-2024}"

# Bifrost runs as UID 1000 — ensure data dir is writable
chown -R 1000:1000 /opt/liveclaw/bifrost-data 2>/dev/null || true
docker compose -f docker-compose.bifrost.yml pull
docker compose -f docker-compose.bifrost.yml up -d --remove-orphans

# Hard gate: wait for Bifrost healthy
echo "  Waiting for Bifrost health..."
for i in $(seq 1 12); do
    if curl -sf http://localhost:8080/health > /dev/null 2>&1; then
        info "Bifrost gateway healthy (attempt $i)"
        break
    fi
    if [ "$i" -eq 12 ]; then
        error "Bifrost failed to start within 60 seconds"
        docker compose -f docker-compose.bifrost.yml logs --tail=30
        exit 1
    fi
    sleep 5
done

# ── Step 2: Start observability stack (best-effort) ───────────────────────
docker compose -f docker-compose.observability.yml pull 2>/dev/null || warn "Some observability images failed to pull"
docker compose -f docker-compose.observability.yml up -d 2>/dev/null || warn "Observability stack failed to start"

echo "  Grafana dashboards on localhost:3001 (admin / \$GF_ADMIN_PASSWORD)"
echo "  Prometheus on localhost:9090"
echo "  Tempo on localhost:3200"
cd -

# Directories
mkdir -p /opt/liveclaw/{backend,frontend,scripts,bots,bifrost-data}

# Download/update picobot binary (always fetch latest)
cd /opt/liveclaw/backend
CURRENT_VER=""
if [ -f ".picobot-version" ]; then
    CURRENT_VER=$(cat .picobot-version 2>/dev/null || echo "")
fi
LATEST_VER=$(curl -sf https://api.github.com/repos/louisho5/picobot/releases/latest | grep -o '"tag_name":\s*"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")

verify_picobot_checksum() {
    local binary_path="$1"
    local version="$2"
    local checksum_url="https://github.com/louisho5/picobot/releases/download/${version}/checksums.txt"
    local expected_checksum

    # Attempt to download checksums file
    expected_checksum=$(curl -sfL "$checksum_url" 2>/dev/null | grep "picobot_linux_amd64" | awk '{print $1}')
    if [ -z "$expected_checksum" ]; then
        echo "  ⚠️  No checksum file found for ${version} — skipping verification"
        return 0  # Non-blocking: proceed without checksum if not published
    fi

    local actual_checksum
    actual_checksum=$(sha256sum "$binary_path" | awk '{print $1}')

    if [ "$expected_checksum" = "$actual_checksum" ]; then
        echo "  ✅ SHA256 checksum verified: ${actual_checksum:0:16}..."
        return 0
    else
        echo "  ❌ SHA256 MISMATCH — expected: ${expected_checksum:0:16}..., got: ${actual_checksum:0:16}..."
        echo "  Refusing to install untrusted binary. Keeping existing version."
        return 1
    fi
}

if [ -n "$LATEST_VER" ] && [ "$CURRENT_VER" != "$LATEST_VER" ]; then
    echo "  Updating picobot: ${CURRENT_VER:-none} → ${LATEST_VER}"
    curl -fSL --retry 3 -o picobot.tmp \
        "https://github.com/louisho5/picobot/releases/download/${LATEST_VER}/picobot_linux_amd64" 2>/dev/null
    if [ -s picobot.tmp ]; then
        if verify_picobot_checksum picobot.tmp "$LATEST_VER"; then
            mv picobot.tmp picobot
            chmod +x picobot
            echo "$LATEST_VER" > .picobot-version
            echo "  picobot ${LATEST_VER}: $(ls -lh picobot | awk '{print $5}')"
        else
            rm -f picobot.tmp
        fi
    else
        rm -f picobot.tmp
        echo "  ⚠️  Download failed — keeping existing binary"
    fi
elif [ ! -f picobot ]; then
    echo "  Downloading picobot (first install)..."
    curl -fSL --retry 3 -o picobot.tmp \
        "https://github.com/louisho5/picobot/releases/latest/download/picobot_linux_amd64" 2>/dev/null
    if [ -s picobot.tmp ]; then
        if verify_picobot_checksum picobot.tmp "${LATEST_VER:-unknown}"; then
            mv picobot.tmp picobot
            chmod +x picobot
            [ -n "$LATEST_VER" ] && echo "$LATEST_VER" > .picobot-version
            echo "  picobot ready: $(ls -lh picobot | awk '{print $5}')"
        else
            rm -f picobot.tmp
            echo "  ⚠️  Checksum verification failed — no picobot installed"
        fi
    else
        rm -f picobot.tmp
        echo "  ⚠️  Download failed — no picobot installed"
    fi
else
    echo "  picobot up-to-date: ${CURRENT_VER}"
fi
SETUP_EOF

# ─── Upload Code ─────────────────────────────────────────────────────────────
info "Uploading backend..."
rsync -az --delete -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/liveclaw_deploy" \
    --exclude 'node_modules' \
    --exclude '.env' \
    --exclude 'liveclaw.db' \
    --exclude 'picobot' \
    "$BACKEND_DIR/" root@"$DROPLET_IP":${REMOTE_BASE}/backend/

info "Uploading observability stack..."
rsync -az -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/liveclaw_deploy" \
    ./docker-compose.observability.yml root@"$DROPLET_IP":${REMOTE_BASE}/
rsync -az --delete -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/liveclaw_deploy" \
    ./observability/ root@"$DROPLET_IP":${REMOTE_BASE}/observability/

if [ -d "$FRONTEND_DIR" ]; then
    info "Uploading frontend..."
    rsync -az --delete -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/liveclaw_deploy" "$FRONTEND_DIR/" root@"$DROPLET_IP":${REMOTE_BASE}/frontend/
else
    warn "Frontend dir '${FRONTEND_DIR}' not found. Skipping."
fi

# ─── Start Backend ───────────────────────────────────────────────────────────
info "Installing dependencies & starting orchestrator..."

ssh $SSH_OPTS root@"$DROPLET_IP" << 'START_EOF'
set -euo pipefail
cd /opt/liveclaw/backend

# Install production dependencies only
npm install --omit=dev --loglevel warn

# Create .env if it doesn't exist
if [ ! -f ".env" ]; then
    cp .env.example .env 2>/dev/null || cat > .env << 'ENVEOF'
PORT=3000
NODE_ENV=production
DOMAIN_NAME=https://liveclaw.xyz
ALLOWED_ORIGINS=https://liveclaw.xyz,https://www.liveclaw.xyz
BIFROST_GATEWAY_URL=http://localhost:8080
PICOBOT_PATH=/opt/liveclaw/backend/picobot
DB_PATH=/opt/liveclaw/backend/liveclaw.db
BOTS_DIR=/opt/liveclaw/bots
MAX_CONCURRENT_BOTS=200
TURNSTILE_SECRET_KEY=your_turnstile_secret
DODO_API_KEY=your_dodo_api_key
DODO_WEBHOOK_SECRET=your_dodo_webhook_secret
DODO_PRODUCT_ID=your_dodo_product_id
OPENROUTER_API_KEY=your_openrouter_api_key
# TELEGRAM_MASTER_BOT_TOKEN=  # optional
DATABASE_URL=postgresql://...  # required in production (managed PostgreSQL)
MCP_SERVERS_CONFIG=
ENVEOF
    echo "  ⚠️  Created .env with placeholders — edit with real keys!"
fi

# Start/restart via PM2
if pm2 describe liveclaw-orchestrator &>/dev/null; then
    pm2 reload liveclaw-orchestrator
    echo "  PM2: reloaded"
else
    pm2 start server.js --name "liveclaw-orchestrator" --max-memory-restart 512M
    echo "  PM2: started"
fi

pm2 save
pm2 startup 2>/dev/null | tail -n 1 | bash 2>/dev/null || true
START_EOF

# ─── Nginx Configuration ────────────────────────────────────────────────────
info "Configuring Nginx reverse proxy..."

ssh $SSH_OPTS root@"$DROPLET_IP" << NGINX_EOF
cat > /etc/nginx/sites-available/liveclaw << 'CONF'
# LiveClaw — Nginx reverse proxy
# Auto-generated by deploy.sh

# Security: hide server version
server_tokens off;

server {
    listen 80;
    server_name ${DOMAIN} www.${DOMAIN};

    # Frontend (static files)
    root /opt/liveclaw/frontend;
    index index.html;

    # Gzip
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml;
    gzip_min_length 256;

    # Next.js static chunks — very long-lived cache
    location /_next/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    # Binary static assets
    location ~* \.(png|jpg|jpeg|gif|ico|svg|woff2?|mp4|webp)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    # Admin panel SPA
    location /admin {
        try_files \$uri \$uri/ /admin/index.html;
    }

    # /api/* — strip prefix and proxy to Node.js (used by admin dashboard)
    # e.g. /api/admin/login -> localhost:3000/admin/login
    location = /api/admin/login {
        limit_req zone=admin_login burst=7 nodelay;
        proxy_pass http://127.0.0.1:3000/admin/login;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Request-Id \$request_id;
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
    }

    # Admin login direct (kept for internal tooling)
    location = /admin/login {
        limit_req zone=admin_login burst=7 nodelay;
        proxy_pass http://127.0.0.1:3000/admin/login;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }

    # Webhooks → Node.js (must come before location /)
    location /webhook/ {
        proxy_pass http://127.0.0.1:3000/webhook/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    # Root: try static files first, then fall through to Node.js backend.
    # This routes all API calls (/health, /pricing, /redeem-beta, etc.) to
    # the Node.js orchestrator without needing an /api/ prefix.
    location / {
        try_files \$uri \$uri/ @backend;
    }

    location @backend {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Request-Id \$request_id;
        proxy_read_timeout 30s;
        proxy_connect_timeout 10s;
    }
}
CONF

ln -sf /etc/nginx/sites-available/liveclaw /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

# Test config before restarting
nginx -t && systemctl restart nginx
echo "  Nginx: configured and running"
NGINX_EOF

# ─── SSL Certificate (Certbot + Let's Encrypt) ──────────────────────────────
info "Provisioning SSL certificate..."

ssh $SSH_OPTS root@"$DROPLET_IP" << SSL_EOF
set -euo pipefail

# Ensure certbot and nginx plugin are installed
apt-get install -y -qq certbot python3-certbot-nginx

# Attempt automatic SSL provisioning
# This will modify the Nginx config to listen on 443 and redirect 80 → 443
if certbot --nginx \
    -d ${DOMAIN} \
    -d www.${DOMAIN} \
    -m ${ADMIN_EMAIL} \
    --agree-tos \
    --non-interactive \
    --redirect \
    --staple-ocsp 2>/dev/null; then
    echo "  ✅ SSL certificate issued and Nginx configured for HTTPS"
else
    echo "  ⚠️  Certbot failed — DNS may not be pointed yet."
    echo "  Run manually after DNS propagates:"
    echo "    certbot --nginx -d ${DOMAIN} -d www.${DOMAIN} -m ${ADMIN_EMAIL} --agree-tos"
fi

# Set up auto-renewal cron (certbot installs a systemd timer by default on Ubuntu 24,
# but we add a cron as a safety net)
if ! crontab -l 2>/dev/null | grep -q certbot; then
    (crontab -l 2>/dev/null; echo "0 3 * * * certbot renew --quiet --deploy-hook 'systemctl reload nginx'") | crontab -
    echo "  Auto-renewal cron configured (3 AM daily)"
fi
SSL_EOF

# ─── Upload & Run Webhook Setup Script ───────────────────────────────────────
info "Uploading utility scripts..."
rsync -az -e "ssh -o StrictHostKeyChecking=no -i ~/.ssh/liveclaw_deploy" ./scripts/ root@"$DROPLET_IP":${REMOTE_BASE}/scripts/

info "Setting Telegram webhook..."
ssh $SSH_OPTS root@"$DROPLET_IP" << 'WEBHOOK_EOF'
cd /opt/liveclaw
if [ -f .env ] && grep -q "TELEGRAM_MASTER_BOT_TOKEN" .env; then
    node scripts/set-webhook.js 2>&1 || echo "  ⚠️  Webhook setup deferred — add TELEGRAM_MASTER_BOT_TOKEN to .env first"
else
    echo "  ⚠️  Skipped webhook setup — TELEGRAM_MASTER_BOT_TOKEN not in .env"
    echo "  Run manually: cd /opt/liveclaw && node scripts/set-webhook.js"
fi
WEBHOOK_EOF

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
info "═══════════════════════════════════════════════════"
info "  🚀 Deployment complete!"
info "═══════════════════════════════════════════════════"
echo ""
echo "  Server:   ${DROPLET_IP}"
echo "  Domain:   https://${DOMAIN}"
echo "  SSH:      ssh root@${DROPLET_IP}"
echo ""
echo "  Post-deploy checklist:"
echo "  1. Point ${DOMAIN} A record → ${DROPLET_IP}"
echo "  2. Edit .env:  ssh root@${DROPLET_IP} 'nano /opt/liveclaw/backend/.env'"
echo "  3. Restart:    ssh root@${DROPLET_IP} 'pm2 restart liveclaw-orchestrator'"
echo "  4. SSL (if skipped): ssh root@${DROPLET_IP} 'certbot --nginx -d ${DOMAIN} -d www.${DOMAIN}'"
echo "  5. Webhook:    ssh root@${DROPLET_IP} 'cd /opt/liveclaw && node scripts/set-webhook.js'"
echo "  6. Grafana:    ssh -L 3001:localhost:3001 root@${DROPLET_IP}  →  http://localhost:3001"
echo ""
echo "  Monthly cost: ~\$12/mo (s-2vcpu-2gb)"
echo "  Runway at \$200 credit: ~16 months"
echo ""
