//! Bloomberg-terminal-style AI trading backend (axum), usable as a library so the
//! native Tauri app can embed it. The web binary (`main.rs`) calls `run()` with MySQL;
//! the native app calls it with SQLite.

pub mod alpaca;
pub mod backtest;
pub mod bots;
pub mod chat;
pub mod config;
pub mod database;
pub mod db;
pub mod error;
pub mod indicators;
pub mod llm;
pub mod options;
pub mod rag;
pub mod research;
pub mod risk;
pub mod signals;
pub mod state;
pub mod sync;
pub mod worker;

use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use config::Settings;
use database::Db;
use error::{ApiError, ApiResult};
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use state::AppState;
use std::collections::HashMap;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};

// The built React frontend is embedded directly into the binary at compile time,
// so the app runs as a single self-contained native executable — no Apache/MAMP
// web server needed. Build the frontend (base '/') BEFORE compiling.
#[derive(RustEmbed)]
#[folder = "../frontend/dist"]
struct Assets;

/// Serve an embedded static asset, falling back to index.html for SPA routes.
async fn static_handler(uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".to_string();
    }
    match Assets::get(&path) {
        Some(content) => {
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            ([(header::CONTENT_TYPE, mime.as_ref())], content.data).into_response()
        }
        // Unknown path with no file extension → SPA deep link → serve index.html.
        None => match Assets::get("index.html") {
            Some(index) => ([(header::CONTENT_TYPE, "text/html")], index.data).into_response(),
            None => (StatusCode::NOT_FOUND, "frontend not embedded").into_response(),
        },
    }
}

