#!/usr/bin/env bash
# =============================================================================
# LiveClaw — GTM Container Setup
# =============================================================================
#
# Provisions a complete Google Tag Manager container for LiveClaw:
#   • Triggers  — one per tracked event (pricing, checkout, deploy, promo)
#   • Variables — Data Layer Variables for event properties
#   • Constants — placeholder IDs for Meta Pixel and GA4
#   • Tags      — Meta Pixel + GA4 tags (paused until you fill in the IDs)
#   • Version   — publishes a named version when done
#
# USAGE
#   1. Authenticate once:   gtm auth login
#   2. Run this script:     bash scripts/setup-gtm.sh
#   3. Fill in the ID placeholders in your GTM workspace when you're ready
#      to run ads (Meta Pixel ID, GA4 Measurement ID).
#
# REQUIREMENTS
#   gtm CLI  — https://github.com/owntag/gtm-cli   (already installed)
#   jq       — brew install jq
# =============================================================================

set -euo pipefail

GTM=${GTM_BIN:-gtm}
JQ=${JQ_BIN:-jq}

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log()  { echo -e "${CYAN}▶${RESET} $*"; }
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
die()  { echo -e "${RED}✗ ERROR:${RESET} $*" >&2; exit 1; }
hr()   { echo -e "\n${BOLD}──────────────────────────────────────────────────────${RESET}"; }

# GTM CLI prints a status line (e.g. "✓ Variable created: 5") on stdout
# before the JSON. This helper strips everything before the first "{" or "[".
strip_status() { sed -n '/^[{\[]/,$p'; }

# Retry wrapper — Google Tag Manager API sometimes returns 502s
retry() {
    local attempts=3 delay=5 i
    for ((i=1; i<=attempts; i++)); do
        if "$@" 2>/tmp/gtm_retry_err; then
            return 0
        fi
        local err
        err=$(cat /tmp/gtm_retry_err 2>/dev/null || true)
        if echo "$err" | grep -q "502\|503\|temporarily\|Server Error"; then
            echo -e "${CYAN}  ↻ API hiccup (attempt ${i}/${attempts}) — retrying in ${delay}s...${RESET}" >&2
            sleep "$delay"
            delay=$((delay * 2))
        else
            cat /tmp/gtm_retry_err >&2
            return 1
        fi
    done
    cat /tmp/gtm_retry_err >&2
    return 1
}

# ── Dependency check ──────────────────────────────────────────────────────────
command -v "$GTM" >/dev/null 2>&1 || die "gtm CLI not found. Install: curl -fsSL https://raw.githubusercontent.com/owntag/gtm-cli/main/install.sh | bash"
command -v "$JQ"  >/dev/null 2>&1 || die "jq not found. Install: brew install jq"

# ── Auth check ────────────────────────────────────────────────────────────────
hr; log "Checking GTM authentication..."
if ! $GTM auth status >/dev/null 2>&1; then
    echo ""
    echo "  Not authenticated. Run: gtm auth login"
    echo "  Then re-run this script."
    exit 1
fi
ok "Authenticated"

# ── Account + Container selection ────────────────────────────────────────────
hr; log "Fetching GTM accounts..."
ACCOUNTS_JSON=$($GTM accounts list -o json | strip_status)
ACCOUNT_COUNT=$(echo "$ACCOUNTS_JSON" | $JQ 'length')

if [[ "$ACCOUNT_COUNT" -eq 0 ]]; then
    die "No GTM accounts found. Create one at https://tagmanager.google.com"
fi

if [[ "$ACCOUNT_COUNT" -eq 1 ]]; then
    ACCOUNT_ID=$(echo "$ACCOUNTS_JSON" | $JQ -r '.[0].accountId')
    ACCOUNT_NAME=$(echo "$ACCOUNTS_JSON" | $JQ -r '.[0].name')
    ok "Using account: ${ACCOUNT_NAME} (${ACCOUNT_ID})"
else
    echo ""; echo "Available accounts:"
    echo "$ACCOUNTS_JSON" | $JQ -r '.[] | "  \(.accountId)  \(.name)"'
    echo ""
    read -r -p "Enter Account ID to use: " ACCOUNT_ID
fi

