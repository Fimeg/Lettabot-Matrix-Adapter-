#!/bin/bash
# Matrix Bot Full Restart Script
#
# Performs a complete fresh-device restart:
#   1. Kills any running bot process
#   2. Wipes session + crypto data (crypto is ephemeral — required every restart)
#   3. Logs in and saves a new session
#   4. Removes all OLD devices (using the new token, requires password auth)
#   5. Starts the bot in the background
#
# The new device auto-verifies via cross-signing (recovery key in lettabot.yaml).
# No SAS emoji verification needed — just dismiss any Element prompt about it.
#
# Usage:
#   ./scripts/restart-matrix.sh [--build]
#
# Options:
#   --build    Run `npm run build` before starting (use after code changes)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$BOT_DIR"

# ── Config ──────────────────────────────────────────────────────────────────
# All settings from environment variables (no hardcoded values)
HOMESERVER="${MATRIX_HOMESERVER:-https://matrix.example.com}"
MATRIX_USER="${MATRIX_USER:-your-username}"
MATRIX_PASSWORD="${MATRIX_PASSWORD:-}"
STORE_DIR="${MATRIX_STORE_DIR:-./data/matrix-bot}"
LOG_FILE="${BOT_LOG_FILE:-/tmp/bot-output.log}"

# Validate required env vars
if [[ -z "$MATRIX_PASSWORD" ]]; then
  echo "[restart] ERROR: MATRIX_PASSWORD environment variable not set"
  exit 1
fi

# ── Step 1: Kill existing bot ────────────────────────────────────────────────
echo "[restart] Stopping existing bot..."
pkill -f "node dist/main" 2>/dev/null && sleep 2 || true

# ── Step 2: Optional rebuild ─────────────────────────────────────────────────
if [[ "${1:-}" == "--build" ]]; then
  echo "[restart] Building..."
  npm run build
fi

# ── Step 3: Clear session + crypto data ──────────────────────────────────────
echo "[restart] Clearing session data..."
rm -rf "$STORE_DIR"
mkdir -p "$STORE_DIR"

# ── Step 4: Fresh Matrix login ────────────────────────────────────────────────
DEVICE_ID="${MATRIX_DEVICE_PREFIX:-BOT}_$(date +%s)"
echo "[restart] Logging in as @${MATRIX_USER} with device ${DEVICE_ID}..."

LOGIN_RESPONSE=$(curl -s -X POST "${HOMESERVER}/_matrix/client/v3/login" \
  -H "Content-Type: application/json" \
  -d "{
    \"type\": \"m.login.password\",
    \"identifier\": {\"type\": \"m.id.user\", \"user\": \"${MATRIX_USER}\"},
    \"password\": \"${MATRIX_PASSWORD}\",
    \"device_id\": \"${DEVICE_ID}\"
  }")

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.access_token')
ACTUAL_DEVICE=$(echo "$LOGIN_RESPONSE" | jq -r '.device_id')

if [[ -z "$ACCESS_TOKEN" || "$ACCESS_TOKEN" == "null" ]]; then
  echo "[restart] ERROR: Login failed"
  echo "$LOGIN_RESPONSE"
  exit 1
fi

echo "$LOGIN_RESPONSE" | jq '{
  userId: .user_id,
  accessToken: .access_token,
  homeserverUrl: "'"${HOMESERVER}"'",
  deviceId: .device_id
}' > "${STORE_DIR}/session.json"

echo "[restart] Session saved. New device: ${ACTUAL_DEVICE}"

# ── Step 5: Remove old BOT_ devices ──────────────────────────────────────────
echo "[restart] Fetching device list to remove old BOT_ devices..."

DEVICES=$(curl -s \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  "${HOMESERVER}/_matrix/client/v3/devices")

OLD_DEVICES=$(echo "$DEVICES" | jq -r \
  --arg new "$ACTUAL_DEVICE" \
  '.devices[] | select(.device_id | startswith("BOT_")) | select(.device_id != $new) | .device_id')

if [[ -z "$OLD_DEVICES" ]]; then
  echo "[restart] No old BOT_ devices to remove"
else
  echo "[restart] Removing old devices: $(echo $OLD_DEVICES | tr '\n' ' ')"
  DEVICE_JSON=$(echo "$OLD_DEVICES" | jq -Rs 'split("\n") | map(select(length > 0))')

  curl -s -X POST \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    "${HOMESERVER}/_matrix/client/v3/delete_devices" \
    -d "{
      \"devices\": ${DEVICE_JSON},
      \"auth\": {
        \"type\": \"m.login.password\",
        \"identifier\": {\"type\": \"m.id.user\", \"user\": \"${MATRIX_USER}\"},
        \"password\": \"${MATRIX_PASSWORD}\"
      }
    }" | jq -r 'if .errcode then "WARNING: \(.errcode): \(.error)" else "Removed successfully" end'
fi

# ── Step 6: Start bot ─────────────────────────────────────────────────────────
echo "[restart] Starting bot → logging to ${LOG_FILE}"
node dist/main.js > "$LOG_FILE" 2>&1 &
BOT_PID=$!
echo "[restart] Bot PID: ${BOT_PID}"

echo ""
echo "══════════════════════════════════════════"
echo " Bot started as device: ${ACTUAL_DEVICE}"
echo " Device auto-verifies via cross-signing"
echo " Logs: tail -f ${LOG_FILE}"
echo "══════════════════════════════════════════"
