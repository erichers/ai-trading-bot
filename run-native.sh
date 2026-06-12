#!/usr/bin/env bash
# Run the AI Trading Terminal as a single self-contained NATIVE binary.
# The Rust/axum backend embeds the built React frontend and serves the whole app
# (SPA + REST API + WebSocket) on http://localhost:8001 — no Apache/MAMP web server.
#
# Still required (the app's data + local AI engine):
#   • MySQL  — via MAMP on :8889 (the database with your trades/research)
#   • Ollama — local Gemma for free 24/7 research + the Vanna chat
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
MYSQL_BIN=/Applications/MAMP/Library/bin/mysql80/bin/mysql

echo "▶ Ollama (local Gemma)…"
curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1 || { (ollama serve >/tmp/ollama.log 2>&1 &); sleep 2; }
ollama list 2>/dev/null | grep -q gemma4 || echo "  ! gemma4:e2b missing — run: ollama pull gemma4:e2b"

echo "▶ MySQL (MAMP :8889)…"
"$MYSQL_BIN" -u root -proot -h 127.0.0.1 -P 8889 -e "SELECT 1" >/dev/null 2>&1 \
  || { /Applications/MAMP/bin/startMysql.sh >/dev/null 2>&1 || true; sleep 2; }
"$MYSQL_BIN" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS trading_terminal" >/dev/null 2>&1 || true

echo "▶ Building frontend (embedded into the binary)…"
cd "$ROOT/frontend"; [ -d node_modules ] || npm install; npm run build

echo "▶ Building native binary (release)…"
cd "$ROOT/backend-rs"; ~/.cargo/bin/cargo build --release

echo "✓ Native app → http://localhost:8001/"
( sleep 1; command -v open >/dev/null && open "http://localhost:8001/" ) &
exec ./target/release/trading-backend-rs
