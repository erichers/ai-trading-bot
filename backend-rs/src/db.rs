//! MySQL persistence via sqlx. Reuses the SAME tables as the Python backend.
//! No destructive migrations — only CREATE TABLE IF NOT EXISTS + seed.

use crate::error::ApiResult;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};
use sqlx::mysql::MySqlPool;
use sqlx::Row;

pub const DEFAULT_WATCHLIST: [&str; 6] = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"];

pub const RISK_LIMITS_KEY: &str = "risk_limits";
pub const WORKER_KEY: &str = "research_worker";

fn now_naive() -> NaiveDateTime {
    Utc::now().naive_utc()
}

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn iso(dt: Option<NaiveDateTime>) -> Option<String> {
    dt.map(|d| DateTime::<Utc>::from_naive_utc_and_offset(d, Utc).to_rfc3339())
}

/// Parse an ISO-ish string into a naive UTC datetime.
fn parse_dt(v: &Value) -> Option<NaiveDateTime> {
    let s = v.as_str()?;
    if let Ok(dt) = DateTime::parse_from_rfc3339(&s.replace('Z', "+00:00")) {
        return Some(dt.naive_utc());
    }
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok()
}

pub async fn connect(database_url: &str) -> anyhow::Result<MySqlPool> {
    let pool = MySqlPool::connect(database_url).await?;
    Ok(pool)
}

pub async fn init_db(pool: &MySqlPool) -> anyhow::Result<()> {
    // Tables already exist (created by the Python app). We only ensure they exist
    // in case this is a fresh DB, mirroring the SQLAlchemy schema.
    let ddl = [
        "CREATE TABLE IF NOT EXISTS watchlist (symbol VARCHAR(20) PRIMARY KEY, added_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS settings (`key` VARCHAR(128) PRIMARY KEY, value JSON)",
        "CREATE TABLE IF NOT EXISTS strategies (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255), symbols JSON, timeframe VARCHAR(16), rules JSON, ai_gate JSON, exits JSON, sizing JSON, action JSON, mode VARCHAR(16), enabled BOOLEAN, created_at DATETIME, updated_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS trades (id INT AUTO_INCREMENT PRIMARY KEY, alpaca_order_id VARCHAR(64), client_order_id VARCHAR(64), symbol VARCHAR(32), asset_class VARCHAR(16), side VARCHAR(8), qty FLOAT, order_type VARCHAR(16), order_class VARCHAR(16), time_in_force VARCHAR(8), limit_price FLOAT, stop_price FLOAT, take_profit FLOAT, stop_loss FLOAT, status VARCHAR(32), filled_qty FLOAT, filled_avg_price FLOAT, submitted_at DATETIME, filled_at DATETIME, source VARCHAR(16), strategy_id VARCHAR(64), raw JSON, created_at DATETIME, updated_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS research_analyses (id INT AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(32), thesis TEXT, sentiment_score FLOAT, conviction FLOAT, key_risks JSON, suggested_action VARCHAR(32), suggested_stop FLOAT, suggested_target FLOAT, regime VARCHAR(32), bear_case TEXT, provider VARCHAR(32), model VARCHAR(64), raw JSON, generated_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS signals (id INT AUTO_INCREMENT PRIMARY KEY, strategy_id VARCHAR(64), symbol VARCHAR(32), timeframe VARCHAR(16), fired BOOLEAN, matched JSON, snapshot JSON, created_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS risk_events (id INT AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(32), side VARCHAR(8), qty FLOAT, order_type VARCHAR(16), decision VARCHAR(16), rules JSON, computed JSON, source VARCHAR(16), created_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS briefings (id INT AUTO_INCREMENT PRIMARY KEY, summary TEXT, items JSON, regime VARCHAR(32), generated_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS deep_research (id INT AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(32), kind VARCHAR(24), title VARCHAR(255), body MEDIUMTEXT, data JSON, provider VARCHAR(32), model VARCHAR(64), created_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS bots (id VARCHAR(64) PRIMARY KEY, name VARCHAR(255), enabled BOOLEAN, symbols JSON, kind VARCHAR(32), config JSON, rules JSON, ai_gate JSON, risk JSON, action JSON, mode VARCHAR(16), created_at DATETIME, updated_at DATETIME)",
        "CREATE TABLE IF NOT EXISTS chat_messages (id INT AUTO_INCREMENT PRIMARY KEY, role VARCHAR(16), content TEXT, meta JSON, created_at DATETIME)",
    ];
    for stmt in ddl {
        let _ = sqlx::query(stmt).execute(pool).await;
    }
    // Seed default watchlist if empty.
    let count: i64 = sqlx::query("SELECT COUNT(*) AS c FROM watchlist")
        .fetch_one(pool)
        .await?
        .try_get("c")?;
    if count == 0 {
        for sym in DEFAULT_WATCHLIST {
            let _ = sqlx::query("INSERT INTO watchlist (symbol, added_at) VALUES (?, ?)")
                .bind(sym)
                .bind(now_naive())
                .execute(pool)
                .await;
        }
    }
    seed_default_bot(pool).await?;
    Ok(())
}

