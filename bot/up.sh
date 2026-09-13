#!/bin/bash
cd "$(dirname "$0")/.."

# oxmgr-based launch for the bot.
# oxmgr handles auto-restart and process management (replaces pm2 as of
# 2026-05-12). See CLAUDE.md "Bot Startup (oxmgr)".

SERVICE_NAME="comfy-pr-bot"
BUN_BIN="/root/.bun/bin/bun"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v oxmgr &> /dev/null; then
  echo "oxmgr is not installed. Installing oxmgr globally..."
  npm install -g oxmgr
fi

# Stop existing instance if running
echo "[$(date)] Stopping existing $SERVICE_NAME if any..."
oxmgr stop "$SERVICE_NAME" 2>/dev/null || true
oxmgr rm   "$SERVICE_NAME" 2>/dev/null || true

# Start the bot under oxmgr.
# --restart always: same auto-restart-on-exit semantics as pm2.
# Command is passed as a single quoted string because oxmgr's <COMMAND>
# is one positional arg, not argv-style.
echo "[$(date)] Starting $SERVICE_NAME with oxmgr..."
oxmgr start \
  --name "$SERVICE_NAME" \
  --restart always \
  --cwd "$REPO_DIR" \
  "$BUN_BIN bot/index.ts --continue"

# Show status
echo "[$(date)] Bot started"
oxmgr status "$SERVICE_NAME"

# Follow logs
echo "[$(date)] Following logs (Ctrl+C to exit)..."
oxmgr logs "$SERVICE_NAME" -f