# Check for existing LiveClaw container
log "Fetching containers for account ${ACCOUNT_ID}..."
CONTAINERS_JSON=$($GTM containers list --account-id "$ACCOUNT_ID" -o json | strip_status)
EXISTING=$(echo "$CONTAINERS_JSON" | $JQ -r '.[] | select(.name | test("liveclaw"; "i")) | .containerId' | head -1)

if [[ -n "$EXISTING" ]]; then
    CONTAINER_ID="$EXISTING"
    CONTAINER_NAME=$(echo "$CONTAINERS_JSON" | $JQ -r --arg id "$CONTAINER_ID" '.[] | select(.containerId == $id) | .name')
    ok "Found existing container: ${CONTAINER_NAME} (${CONTAINER_ID})"
else
    log "Creating new GTM container 'LiveClaw'..."
    NEW_CONTAINER=$($GTM containers create \
        --account-id "$ACCOUNT_ID" \
        --name "LiveClaw" \
        --type web \
        -o json | strip_status)
    CONTAINER_ID=$(echo "$NEW_CONTAINER" | $JQ -r '.containerId')
    ok "Created container: LiveClaw (${CONTAINER_ID})"
fi

# ── Workspace ─────────────────────────────────────────────────────────────────
log "Setting up workspace..."
WORKSPACES_JSON=$($GTM workspaces list --account-id "$ACCOUNT_ID" --container-id "$CONTAINER_ID" -o json | strip_status)
WORKSPACE_ID=$(echo "$WORKSPACES_JSON" | $JQ -r '.[0].workspaceId')
ok "Using workspace ID: ${WORKSPACE_ID}"

# Set defaults so we don't repeat IDs on every command
$GTM config set defaultAccountId   "$ACCOUNT_ID"
$GTM config set defaultContainerId "$CONTAINER_ID"
$GTM config set defaultWorkspaceId "$WORKSPACE_ID"
ok "Defaults saved to gtm config"

# ── Helper: create variable ───────────────────────────────────────────────────
create_dlv() {
    local name="$1" key="$2"
    retry $GTM variables create \
        --name "$name" \
        --type v \
        --config "{\"parameter\":[{\"type\":\"INTEGER\",\"key\":\"dataLayerVersion\",\"value\":\"2\"},{\"type\":\"BOOLEAN\",\"key\":\"setDefaultValue\",\"value\":\"false\"},{\"type\":\"TEMPLATE\",\"key\":\"name\",\"value\":\"$key\"}]}" \
        -o json | strip_status | $JQ -r '.variableId'
}

create_const() {
    local name="$1" value="$2"
    retry $GTM variables create \
        --name "$name" \
        --type c \
        --config "{\"parameter\":[{\"type\":\"TEMPLATE\",\"key\":\"value\",\"value\":\"$value\"}]}" \
        -o json | strip_status | $JQ -r '.variableId'
}

# ── Helper: create custom event trigger ───────────────────────────────────────
create_ce_trigger() {
    local name="$1" event_name="$2"
    retry $GTM triggers create \
        --name "$name" \
        --type CUSTOM_EVENT \
        --config "{\"customEventFilter\":[{\"type\":\"EQUALS\",\"parameter\":[{\"type\":\"TEMPLATE\",\"key\":\"arg0\",\"value\":\"{{_event}}\"},{\"type\":\"TEMPLATE\",\"key\":\"arg1\",\"value\":\"$event_name\"}]}]}" \
        -o json | strip_status | $JQ -r '.triggerId'
}

# ─────────────────────────────────────────────────────────────────────────────
hr; log "Creating Data Layer Variables..."
# ─────────────────────────────────────────────────────────────────────────────

DLV_TYPE=$(create_dlv "DLV - type"       "type");       ok "DLV - type             (${DLV_TYPE})"
DLV_EARLYCLAW=$(create_dlv "DLV - earlyClaw"  "earlyClaw");  ok "DLV - earlyClaw        (${DLV_EARLYCLAW})"
DLV_MODEL=$(create_dlv "DLV - model"      "model");      ok "DLV - model            (${DLV_MODEL})"
DLV_SAVINGS=$(create_dlv "DLV - savings"    "savings");    ok "DLV - savings          (${DLV_SAVINGS})"

# ─────────────────────────────────────────────────────────────────────────────
hr; log "Creating Constant Variables (pixel ID placeholders)..."
# ─────────────────────────────────────────────────────────────────────────────

