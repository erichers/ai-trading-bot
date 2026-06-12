//! Background research worker + realtime websocket broadcaster.

use crate::db;
use crate::research;
use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket};
use chrono::Utc;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

static RUNNING: AtomicBool = AtomicBool::new(false);
static CYCLES: AtomicU64 = AtomicU64::new(0);
static LAST_RUN: Mutex<Option<String>> = Mutex::new(None);

pub fn default_config() -> Value {
    json!({
        "enabled": true,
        "provider": "gemma",
        "depth": "standard",
        "interval_sec": 900,
        "universe": ["SPY", "QQQ", "TSLA", "META", "NVDA", "AAPL", "AMZN", "GOOGL", "MSFT", "AMD"],
    })
}

pub async fn get_config(state: &AppState) -> Value {
    let mut cfg = default_config();
    if let Ok(Some(stored)) = db::get_setting(&state.pool, db::WORKER_KEY).await {
        if let Some(obj) = stored.as_object() {
            for (k, v) in obj {
                cfg[k] = v.clone();
            }
        }
    }
    cfg
}

pub async fn set_config(state: &AppState, partial: &Value) -> Value {
    let mut cfg = get_config(state).await;
    if let Some(obj) = partial.as_object() {
        for (k, v) in obj {
            if !v.is_null() {
                cfg[k] = v.clone();
            }
        }
    }
    let _ = db::set_setting(&state.pool, db::WORKER_KEY, &cfg).await;
    cfg
}

pub async fn status(state: &AppState) -> Value {
    let cfg = get_config(state).await;
    let count_today = db::count_deep_research_today(&state.pool).await.unwrap_or(0);
    let last_run = LAST_RUN.lock().unwrap().clone();
    json!({
        "enabled": cfg["enabled"].as_bool().unwrap_or(true),
        "provider": cfg["provider"].as_str().unwrap_or("gemma"),
        "depth": cfg["depth"].as_str().unwrap_or("standard"),
        "interval_sec": cfg["interval_sec"].as_i64().unwrap_or(900),
        "universe": cfg["universe"],
        "last_run": last_run,
        "running": RUNNING.load(Ordering::Relaxed),
        "count_today": count_today,
        "cycles": CYCLES.load(Ordering::Relaxed),
    })
}