/// Connect the DB (MySQL or SQLite per config), init schema, and build AppState.
pub async fn init_state(settings: Arc<Settings>) -> anyhow::Result<AppState> {
    let pool = if settings.use_sqlite() {
        // Ensure the parent directory exists for the SQLite file.
        if let Some(parent) = std::path::Path::new(&settings.sqlite_path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        let sq = db::connect_sqlite(&settings.sqlite_path).await?;
        Db::Sq(sq)
    } else {
        let my = db::connect_mysql(&settings.database_url()).await?;
        Db::My(my)
    };
    db::init_db(&pool).await?;
    tracing::info!(
        "DB connected and initialized (backend={}).",
        if pool.is_sqlite() { "sqlite" } else { "mysql" }
    );

    let alpaca = alpaca::Alpaca::new(settings.clone());
    let llm = llm::Llm::new(settings.clone());
    Ok(AppState {
        settings,
        pool,
        alpaca,
        llm,
    })
}

/// Build the axum Router (API + WS + embedded SPA) for a given AppState.
pub fn build_app(app_state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin([
            "http://localhost:5173".parse().unwrap(),
            "http://localhost:3000".parse().unwrap(),
            "http://localhost:8888".parse().unwrap(),
        ])
        .allow_methods(Any)
        .allow_headers(Any);

    let api = Router::new()
        .route("/health", get(health))
        // trading
        .route("/account", get(account))
        .route("/positions", get(positions))
        .route("/orders", get(orders).post(create_order).delete(kill_switch))
        .route("/orders/:order_id", delete(cancel_order))
        .route("/trades", get(trades))
        .route("/clock", get(clock))
        .route("/calendar", get(calendar))
        // market
        .route("/assets", get(assets))
        .route("/bars/:symbol", get(bars))
        .route("/quote/:symbol", get(quote))
        .route("/snapshot/:symbol", get(snapshot))
        .route("/snapshots", get(snapshots))
        .route("/news", get(news))
        // watchlist
        .route("/watchlist", get(get_watchlist).post(add_watchlist))
        .route("/watchlist/:symbol", delete(remove_watchlist))
        // indicators
        .route("/indicators/catalog", get(indicators_catalog))
        .route("/indicators/:symbol", get(indicators_symbol))
        // strategies + signals
        .route("/strategies", get(list_strategies).post(create_strategy))
        .route("/strategies/:id", put(update_strategy).delete(delete_strategy))
        .route("/signals/evaluate", post(evaluate_signal))
        .route("/signals/history", get(signals_history))
        // risk
        .route("/risk/limits", get(risk_limits).put(risk_update_limits))
        .route("/risk/status", get(risk_status))
        .route("/risk/check", post(risk_check))
        .route("/risk/size", post(risk_size))
        .route("/risk/kill-switch", post(risk_kill_switch))
        .route("/risk/events", get(risk_events))
        // options
        .route("/options/expirations/:symbol", get(opt_expirations))
        .route("/options/chain/:symbol", get(opt_chain))
        .route("/options/flow/:symbol", get(opt_flow))
        .route("/options/select/:symbol", get(opt_select))
        // bots
        .route("/bots", get(list_bots).post(create_bot))
        .route("/bots/:id", put(update_bot).delete(delete_bot))
        .route("/bots/:id/evaluate", post(evaluate_bot))
        .route("/bots/:id/run", post(run_bot))
        .route("/bots/:id/status", get(bot_status))
        .route("/bots/from-prompt", post(bot_from_prompt))
        // backtest
        .route("/backtest", post(backtest_run))
        // research
        .route("/research/analyze", post(research_analyze))
        .route("/research/history", get(research_history))
        .route("/research/briefing", get(research_briefing))
        .route("/research/regime", get(research_regime))
        .route("/research/feed", get(research_feed))
        .route("/research/deep", get(research_deep_list).post(research_deep_create))
        .route("/research/deep/:id", get(research_deep_get))
        .route("/research/worker", get(worker_status).put(worker_update))
        .route("/research/worker/run-once", post(worker_run_once))
        // chat
        .route("/chat", post(chat_post))
        .route("/chat/schema", get(chat_schema))
        .route("/chat/history", get(chat_history))
        // RAG knowledge index
        .route("/rag/reindex", post(rag_reindex))
        .route("/rag/search", get(rag_search))
        .route("/insights", get(insights_get))
        // sync (SQLite <-> MySQL; native app only)
        .route("/sync", post(sync_now))
        .route("/sync/status", get(sync_status));

    Router::new()
        .nest("/api", api)
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(app_state)
        // Everything else serves the embedded SPA (API/WS matched above first).
        .fallback(static_handler)
}

/// Full server lifecycle: load settings (if not given), init state, start the
/// background worker, and serve on `port` (or $PORT, default 8001).
pub async fn run(settings: Option<Arc<Settings>>, port: Option<u16>) -> anyhow::Result<()> {
    let settings = settings.unwrap_or_else(|| Arc::new(config::Settings::load()));
    if !settings.alpaca_configured() {
        tracing::warn!("Alpaca credentials missing — Alpaca calls will return 424 (NO MOCK).");
    }

    let app_state = init_state(settings).await?;

    // Background research worker.
    worker::start(app_state.clone());

    // RAG knowledge index: index on startup + refresh every ~5 min (non-blocking).
    rag::start(app_state.clone());

    // SQLite <-> MySQL sync: only the native app (DB_BACKEND=sqlite) syncs.
    // The MySQL web binary must NOT run this (it IS the source of truth).
    if app_state.pool.is_sqlite() {
        start_sync(app_state.clone());
    }

    let app = build_app(app_state);

    let port: u16 = port
        .or_else(|| std::env::var("PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(8001);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::info!("AI Trading Terminal (Rust, self-contained) listening on http://localhost:{port}");
    axum::serve(listener, app).await?;
    Ok(())
}

/// Start the native-app sync loop: an immediate startup pull (MySQL->SQLite so the
/// app shows the worker's accumulated research) followed by a periodic merge every
/// ~120s. Gated by the caller to DB_BACKEND=sqlite. Never blocks startup: if MySQL
/// is down, each cycle logs and skips.
pub fn start_sync(state: AppState) {
    tokio::spawn(async move {
        // Startup pull (and push) once, immediately.
        match sync::sync(&state.pool, &state.settings).await {
            Ok(v) => tracing::info!(
                "startup sync: pulled {} pushed {} (mysql_reachable={})",
                v["pulled"].as_i64().unwrap_or(0),
                v["pushed"].as_i64().unwrap_or(0),
                v["mysql_reachable"].as_bool().unwrap_or(false),
            ),
            Err(e) => tracing::warn!("startup sync failed: {e:#}"),
        }
        // Periodic merge.
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(120));
        tick.tick().await; // consume the immediate first tick
        loop {
            tick.tick().await;
            if let Err(e) = sync::sync(&state.pool, &state.settings).await {
                tracing::warn!("periodic sync failed: {e:#}");
            }
        }
    });
}

// ---- helpers ----------------------------------------------------------------
fn qint(q: &HashMap<String, String>, key: &str, default: i64) -> i64 {
    q.get(key).and_then(|v| v.parse().ok()).unwrap_or(default)
}

// ---- health -----------------------------------------------------------------
async fn health(State(s): State<AppState>) -> Json<Value> {
    let mut kill_switch_engaged = false;
    let mut circuit_breaker_tripped = false;
    if let Ok(limits) = db::get_risk_limits(&s.pool).await {
        kill_switch_engaged = limits["kill_switch_engaged"].as_bool().unwrap_or(false);
        if let Ok(acct) = s.alpaca.get_account().await {
            let day_pl_pct = acct["day_pl_pct"].as_f64().unwrap_or(0.0);
            let max_loss = limits["max_daily_loss_pct"].as_f64().unwrap_or(0.0);
            if max_loss != 0.0 {
                circuit_breaker_tripped = day_pl_pct <= -max_loss.abs();
            }
        }
    }
    let worker_cfg = worker::get_config(&s).await;
    Json(json!({
        "status": "ok",
        "alpaca_connected": s.alpaca.alpaca_connected().await,
        "anthropic_configured": s.settings.anthropic_configured(),
        "paper": s.settings.alpaca_paper_trade,
        "market_open": s.alpaca.market_open().await,
        "research_provider": s.settings.research_provider,
        "research_backup_provider": s.settings.research_backup_provider,
        "research_model": s.settings.effective_research_model(),
        "kimi_configured": s.settings.kimi_configured(),
        "chat_provider": s.settings.chat_provider,
        "ollama_connected": s.llm.ollama_connected().await,
        "kill_switch_engaged": kill_switch_engaged,
        "circuit_breaker_tripped": circuit_breaker_tripped,
        "worker_enabled": worker_cfg["enabled"].as_bool().unwrap_or(true),
        "worker_provider": worker_cfg["provider"].as_str().unwrap_or("gemma"),
    }))
}

// ---- trading ----------------------------------------------------------------
async fn account(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.get_account().await?))
}