CONST_META=$(create_const "Meta Pixel ID"        "FILL_IN_META_PIXEL_ID")
ok "Meta Pixel ID constant     (${CONST_META})"
CONST_GA4=$(create_const "GA4 Measurement ID"   "FILL_IN_GA4_MEASUREMENT_ID")
ok "GA4 Measurement ID constant (${CONST_GA4})"

# ─────────────────────────────────────────────────────────────────────────────
hr; log "Creating Triggers..."
# ─────────────────────────────────────────────────────────────────────────────

# All Pages trigger
TRIG_ALL_PAGES=$(retry $GTM triggers create \
    --name "All Pages" \
    --type PAGEVIEW \
    -o json | strip_status | $JQ -r '.triggerId')
ok "All Pages trigger                (${TRIG_ALL_PAGES})"

TRIG_PRICING=$(create_ce_trigger   "CE - pricing_modal_opened"  "pricing_modal_opened");  ok "CE - pricing_modal_opened     (${TRIG_PRICING})"
TRIG_CHECKOUT=$(create_ce_trigger  "CE - checkout_started"      "checkout_started");       ok "CE - checkout_started         (${TRIG_CHECKOUT})"
TRIG_PROMO=$(create_ce_trigger     "CE - promo_applied"          "promo_applied");          ok "CE - promo_applied            (${TRIG_PROMO})"
TRIG_COMPLETED=$(create_ce_trigger "CE - checkout_completed"    "checkout_completed");     ok "CE - checkout_completed       (${TRIG_COMPLETED})"
TRIG_DEPLOY=$(create_ce_trigger    "CE - bot_deployed"           "bot_deployed");           ok "CE - bot_deployed             (${TRIG_DEPLOY})"

# Combine all conversion triggers
ALL_CONVERSION_TRIGGERS="${TRIG_CHECKOUT},${TRIG_COMPLETED},${TRIG_DEPLOY}"

# ─────────────────────────────────────────────────────────────────────────────
hr; log "Creating Tags (paused until you fill in the IDs)..."
# ─────────────────────────────────────────────────────────────────────────────

# Helper to create a tag with retry
create_tag() {
    local label="$1"; shift
    local output
    output=$(retry "$@" 2>&1) || { echo "$output" >&2; return 1; }
    local tag_id
    tag_id=$(echo "$output" | strip_status | $JQ -r '.tagId')
    ok "${label} (${tag_id})"
}

# Meta Pixel — Base (PageView)
META_PV_CONFIG='{"parameter":[{"type":"TEMPLATE","key":"html","value":"<!-- Meta Pixel Base Code -->\n<script>\n!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='"'"'2.0'"'"';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'"'"'script'"'"','"'"'https://connect.facebook.net/en_US/fbevents.js'"'"');fbq('"'"'init'"'"','"'"'{{Meta Pixel ID}}'"'"');fbq('"'"'track'"'"','"'"'PageView'"'"');\n</script>"},{"type":"BOOLEAN","key":"supportDocumentWrite","value":"false"}]}'
create_tag "Meta Pixel - PageView tag        " \
    $GTM tags create --name "Meta Pixel - PageView" --type html \
    --firing-trigger-id "$TRIG_ALL_PAGES" --paused --config "$META_PV_CONFIG" -o json

# Meta Pixel — Custom Events
META_CV_CONFIG='{"parameter":[{"type":"TEMPLATE","key":"html","value":"<script>\nif(typeof fbq!=='"'"'undefined'"'"'){var evtMap={checkout_started:'"'"'InitiateCheckout'"'"',checkout_completed:'"'"'Purchase'"'"',bot_deployed:'"'"'Subscribe'"'"'};var evtName=evtMap[{{Event}}]||{{Event}};fbq('"'"'track'"'"',evtName,{type:{{DLV - type}},model:{{DLV - model}}});}\n</script>"},{"type":"BOOLEAN","key":"supportDocumentWrite","value":"false"}]}'
create_tag "Meta Pixel - Conversions tag     " \
    $GTM tags create --name "Meta Pixel - Conversions" --type html \
    --firing-trigger-id "$ALL_CONVERSION_TRIGGERS" --paused --config "$META_CV_CONFIG" -o json

