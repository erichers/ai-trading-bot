# AI Trading Terminal — native macOS app

A self-contained native macOS build of the AI Trading Terminal. The Rust/axum
backend (with the React frontend embedded) runs **on SQLite** inside a Tauri
window — no MAMP web server needed. The 24/7 research worker and the web version
run on MySQL; the two databases are kept in sync (see below).

## Contents

```
app-native/
  src-tauri/            Tauri v2 app (spawns the axum backend on SQLite, opens a webview)
    icons/              App icon set (icon.icns + png sizes) — generated from icon-src/
    tauri.conf.json     bundle.icon points at icons/
  icon-src/
    icon.html           Source SVG/HTML for the app icon (committed)
    icon.png            1024×1024 rendered icon (committed)
  launcher/
    launcher.applescript  Source for the double-clickable Desktop launcher
    launcher.sh           Shell equivalent (reference / debugging)
  dist/                 Tauri splash placeholder (source, not a build artifact)
```

## App icon

The icon is a trading-terminal motif: near-black background (#0a0b0d), green
(#1bcf6b) up-candles, an amber (#f7a01d) trend line. To regenerate:

```bash
# 1. Render the source HTML to a 1024×1024 PNG with headless Chrome
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-sandbox --force-device-scale-factor=1 \
  --window-size=1024,1024 --screenshot=/tmp/icon.png \
  file:///Users/ulrich/Sites/sandbox/app-native/icon-src/icon.html
cp /tmp/icon.png app-native/icon-src/icon.png

# 2. Generate the icon set (icns + pngs) into src-tauri/icons/
cd app-native/src-tauri && ~/.cargo/bin/cargo tauri icon /tmp/icon.png
```

## SQLite ↔ MySQL sync

`backend-rs/src/sync.rs` bidirectionally merges the native app's SQLite database
with the MySQL database used by the web version + research worker.

- **Append-only tables** (`trades, research_analyses, deep_research, signals,
  risk_events, briefings, chat_messages`): each row is identified by a stable
  natural key (e.g. `trades` → `alpaca_order_id`/`client_order_id`;
  `research_analyses` → symbol+generated_at+provider+model+thesis-hash). Rows
  present on one side but not the other are inserted on the missing side. Never
  duplicated — re-running inserts nothing (idempotent).
- **Config tables**: `watchlist` is a symbol union; `strategies`/`bots` are
  last-write-wins by `updated_at`; `settings` is a key union.

When the app runs:
- **on startup** it pulls MySQL→SQLite (so you immediately see the worker's
  accumulated research), and pushes anything local;
- **every ~120s** it merges both directions;
- **on quit** it pushes a final SQLite→MySQL flush.

Sync only runs in the native app (`DB_BACKEND=sqlite`) — **not** in the MySQL web
binary. It only attempts a sync if MySQL is configured **and** reachable (short
connect timeout); if MySQL is down it logs and skips — it never crashes or blocks
app startup.

Manual control:
- `POST /api/sync` → `{pulled, pushed, tables}`
- `GET /api/sync/status` → `{last_sync, mysql_reachable, sqlite_counts}`

## Desktop launcher — "Trading Terminal.app"

A double-clickable launcher (no Terminal window) lives on the Desktop. Build it
from the AppleScript source:

```bash
cd app-native/launcher
osacompile -o ~/Desktop/"Trading Terminal.app" launcher.applescript
cp ../src-tauri/icons/icon.icns ~/Desktop/"Trading Terminal.app"/Contents/Resources/applet.icns
```

Behavior:

**On open** it
1. starts **Ollama** (Gemma) if not already running,
2. starts **MAMP MySQL** (`/Applications/MAMP/bin/startMysql.sh`) if `:8889` is
   down (remembering whether *it* started MySQL),
3. launches the native `AI Trading Terminal.app`.

It then **waits** for the app to quit (polling `pgrep -f MacOS/ai-trading-terminal`
every 3s). **On quit** it
- waits a few seconds so the app's final SQLite→MySQL sync push completes,
- stops MAMP MySQL **only if it started it**,
- **leaves Ollama running** so Gemma stays available in the background.

Each step is guarded so a missing path/service never aborts the rest, and the
wait loop re-checks every 3s rather than hanging. Logs go to
`/tmp/trading-terminal-launcher.log`. `launcher.sh` is a plain-shell equivalent
for debugging.

## Build the .app

```bash
# Build the frontend first so the embedded SPA is current.
cd frontend && npm run build

# Bundle the native app.
cd ../app-native/src-tauri && ~/.cargo/bin/cargo tauri build --bundles app
# -> target/release/bundle/macos/AI Trading Terminal.app
```

The build is unsigned (no Apple Developer certificate); on first launch macOS
Gatekeeper may require right-click → Open. DMG/codesign/notarization are out of
scope here.

## Web version (unchanged)

The MySQL-backed web version still works:

```bash
cd backend-rs && DB_BACKEND=mysql ~/.cargo/bin/cargo run   # serves http://localhost:8001
```