async fn positions(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.get_positions().await?))
}

async fn orders(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let status = q.get("status").map(|x| x.as_str()).unwrap_or("open");
    let result = s.alpaca.get_orders(status).await?;
    if let Some(arr) = result.as_array() {
        for o in arr {
            let _ = db::upsert_trade_from_alpaca(&s.pool, o).await;
        }
    }
    Ok(Json(result))
}

fn build_risk_rules(decision: &Value) -> Value {
    let mut rules = vec![];
    if let Some(v) = decision["vetoes"].as_array() {
        for x in v {
            let mut m = x.clone();
            m["kind"] = json!("veto");
            rules.push(m);
        }
    }
    if let Some(w) = decision["warnings"].as_array() {
        for x in w {
            let mut m = x.clone();
            m["kind"] = json!("warning");
            rules.push(m);
        }
    }
    Value::Array(rules)
}

async fn create_order(
    State(s): State<AppState>,
    Json(mut payload): Json<Value>,
) -> ApiResult<Json<Value>> {
    let source = payload["source"].as_str().unwrap_or("manual").to_string();
    let bypass = payload["bypass_risk"].as_bool().unwrap_or(false);
    if let Some(obj) = payload.as_object_mut() {
        obj.remove("bypass_risk");
    }

    let mut decision: Option<Value> = None;
    if let (Ok(account), Ok(positions_v), Ok(limits)) = (
        s.alpaca.get_account().await,
        s.alpaca.get_positions().await,
        db::get_risk_limits(&s.pool).await,
    ) {
        let positions = positions_v.as_array().cloned().unwrap_or_default();
        let market_open = s.alpaca.market_open().await;
        let day_trade_count = account["daytrade_count"].as_i64().unwrap_or(0);
        decision = Some(risk::evaluate_order(
            &payload,
            &account,
            &positions,
            &limits,
            market_open,
            day_trade_count,
        ));
    }

    if let Some(d) = &decision {
        if !d["approved"].as_bool().unwrap_or(true) && !bypass {
            let _ = db::insert_risk_event(&s.pool, &json!({
                "symbol": payload["symbol"], "side": payload["side"], "qty": payload["qty"],
                "order_type": payload["type"], "decision": "vetoed",
                "rules": build_risk_rules(d), "computed": d["computed"], "source": source,
            })).await;
            return Ok(Json(json!({
                "rejected": true, "decision": "vetoed",
                "vetoes": d["vetoes"], "computed": d["computed"], "risk": d,
            })));
        }
    }

    let mut result = s.alpaca.place_order(&payload).await?;
    let is_option = result["asset_class"].as_str() == Some("option") || alpaca::is_option_order(&payload);
    let _ = db::insert_trade(&s.pool, &json!({
        "alpaca_order_id": result["id"], "client_order_id": result["client_order_id"],
        "symbol": result["symbol"], "asset_class": if is_option { "option" } else { "us_equity" },
        "side": result["side"], "qty": result["qty"], "order_type": result["type"],
        "order_class": result["order_class"], "time_in_force": result["time_in_force"],
        "limit_price": result["limit_price"], "stop_price": result["stop_price"],
        "take_profit": payload["take_profit"], "stop_loss": payload["stop_loss"],
        "status": result["status"], "filled_qty": result["filled_qty"],
        "filled_avg_price": result["filled_avg_price"], "submitted_at": result["submitted_at"],
        "filled_at": result["filled_at"], "source": payload["source"],
        "strategy_id": payload["strategy_id"], "raw": result["raw"],
    })).await;

    if let Some(d) = &decision {
        let mut rules = build_risk_rules(d);
        let mut event_decision = d["decision"].as_str().unwrap_or("approved").to_string();
        if bypass && !d["approved"].as_bool().unwrap_or(true) {
            event_decision = "approved".to_string();
            if let Some(arr) = rules.as_array_mut() {
                arr.push(json!({"rule": "bypassed", "message": "Risk veto bypassed via bypass_risk=true.", "kind": "warning"}));
            }
        }
        let _ = db::insert_risk_event(&s.pool, &json!({
            "symbol": result["symbol"], "side": payload["side"], "qty": payload["qty"],
            "order_type": payload["type"], "decision": event_decision,
            "rules": rules, "computed": d["computed"], "source": source,
        })).await;
        result["risk"] = d.clone();
    }
    Ok(Json(result))
}