# GA4 Configuration tag
GA4_CFG='{"parameter":[{"type":"BOOLEAN","key":"sendPageView","value":"true"},{"type":"TEMPLATE","key":"measurementIdOverride","value":"{{GA4 Measurement ID}}"},{"type":"TEMPLATE","key":"eventName","value":"page_view"}]}'
create_tag "GA4 - Configuration tag          " \
    $GTM tags create --name "GA4 - Configuration" --type gaawe \
    --firing-trigger-id "$TRIG_ALL_PAGES" --paused --config "$GA4_CFG" -o json

# GA4 Events (all custom events)
ALL_EVENT_TRIGGERS="${TRIG_PRICING},${TRIG_CHECKOUT},${TRIG_PROMO},${TRIG_COMPLETED},${TRIG_DEPLOY}"
GA4_EVT='{"parameter":[{"type":"BOOLEAN","key":"sendPageView","value":"false"},{"type":"TEMPLATE","key":"measurementIdOverride","value":"{{GA4 Measurement ID}}"},{"type":"TEMPLATE","key":"eventName","value":"{{Event}}"},{"type":"LIST","key":"eventParameters","list":[{"type":"MAP","map":[{"type":"TEMPLATE","key":"name","value":"type"},{"type":"TEMPLATE","key":"value","value":"{{DLV - type}}"}]},{"type":"MAP","map":[{"type":"TEMPLATE","key":"name","value":"model"},{"type":"TEMPLATE","key":"value","value":"{{DLV - model}}"}]},{"type":"MAP","map":[{"type":"TEMPLATE","key":"name","value":"savings"},{"type":"TEMPLATE","key":"value","value":"{{DLV - savings}}"}]}]}]}'
create_tag "GA4 - Custom Events tag          " \
    $GTM tags create --name "GA4 - Custom Events" --type gaawe \
    --firing-trigger-id "$ALL_EVENT_TRIGGERS" --paused --config "$GA4_EVT" -o json

ok "All tags created (paused until IDs are filled in)"

# ─────────────────────────────────────────────────────────────────────────────
hr; log "Publishing container version..."
# ─────────────────────────────────────────────────────────────────────────────

VERSION=$(retry $GTM versions create \
    --name "v1.0 — LiveClaw analytics baseline" \
    --notes "Triggers for pricing_modal_opened, checkout_started, promo_applied, checkout_completed, bot_deployed. Meta Pixel + GA4 tags paused pending ID configuration." \
    -o json | strip_status)
VERSION_ID=$(echo "$VERSION" | $JQ -r '.containerVersion.containerVersionId')

retry $GTM versions publish --version-id "$VERSION_ID" >/dev/null
ok "Published version ${VERSION_ID}"

# ─────────────────────────────────────────────────────────────────────────────
hr
echo ""
echo -e "${BOLD}GTM container setup complete!${RESET}"
echo ""
echo -e "  Container ID : ${CYAN}${CONTAINER_ID}${RESET}"
echo -e "  Workspace ID : ${CYAN}${WORKSPACE_ID}${RESET}"
echo ""
echo -e "${BOLD}Your GTM-XXXXXXX snippet ID:${RESET}"
$GTM containers get --account-id "$ACCOUNT_ID" --container-id "$CONTAINER_ID" -o json \
    | strip_status | $JQ -r '"  " + .publicId'
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo "  1. Copy the GTM-XXXXXXX ID above → paste into liveclaw-web/.env as LIVECLAW_GTM_ID"
echo "  2. Also paste it into Dodo → Settings → Google Tag Manager toggle"
echo "  3. When ready for Meta ads:"
echo "       GTM → Variables → 'Meta Pixel ID' → replace FILL_IN_META_PIXEL_ID with your real ID"
echo "       GTM → Tags → 'Meta Pixel - PageView' + 'Meta Pixel - Conversions' → unpause both"
echo "       Publish a new version"
echo "  4. When ready for Google Ads / GA4:"
echo "       GTM → Variables → 'GA4 Measurement ID' → replace FILL_IN_GA4_MEASUREMENT_ID"
echo "       GTM → Tags → 'GA4 - Configuration' + 'GA4 - Custom Events' → unpause"
echo "       Publish a new version"
echo ""
