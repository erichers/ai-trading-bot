#!/usr/bin/env bash
# Start the full trading terminal (backend :8000 + frontend :5173) for local dev.
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "▶ Backend (FastAPI) on :8000"
cd "$ROOT/backend"
if [ ! -d .venv ]; then
  python3 -m venv .venv
  ./.venv/bin/pip install -q -r requirements.txt
fi
./.venv/bin/uvicorn main:app --port 8000 --reload &
BACK=$!

echo "▶ Frontend (Vite) on :5173"
cd "$ROOT/frontend"
[ -d node_modules ] || npm install
npm run dev &
FRONT=$!

trap "echo; echo 'Stopping…'; kill $BACK $FRONT 2>/dev/null" INT TERM
echo "✓ Terminal up → http://localhost:5173  (backend: http://localhost:8000/api/health)"
wait