async fn cancel_order(State(s): State<AppState>, Path(order_id): Path<String>) -> Json<Value> {
    let result = s.alpaca.cancel_order(&order_id).await;
    let _ = db::upsert_trade_from_alpaca(&s.pool, &json!({"id": order_id, "status": "canceled"})).await;
    Json(result)
}

async fn kill_switch(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.cancel_all_orders().await?))
}

async fn trades(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let status = q.get("status").map(|x| x.as_str());
    let symbol = q.get("symbol").map(|x| x.as_str());
    let limit = qint(&q, "limit", 100);
    Ok(Json(db::list_trades(&s.pool, status, symbol, limit).await?))
}

async fn clock(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.get_clock().await?))
}

async fn calendar(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.get_calendar(q.get("start").map(|x| x.as_str()), q.get("end").map(|x| x.as_str())).await?))
}

// ---- market -----------------------------------------------------------------
async fn assets(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let search = q.get("search").map(|x| x.as_str()).unwrap_or("");
    let limit = qint(&q, "limit", 20) as usize;
    Ok(Json(s.alpaca.search_assets(search, limit).await?))
}

async fn bars(
    State(s): State<AppState>,
    Path(symbol): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let timeframe = q.get("timeframe").map(|x| x.as_str()).unwrap_or("1Day");
    let limit = qint(&q, "limit", 300) as usize;
    Ok(Json(s.alpaca.get_bars(&symbol.to_uppercase(), timeframe, limit).await?))
}

async fn quote(State(s): State<AppState>, Path(symbol): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.get_quote(&symbol.to_uppercase()).await?))
}

async fn snapshot(State(s): State<AppState>, Path(symbol): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(s.alpaca.get_snapshot(&symbol.to_uppercase()).await?))
}

async fn snapshots(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let syms: Vec<String> = q
        .get("symbols")
        .map(|x| x.split(',').filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_uppercase()).collect())
        .unwrap_or_default();
    Ok(Json(s.alpaca.get_snapshots(&syms).await?))
}

async fn news(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let syms: Vec<String> = q
        .get("symbols")
        .map(|x| x.split(',').filter(|t| !t.trim().is_empty()).map(|t| t.trim().to_uppercase()).collect())
        .unwrap_or_default();
    let limit = qint(&q, "limit", 30) as usize;
    Ok(Json(s.alpaca.get_news(&syms, limit).await?))
}

// ---- watchlist --------------------------------------------------------------
async fn get_watchlist(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::get_watchlist(&s.pool).await?)))
}

async fn add_watchlist(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let symbol = body["symbol"].as_str().unwrap_or("");
    Ok(Json(json!(db::add_watchlist(&s.pool, symbol).await?)))
}

async fn remove_watchlist(State(s): State<AppState>, Path(symbol): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(json!(db::remove_watchlist(&s.pool, &symbol).await?)))
}

// ---- indicators -------------------------------------------------------------
async fn indicators_catalog() -> Json<Value> {
    Json(indicators::catalog())
}