// ---- Watchlist --------------------------------------------------------------
pub async fn get_watchlist(pool: &MySqlPool) -> ApiResult<Vec<String>> {
    let rows = sqlx::query("SELECT symbol FROM watchlist ORDER BY added_at ASC")
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(|r| r.get::<String, _>("symbol")).collect())
}

pub async fn add_watchlist(pool: &MySqlPool, symbol: &str) -> ApiResult<Vec<String>> {
    let sym = symbol.trim().to_uppercase();
    let _ = sqlx::query("INSERT IGNORE INTO watchlist (symbol, added_at) VALUES (?, ?)")
        .bind(&sym)
        .bind(now_naive())
        .execute(pool)
        .await?;
    get_watchlist(pool).await
}

pub async fn remove_watchlist(pool: &MySqlPool, symbol: &str) -> ApiResult<Vec<String>> {
    let sym = symbol.trim().to_uppercase();
    let _ = sqlx::query("DELETE FROM watchlist WHERE symbol = ?")
        .bind(&sym)
        .execute(pool)
        .await?;
    get_watchlist(pool).await
}

// ---- Settings ---------------------------------------------------------------
pub async fn get_setting(pool: &MySqlPool, key: &str) -> ApiResult<Option<Value>> {
    let row = sqlx::query("SELECT value FROM settings WHERE `key` = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    Ok(row.and_then(|r| r.try_get::<Value, _>("value").ok()))
}

pub async fn set_setting(pool: &MySqlPool, key: &str, value: &Value) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

// ---- Risk limits ------------------------------------------------------------
pub fn default_limits() -> Value {
    json!({
        "max_position_pct": 20,
        "max_open_positions": 10,
        "max_daily_loss_pct": 5,
        "max_per_trade_risk_pct": 1,
        "max_concentration_pct": 25,
        "min_price": 1,
        "default_risk_per_trade_pct": 1,
        "skip_first_minutes": 5,
        "kill_switch_engaged": false,
    })
}

pub async fn get_risk_limits(pool: &MySqlPool) -> ApiResult<Value> {
    let mut limits = default_limits();
    if let Some(stored) = get_setting(pool, RISK_LIMITS_KEY).await? {
        if let Some(obj) = stored.as_object() {
            for (k, v) in obj {
                limits[k] = v.clone();
            }
        }
    }
    Ok(limits)
}

pub async fn set_risk_limits(pool: &MySqlPool, partial: &Value) -> ApiResult<Value> {
    let mut current = get_risk_limits(pool).await?;
    if let Some(obj) = partial.as_object() {
        for (k, v) in obj {
            if !v.is_null() {
                current[k] = v.clone();
            }
        }
    }
    set_setting(pool, RISK_LIMITS_KEY, &current).await?;
    Ok(current)
}

// ---- Trades -----------------------------------------------------------------
fn trade_row_to_json(r: &sqlx::mysql::MySqlRow) -> Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "alpaca_order_id": r.get::<Option<String>, _>("alpaca_order_id"),
        "client_order_id": r.get::<Option<String>, _>("client_order_id"),
        "symbol": r.get::<Option<String>, _>("symbol"),
        "asset_class": r.get::<Option<String>, _>("asset_class"),
        "side": r.get::<Option<String>, _>("side"),
        "qty": r.get::<Option<f64>, _>("qty"),
        "order_type": r.get::<Option<String>, _>("order_type"),
        "order_class": r.get::<Option<String>, _>("order_class"),
        "time_in_force": r.get::<Option<String>, _>("time_in_force"),
        "limit_price": r.get::<Option<f64>, _>("limit_price"),
        "stop_price": r.get::<Option<f64>, _>("stop_price"),
        "take_profit": r.get::<Option<f64>, _>("take_profit"),
        "stop_loss": r.get::<Option<f64>, _>("stop_loss"),
        "status": r.get::<Option<String>, _>("status"),
        "filled_qty": r.get::<Option<f64>, _>("filled_qty"),
        "filled_avg_price": r.get::<Option<f64>, _>("filled_avg_price"),
        "submitted_at": iso(r.get::<Option<NaiveDateTime>, _>("submitted_at")),
        "filled_at": iso(r.get::<Option<NaiveDateTime>, _>("filled_at")),
        "source": r.get::<Option<String>, _>("source"),
        "strategy_id": r.get::<Option<String>, _>("strategy_id"),
        "raw": r.get::<Option<Value>, _>("raw"),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
        "updated_at": iso(r.get::<Option<NaiveDateTime>, _>("updated_at")),
    })
}

