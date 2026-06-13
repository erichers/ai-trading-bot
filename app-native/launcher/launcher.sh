#!/usr/bin/env bash
#
# Trading Terminal launcher (reference / debugging equivalent of launcher.applescript).
#
# On open:
#   1. Start Ollama (Gemma) if not already running.
#   2. Start MAMP MySQL if not already running.
#   3. Launch the native "AI Trading Terminal.app".
# Then WAIT for the app to quit, and ON QUIT:
#   - stop MAMP MySQL (after a short grace period so the app's shutdown sync flushes)
#   - LEAVE Ollama running so Gemma stays available in the background.
#
# Every step is guarded so a missing path/service never aborts the rest.
set -u

APP="/Users/ulrich/Sites/sandbox/app-native/src-tauri/target/release/bundle/macos/AI Trading Terminal.app"
APP_PROC="MacOS/ai-trading-terminal"   # pgrep pattern for the running native binary
MAMP_START="/Applications/MAMP/bin/startMysql.sh"
MAMP_STOP="/Applications/MAMP/bin/stopMysql.sh"
LOG="/tmp/trading-terminal-launcher.log"

log() { echo "$(date '+%H:%M:%S') $*" | tee -a "$LOG"; }

log "=== Trading Terminal launcher: OPEN ==="

# --- 1. Ollama (Gemma) ---------------------------------------------------------
if pgrep -x ollama >/dev/null 2>&1; then
  log "Ollama already running — leaving it."
else
  if command -v ollama >/dev/null 2>&1; then
    log "Starting Ollama…"
    nohup ollama serve >/tmp/ollama.log 2>&1 &
    sleep 2
  else
    log "! ollama not found in PATH — skipping (Gemma research will be unavailable)."
  fi
fi

# --- 2. MAMP MySQL -------------------------------------------------------------
# MySQL on 127.0.0.1:8889 (MAMP default). Probe the port; start only if down.
if nc -z 127.0.0.1 8889 >/dev/null 2>&1; then
  log "MySQL (:8889) already up — leaving it."
  STARTED_MYSQL=0
else
  if [ -x "$MAMP_START" ]; then
    log "Starting MAMP MySQL…"
    "$MAMP_START" >/dev/null 2>&1 || log "! startMysql.sh returned non-zero (continuing)."
    sleep 3
    STARTED_MYSQL=1
  else
    log "! $MAMP_START not found — skipping (app will run on SQLite, no MySQL sync)."
    STARTED_MYSQL=0
  fi
fi

# --- 3. Launch the app ---------------------------------------------------------
if [ -d "$APP" ]; then
  log "Launching: $APP"
  open "$APP"
else
  log "! App not found at: $APP — build it first (cargo tauri build). Aborting."
  exit 1
fi

# --- 4. Wait for the app to quit ----------------------------------------------
# Give it a moment to spawn, then poll every 3s.
sleep 4
log "Waiting for the app to quit…"
while pgrep -f "$APP_PROC" >/dev/null 2>&1; do
  sleep 3
done
log "App has quit."

# --- 5. On quit: allow final sync, then stop MySQL (NOT Ollama) ---------------
# The native app pushes a final SQLite->MySQL sync on exit; give it a few seconds.
log "Grace period for final sync push…"
sleep 5

if [ "${STARTED_MYSQL:-0}" = "1" ] && [ -x "$MAMP_STOP" ]; then
  log "Stopping MAMP MySQL (we started it)…"
  "$MAMP_STOP" >/dev/null 2>&1 || log "! stopMysql.sh returned non-zero."
else
  log "Leaving MySQL as we found it (we did not start it, or stop script missing)."
fi

log "Leaving Ollama RUNNING so Gemma stays available in the background."
log "=== Trading Terminal launcher: DONE ==="