async fn indicators_symbol(
    State(s): State<AppState>,
    Path(symbol): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let timeframe = q.get("timeframe").map(|x| x.as_str()).unwrap_or("1Day");
    let bars_v = s.alpaca.get_bars(&symbol.to_uppercase(), timeframe, 300).await?;
    let bars = bars_v.as_array().cloned().unwrap_or_default();
    Ok(Json(indicators::compute_all(&bars)))
}

// ---- strategies -------------------------------------------------------------
async fn list_strategies(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(db::list_strategies(&s.pool).await?))
}
async fn create_strategy(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    Ok(Json(db::create_strategy(&s.pool, &body).await?))
}
async fn update_strategy(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    match db::update_strategy(&s.pool, &id, &body).await? {
        Some(v) => Ok(Json(v)),
        None => Err(ApiError::not_found("strategy not found")),
    }
}
async fn delete_strategy(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_strategy(&s.pool, &id).await? {
        Ok(Json(json!({"deleted": id})))
    } else {
        Err(ApiError::not_found("strategy not found"))
    }
}
async fn evaluate_signal(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let symbol = body["symbol"].as_str().unwrap_or("");
    let timeframe = body["timeframe"].as_str().unwrap_or("1Day");
    let rules = body["rules"].as_array().cloned().unwrap_or_default();
    let result = signals::evaluate(&s, symbol, timeframe, &rules).await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    let _ = db::insert_signal(&s.pool, &json!({
        "strategy_id": body["strategy_id"], "symbol": symbol, "timeframe": timeframe,
        "fired": result["fired"], "matched": result["matched"], "snapshot": result["snapshot"],
    })).await;
    Ok(Json(result))
}
async fn signals_history(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let symbol = q.get("symbol").map(|x| x.as_str());
    let limit = qint(&q, "limit", 50);
    Ok(Json(db::list_signals(&s.pool, symbol, limit).await?))
}

