#!/bin/bash
# nginx-watchdog.sh — LiveClaw server-side Nginx health watchdog
# ─────────────────────────────────────────────────────────────────────────────
# Deployed to /opt/liveclaw/scripts/ on both backend and frontend droplets.
# Installed as a cron job: */2 * * * * /opt/liveclaw/scripts/nginx-watchdog.sh
#
# Three layers of Nginx resilience:
#   1. systemd Restart=always  — restarts within seconds of any crash
#   2. This watchdog cron      — catches cases systemd misses (e.g. hung process)
#   3. Deploy script           — always starts nginx if found inactive on deploy
#
# Logs to syslog (readable via: journalctl -t liveclaw-watchdog)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

LOGTAG="liveclaw-watchdog"

is_nginx_healthy() {
  systemctl is-active --quiet nginx && \
  curl -sf --max-time 5 http://localhost/ -o /dev/null 2>/dev/null
}

if is_nginx_healthy; then
  exit 0  # all good, exit silently
fi

# Nginx is either inactive or not responding — attempt recovery
logger -t "$LOGTAG" "WARN: nginx unhealthy — systemctl status: $(systemctl is-active nginx 2>/dev/null || echo 'unknown')"

# Validate config before starting (avoid starting with a broken config)
if ! nginx -t 2>/dev/null; then
  logger -t "$LOGTAG" "ERROR: nginx config test failed — aborting restart (manual intervention required)"
  exit 1
fi

systemctl start nginx 2>/dev/null || systemctl restart nginx 2>/dev/null || true
sleep 5

if is_nginx_healthy; then
  logger -t "$LOGTAG" "OK: nginx recovered successfully"
  exit 0
fi

logger -t "$LOGTAG" "ERROR: nginx failed to recover — run: systemctl status nginx && journalctl -u nginx -n 50"
exit 1