pub async fn insert_trade(pool: &MySqlPool, d: &Value) -> ApiResult<()> {
    let now = now_naive();
    sqlx::query(
        "INSERT INTO trades (alpaca_order_id, client_order_id, symbol, asset_class, side, qty, order_type, order_class, time_in_force, limit_price, stop_price, take_profit, stop_loss, status, filled_qty, filled_avg_price, submitted_at, filled_at, source, strategy_id, raw, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(d["alpaca_order_id"].as_str())
    .bind(d["client_order_id"].as_str())
    .bind(d["symbol"].as_str().map(|s| s.to_uppercase()))
    .bind(d["asset_class"].as_str().unwrap_or("us_equity"))
    .bind(d["side"].as_str())
    .bind(d["qty"].as_f64())
    .bind(d["order_type"].as_str())
    .bind(d["order_class"].as_str())
    .bind(d["time_in_force"].as_str())
    .bind(d["limit_price"].as_f64())
    .bind(d["stop_price"].as_f64())
    .bind(d["take_profit"].as_f64())
    .bind(d["stop_loss"].as_f64())
    .bind(d["status"].as_str())
    .bind(d["filled_qty"].as_f64().unwrap_or(0.0))
    .bind(d["filled_avg_price"].as_f64())
    .bind(parse_dt(&d["submitted_at"]))
    .bind(parse_dt(&d["filled_at"]))
    .bind(d["source"].as_str().unwrap_or("manual"))
    .bind(d["strategy_id"].as_str())
    .bind(if d["raw"].is_null() { None } else { Some(d["raw"].clone()) })
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn upsert_trade_from_alpaca(pool: &MySqlPool, order: &Value) -> ApiResult<()> {
    let aid = order["id"]
        .as_str()
        .or_else(|| order["alpaca_order_id"].as_str());
    if let Some(aid) = aid {
        let existing = sqlx::query("SELECT id FROM trades WHERE alpaca_order_id = ?")
            .bind(aid)
            .fetch_optional(pool)
            .await?;
        if existing.is_some() {
            sqlx::query("UPDATE trades SET status = COALESCE(?, status), updated_at = ? WHERE alpaca_order_id = ?")
                .bind(order["status"].as_str())
                .bind(now_naive())
                .bind(aid)
                .execute(pool)
                .await?;
            return Ok(());
        }
        // insert minimal row
        let now = now_naive();
        sqlx::query("INSERT INTO trades (alpaca_order_id, symbol, asset_class, side, qty, order_type, time_in_force, limit_price, stop_price, status, filled_qty, filled_avg_price, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .bind(aid)
            .bind(order["symbol"].as_str().unwrap_or("").to_uppercase())
            .bind(order["asset_class"].as_str().unwrap_or("us_equity"))
            .bind(order["side"].as_str())
            .bind(order["qty"].as_f64())
            .bind(order["type"].as_str())
            .bind(order["time_in_force"].as_str())
            .bind(order["limit_price"].as_f64())
            .bind(order["stop_price"].as_f64())
            .bind(order["status"].as_str())
            .bind(order["filled_qty"].as_f64().unwrap_or(0.0))
            .bind(order["filled_avg_price"].as_f64())
            .bind("manual")
            .bind(now)
            .bind(now)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn list_trades(
    pool: &MySqlPool,
    status: Option<&str>,
    symbol: Option<&str>,
    limit: i64,
) -> ApiResult<Value> {
    let mut q = String::from("SELECT * FROM trades");
    let mut conds = vec![];
    if status.is_some() {
        conds.push("status = ?");
    }
    if symbol.is_some() {
        conds.push("symbol = ?");
    }
    if !conds.is_empty() {
        q.push_str(" WHERE ");
        q.push_str(&conds.join(" AND "));
    }
    q.push_str(" ORDER BY id DESC LIMIT ?");
    let mut query = sqlx::query(&q);
    if let Some(s) = status {
        query = query.bind(s);
    }
    if let Some(s) = symbol {
        query = query.bind(s.to_uppercase());
    }
    query = query.bind(limit);
    let rows = query.fetch_all(pool).await?;
    Ok(Value::Array(rows.iter().map(trade_row_to_json).collect()))
}

// ---- Research analyses ------------------------------------------------------
fn research_row_to_json(r: &sqlx::mysql::MySqlRow) -> Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "symbol": r.get::<Option<String>, _>("symbol"),
        "thesis": r.get::<Option<String>, _>("thesis"),
        "sentiment_score": r.get::<Option<f64>, _>("sentiment_score"),
        "conviction": r.get::<Option<f64>, _>("conviction"),
        "key_risks": r.get::<Option<Value>, _>("key_risks").unwrap_or(json!([])),
        "suggested_action": r.get::<Option<String>, _>("suggested_action"),
        "suggested_stop": r.get::<Option<f64>, _>("suggested_stop"),
        "suggested_target": r.get::<Option<f64>, _>("suggested_target"),
        "regime": r.get::<Option<String>, _>("regime"),
        "bear_case": r.get::<Option<String>, _>("bear_case"),
        "provider": r.get::<Option<String>, _>("provider"),
        "model": r.get::<Option<String>, _>("model"),
        "generated_at": iso(r.get::<Option<NaiveDateTime>, _>("generated_at")),
    })
}

pub async fn insert_research(pool: &MySqlPool, d: &Value) -> ApiResult<Value> {
    let gen = parse_dt(&d["generated_at"]).unwrap_or_else(now_naive);
    let res = sqlx::query(
        "INSERT INTO research_analyses (symbol, thesis, sentiment_score, conviction, key_risks, suggested_action, suggested_stop, suggested_target, regime, bear_case, provider, model, raw, generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
    .bind(d["thesis"].as_str())
    .bind(d["sentiment_score"].as_f64())
    .bind(d["conviction"].as_f64())
    .bind(if d["key_risks"].is_null() { None } else { Some(d["key_risks"].clone()) })
    .bind(d["suggested_action"].as_str())
    .bind(d["suggested_stop"].as_f64())
    .bind(d["suggested_target"].as_f64())
    .bind(d["regime"].as_str())
    .bind(d["bear_case"].as_str())
    .bind(d["provider"].as_str())
    .bind(d["model"].as_str())
    .bind(Some(d.clone()))
    .bind(gen)
    .execute(pool)
    .await?;
    let id = res.last_insert_id();
    let row = sqlx::query("SELECT * FROM research_analyses WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    Ok(research_row_to_json(&row))
}

pub async fn list_research(pool: &MySqlPool, symbol: Option<&str>, limit: i64) -> ApiResult<Value> {
    let mut q = String::from("SELECT * FROM research_analyses");
    if symbol.is_some() {
        q.push_str(" WHERE symbol = ?");
    }
    q.push_str(" ORDER BY id DESC LIMIT ?");
    let mut query = sqlx::query(&q);
    if let Some(s) = symbol {
        query = query.bind(s.to_uppercase());
    }
    query = query.bind(limit);
    let rows = query.fetch_all(pool).await?;
    Ok(Value::Array(rows.iter().map(research_row_to_json).collect()))
}

// ---- Signals ----------------------------------------------------------------
fn signal_row_to_json(r: &sqlx::mysql::MySqlRow) -> Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "strategy_id": r.get::<Option<String>, _>("strategy_id"),
        "symbol": r.get::<Option<String>, _>("symbol"),
        "timeframe": r.get::<Option<String>, _>("timeframe"),
        "fired": r.get::<Option<bool>, _>("fired").unwrap_or(false),
        "matched": r.get::<Option<Value>, _>("matched").unwrap_or(json!([])),
        "snapshot": r.get::<Option<Value>, _>("snapshot").unwrap_or(json!({})),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
    })
}

pub async fn insert_signal(pool: &MySqlPool, d: &Value) -> ApiResult<Value> {
    let res = sqlx::query(
        "INSERT INTO signals (strategy_id, symbol, timeframe, fired, matched, snapshot, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(d["strategy_id"].as_str())
    .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
    .bind(d["timeframe"].as_str())
    .bind(d["fired"].as_bool().unwrap_or(false))
    .bind(if d["matched"].is_null() { None } else { Some(d["matched"].clone()) })
    .bind(if d["snapshot"].is_null() { None } else { Some(d["snapshot"].clone()) })
    .bind(now_naive())
    .execute(pool)
    .await?;
    let row = sqlx::query("SELECT * FROM signals WHERE id = ?")
        .bind(res.last_insert_id())
        .fetch_one(pool)
        .await?;
    Ok(signal_row_to_json(&row))
}

pub async fn list_signals(pool: &MySqlPool, symbol: Option<&str>, limit: i64) -> ApiResult<Value> {
    let mut q = String::from("SELECT * FROM signals");
    if symbol.is_some() {
        q.push_str(" WHERE symbol = ?");
    }
    q.push_str(" ORDER BY id DESC LIMIT ?");
    let mut query = sqlx::query(&q);
    if let Some(s) = symbol {
        query = query.bind(s.to_uppercase());
    }
    query = query.bind(limit);
    let rows = query.fetch_all(pool).await?;
    Ok(Value::Array(rows.iter().map(signal_row_to_json).collect()))
}

// ---- Risk events ------------------------------------------------------------
fn risk_event_row_to_json(r: &sqlx::mysql::MySqlRow) -> Value {
    json!({
        "id": r.get::<i32, _>("id"),
        "symbol": r.get::<Option<String>, _>("symbol"),
        "side": r.get::<Option<String>, _>("side"),
        "qty": r.get::<Option<f64>, _>("qty"),
        "order_type": r.get::<Option<String>, _>("order_type"),
        "decision": r.get::<Option<String>, _>("decision"),
        "rules": r.get::<Option<Value>, _>("rules").unwrap_or(json!([])),
        "computed": r.get::<Option<Value>, _>("computed").unwrap_or(json!({})),
        "source": r.get::<Option<String>, _>("source"),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
    })
}

pub async fn insert_risk_event(pool: &MySqlPool, d: &Value) -> ApiResult<Value> {
    let res = sqlx::query(
        "INSERT INTO risk_events (symbol, side, qty, order_type, decision, rules, computed, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
    .bind(d["side"].as_str())
    .bind(d["qty"].as_f64())
    .bind(d["order_type"].as_str())
    .bind(d["decision"].as_str().unwrap_or("approved"))
    .bind(Some(if d["rules"].is_null() { json!([]) } else { d["rules"].clone() }))
    .bind(Some(if d["computed"].is_null() { json!({}) } else { d["computed"].clone() }))
    .bind(d["source"].as_str().unwrap_or("manual"))
    .bind(now_naive())
    .execute(pool)
    .await?;
    let row = sqlx::query("SELECT * FROM risk_events WHERE id = ?")
        .bind(res.last_insert_id())
        .fetch_one(pool)
        .await?;
    Ok(risk_event_row_to_json(&row))
}

pub async fn list_risk_events(pool: &MySqlPool, limit: i64) -> ApiResult<Value> {
    let rows = sqlx::query("SELECT * FROM risk_events ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(Value::Array(rows.iter().map(risk_event_row_to_json).collect()))
}

// ---- Briefings --------------------------------------------------------------
pub async fn insert_briefing(pool: &MySqlPool, d: &Value) -> ApiResult<()> {
    let gen = parse_dt(&d["generated_at"]).unwrap_or_else(now_naive);
    sqlx::query("INSERT INTO briefings (summary, items, regime, generated_at) VALUES (?,?,?,?)")
        .bind(d["summary"].as_str())
        .bind(if d["items"].is_null() { None } else { Some(d["items"].clone()) })
        .bind(d["regime"].as_str())
        .bind(gen)
        .execute(pool)
        .await?;
    Ok(())
}

// ---- Deep research ----------------------------------------------------------
fn deep_row_to_json(r: &sqlx::mysql::MySqlRow, summary_len: usize) -> Value {
    let body = r.get::<Option<String>, _>("body").unwrap_or_default();
    let summary = make_summary(&body, summary_len);
    json!({
        "id": r.get::<i32, _>("id"),
        "symbol": r.get::<Option<String>, _>("symbol"),
        "kind": r.get::<Option<String>, _>("kind"),
        "title": r.get::<Option<String>, _>("title"),
        "body": body,
        "summary": summary,
        "data": r.get::<Option<Value>, _>("data").unwrap_or(json!({})),
        "provider": r.get::<Option<String>, _>("provider"),
        "model": r.get::<Option<String>, _>("model"),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
    })
}

fn make_summary(body: &str, n: usize) -> String {
    let chars: Vec<char> = body.chars().collect();
    if chars.len() > n {
        let s: String = chars[..n].iter().collect();
        format!("{}…", s.trim_end())
    } else {
        body.to_string()
    }
}

pub async fn insert_deep_research(pool: &MySqlPool, d: &Value) -> ApiResult<Value> {
    let created = parse_dt(&d["created_at"]).unwrap_or_else(now_naive);
    let res = sqlx::query(
        "INSERT INTO deep_research (symbol, kind, title, body, data, provider, model, created_at) VALUES (?,?,?,?,?,?,?,?)",
    )
    .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
    .bind(d["kind"].as_str().unwrap_or("analysis"))
    .bind(d["title"].as_str())
    .bind(d["body"].as_str())
    .bind(if d["data"].is_null() { None } else { Some(d["data"].clone()) })
    .bind(d["provider"].as_str())
    .bind(d["model"].as_str())
    .bind(created)
    .execute(pool)
    .await?;
    let row = sqlx::query("SELECT * FROM deep_research WHERE id = ?")
        .bind(res.last_insert_id())
        .fetch_one(pool)
        .await?;
    Ok(deep_row_to_json(&row, 280))
}

pub async fn list_deep_research(
    pool: &MySqlPool,
    symbol: Option<&str>,
    kind: Option<&str>,
    limit: i64,
) -> ApiResult<Value> {
    let mut q = String::from("SELECT * FROM deep_research");
    let mut conds = vec![];
    if symbol.is_some() {
        conds.push("symbol = ?");
    }
    if kind.is_some() {
        conds.push("kind = ?");
    }
    if !conds.is_empty() {
        q.push_str(" WHERE ");
        q.push_str(&conds.join(" AND "));
    }
    q.push_str(" ORDER BY id DESC LIMIT ?");
    let mut query = sqlx::query(&q);
    if let Some(s) = symbol {
        query = query.bind(s.to_uppercase());
    }
    if let Some(k) = kind {
        query = query.bind(k);
    }
    query = query.bind(limit);
    let rows = query.fetch_all(pool).await?;
    Ok(Value::Array(
        rows.iter().map(|r| deep_row_to_json(r, 280)).collect(),
    ))
}

pub async fn get_deep_research(pool: &MySqlPool, id: i64) -> ApiResult<Option<Value>> {
    let row = sqlx::query("SELECT * FROM deep_research WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| deep_row_to_json(&r, 280)))
}

pub async fn count_deep_research_today(pool: &MySqlPool) -> ApiResult<i64> {
    let start = Utc::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap();
    let c: i64 = sqlx::query("SELECT COUNT(*) AS c FROM deep_research WHERE created_at >= ?")
        .bind(start)
        .fetch_one(pool)
        .await?
        .try_get("c")?;
    Ok(c)
}

// ---- Strategies -------------------------------------------------------------
pub fn default_equity_action() -> Value {
    json!({"asset": "equity", "side": "buy"})
}
pub fn default_option_action() -> Value {
    json!({"asset": "option", "right": "auto", "moneyness": "ATM", "otm_strikes": 1, "expiry": "nearest_weekly", "contract_symbol": null})
}

fn strategy_row_to_json(r: &sqlx::mysql::MySqlRow) -> Value {
    let action = r.get::<Option<Value>, _>("action");
    json!({
        "id": r.get::<String, _>("id"),
        "name": r.get::<Option<String>, _>("name"),
        "symbols": r.get::<Option<Value>, _>("symbols").unwrap_or(json!([])),
        "timeframe": r.get::<Option<String>, _>("timeframe"),
        "rules": r.get::<Option<Value>, _>("rules").unwrap_or(json!([])),
        "ai_gate": r.get::<Option<Value>, _>("ai_gate").unwrap_or(json!({})),
        "exits": r.get::<Option<Value>, _>("exits").unwrap_or(json!({})),
        "sizing": r.get::<Option<Value>, _>("sizing").unwrap_or(json!({})),
        "action": action.filter(|v| !v.is_null()).unwrap_or_else(default_equity_action),
        "mode": r.get::<Option<String>, _>("mode"),
        "enabled": r.get::<Option<bool>, _>("enabled").unwrap_or(true),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
        "updated_at": iso(r.get::<Option<NaiveDateTime>, _>("updated_at")),
    })
}

pub async fn list_strategies(pool: &MySqlPool) -> ApiResult<Value> {
    let rows = sqlx::query("SELECT * FROM strategies ORDER BY updated_at DESC")
        .fetch_all(pool)
        .await?;
    Ok(Value::Array(rows.iter().map(strategy_row_to_json).collect()))
}

pub async fn get_strategy(pool: &MySqlPool, id: &str) -> ApiResult<Option<Value>> {
    let row = sqlx::query("SELECT * FROM strategies WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| strategy_row_to_json(&r)))
}

pub async fn create_strategy(pool: &MySqlPool, s: &Value) -> ApiResult<Value> {
    let id = s["id"].as_str().map(|x| x.to_string()).unwrap_or_else(uid);
    let now = now_naive();
    let action = if s["action"].is_null() {
        default_equity_action()
    } else {
        s["action"].clone()
    };
    sqlx::query(
        "INSERT INTO strategies (id, name, symbols, timeframe, rules, ai_gate, exits, sizing, action, mode, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(s["name"].as_str().unwrap_or(""))
    .bind(s["symbols"].clone())
    .bind(s["timeframe"].as_str().unwrap_or("1Day"))
    .bind(s["rules"].clone())
    .bind(s["ai_gate"].clone())
    .bind(s["exits"].clone())
    .bind(s["sizing"].clone())
    .bind(action)
    .bind(s["mode"].as_str().unwrap_or("signal"))
    .bind(s["enabled"].as_bool().unwrap_or(true))
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(get_strategy(pool, &id).await?.unwrap())
}

pub async fn update_strategy(pool: &MySqlPool, id: &str, s: &Value) -> ApiResult<Option<Value>> {
    if get_strategy(pool, id).await?.is_none() {
        return Ok(None);
    }
    for (field, col) in [
        ("name", "name"),
        ("timeframe", "timeframe"),
        ("mode", "mode"),
    ] {
        if let Some(v) = s.get(field).and_then(|v| v.as_str()) {
            sqlx::query(&format!("UPDATE strategies SET {col} = ? WHERE id = ?"))
                .bind(v)
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    for field in ["symbols", "rules", "ai_gate", "exits", "sizing", "action"] {
        if let Some(v) = s.get(field) {
            if !v.is_null() {
                sqlx::query(&format!("UPDATE strategies SET {field} = ? WHERE id = ?"))
                    .bind(v.clone())
                    .bind(id)
                    .execute(pool)
                    .await?;
            }
        }
    }
    if let Some(v) = s.get("enabled").and_then(|v| v.as_bool()) {
        sqlx::query("UPDATE strategies SET enabled = ? WHERE id = ?")
            .bind(v)
            .bind(id)
            .execute(pool)
            .await?;
    }
    sqlx::query("UPDATE strategies SET updated_at = ? WHERE id = ?")
        .bind(now_naive())
        .bind(id)
        .execute(pool)
        .await?;
    get_strategy(pool, id).await
}

pub async fn delete_strategy(pool: &MySqlPool, id: &str) -> ApiResult<bool> {
    let res = sqlx::query("DELETE FROM strategies WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

// ---- Bots -------------------------------------------------------------------
pub const DEFAULT_BOT_SYMBOLS: [&str; 5] = ["QQQ", "SPY", "TSLA", "META", "NVDA"];

fn default_bot_config() -> Value {
    json!({"direction": "research", "side": "auto", "expiry": "nearest_weekly", "strike": "ATM", "target_delta": 0.4, "contracts": 1, "max_premium": 1500})
}

fn bot_row_to_json(r: &sqlx::mysql::MySqlRow) -> Value {
    let action = r.get::<Option<Value>, _>("action");
    json!({
        "id": r.get::<String, _>("id"),
        "name": r.get::<Option<String>, _>("name"),
        "enabled": r.get::<Option<bool>, _>("enabled").unwrap_or(true),
        "symbols": r.get::<Option<Value>, _>("symbols").unwrap_or(json!([])),
        "kind": r.get::<Option<String>, _>("kind"),
        "config": r.get::<Option<Value>, _>("config").unwrap_or(json!({})),
        "rules": r.get::<Option<Value>, _>("rules").unwrap_or(json!([])),
        "ai_gate": r.get::<Option<Value>, _>("ai_gate").unwrap_or(json!({})),
        "risk": r.get::<Option<Value>, _>("risk").unwrap_or(json!({})),
        "action": action.filter(|v| !v.is_null()).unwrap_or_else(default_option_action),
        "mode": r.get::<Option<String>, _>("mode"),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
        "updated_at": iso(r.get::<Option<NaiveDateTime>, _>("updated_at")),
    })
}

pub async fn list_bots(pool: &MySqlPool) -> ApiResult<Value> {
    let rows = sqlx::query("SELECT * FROM bots ORDER BY created_at ASC")
        .fetch_all(pool)
        .await?;
    Ok(Value::Array(rows.iter().map(bot_row_to_json).collect()))
}

pub async fn get_bot(pool: &MySqlPool, id: &str) -> ApiResult<Option<Value>> {
    let row = sqlx::query("SELECT * FROM bots WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|r| bot_row_to_json(&r)))
}

pub async fn create_bot(pool: &MySqlPool, b: &Value) -> ApiResult<Value> {
    let id = b["id"].as_str().map(|x| x.to_string()).unwrap_or_else(uid);
    let now = now_naive();
    let symbols = if b["symbols"].is_null() || b["symbols"].as_array().map(|a| a.is_empty()).unwrap_or(true) {
        json!(DEFAULT_BOT_SYMBOLS)
    } else {
        b["symbols"].clone()
    };
    let mut config = default_bot_config();
    if let Some(obj) = b["config"].as_object() {
        for (k, v) in obj {
            config[k] = v.clone();
        }
    }
    let action = if b["action"].is_null() {
        default_option_action()
    } else {
        b["action"].clone()
    };
    sqlx::query(
        "INSERT INTO bots (id, name, enabled, symbols, kind, config, rules, ai_gate, risk, action, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(b["name"].as_str().unwrap_or("Bot"))
    .bind(b["enabled"].as_bool().unwrap_or(true))
    .bind(symbols)
    .bind(b["kind"].as_str().unwrap_or("options_weekly"))
    .bind(config)
    .bind(if b["rules"].is_null() { json!([]) } else { b["rules"].clone() })
    .bind(if b["ai_gate"].is_null() { json!({"enabled": true, "min_conviction": 60}) } else { b["ai_gate"].clone() })
    .bind(if b["risk"].is_null() { json!({"risk_per_trade_pct": 1}) } else { b["risk"].clone() })
    .bind(action)
    .bind(b["mode"].as_str().unwrap_or("signal"))
    .bind(now)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(get_bot(pool, &id).await?.unwrap())
}

pub async fn update_bot(pool: &MySqlPool, id: &str, b: &Value) -> ApiResult<Option<Value>> {
    if get_bot(pool, id).await?.is_none() {
        return Ok(None);
    }
    if let Some(v) = b.get("name").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE bots SET name = ? WHERE id = ?").bind(v).bind(id).execute(pool).await?;
    }
    if let Some(v) = b.get("kind").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE bots SET kind = ? WHERE id = ?").bind(v).bind(id).execute(pool).await?;
    }
    if let Some(v) = b.get("mode").and_then(|v| v.as_str()) {
        sqlx::query("UPDATE bots SET mode = ? WHERE id = ?").bind(v).bind(id).execute(pool).await?;
    }
    if let Some(v) = b.get("enabled").and_then(|v| v.as_bool()) {
        sqlx::query("UPDATE bots SET enabled = ? WHERE id = ?").bind(v).bind(id).execute(pool).await?;
    }
    for field in ["symbols", "config", "rules", "ai_gate", "risk", "action"] {
        if let Some(v) = b.get(field) {
            if !v.is_null() {
                sqlx::query(&format!("UPDATE bots SET {field} = ? WHERE id = ?"))
                    .bind(v.clone())
                    .bind(id)
                    .execute(pool)
                    .await?;
            }
        }
    }
    sqlx::query("UPDATE bots SET updated_at = ? WHERE id = ?")
        .bind(now_naive())
        .bind(id)
        .execute(pool)
        .await?;
    get_bot(pool, id).await
}

pub async fn delete_bot(pool: &MySqlPool, id: &str) -> ApiResult<bool> {
    let res = sqlx::query("DELETE FROM bots WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn seed_default_bot(pool: &MySqlPool) -> ApiResult<()> {
    let c: i64 = sqlx::query("SELECT COUNT(*) AS c FROM bots")
        .fetch_one(pool)
        .await?
        .try_get("c")?;
    if c > 0 {
        return Ok(());
    }
    create_bot(
        pool,
        &json!({
            "name": "Weekly Options — Megacap",
            "symbols": DEFAULT_BOT_SYMBOLS,
            "kind": "options_weekly",
            "config": default_bot_config(),
            "rules": [],
            "ai_gate": {"enabled": true, "min_conviction": 60},
            "risk": {"risk_per_trade_pct": 1},
            "mode": "signal",
        }),
    )
    .await?;
    Ok(())
}

// ---- Chat -------------------------------------------------------------------
pub async fn insert_chat_message(pool: &MySqlPool, role: &str, content: &str, meta: &Value) -> ApiResult<()> {
    sqlx::query("INSERT INTO chat_messages (role, content, meta, created_at) VALUES (?,?,?,?)")
        .bind(role)
        .bind(content)
        .bind(meta.clone())
        .bind(now_naive())
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn list_chat_messages(pool: &MySqlPool, limit: i64) -> ApiResult<Value> {
    let rows = sqlx::query("SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .fetch_all(pool)
        .await?;
    let mut out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<i32, _>("id"),
                "role": r.get::<Option<String>, _>("role"),
                "content": r.get::<Option<String>, _>("content"),
                "meta": r.get::<Option<Value>, _>("meta").unwrap_or(json!({})),
                "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
            })
        })
        .collect();
    out.reverse();
    Ok(Value::Array(out))
}

// ---- Read-only SQL for chat -------------------------------------------------
pub async fn run_readonly_sql(pool: &MySqlPool, sql: &str) -> ApiResult<Value> {
    use sqlx::Column;
    let rows = sqlx::query(sql).fetch_all(pool).await?;
    let mut columns: Vec<String> = vec![];
    if let Some(first) = rows.first() {
        columns = first.columns().iter().map(|c| c.name().to_string()).collect();
    }
    let mut out_rows = vec![];
    for r in &rows {
        let mut obj = serde_json::Map::new();
        for (i, col) in columns.iter().enumerate() {
            // Try common types in order.
            let val: Value = r
                .try_get::<Option<i64>, _>(i)
                .map(|v| v.map(Value::from).unwrap_or(Value::Null))
                .or_else(|_| r.try_get::<Option<f64>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
                .or_else(|_| {
                    r.try_get::<Option<NaiveDateTime>, _>(i)
                        .map(|v| v.map(|d| Value::from(DateTime::<Utc>::from_naive_utc_and_offset(d, Utc).to_rfc3339())).unwrap_or(Value::Null))
                })
                .or_else(|_| r.try_get::<Option<bool>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
                .or_else(|_| r.try_get::<Option<Value>, _>(i).map(|v| v.unwrap_or(Value::Null)))
                .or_else(|_| r.try_get::<Option<String>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
                .unwrap_or(Value::Null);
            obj.insert(col.clone(), val);
        }
        out_rows.push(Value::Object(obj));
    }
    Ok(json!({"columns": columns, "rows": out_rows}))
}