// ---- risk -------------------------------------------------------------------
async fn risk_limits(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(db::get_risk_limits(&s.pool).await?))
}
async fn risk_update_limits(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    Ok(Json(db::set_risk_limits(&s.pool, &body).await?))
}
async fn risk_status(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let account = s.alpaca.get_account().await.unwrap_or(json!({}));
    let positions = s.alpaca.get_positions().await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let limits = db::get_risk_limits(&s.pool).await?;

    let f = |v: &Value| v.as_f64().unwrap_or(0.0);
    let equity = f(&account["equity"]);
    let buying_power = f(&account["buying_power"]);
    let day_pl = f(&account["day_pl"]);
    let day_pl_pct = f(&account["day_pl_pct"]);
    let max_daily_loss = f(&limits["max_daily_loss_pct"]);
    let max_open = limits["max_open_positions"].as_i64().unwrap_or(0);

    let mut open_risk = 0.0;
    for p in &positions {
        let qty = f(&p["qty"]);
        let cur = {
            let c = f(&p["current_price"]);
            if c != 0.0 { c } else { f(&p["avg_entry_price"]) }
        };
        let stop_est = cur * (1.0 - 0.02);
        open_risk += qty * (cur - stop_est);
    }
    open_risk = (open_risk * 100.0).round() / 100.0;
    let open_risk_pct = if equity != 0.0 { (open_risk / equity * 100.0 * 10000.0).round() / 10000.0 } else { 0.0 };
    let circuit_breaker_tripped = if max_daily_loss != 0.0 { day_pl_pct <= -max_daily_loss.abs() } else { false };
    let open_positions = positions.len() as i64;

    Ok(Json(json!({
        "equity": (equity * 100.0).round() / 100.0,
        "buying_power": (buying_power * 100.0).round() / 100.0,
        "day_pl": (day_pl * 100.0).round() / 100.0,
        "day_pl_pct": (day_pl_pct * 10000.0).round() / 10000.0,
        "open_positions": open_positions,
        "max_open_positions": max_open,
        "open_risk": open_risk,
        "open_risk_pct": open_risk_pct,
        "circuit_breaker_tripped": circuit_breaker_tripped,
        "kill_switch_engaged": limits["kill_switch_engaged"].as_bool().unwrap_or(false),
        "utilization": {
            "position_slots_used_pct": if max_open != 0 { ((open_positions as f64 / max_open as f64 * 100.0) * 100.0).round() / 100.0 } else { 0.0 },
            "buying_power_used_pct": if equity != 0.0 { (((equity - buying_power) / equity * 100.0) * 100.0).round() / 100.0 } else { 0.0 },
            "daily_loss_used_pct": if max_daily_loss != 0.0 { ((day_pl_pct.min(0.0) / -max_daily_loss.abs() * 100.0) * 100.0).round() / 100.0 } else { 0.0 },
        },
        "limits": limits,
    })))
}
async fn risk_check(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let account = s.alpaca.get_account().await.unwrap_or(json!({}));
    let positions = s.alpaca.get_positions().await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let limits = db::get_risk_limits(&s.pool).await?;
    let market_open = s.alpaca.market_open().await;
    let dtc = account["daytrade_count"].as_i64().unwrap_or(0);
    Ok(Json(risk::evaluate_order(&body, &account, &positions, &limits, market_open, dtc)))
}
async fn risk_size(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let limits = db::get_risk_limits(&s.pool).await?;
    let account = s.alpaca.get_account().await.unwrap_or(json!({}));
    let equity = account["equity"].as_f64().unwrap_or(0.0);
    let rpt = body["risk_per_trade_pct"].as_f64()
        .unwrap_or_else(|| limits["default_risk_per_trade_pct"].as_f64().unwrap_or(1.0));
    let entry = body["entry"].as_f64().unwrap_or(0.0);
    let stop = body["stop"].as_f64().unwrap_or(0.0);
    Ok(Json(risk::size_position(equity, rpt, entry, stop)))
}
async fn risk_kill_switch(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let engaged = body["engaged"].as_bool().unwrap_or(false);
    let flatten = body["flatten"].as_bool().unwrap_or(false);
    let close_positions = body["close_positions"].as_bool().unwrap_or(false);
    let limits = db::set_risk_limits(&s.pool, &json!({"kill_switch_engaged": engaged})).await?;
    let mut result = json!({"kill_switch_engaged": limits["kill_switch_engaged"].as_bool().unwrap_or(false)});
    if engaged && flatten {
        let cancelled = s.alpaca.cancel_all_orders().await.map(|c| c["cancelled"].as_i64().unwrap_or(0)).unwrap_or(0);
        result["cancelled"] = json!(cancelled);
        if close_positions {
            let mut closed = 0;
            let positions = s.alpaca.get_positions().await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
            for p in &positions {
                let sym = p["symbol"].as_str().unwrap_or("");
                let qty = p["qty"].as_f64().unwrap_or(0.0).abs();
                let side = if p["side"].as_str() == Some("long") { "sell" } else { "buy" };
                if sym.is_empty() || qty <= 0.0 { continue; }
                if s.alpaca.place_order(&json!({"symbol": sym, "qty": qty, "side": side, "type": "market", "time_in_force": "day"})).await.is_ok() {
                    closed += 1;
                }
            }
            result["positions_closed"] = json!(closed);
        }
    }
    Ok(Json(result))
}
async fn risk_events(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let limit = qint(&q, "limit", 50);
    Ok(Json(db::list_risk_events(&s.pool, limit).await?))
}

// ---- options ----------------------------------------------------------------
async fn opt_expirations(State(s): State<AppState>, Path(symbol): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(options::expirations_with_type(&s, &symbol.to_uppercase()).await?))
}
async fn opt_chain(
    State(s): State<AppState>,
    Path(symbol): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let expiration = q.get("expiration").map(|x| x.as_str());
    let opt_type = q.get("type").map(|x| x.as_str()).unwrap_or("all");
    Ok(Json(options::chain_json(&s, &symbol.to_uppercase(), expiration, opt_type).await?))
}
async fn opt_flow(
    State(s): State<AppState>,
    Path(symbol): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let period = q.get("period").map(|x| x.as_str()).unwrap_or("weekly");
    Ok(Json(options::get_option_flow(&s, &symbol.to_uppercase(), period).await?))
}
async fn opt_select(
    State(s): State<AppState>,
    Path(symbol): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let right = q.get("right").map(|x| x.as_str()).unwrap_or("call");
    let expiry = q.get("expiry").map(|x| x.as_str()).unwrap_or("nearest_weekly");
    let moneyness = q.get("moneyness").map(|x| x.as_str());
    let count = qint(&q, "count", 9) as usize;
    Ok(Json(options::select_contracts(&s, &symbol.to_uppercase(), right, Some(expiry), moneyness, count).await?))
}

