#!/usr/bin/env bash
# Production-style serve: build the SPA (served by MAMP/Apache at /sandbox/) and
# run the supporting services. The app lives at http://localhost:8888/sandbox/.
#
# Prereqs (one-time): MAMP running (Apache :8888 + MySQL :8889) with the
# deploy/apache-sandbox.conf block appended to MAMP's httpd.conf. See README.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
MYSQL_BIN=/Applications/MAMP/Library/bin/mysql80/bin/mysql

echo "▶ Ollama (local Gemma research)"
if ! curl -s --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
  (ollama serve >/tmp/ollama.log 2>&1 &) ; sleep 2
fi
ollama list 2>/dev/null | grep -q gemma4 || echo "  ! gemma4:e2b not found — run: ollama pull gemma4:e2b"

echo "▶ MAMP MySQL (:8889)"
if ! "$MYSQL_BIN" -u root -proot -h 127.0.0.1 -P 8889 -e "SELECT 1" >/dev/null 2>&1; then
  /Applications/MAMP/bin/startMysql.sh >/dev/null 2>&1 || true ; sleep 2
fi
"$MYSQL_BIN" -u root -proot -h 127.0.0.1 -P 8889 -e "CREATE DATABASE IF NOT EXISTS trading_terminal" >/dev/null 2>&1 || true

echo "▶ Building frontend → frontend/dist (served by Apache at /sandbox/)"
cd "$ROOT/frontend"
[ -d node_modules ] || npm install
npm run build

echo "▶ Backend (FastAPI) on :8000"
cd "$ROOT/backend"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r requirements.txt
fi
echo "✓ Terminal → http://localhost:8888/sandbox/   (ensure MAMP Apache is running)"
exec ./.venv/bin/uvicorn main:app --port 8000 --host 127.0.0.1
