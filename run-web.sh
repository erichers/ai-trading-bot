#!/usr/bin/env bash
# Canonical WEB launcher — serves the app at http://localhost:8888/sandbox/ via
# MAMP Apache, backed by MAMP MySQL (browse it in phpMyAdmin). The native macOS
# app uses embedded SQLite and auto-syncs to this same MySQL, so both stay in sync.
#
# What it does:
#   1. ensures Ollama (Gemma) + MAMP MySQL are reachable
#   2. builds the SPA with base=/sandbox/ into frontend/dist-sandbox
#   3. (re)starts the Rust backend on :8001 (DB_BACKEND=mysql) — Apache proxies
#      /sandbox/api and /sandbox/ws to it
#   4. ensures MAMP Apache is running and opens the dashboard
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MYSQL_BIN="/Applications/MAMP/Library/bin/mysql80/bin/mysql"
HTTPD="/Applications/MAMP/Library/bin/httpd"
HTTPD_CONF="/Applications/MAMP/conf/apache/httpd.conf"

echo "▸ Ollama…"; curl -s http://localhost:11434/api/tags >/dev/null 2>&1 || (command -v ollama >/dev/null && (ollama serve >/dev/null 2>&1 &)) || echo "  (Ollama not found — research/chat will degrade)"

echo "▸ MAMP MySQL…"; "$MYSQL_BIN" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS trading_terminal" >/dev/null 2>&1 \
  || echo "  (MySQL not reachable on :8889 — start MAMP)"

echo "▸ Building SPA (base=/sandbox/) → frontend/dist-sandbox…"
( cd "$ROOT/frontend" && npx tsc -b && npx vite build --base=/sandbox/ --outDir dist-sandbox ) || { echo "build failed"; exit 1; }

echo "▸ Rust backend on :8001 (MySQL)…"
pkill -f trading-backend-rs >/dev/null 2>&1; sleep 1
( cd "$ROOT/backend-rs" && DB_BACKEND=mysql PORT=8001 nohup ./target/release/trading-backend-rs >/tmp/ttrs.log 2>&1 & )
sleep 3

echo "▸ MAMP Apache…"
if ! curl -s -o /dev/null http://localhost:8888/ 2>/dev/null; then
  "$HTTPD" -k start -f "$HTTPD_CONF" 2>/dev/null || echo "  (start MAMP from the MAMP app)"
else
  "$HTTPD" -k restart -f "$HTTPD_CONF" 2>/dev/null || true
fi
sleep 2

CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8888/sandbox/ 2>/dev/null)
echo "▸ http://localhost:8888/sandbox/ -> $CODE"
[ "$CODE" = "200" ] && open "http://localhost:8888/sandbox/" || echo "  (not 200 — ensure MAMP Apache is running and the sandbox vhost block is in $HTTPD_CONF)"