// ---- bots -------------------------------------------------------------------
async fn list_bots(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(db::list_bots(&s.pool).await?))
}
async fn create_bot(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    Ok(Json(db::create_bot(&s.pool, &body).await?))
}
async fn update_bot(State(s): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    match db::update_bot(&s.pool, &id, &body).await? {
        Some(v) => Ok(Json(v)),
        None => Err(ApiError::not_found("bot not found")),
    }
}
async fn delete_bot(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    if db::delete_bot(&s.pool, &id).await? {
        Ok(Json(json!({"deleted": true, "id": id})))
    } else {
        Err(ApiError::not_found("bot not found"))
    }
}
async fn evaluate_bot(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let bot = db::get_bot(&s.pool, &id).await?.ok_or_else(|| ApiError::not_found("bot not found"))?;
    let result = bots::evaluate_bot(&s, &bot).await;
    let _ = db::save_bot_evaluation(&s.pool, &id, &result).await;
    Ok(Json(result))
}
async fn bot_status(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let bot = db::get_bot(&s.pool, &id).await?.ok_or_else(|| ApiError::not_found("bot not found"))?;
    Ok(Json(json!({
        "bot": bot,
        "last_evaluated_at": bot["last_evaluated_at"],
        "last_result": bot["last_result"],
        "mode": bot["mode"],
        "enabled": bot["enabled"],
    })))
}
async fn bot_from_prompt(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let prompt = body["prompt"].as_str().unwrap_or("").trim();
    if prompt.is_empty() {
        return Err(ApiError::bad_request("prompt is required"));
    }
    let symbol = body["symbol"].as_str();
    let result = bots::from_prompt(&s, prompt, symbol)
        .await
        .map_err(|e| ApiError::upstream(e.to_string()))?;
    Ok(Json(result))
}
async fn run_bot(State(s): State<AppState>, Path(id): Path<String>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let bot = db::get_bot(&s.pool, &id).await?.ok_or_else(|| ApiError::not_found("bot not found"))?;
    let place = body["place"].as_bool().unwrap_or(false);
    Ok(Json(bots::run_bot(&s, &bot, place).await))
}

// ---- backtest ---------------------------------------------------------------
async fn backtest_run(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    Ok(Json(backtest::run_backtest(&s, &body).await?))
}

// ---- research ---------------------------------------------------------------
async fn research_analyze(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let symbol = body["symbol"].as_str().unwrap_or("");
    let provider = body["provider"].as_str();
    let depth = body["depth"].as_str().unwrap_or("standard");
    let result = research::analyze(&s, symbol, provider, depth).await
        .map_err(|e| ApiError::upstream(format!("Research unavailable: {e}")))?;
    let _ = db::insert_research(&s.pool, &result).await;
    Ok(Json(result))
}
async fn research_history(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let symbol = q.get("symbol").map(|x| x.as_str());
    let limit = qint(&q, "limit", 50);
    Ok(Json(db::list_research(&s.pool, symbol, limit).await?))
}
async fn research_briefing(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    let wl = db::get_watchlist(&s.pool).await?;
    let result = research::briefing(&s, &wl, None).await
        .map_err(|e| ApiError::upstream(format!("Briefing unavailable: {e}")))?;
    let _ = db::insert_briefing(&s.pool, &result).await;
    Ok(Json(result))
}
async fn research_regime(State(s): State<AppState>) -> ApiResult<Json<Value>> {
    Ok(Json(research::regime(&s).await.map_err(|e| ApiError::upstream(e.to_string()))?))
}

fn truncate(text: &str, n: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() > n {
        let s: String = chars[..n].iter().collect();
        format!("{}…", s.trim_end())
    } else {
        text.to_string()
    }
}

