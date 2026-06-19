//! Autonomous bot scheduler.
//!
//! Evaluates ENABLED bots on their timeframe cadence, gated by market hours and
//! the master failsafes, and places orders only for `auto` bots. `semi` bots are
//! evaluated and their signals recorded for manual confirmation; `signal` bots
//! just record. Disabled by default — autonomous trading must be turned on
//! deliberately. All placement still flows through run_bot, so every failsafe
//! (kill switch, trading master switch, daily entry cap, risk vetoes) applies.

use crate::bots;
use crate::db;
use crate::state::AppState;
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

const KEY: &str = "bot_worker";

static RUNNING: AtomicBool = AtomicBool::new(false);
static TICKS: AtomicU64 = AtomicU64::new(0);
static PLACED: AtomicU64 = AtomicU64::new(0);
static LAST_TICK: Mutex<Option<String>> = Mutex::new(None);
static LAST_NOTE: Mutex<Option<String>> = Mutex::new(None);
static LAST_RUN: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None); // bot id -> unix secs

fn default_config() -> Value {
    // DISABLED by default — the user must opt into autonomous trading.
    json!({ "enabled": false, "interval_sec": 60 })
}

fn timeframe_secs(tf: &str) -> i64 {
    match tf {
        "1Min" => 60,
        "5Min" => 300,
        "15Min" => 900,
        "30Min" => 1800,
        "1Hour" => 3600,
        "1Day" => 86_400,
        _ => 300,
    }
}

pub async fn get_config(state: &AppState) -> Value {
    let mut cfg = default_config();
    if let Ok(Some(stored)) = db::get_setting(&state.pool, KEY).await {
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
    let _ = db::set_setting(&state.pool, KEY, &cfg).await;
    cfg
}

pub async fn status(state: &AppState) -> Value {
    let cfg = get_config(state).await;
    json!({
        "enabled": cfg["enabled"].as_bool().unwrap_or(false),
        "interval_sec": cfg["interval_sec"].as_i64().unwrap_or(60),
        "running": RUNNING.load(Ordering::Relaxed),
        "market_open": state.alpaca.market_open().await,
        "ticks": TICKS.load(Ordering::Relaxed),
        "orders_placed": PLACED.load(Ordering::Relaxed),
        "last_tick": LAST_TICK.lock().unwrap().clone(),
        "last_note": LAST_NOTE.lock().unwrap().clone(),
    })
}

async fn run_cycle(state: &AppState) {
    TICKS.fetch_add(1, Ordering::Relaxed);
    *LAST_TICK.lock().unwrap() = Some(Utc::now().to_rfc3339());

    // Master failsafes first.
    let limits = db::get_risk_limits(&state.pool)
        .await
        .unwrap_or_else(|_| db::default_limits());
    if !limits["trading_enabled"].as_bool().unwrap_or(true)
        || limits["kill_switch_engaged"].as_bool().unwrap_or(false)
    {
        *LAST_NOTE.lock().unwrap() = Some("Idle — trading failsafe active.".into());
        return;
    }
    if !state.alpaca.market_open().await {
        *LAST_NOTE.lock().unwrap() = Some("Idle — market closed.".into());
        return;
    }

    let bots_v = db::list_bots(&state.pool).await.unwrap_or_else(|_| json!([]));
    let now = Utc::now().timestamp();
    let mut evaluated = 0usize;
    let mut placed = 0usize;
    let empty = vec![];
    for bot in bots_v.as_array().unwrap_or(&empty) {
        if !bot["enabled"].as_bool().unwrap_or(false) {
            continue;
        }
        let id = bot["id"].as_str().unwrap_or("").to_string();
        if id.is_empty() {
            continue;
        }
        let tf = bot["config"]["timeframe"]
            .as_str()
            .or_else(|| bot["timeframe"].as_str())
            .unwrap_or("5Min");
        let cadence = timeframe_secs(tf);
        {
            let mut guard = LAST_RUN.lock().unwrap();
            let map = guard.get_or_insert_with(HashMap::new);
            let last = map.get(&id).copied().unwrap_or(0);
            if now - last < cadence {
                continue;
            }
            map.insert(id.clone(), now);
        }
        // auto → place; semi/signal → evaluate & record only (await manual confirm).
        let mode = bot["mode"].as_str().unwrap_or("signal").to_lowercase();
        let place = mode == "auto";
        let res = bots::run_bot(state, bot, place).await;
        evaluated += 1;
        placed += res["placed"].as_array().map(|a| a.len()).unwrap_or(0);
    }
    PLACED.fetch_add(placed as u64, Ordering::Relaxed);
    *LAST_NOTE.lock().unwrap() = Some(format!(
        "Evaluated {evaluated} enabled bot(s); placed {placed} order(s)."
    ));
}

pub async fn run_once(state: &AppState) -> Value {
    run_cycle(state).await;
    status(state).await
}

pub fn start(state: AppState) {
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        loop {
            let cfg = get_config(&state).await;
            let interval = cfg["interval_sec"].as_i64().unwrap_or(60).max(30) as u64;
            if cfg["enabled"].as_bool().unwrap_or(false) {
                RUNNING.store(true, Ordering::Relaxed);
                run_cycle(&state).await;
            } else {
                RUNNING.store(false, Ordering::Relaxed);
            }
            // Sleep in small chunks so toggling `enabled` takes effect quickly.
            let mut slept = 0u64;
            while slept < interval {
                let chunk = std::cmp::min(5, interval - slept);
                tokio::time::sleep(std::time::Duration::from_secs(chunk)).await;
                slept += chunk;
            }
        }
    });
}