async fn analyze_one(state: &AppState, symbol: &str, provider: &str, depth: &str) {
    let result = match research::analyze(state, symbol, Some(provider), depth).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("worker: analyze {} failed ({})", symbol, e);
            return;
        }
    };
    if depth == "deep" {
        if let Ok(doc) = research::generate_deep(state, symbol, "deep", Some(provider)).await {
            let _ = db::insert_deep_research(&state.pool, &doc).await;
        }
    }
    let _ = db::insert_research(&state.pool, &result).await;
    let risks: String = result["key_risks"]
        .as_array()
        .map(|a| a.iter().map(|r| format!("- {}", r.as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n"))
        .unwrap_or_default();
    let body = format!(
        "## Thesis\n{}\n\n## Bear case\n{}\n\n## Key risks\n{}",
        result["thesis"].as_str().unwrap_or("").trim(),
        result["bear_case"].as_str().unwrap_or("").trim(),
        risks
    );
    let _ = db::insert_deep_research(&state.pool, &json!({
        "symbol": symbol, "kind": "analysis", "title": format!("{} analysis", symbol),
        "body": body, "data": result, "provider": result["provider"], "model": result["model"],
    })).await;
}

async fn run_cycle(state: &AppState) {
    let cfg = get_config(state).await;
    let universe: Vec<String> = cfg["universe"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let provider = cfg["provider"].as_str().unwrap_or("gemma").to_string();
    let depth = cfg["depth"].as_str().unwrap_or("standard").to_string();
    tracing::info!("research worker: cycle over {} symbols (provider={}, depth={})", universe.len(), provider, depth);
    for sym in &universe {
        if !get_config(state).await["enabled"].as_bool().unwrap_or(true) {
            return;
        }
        analyze_one(state, sym, &provider, &depth).await;
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    // briefing
    if let Ok(result) = research::briefing(state, &universe, Some(&provider)).await {
        let _ = db::insert_briefing(&state.pool, &result).await;
        let items: String = result["items"].as_array().map(|a| a.iter().map(|i| format!("- {}", i["note"].as_str().unwrap_or(""))).collect::<Vec<_>>().join("\n")).unwrap_or_default();
        let body = format!("## Market briefing\n{}\n\nRegime: **{}**\n\n## Watchlist\n{}", result["summary"].as_str().unwrap_or("").trim(), result["regime"].as_str().unwrap_or("range"), items);
        let _ = db::insert_deep_research(&state.pool, &json!({
            "symbol": "MARKET", "kind": "market", "title": "Market briefing",
            "body": body, "data": result,
            "provider": research::normalize_provider(Some(&provider)),
            "model": state.settings.research_model,
        })).await;
    }
    let cycles = CYCLES.fetch_add(1, Ordering::Relaxed) + 1;
    if !universe.is_empty() {
        let idx = (cycles as usize - 1) % universe.len();
        let kind = if (cycles - 1) % 2 == 1 { "earnings" } else { "deep" };
        if let Ok(doc) = research::generate_deep(state, &universe[idx], kind, Some(&provider)).await {
            let _ = db::insert_deep_research(&state.pool, &doc).await;
        }
    }
    *LAST_RUN.lock().unwrap() = Some(Utc::now().to_rfc3339());
    tracing::info!("research worker: cycle complete (#{})", cycles);
}

pub async fn run_once(state: &AppState) -> Value {
    let before = CYCLES.load(Ordering::Relaxed);
    run_cycle(state).await;
    json!({"ran": true, "count": CYCLES.load(Ordering::Relaxed) - before})
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        RUNNING.store(true, Ordering::Relaxed);
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        loop {
            let cfg = get_config(&state).await;
            let interval = cfg["interval_sec"].as_i64().unwrap_or(900).max(30) as u64;
            if !cfg["enabled"].as_bool().unwrap_or(true) {
                RUNNING.store(false, Ordering::Relaxed);
                // Poll for re-enable so PUT {enabled:true} restarts work.
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                RUNNING.store(true, Ordering::Relaxed);
                continue;
            }
            run_cycle(&state).await;
            let mut slept = 0u64;
            while slept < interval {
                if !get_config(&state).await["enabled"].as_bool().unwrap_or(true) {
                    break;
                }
                let chunk = std::cmp::min(10, interval - slept);
                tokio::time::sleep(std::time::Duration::from_secs(chunk)).await;
                slept += chunk;
            }
        }
    });
}

// ---- Realtime websocket -----------------------------------------------------
pub async fn realtime_run(mut socket: WebSocket, state: AppState) {
    loop {
        let watchlist = match db::get_watchlist(&state.pool).await {
            Ok(w) => w,
            Err(_) => vec![],
        };
        let ts = Utc::now().to_rfc3339();
        let snaps = match state.alpaca.get_snapshots(&watchlist).await {
            Ok(s) => s,
            Err(_) => {
                let msg = json!({"type": "status", "message": "Real-time market data temporarily unavailable.", "ts": ts});
                if socket.send(Message::Text(msg.to_string())).await.is_err() {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                continue;
            }
        };
        for sym in &watchlist {
            let snap = &snaps[sym];
            if snap.is_null() {
                continue;
            }
            let price = snap["price"].as_f64().unwrap_or(0.0);
            if price == 0.0 {
                continue;
            }
            let spread = (price * 0.0005).max(0.01);
            let msg = json!({
                "type": "quote",
                "symbol": sym,
                "price": (price * 100.0).round() / 100.0,
                "change_pct": snap["change_pct"].as_f64().unwrap_or(0.0),
                "bid": ((price - spread) * 100.0).round() / 100.0,
                "ask": ((price + spread) * 100.0).round() / 100.0,
                "ts": ts,
            });
            if socket.send(Message::Text(msg.to_string())).await.is_err() {
                return;
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}