async fn research_feed(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let limit = qint(&q, "limit", 50);
    let mut items: Vec<Value> = vec![];
    let research = db::list_research(&s.pool, None, limit).await?;
    if let Some(arr) = research.as_array() {
        for r in arr {
            items.push(json!({
                "id": format!("analysis-{}", r["id"]),
                "source": "analysis",
                "symbol": r["symbol"],
                "title": format!("{} analysis", r["symbol"].as_str().unwrap_or("")),
                "summary": truncate(r["thesis"].as_str().unwrap_or(""), 280),
                "conviction": r["conviction"],
                "sentiment_score": r["sentiment_score"],
                "regime": r["regime"],
                "provider": r["provider"],
                "model": r["model"],
                "created_at": r["generated_at"],
            }));
        }
    }
    let deep = db::list_deep_research(&s.pool, None, None, limit).await?;
    if let Some(arr) = deep.as_array() {
        for d in arr {
            let kind = d["kind"].as_str().unwrap_or("deep");
            if kind == "analysis" {
                continue;
            }
            let source = match kind {
                "deep" => "deep",
                "earnings" => "earnings",
                "market" => "market",
                "briefing" => "briefing",
                _ => "deep",
            };
            let data = &d["data"];
            items.push(json!({
                "id": format!("deep-{}", d["id"]),
                "source": source,
                "symbol": d["symbol"],
                "title": d["title"],
                "summary": d["summary"],
                "conviction": data["conviction"],
                "sentiment_score": data["sentiment_score"],
                "regime": data["regime"],
                "provider": d["provider"],
                "model": d["model"],
                "created_at": d["created_at"],
            }));
        }
    }
    items.sort_by(|a, b| b["created_at"].as_str().unwrap_or("").cmp(a["created_at"].as_str().unwrap_or("")));
    items.truncate(limit as usize);
    Ok(Json(Value::Array(items)))
}
async fn research_deep_list(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let symbol = q.get("symbol").map(|x| x.as_str());
    let kind = q.get("kind").map(|x| x.as_str());
    let limit = qint(&q, "limit", 50);
    Ok(Json(db::list_deep_research(&s.pool, symbol, kind, limit).await?))
}
async fn research_deep_get(State(s): State<AppState>, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    match db::get_deep_research(&s.pool, id).await? {
        Some(v) => Ok(Json(v)),
        None => Err(ApiError::not_found("deep_research not found")),
    }
}
async fn research_deep_create(State(s): State<AppState>, Json(body): Json<Value>) -> ApiResult<Json<Value>> {
    let symbol = body["symbol"].as_str().unwrap_or("");
    let kind = body["kind"].as_str().unwrap_or("deep");
    let doc = research::generate_deep(&s, symbol, kind, None).await
        .map_err(|e| ApiError::upstream(format!("Deep research unavailable: {e}")))?;
    Ok(Json(db::insert_deep_research(&s.pool, &doc).await?))
}
async fn worker_status(State(s): State<AppState>) -> Json<Value> {
    Json(worker::status(&s).await)
}
async fn worker_update(State(s): State<AppState>, Json(body): Json<Value>) -> Json<Value> {
    worker::set_config(&s, &body).await;
    Json(worker::status(&s).await)
}
async fn worker_run_once(State(s): State<AppState>) -> Json<Value> {
    Json(worker::run_once(&s).await)
}

// ---- chat -------------------------------------------------------------------
async fn chat_schema() -> Json<Value> {
    Json(chat::schema())
}
async fn chat_history(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let limit = qint(&q, "limit", 50);
    Json(db::list_chat_messages(&s.pool, limit).await.unwrap_or(json!([])))
}
async fn chat_post(State(s): State<AppState>, Json(body): Json<Value>) -> Json<Value> {
    let message = body["message"].as_str().unwrap_or("");
    let history = body["history"].as_array().cloned().unwrap_or_default();
    let result = chat::ask(&s, message, &history).await;
    let _ = db::insert_chat_message(&s.pool, "user", message, &json!({})).await;
    let _ = db::insert_chat_message(&s.pool, "assistant", result["answer"].as_str().unwrap_or(""), &json!({"mode": result["mode"], "sql": result["sql"]})).await;
    Json(result)
}

// ---- RAG knowledge index ----------------------------------------------------
async fn rag_reindex(State(s): State<AppState>) -> Json<Value> {
    Json(rag::reindex(&s).await)
}
async fn rag_search(
    State(s): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<Value> {
    let query = q.get("q").map(|x| x.as_str()).unwrap_or("");
    let k = qint(&q, "k", 6).clamp(1, 50) as usize;
    Json(rag::search(&s, query, k).await)
}
async fn insights_get(State(s): State<AppState>) -> Json<Value> {
    Json(rag::compute_insights(&s).await)
}

// ---- sync (SQLite <-> MySQL) ------------------------------------------------
/// Manually trigger a bidirectional sync. Returns {pulled, pushed, ...}.
async fn sync_now(State(s): State<AppState>) -> Json<Value> {
    match sync::sync(&s.pool, &s.settings).await {
        Ok(v) => Json(v),
        Err(e) => Json(json!({ "error": e.to_string(), "pulled": 0, "pushed": 0 })),
    }
}

/// Sync status: last sync info, mysql reachability, current SQLite counts.
async fn sync_status(State(s): State<AppState>) -> Json<Value> {
    Json(sync::status(&s.pool, &s.settings).await)
}

// ---- websocket --------------------------------------------------------------
async fn ws_handler(ws: WebSocketUpgrade, State(s): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| worker::realtime_run(socket, s))
}
