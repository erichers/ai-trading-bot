//! Persistence via sqlx. Dispatches between MySQL (web, default) and SQLite (native app).
//! Reuses the SAME logical tables as the Python backend.
//! No destructive migrations — only CREATE TABLE IF NOT EXISTS + seed.

use crate::database::Db;
use crate::error::ApiResult;
use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{json, Value};
use sqlx::Row;

pub const DEFAULT_WATCHLIST: [&str; 6] = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"];

pub const RISK_LIMITS_KEY: &str = "risk_limits";
pub const WORKER_KEY: &str = "research_worker";

fn now_naive() -> NaiveDateTime {
    Utc::now().naive_utc()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
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

/// Parse a datetime *value* (Value::String) into an ISO-8601 string for SQLite storage.
fn parse_dt_iso(v: &Value) -> Option<String> {
    parse_dt(v).map(|d| DateTime::<Utc>::from_naive_utc_and_offset(d, Utc).to_rfc3339())
}

/// Serialize a JSON value to a TEXT string for SQLite (None when null).
fn json_text(v: &Value) -> Option<String> {
    if v.is_null() {
        None
    } else {
        Some(v.to_string())
    }
}

// ---- SQLite row JSON helpers ------------------------------------------------
// SQLite stores JSON as TEXT, so read a column as Option<String> and parse it.
fn sq_json(r: &sqlx::sqlite::SqliteRow, col: &str, default: Value) -> Value {
    let s: Option<String> = r.try_get(col).ok().flatten();
    match s {
        Some(t) if !t.is_empty() => serde_json::from_str(&t).unwrap_or(default),
        _ => default,
    }
}

fn sq_str(r: &sqlx::sqlite::SqliteRow, col: &str) -> Option<String> {
    r.try_get(col).ok().flatten()
}

fn sq_f64(r: &sqlx::sqlite::SqliteRow, col: &str) -> Option<f64> {
    r.try_get(col).ok().flatten()
}

fn sq_i64(r: &sqlx::sqlite::SqliteRow, col: &str) -> i64 {
    r.try_get(col).ok().unwrap_or(0)
}

fn sq_bool(r: &sqlx::sqlite::SqliteRow, col: &str) -> Option<bool> {
    let v: Option<i64> = r.try_get(col).ok().flatten();
    v.map(|x| x != 0)
}

// =============================================================================
// Connect + init
// =============================================================================
pub async fn connect_mysql(database_url: &str) -> anyhow::Result<MySqlPoolAlias> {
    let pool = sqlx::mysql::MySqlPool::connect(database_url).await?;
    Ok(pool)
}
pub type MySqlPoolAlias = sqlx::mysql::MySqlPool;

pub async fn connect_sqlite(path: &str) -> anyhow::Result<sqlx::sqlite::SqlitePool> {
    use sqlx::sqlite::SqliteConnectOptions;
    use std::str::FromStr;
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
        .create_if_missing(true)
        .busy_timeout(std::time::Duration::from_secs(10));
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

pub async fn init_db(db: &Db) -> anyhow::Result<()> {
    match db {
        Db::My(pool) => init_mysql(pool).await,
        Db::Sq(pool) => init_sqlite(pool).await,
    }
}

async fn init_mysql(pool: &sqlx::mysql::MySqlPool) -> anyhow::Result<()> {
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
        "CREATE TABLE IF NOT EXISTS rag_documents (id INT AUTO_INCREMENT PRIMARY KEY, source_table VARCHAR(48), source_id VARCHAR(96), doc_text TEXT, embedding LONGTEXT, metadata JSON, source_updated_at VARCHAR(48), updated_at DATETIME, UNIQUE KEY uq_rag_src (source_table, source_id))",
    ];
    for stmt in ddl {
        let _ = sqlx::query(stmt).execute(pool).await;
    }
    // Migration-safe ALTERs (ignore errors if column already exists).
    for alter in [
        "ALTER TABLE bots ADD COLUMN last_evaluated_at DATETIME NULL",
        "ALTER TABLE bots ADD COLUMN last_result JSON NULL",
        // updated_at on settings enables last-write-wins sync across web/native.
        "ALTER TABLE settings ADD COLUMN updated_at DATETIME NULL",
    ] {
        let _ = sqlx::query(alter).execute(pool).await;
    }
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
    seed_default_bot(&Db::My(pool.clone())).await?;
    Ok(())
}

async fn init_sqlite(pool: &sqlx::sqlite::SqlitePool) -> anyhow::Result<()> {
    // SQLite DDL: INTEGER PRIMARY KEY AUTOINCREMENT for auto-id; TEXT for
    // VARCHAR/TEXT/MEDIUMTEXT/JSON/DATETIME; REAL for FLOAT; INTEGER for BOOLEAN.
    let ddl = [
        "CREATE TABLE IF NOT EXISTS watchlist (symbol TEXT PRIMARY KEY, added_at TEXT)",
        "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)",
        "CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, name TEXT, symbols TEXT, timeframe TEXT, rules TEXT, ai_gate TEXT, exits TEXT, sizing TEXT, action TEXT, mode TEXT, enabled INTEGER, created_at TEXT, updated_at TEXT)",
        "CREATE TABLE IF NOT EXISTS trades (id INTEGER PRIMARY KEY AUTOINCREMENT, alpaca_order_id TEXT, client_order_id TEXT, symbol TEXT, asset_class TEXT, side TEXT, qty REAL, order_type TEXT, order_class TEXT, time_in_force TEXT, limit_price REAL, stop_price REAL, take_profit REAL, stop_loss REAL, status TEXT, filled_qty REAL, filled_avg_price REAL, submitted_at TEXT, filled_at TEXT, source TEXT, strategy_id TEXT, raw TEXT, created_at TEXT, updated_at TEXT)",
        "CREATE TABLE IF NOT EXISTS research_analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, thesis TEXT, sentiment_score REAL, conviction REAL, key_risks TEXT, suggested_action TEXT, suggested_stop REAL, suggested_target REAL, regime TEXT, bear_case TEXT, provider TEXT, model TEXT, raw TEXT, generated_at TEXT)",
        "CREATE TABLE IF NOT EXISTS signals (id INTEGER PRIMARY KEY AUTOINCREMENT, strategy_id TEXT, symbol TEXT, timeframe TEXT, fired INTEGER, matched TEXT, snapshot TEXT, created_at TEXT)",
        "CREATE TABLE IF NOT EXISTS risk_events (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, side TEXT, qty REAL, order_type TEXT, decision TEXT, rules TEXT, computed TEXT, source TEXT, created_at TEXT)",
        "CREATE TABLE IF NOT EXISTS briefings (id INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, items TEXT, regime TEXT, generated_at TEXT)",
        "CREATE TABLE IF NOT EXISTS deep_research (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT, kind TEXT, title TEXT, body TEXT, data TEXT, provider TEXT, model TEXT, created_at TEXT)",
        "CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, symbols TEXT, kind TEXT, config TEXT, rules TEXT, ai_gate TEXT, risk TEXT, action TEXT, mode TEXT, created_at TEXT, updated_at TEXT)",
        "CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, meta TEXT, created_at TEXT)",
        "CREATE TABLE IF NOT EXISTS rag_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, source_table TEXT, source_id TEXT, doc_text TEXT, embedding TEXT, metadata TEXT, source_updated_at TEXT, updated_at TEXT)",
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_rag_src ON rag_documents (source_table, source_id)",
    ];
    for stmt in ddl {
        sqlx::query(stmt).execute(pool).await?;
    }
    // Migration-safe ALTERs (ignore errors if column already exists).
    for alter in [
        "ALTER TABLE bots ADD COLUMN last_evaluated_at TEXT",
        "ALTER TABLE bots ADD COLUMN last_result TEXT",
        // updated_at on settings enables last-write-wins sync across web/native.
        "ALTER TABLE settings ADD COLUMN updated_at TEXT",
    ] {
        let _ = sqlx::query(alter).execute(pool).await;
    }
    let count: i64 = sqlx::query("SELECT COUNT(*) AS c FROM watchlist")
        .fetch_one(pool)
        .await?
        .try_get("c")?;
    if count == 0 {
        for sym in DEFAULT_WATCHLIST {
            let _ = sqlx::query("INSERT INTO watchlist (symbol, added_at) VALUES (?, ?)")
                .bind(sym)
                .bind(now_iso())
                .execute(pool)
                .await;
        }
    }
    seed_default_bot(&Db::Sq(pool.clone())).await?;
    Ok(())
}

// =============================================================================
// Watchlist
// =============================================================================
pub async fn get_watchlist(db: &Db) -> ApiResult<Vec<String>> {
    match db {
        Db::My(pool) => {
            let rows = sqlx::query("SELECT symbol FROM watchlist ORDER BY added_at ASC")
                .fetch_all(pool)
                .await?;
            Ok(rows.iter().map(|r| r.get::<String, _>("symbol")).collect())
        }
        Db::Sq(pool) => {
            let rows = sqlx::query("SELECT symbol FROM watchlist ORDER BY added_at ASC")
                .fetch_all(pool)
                .await?;
            Ok(rows.iter().map(|r| r.get::<String, _>("symbol")).collect())
        }
    }
}

pub async fn add_watchlist(db: &Db, symbol: &str) -> ApiResult<Vec<String>> {
    let sym = symbol.trim().to_uppercase();
    match db {
        Db::My(pool) => {
            let _ = sqlx::query("INSERT IGNORE INTO watchlist (symbol, added_at) VALUES (?, ?)")
                .bind(&sym)
                .bind(now_naive())
                .execute(pool)
                .await?;
        }
        Db::Sq(pool) => {
            let _ = sqlx::query("INSERT OR IGNORE INTO watchlist (symbol, added_at) VALUES (?, ?)")
                .bind(&sym)
                .bind(now_iso())
                .execute(pool)
                .await?;
        }
    }
    get_watchlist(db).await
}

pub async fn remove_watchlist(db: &Db, symbol: &str) -> ApiResult<Vec<String>> {
    let sym = symbol.trim().to_uppercase();
    match db {
        Db::My(pool) => {
            let _ = sqlx::query("DELETE FROM watchlist WHERE symbol = ?")
                .bind(&sym)
                .execute(pool)
                .await?;
        }
        Db::Sq(pool) => {
            let _ = sqlx::query("DELETE FROM watchlist WHERE symbol = ?")
                .bind(&sym)
                .execute(pool)
                .await?;
        }
    }
    get_watchlist(db).await
}

// =============================================================================
// Settings
// =============================================================================
pub async fn get_setting(db: &Db, key: &str) -> ApiResult<Option<Value>> {
    match db {
        Db::My(pool) => {
            let row = sqlx::query("SELECT value FROM settings WHERE `key` = ?")
                .bind(key)
                .fetch_optional(pool)
                .await?;
            Ok(row.and_then(|r| r.try_get::<Value, _>("value").ok()))
        }
        Db::Sq(pool) => {
            let row = sqlx::query("SELECT value FROM settings WHERE key = ?")
                .bind(key)
                .fetch_optional(pool)
                .await?;
            Ok(row.and_then(|r| {
                r.try_get::<Option<String>, _>("value")
                    .ok()
                    .flatten()
                    .and_then(|s| serde_json::from_str(&s).ok())
            }))
        }
    }
}

pub async fn set_setting(db: &Db, key: &str, value: &Value) -> ApiResult<()> {
    match db {
        Db::My(pool) => {
            sqlx::query(
                "INSERT INTO settings (`key`, value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)",
            )
            .bind(key)
            .bind(value)
            .bind(now_naive())
            .execute(pool)
            .await?;
        }
        Db::Sq(pool) => {
            sqlx::query(
                "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            )
            .bind(key)
            .bind(value.to_string())
            .bind(now_iso())
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

// =============================================================================
// Risk limits
// =============================================================================
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
        // Master failsafe: when false, ALL new entries are blocked by the risk engine.
        "trading_enabled": true,
        // Failsafe: hard cap on orders placed per UTC day (runaway-bot backstop). 0 = no cap.
        "max_orders_per_day": 50,
    })
}

pub async fn get_risk_limits(db: &Db) -> ApiResult<Value> {
    let mut limits = default_limits();
    if let Some(stored) = get_setting(db, RISK_LIMITS_KEY).await? {
        if let Some(obj) = stored.as_object() {
            for (k, v) in obj {
                limits[k] = v.clone();
            }
        }
    }
    Ok(limits)
}

pub async fn set_risk_limits(db: &Db, partial: &Value) -> ApiResult<Value> {
    let mut current = get_risk_limits(db).await?;
    if let Some(obj) = partial.as_object() {
        for (k, v) in obj {
            if !v.is_null() {
                current[k] = v.clone();
            }
        }
    }
    set_setting(db, RISK_LIMITS_KEY, &current).await?;
    Ok(current)
}

// =============================================================================
// Trades
// =============================================================================
fn trade_row_to_json_my(r: &sqlx::mysql::MySqlRow) -> Value {
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

fn trade_row_to_json_sq(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": sq_i64(r, "id"),
        "alpaca_order_id": sq_str(r, "alpaca_order_id"),
        "client_order_id": sq_str(r, "client_order_id"),
        "symbol": sq_str(r, "symbol"),
        "asset_class": sq_str(r, "asset_class"),
        "side": sq_str(r, "side"),
        "qty": sq_f64(r, "qty"),
        "order_type": sq_str(r, "order_type"),
        "order_class": sq_str(r, "order_class"),
        "time_in_force": sq_str(r, "time_in_force"),
        "limit_price": sq_f64(r, "limit_price"),
        "stop_price": sq_f64(r, "stop_price"),
        "take_profit": sq_f64(r, "take_profit"),
        "stop_loss": sq_f64(r, "stop_loss"),
        "status": sq_str(r, "status"),
        "filled_qty": sq_f64(r, "filled_qty"),
        "filled_avg_price": sq_f64(r, "filled_avg_price"),
        "submitted_at": sq_str(r, "submitted_at"),
        "filled_at": sq_str(r, "filled_at"),
        "source": sq_str(r, "source"),
        "strategy_id": sq_str(r, "strategy_id"),
        "raw": sq_json(r, "raw", Value::Null),
        "created_at": sq_str(r, "created_at"),
        "updated_at": sq_str(r, "updated_at"),
    })
}

pub async fn insert_trade(db: &Db, d: &Value) -> ApiResult<()> {
    let sql = "INSERT INTO trades (alpaca_order_id, client_order_id, symbol, asset_class, side, qty, order_type, order_class, time_in_force, limit_price, stop_price, take_profit, stop_loss, status, filled_qty, filled_avg_price, submitted_at, filled_at, source, strategy_id, raw, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
            let now = now_naive();
            sqlx::query(sql)
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
        }
        Db::Sq(pool) => {
            let now = now_iso();
            sqlx::query(sql)
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
                .bind(parse_dt_iso(&d["submitted_at"]))
                .bind(parse_dt_iso(&d["filled_at"]))
                .bind(d["source"].as_str().unwrap_or("manual"))
                .bind(d["strategy_id"].as_str())
                .bind(json_text(&d["raw"]))
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn upsert_trade_from_alpaca(db: &Db, order: &Value) -> ApiResult<()> {
    let aid = order["id"]
        .as_str()
        .or_else(|| order["alpaca_order_id"].as_str());
    let aid = match aid {
        Some(a) => a,
        None => return Ok(()),
    };
    let insert_sql = "INSERT INTO trades (alpaca_order_id, symbol, asset_class, side, qty, order_type, time_in_force, limit_price, stop_price, status, filled_qty, filled_avg_price, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
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
            let now = now_naive();
            sqlx::query(insert_sql)
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
        Db::Sq(pool) => {
            let existing = sqlx::query("SELECT id FROM trades WHERE alpaca_order_id = ?")
                .bind(aid)
                .fetch_optional(pool)
                .await?;
            if existing.is_some() {
                sqlx::query("UPDATE trades SET status = COALESCE(?, status), updated_at = ? WHERE alpaca_order_id = ?")
                    .bind(order["status"].as_str())
                    .bind(now_iso())
                    .bind(aid)
                    .execute(pool)
                    .await?;
                return Ok(());
            }
            let now = now_iso();
            sqlx::query(insert_sql)
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
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn list_trades(
    db: &Db,
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
    match db {
        Db::My(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = status {
                query = query.bind(s);
            }
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(trade_row_to_json_my).collect()))
        }
        Db::Sq(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = status {
                query = query.bind(s.to_string());
            }
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(trade_row_to_json_sq).collect()))
        }
    }
}

// =============================================================================
// Research analyses
// =============================================================================
fn research_row_to_json_my(r: &sqlx::mysql::MySqlRow) -> Value {
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

fn research_row_to_json_sq(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": sq_i64(r, "id"),
        "symbol": sq_str(r, "symbol"),
        "thesis": sq_str(r, "thesis"),
        "sentiment_score": sq_f64(r, "sentiment_score"),
        "conviction": sq_f64(r, "conviction"),
        "key_risks": sq_json(r, "key_risks", json!([])),
        "suggested_action": sq_str(r, "suggested_action"),
        "suggested_stop": sq_f64(r, "suggested_stop"),
        "suggested_target": sq_f64(r, "suggested_target"),
        "regime": sq_str(r, "regime"),
        "bear_case": sq_str(r, "bear_case"),
        "provider": sq_str(r, "provider"),
        "model": sq_str(r, "model"),
        "generated_at": sq_str(r, "generated_at"),
    })
}

pub async fn insert_research(db: &Db, d: &Value) -> ApiResult<Value> {
    let sql = "INSERT INTO research_analyses (symbol, thesis, sentiment_score, conviction, key_risks, suggested_action, suggested_stop, suggested_target, regime, bear_case, provider, model, raw, generated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
            let gen = parse_dt(&d["generated_at"]).unwrap_or_else(now_naive);
            let res = sqlx::query(sql)
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
            let row = sqlx::query("SELECT * FROM research_analyses WHERE id = ?")
                .bind(res.last_insert_id())
                .fetch_one(pool)
                .await?;
            Ok(research_row_to_json_my(&row))
        }
        Db::Sq(pool) => {
            let gen = parse_dt_iso(&d["generated_at"]).unwrap_or_else(now_iso);
            let res = sqlx::query(sql)
                .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
                .bind(d["thesis"].as_str())
                .bind(d["sentiment_score"].as_f64())
                .bind(d["conviction"].as_f64())
                .bind(json_text(&d["key_risks"]))
                .bind(d["suggested_action"].as_str())
                .bind(d["suggested_stop"].as_f64())
                .bind(d["suggested_target"].as_f64())
                .bind(d["regime"].as_str())
                .bind(d["bear_case"].as_str())
                .bind(d["provider"].as_str())
                .bind(d["model"].as_str())
                .bind(Some(d.to_string()))
                .bind(gen)
                .execute(pool)
                .await?;
            let row = sqlx::query("SELECT * FROM research_analyses WHERE id = ?")
                .bind(res.last_insert_rowid())
                .fetch_one(pool)
                .await?;
            Ok(research_row_to_json_sq(&row))
        }
    }
}

pub async fn list_research(db: &Db, symbol: Option<&str>, limit: i64) -> ApiResult<Value> {
    let mut q = String::from("SELECT * FROM research_analyses");
    if symbol.is_some() {
        q.push_str(" WHERE symbol = ?");
    }
    q.push_str(" ORDER BY id DESC LIMIT ?");
    match db {
        Db::My(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(research_row_to_json_my).collect()))
        }
        Db::Sq(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(research_row_to_json_sq).collect()))
        }
    }
}

// =============================================================================
// Signals
// =============================================================================
fn signal_row_to_json_my(r: &sqlx::mysql::MySqlRow) -> Value {
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

fn signal_row_to_json_sq(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": sq_i64(r, "id"),
        "strategy_id": sq_str(r, "strategy_id"),
        "symbol": sq_str(r, "symbol"),
        "timeframe": sq_str(r, "timeframe"),
        "fired": sq_bool(r, "fired").unwrap_or(false),
        "matched": sq_json(r, "matched", json!([])),
        "snapshot": sq_json(r, "snapshot", json!({})),
        "created_at": sq_str(r, "created_at"),
    })
}

pub async fn insert_signal(db: &Db, d: &Value) -> ApiResult<Value> {
    let sql = "INSERT INTO signals (strategy_id, symbol, timeframe, fired, matched, snapshot, created_at) VALUES (?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
            let res = sqlx::query(sql)
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
            Ok(signal_row_to_json_my(&row))
        }
        Db::Sq(pool) => {
            let res = sqlx::query(sql)
                .bind(d["strategy_id"].as_str())
                .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
                .bind(d["timeframe"].as_str())
                .bind(d["fired"].as_bool().unwrap_or(false) as i64)
                .bind(json_text(&d["matched"]))
                .bind(json_text(&d["snapshot"]))
                .bind(now_iso())
                .execute(pool)
                .await?;
            let row = sqlx::query("SELECT * FROM signals WHERE id = ?")
                .bind(res.last_insert_rowid())
                .fetch_one(pool)
                .await?;
            Ok(signal_row_to_json_sq(&row))
        }
    }
}

pub async fn list_signals(db: &Db, symbol: Option<&str>, limit: i64) -> ApiResult<Value> {
    let mut q = String::from("SELECT * FROM signals");
    if symbol.is_some() {
        q.push_str(" WHERE symbol = ?");
    }
    q.push_str(" ORDER BY id DESC LIMIT ?");
    match db {
        Db::My(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(signal_row_to_json_my).collect()))
        }
        Db::Sq(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(signal_row_to_json_sq).collect()))
        }
    }
}

// =============================================================================
// Risk events
// =============================================================================
fn risk_event_row_to_json_my(r: &sqlx::mysql::MySqlRow) -> Value {
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

fn risk_event_row_to_json_sq(r: &sqlx::sqlite::SqliteRow) -> Value {
    json!({
        "id": sq_i64(r, "id"),
        "symbol": sq_str(r, "symbol"),
        "side": sq_str(r, "side"),
        "qty": sq_f64(r, "qty"),
        "order_type": sq_str(r, "order_type"),
        "decision": sq_str(r, "decision"),
        "rules": sq_json(r, "rules", json!([])),
        "computed": sq_json(r, "computed", json!({})),
        "source": sq_str(r, "source"),
        "created_at": sq_str(r, "created_at"),
    })
}

pub async fn insert_risk_event(db: &Db, d: &Value) -> ApiResult<Value> {
    let sql = "INSERT INTO risk_events (symbol, side, qty, order_type, decision, rules, computed, source, created_at) VALUES (?,?,?,?,?,?,?,?,?)";
    let rules = if d["rules"].is_null() { json!([]) } else { d["rules"].clone() };
    let computed = if d["computed"].is_null() { json!({}) } else { d["computed"].clone() };
    match db {
        Db::My(pool) => {
            let res = sqlx::query(sql)
                .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
                .bind(d["side"].as_str())
                .bind(d["qty"].as_f64())
                .bind(d["order_type"].as_str())
                .bind(d["decision"].as_str().unwrap_or("approved"))
                .bind(Some(rules))
                .bind(Some(computed))
                .bind(d["source"].as_str().unwrap_or("manual"))
                .bind(now_naive())
                .execute(pool)
                .await?;
            let row = sqlx::query("SELECT * FROM risk_events WHERE id = ?")
                .bind(res.last_insert_id())
                .fetch_one(pool)
                .await?;
            Ok(risk_event_row_to_json_my(&row))
        }
        Db::Sq(pool) => {
            let res = sqlx::query(sql)
                .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
                .bind(d["side"].as_str())
                .bind(d["qty"].as_f64())
                .bind(d["order_type"].as_str())
                .bind(d["decision"].as_str().unwrap_or("approved"))
                .bind(rules.to_string())
                .bind(computed.to_string())
                .bind(d["source"].as_str().unwrap_or("manual"))
                .bind(now_iso())
                .execute(pool)
                .await?;
            let row = sqlx::query("SELECT * FROM risk_events WHERE id = ?")
                .bind(res.last_insert_rowid())
                .fetch_one(pool)
                .await?;
            Ok(risk_event_row_to_json_sq(&row))
        }
    }
}

pub async fn list_risk_events(db: &Db, limit: i64) -> ApiResult<Value> {
    let sql = "SELECT * FROM risk_events ORDER BY id DESC LIMIT ?";
    match db {
        Db::My(pool) => {
            let rows = sqlx::query(sql).bind(limit).fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(risk_event_row_to_json_my).collect()))
        }
        Db::Sq(pool) => {
            let rows = sqlx::query(sql).bind(limit).fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(risk_event_row_to_json_sq).collect()))
        }
    }
}

// =============================================================================
// Briefings
// =============================================================================
pub async fn insert_briefing(db: &Db, d: &Value) -> ApiResult<()> {
    let sql = "INSERT INTO briefings (summary, items, regime, generated_at) VALUES (?,?,?,?)";
    match db {
        Db::My(pool) => {
            let gen = parse_dt(&d["generated_at"]).unwrap_or_else(now_naive);
            sqlx::query(sql)
                .bind(d["summary"].as_str())
                .bind(if d["items"].is_null() { None } else { Some(d["items"].clone()) })
                .bind(d["regime"].as_str())
                .bind(gen)
                .execute(pool)
                .await?;
        }
        Db::Sq(pool) => {
            let gen = parse_dt_iso(&d["generated_at"]).unwrap_or_else(now_iso);
            sqlx::query(sql)
                .bind(d["summary"].as_str())
                .bind(json_text(&d["items"]))
                .bind(d["regime"].as_str())
                .bind(gen)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

// =============================================================================
// Deep research
// =============================================================================
fn make_summary(body: &str, n: usize) -> String {
    let chars: Vec<char> = body.chars().collect();
    if chars.len() > n {
        let s: String = chars[..n].iter().collect();
        format!("{}…", s.trim_end())
    } else {
        body.to_string()
    }
}

fn deep_row_to_json_my(r: &sqlx::mysql::MySqlRow, summary_len: usize) -> Value {
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

fn deep_row_to_json_sq(r: &sqlx::sqlite::SqliteRow, summary_len: usize) -> Value {
    let body = sq_str(r, "body").unwrap_or_default();
    let summary = make_summary(&body, summary_len);
    json!({
        "id": sq_i64(r, "id"),
        "symbol": sq_str(r, "symbol"),
        "kind": sq_str(r, "kind"),
        "title": sq_str(r, "title"),
        "body": body,
        "summary": summary,
        "data": sq_json(r, "data", json!({})),
        "provider": sq_str(r, "provider"),
        "model": sq_str(r, "model"),
        "created_at": sq_str(r, "created_at"),
    })
}

pub async fn insert_deep_research(db: &Db, d: &Value) -> ApiResult<Value> {
    let sql = "INSERT INTO deep_research (symbol, kind, title, body, data, provider, model, created_at) VALUES (?,?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
            let created = parse_dt(&d["created_at"]).unwrap_or_else(now_naive);
            let res = sqlx::query(sql)
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
            Ok(deep_row_to_json_my(&row, 280))
        }
        Db::Sq(pool) => {
            let created = parse_dt_iso(&d["created_at"]).unwrap_or_else(now_iso);
            let res = sqlx::query(sql)
                .bind(d["symbol"].as_str().unwrap_or("").to_uppercase())
                .bind(d["kind"].as_str().unwrap_or("analysis"))
                .bind(d["title"].as_str())
                .bind(d["body"].as_str())
                .bind(json_text(&d["data"]))
                .bind(d["provider"].as_str())
                .bind(d["model"].as_str())
                .bind(created)
                .execute(pool)
                .await?;
            let row = sqlx::query("SELECT * FROM deep_research WHERE id = ?")
                .bind(res.last_insert_rowid())
                .fetch_one(pool)
                .await?;
            Ok(deep_row_to_json_sq(&row, 280))
        }
    }
}

pub async fn list_deep_research(
    db: &Db,
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
    match db {
        Db::My(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            if let Some(k) = kind {
                query = query.bind(k);
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(|r| deep_row_to_json_my(r, 280)).collect()))
        }
        Db::Sq(pool) => {
            let mut query = sqlx::query(&q);
            if let Some(s) = symbol {
                query = query.bind(s.to_uppercase());
            }
            if let Some(k) = kind {
                query = query.bind(k.to_string());
            }
            query = query.bind(limit);
            let rows = query.fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(|r| deep_row_to_json_sq(r, 280)).collect()))
        }
    }
}

pub async fn get_deep_research(db: &Db, id: i64) -> ApiResult<Option<Value>> {
    let sql = "SELECT * FROM deep_research WHERE id = ?";
    match db {
        Db::My(pool) => {
            let row = sqlx::query(sql).bind(id).fetch_optional(pool).await?;
            Ok(row.map(|r| deep_row_to_json_my(&r, 280)))
        }
        Db::Sq(pool) => {
            let row = sqlx::query(sql).bind(id).fetch_optional(pool).await?;
            Ok(row.map(|r| deep_row_to_json_sq(&r, 280)))
        }
    }
}

pub async fn count_deep_research_today(db: &Db) -> ApiResult<i64> {
    match db {
        Db::My(pool) => {
            let start = Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
            let c: i64 = sqlx::query("SELECT COUNT(*) AS c FROM deep_research WHERE created_at >= ?")
                .bind(start)
                .fetch_one(pool)
                .await?
                .try_get("c")?;
            Ok(c)
        }
        Db::Sq(pool) => {
            let start = Utc::now()
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .map(|d| DateTime::<Utc>::from_naive_utc_and_offset(d, Utc).to_rfc3339())
                .unwrap();
            let c: i64 = sqlx::query("SELECT COUNT(*) AS c FROM deep_research WHERE created_at >= ?")
                .bind(start)
                .fetch_one(pool)
                .await?
                .try_get("c")?;
            Ok(c)
        }
    }
}

/// Orders placed (rows inserted into `trades`) since UTC midnight — used by the
/// runaway-bot daily-order-cap failsafe.
pub async fn count_trades_today(db: &Db) -> ApiResult<i64> {
    match db {
        Db::My(pool) => {
            let start = Utc::now().date_naive().and_hms_opt(0, 0, 0).unwrap();
            let c: i64 = sqlx::query("SELECT COUNT(*) AS c FROM trades WHERE created_at >= ?")
                .bind(start)
                .fetch_one(pool)
                .await?
                .try_get("c")?;
            Ok(c)
        }
        Db::Sq(pool) => {
            let start = Utc::now()
                .date_naive()
                .and_hms_opt(0, 0, 0)
                .map(|d| DateTime::<Utc>::from_naive_utc_and_offset(d, Utc).to_rfc3339())
                .unwrap();
            let c: i64 = sqlx::query("SELECT COUNT(*) AS c FROM trades WHERE created_at >= ?")
                .bind(start)
                .fetch_one(pool)
                .await?
                .try_get("c")?;
            Ok(c)
        }
    }
}

// =============================================================================
// Strategies
// =============================================================================
pub fn default_equity_action() -> Value {
    json!({"asset": "equity", "side": "buy"})
}
pub fn default_option_action() -> Value {
    json!({"asset": "option", "right": "auto", "moneyness": "ATM", "otm_strikes": 1, "expiry": "nearest_weekly", "contract_symbol": null})
}

fn strategy_row_to_json_my(r: &sqlx::mysql::MySqlRow) -> Value {
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

fn strategy_row_to_json_sq(r: &sqlx::sqlite::SqliteRow) -> Value {
    let action = sq_json(r, "action", Value::Null);
    json!({
        "id": sq_str(r, "id"),
        "name": sq_str(r, "name"),
        "symbols": sq_json(r, "symbols", json!([])),
        "timeframe": sq_str(r, "timeframe"),
        "rules": sq_json(r, "rules", json!([])),
        "ai_gate": sq_json(r, "ai_gate", json!({})),
        "exits": sq_json(r, "exits", json!({})),
        "sizing": sq_json(r, "sizing", json!({})),
        "action": if action.is_null() { default_equity_action() } else { action },
        "mode": sq_str(r, "mode"),
        "enabled": sq_bool(r, "enabled").unwrap_or(true),
        "created_at": sq_str(r, "created_at"),
        "updated_at": sq_str(r, "updated_at"),
    })
}

pub async fn list_strategies(db: &Db) -> ApiResult<Value> {
    let sql = "SELECT * FROM strategies ORDER BY updated_at DESC";
    match db {
        Db::My(pool) => {
            let rows = sqlx::query(sql).fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(strategy_row_to_json_my).collect()))
        }
        Db::Sq(pool) => {
            let rows = sqlx::query(sql).fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(strategy_row_to_json_sq).collect()))
        }
    }
}

pub async fn get_strategy(db: &Db, id: &str) -> ApiResult<Option<Value>> {
    let sql = "SELECT * FROM strategies WHERE id = ?";
    match db {
        Db::My(pool) => {
            let row = sqlx::query(sql).bind(id).fetch_optional(pool).await?;
            Ok(row.map(|r| strategy_row_to_json_my(&r)))
        }
        Db::Sq(pool) => {
            let row = sqlx::query(sql).bind(id).fetch_optional(pool).await?;
            Ok(row.map(|r| strategy_row_to_json_sq(&r)))
        }
    }
}

pub async fn create_strategy(db: &Db, s: &Value) -> ApiResult<Value> {
    let id = s["id"].as_str().map(|x| x.to_string()).unwrap_or_else(uid);
    let action = if s["action"].is_null() {
        default_equity_action()
    } else {
        s["action"].clone()
    };
    let sql = "INSERT INTO strategies (id, name, symbols, timeframe, rules, ai_gate, exits, sizing, action, mode, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
            let now = now_naive();
            sqlx::query(sql)
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
        }
        Db::Sq(pool) => {
            let now = now_iso();
            sqlx::query(sql)
                .bind(&id)
                .bind(s["name"].as_str().unwrap_or(""))
                .bind(s["symbols"].to_string())
                .bind(s["timeframe"].as_str().unwrap_or("1Day"))
                .bind(s["rules"].to_string())
                .bind(s["ai_gate"].to_string())
                .bind(s["exits"].to_string())
                .bind(s["sizing"].to_string())
                .bind(action.to_string())
                .bind(s["mode"].as_str().unwrap_or("signal"))
                .bind(s["enabled"].as_bool().unwrap_or(true) as i64)
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await?;
        }
    }
    Ok(get_strategy(db, &id).await?.unwrap())
}

pub async fn update_strategy(db: &Db, id: &str, s: &Value) -> ApiResult<Option<Value>> {
    if get_strategy(db, id).await?.is_none() {
        return Ok(None);
    }
    for (field, col) in [("name", "name"), ("timeframe", "timeframe"), ("mode", "mode")] {
        if let Some(v) = s.get(field).and_then(|v| v.as_str()) {
            let q = format!("UPDATE strategies SET {col} = ? WHERE id = ?");
            match db {
                Db::My(pool) => { sqlx::query(&q).bind(v).bind(id).execute(pool).await?; }
                Db::Sq(pool) => { sqlx::query(&q).bind(v).bind(id).execute(pool).await?; }
            }
        }
    }
    for field in ["symbols", "rules", "ai_gate", "exits", "sizing", "action"] {
        if let Some(v) = s.get(field) {
            if !v.is_null() {
                let q = format!("UPDATE strategies SET {field} = ? WHERE id = ?");
                match db {
                    Db::My(pool) => { sqlx::query(&q).bind(v.clone()).bind(id).execute(pool).await?; }
                    Db::Sq(pool) => { sqlx::query(&q).bind(v.to_string()).bind(id).execute(pool).await?; }
                }
            }
        }
    }
    if let Some(v) = s.get("enabled").and_then(|v| v.as_bool()) {
        match db {
            Db::My(pool) => { sqlx::query("UPDATE strategies SET enabled = ? WHERE id = ?").bind(v).bind(id).execute(pool).await?; }
            Db::Sq(pool) => { sqlx::query("UPDATE strategies SET enabled = ? WHERE id = ?").bind(v as i64).bind(id).execute(pool).await?; }
        }
    }
    match db {
        Db::My(pool) => { sqlx::query("UPDATE strategies SET updated_at = ? WHERE id = ?").bind(now_naive()).bind(id).execute(pool).await?; }
        Db::Sq(pool) => { sqlx::query("UPDATE strategies SET updated_at = ? WHERE id = ?").bind(now_iso()).bind(id).execute(pool).await?; }
    }
    get_strategy(db, id).await
}

pub async fn delete_strategy(db: &Db, id: &str) -> ApiResult<bool> {
    let sql = "DELETE FROM strategies WHERE id = ?";
    let affected = match db {
        Db::My(pool) => sqlx::query(sql).bind(id).execute(pool).await?.rows_affected(),
        Db::Sq(pool) => sqlx::query(sql).bind(id).execute(pool).await?.rows_affected(),
    };
    Ok(affected > 0)
}

// =============================================================================
// Bots
// =============================================================================
pub const DEFAULT_BOT_SYMBOLS: [&str; 5] = ["QQQ", "SPY", "TSLA", "META", "NVDA"];

fn default_bot_config() -> Value {
    json!({"direction": "research", "side": "auto", "expiry": "nearest_weekly", "strike": "ATM", "target_delta": 0.4, "contracts": 1, "max_premium": 1500})
}

fn bot_row_to_json_my(r: &sqlx::mysql::MySqlRow) -> Value {
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
        "last_evaluated_at": iso(r.try_get::<Option<NaiveDateTime>, _>("last_evaluated_at").ok().flatten()),
        "last_result": r.try_get::<Option<Value>, _>("last_result").ok().flatten().unwrap_or(Value::Null),
        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
        "updated_at": iso(r.get::<Option<NaiveDateTime>, _>("updated_at")),
    })
}

fn bot_row_to_json_sq(r: &sqlx::sqlite::SqliteRow) -> Value {
    let action = sq_json(r, "action", Value::Null);
    json!({
        "id": sq_str(r, "id"),
        "name": sq_str(r, "name"),
        "enabled": sq_bool(r, "enabled").unwrap_or(true),
        "symbols": sq_json(r, "symbols", json!([])),
        "kind": sq_str(r, "kind"),
        "config": sq_json(r, "config", json!({})),
        "rules": sq_json(r, "rules", json!([])),
        "ai_gate": sq_json(r, "ai_gate", json!({})),
        "risk": sq_json(r, "risk", json!({})),
        "action": if action.is_null() { default_option_action() } else { action },
        "mode": sq_str(r, "mode"),
        "last_evaluated_at": sq_str(r, "last_evaluated_at"),
        "last_result": sq_json(r, "last_result", Value::Null),
        "created_at": sq_str(r, "created_at"),
        "updated_at": sq_str(r, "updated_at"),
    })
}

pub async fn list_bots(db: &Db) -> ApiResult<Value> {
    let sql = "SELECT * FROM bots ORDER BY created_at ASC";
    match db {
        Db::My(pool) => {
            let rows = sqlx::query(sql).fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(bot_row_to_json_my).collect()))
        }
        Db::Sq(pool) => {
            let rows = sqlx::query(sql).fetch_all(pool).await?;
            Ok(Value::Array(rows.iter().map(bot_row_to_json_sq).collect()))
        }
    }
}

pub async fn get_bot(db: &Db, id: &str) -> ApiResult<Option<Value>> {
    let sql = "SELECT * FROM bots WHERE id = ?";
    match db {
        Db::My(pool) => {
            let row = sqlx::query(sql).bind(id).fetch_optional(pool).await?;
            Ok(row.map(|r| bot_row_to_json_my(&r)))
        }
        Db::Sq(pool) => {
            let row = sqlx::query(sql).bind(id).fetch_optional(pool).await?;
            Ok(row.map(|r| bot_row_to_json_sq(&r)))
        }
    }
}

pub async fn create_bot(db: &Db, b: &Value) -> ApiResult<Value> {
    let id = b["id"].as_str().map(|x| x.to_string()).unwrap_or_else(uid);
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
    let rules = if b["rules"].is_null() { json!([]) } else { b["rules"].clone() };
    let ai_gate = if b["ai_gate"].is_null() { json!({"enabled": true, "min_conviction": 60}) } else { b["ai_gate"].clone() };
    let risk = if b["risk"].is_null() { json!({"risk_per_trade_pct": 1}) } else { b["risk"].clone() };
    let sql = "INSERT INTO bots (id, name, enabled, symbols, kind, config, rules, ai_gate, risk, action, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)";
    match db {
        Db::My(pool) => {
            let now = now_naive();
            sqlx::query(sql)
                .bind(&id)
                .bind(b["name"].as_str().unwrap_or("Bot"))
                .bind(b["enabled"].as_bool().unwrap_or(true))
                .bind(symbols)
                .bind(b["kind"].as_str().unwrap_or("options_weekly"))
                .bind(config)
                .bind(rules)
                .bind(ai_gate)
                .bind(risk)
                .bind(action)
                .bind(b["mode"].as_str().unwrap_or("signal"))
                .bind(now)
                .bind(now)
                .execute(pool)
                .await?;
        }
        Db::Sq(pool) => {
            let now = now_iso();
            sqlx::query(sql)
                .bind(&id)
                .bind(b["name"].as_str().unwrap_or("Bot"))
                .bind(b["enabled"].as_bool().unwrap_or(true) as i64)
                .bind(symbols.to_string())
                .bind(b["kind"].as_str().unwrap_or("options_weekly"))
                .bind(config.to_string())
                .bind(rules.to_string())
                .bind(ai_gate.to_string())
                .bind(risk.to_string())
                .bind(action.to_string())
                .bind(b["mode"].as_str().unwrap_or("signal"))
                .bind(&now)
                .bind(&now)
                .execute(pool)
                .await?;
        }
    }
    Ok(get_bot(db, &id).await?.unwrap())
}

pub async fn update_bot(db: &Db, id: &str, b: &Value) -> ApiResult<Option<Value>> {
    if get_bot(db, id).await?.is_none() {
        return Ok(None);
    }
    for (field, col) in [("name", "name"), ("kind", "kind"), ("mode", "mode")] {
        if let Some(v) = b.get(field).and_then(|v| v.as_str()) {
            let q = format!("UPDATE bots SET {col} = ? WHERE id = ?");
            match db {
                Db::My(pool) => { sqlx::query(&q).bind(v).bind(id).execute(pool).await?; }
                Db::Sq(pool) => { sqlx::query(&q).bind(v).bind(id).execute(pool).await?; }
            }
        }
    }
    if let Some(v) = b.get("enabled").and_then(|v| v.as_bool()) {
        match db {
            Db::My(pool) => { sqlx::query("UPDATE bots SET enabled = ? WHERE id = ?").bind(v).bind(id).execute(pool).await?; }
            Db::Sq(pool) => { sqlx::query("UPDATE bots SET enabled = ? WHERE id = ?").bind(v as i64).bind(id).execute(pool).await?; }
        }
    }
    for field in ["symbols", "config", "rules", "ai_gate", "risk", "action"] {
        if let Some(v) = b.get(field) {
            if !v.is_null() {
                let q = format!("UPDATE bots SET {field} = ? WHERE id = ?");
                match db {
                    Db::My(pool) => { sqlx::query(&q).bind(v.clone()).bind(id).execute(pool).await?; }
                    Db::Sq(pool) => { sqlx::query(&q).bind(v.to_string()).bind(id).execute(pool).await?; }
                }
            }
        }
    }
    match db {
        Db::My(pool) => { sqlx::query("UPDATE bots SET updated_at = ? WHERE id = ?").bind(now_naive()).bind(id).execute(pool).await?; }
        Db::Sq(pool) => { sqlx::query("UPDATE bots SET updated_at = ? WHERE id = ?").bind(now_iso()).bind(id).execute(pool).await?; }
    }
    get_bot(db, id).await
}

pub async fn delete_bot(db: &Db, id: &str) -> ApiResult<bool> {
    let sql = "DELETE FROM bots WHERE id = ?";
    let affected = match db {
        Db::My(pool) => sqlx::query(sql).bind(id).execute(pool).await?.rows_affected(),
        Db::Sq(pool) => sqlx::query(sql).bind(id).execute(pool).await?.rows_affected(),
    };
    Ok(affected > 0)
}

/// Persist the latest evaluation result for a bot.
pub async fn save_bot_evaluation(db: &Db, id: &str, result: &Value) -> ApiResult<()> {
    let sql = "UPDATE bots SET last_evaluated_at = ?, last_result = ? WHERE id = ?";
    match db {
        Db::My(pool) => {
            sqlx::query(sql)
                .bind(now_naive())
                .bind(if result.is_null() { None } else { Some(result.clone()) })
                .bind(id)
                .execute(pool)
                .await?;
        }
        Db::Sq(pool) => {
            sqlx::query(sql)
                .bind(now_iso())
                .bind(json_text(result))
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn seed_default_bot(db: &Db) -> ApiResult<()> {
    let c: i64 = match db {
        Db::My(pool) => sqlx::query("SELECT COUNT(*) AS c FROM bots").fetch_one(pool).await?.try_get("c")?,
        Db::Sq(pool) => sqlx::query("SELECT COUNT(*) AS c FROM bots").fetch_one(pool).await?.try_get("c")?,
    };
    if c > 0 {
        return Ok(());
    }
    create_bot(
        db,
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

// =============================================================================
// Chat
// =============================================================================
pub async fn insert_chat_message(db: &Db, role: &str, content: &str, meta: &Value) -> ApiResult<()> {
    let sql = "INSERT INTO chat_messages (role, content, meta, created_at) VALUES (?,?,?,?)";
    match db {
        Db::My(pool) => {
            sqlx::query(sql)
                .bind(role)
                .bind(content)
                .bind(meta.clone())
                .bind(now_naive())
                .execute(pool)
                .await?;
        }
        Db::Sq(pool) => {
            sqlx::query(sql)
                .bind(role)
                .bind(content)
                .bind(meta.to_string())
                .bind(now_iso())
                .execute(pool)
                .await?;
        }
    }
    Ok(())
}

pub async fn list_chat_messages(db: &Db, limit: i64) -> ApiResult<Value> {
    let sql = "SELECT * FROM chat_messages ORDER BY id DESC LIMIT ?";
    let mut out: Vec<Value> = match db {
        Db::My(pool) => {
            let rows = sqlx::query(sql).bind(limit).fetch_all(pool).await?;
            rows.iter()
                .map(|r| {
                    json!({
                        "id": r.get::<i32, _>("id"),
                        "role": r.get::<Option<String>, _>("role"),
                        "content": r.get::<Option<String>, _>("content"),
                        "meta": r.get::<Option<Value>, _>("meta").unwrap_or(json!({})),
                        "created_at": iso(r.get::<Option<NaiveDateTime>, _>("created_at")),
                    })
                })
                .collect()
        }
        Db::Sq(pool) => {
            let rows = sqlx::query(sql).bind(limit).fetch_all(pool).await?;
            rows.iter()
                .map(|r| {
                    json!({
                        "id": sq_i64(r, "id"),
                        "role": sq_str(r, "role"),
                        "content": sq_str(r, "content"),
                        "meta": sq_json(r, "meta", json!({})),
                        "created_at": sq_str(r, "created_at"),
                    })
                })
                .collect()
        }
    };
    out.reverse();
    Ok(Value::Array(out))
}

// =============================================================================
// Read-only SQL for chat
// =============================================================================
pub async fn run_readonly_sql(db: &Db, sql: &str) -> ApiResult<Value> {
    use sqlx::Column;
    match db {
        Db::My(pool) => {
            let rows = sqlx::query(sql).fetch_all(pool).await?;
            let mut columns: Vec<String> = vec![];
            if let Some(first) = rows.first() {
                columns = first.columns().iter().map(|c| c.name().to_string()).collect();
            }
            let mut out_rows = vec![];
            for r in &rows {
                let mut obj = serde_json::Map::new();
                for (i, col) in columns.iter().enumerate() {
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
        Db::Sq(pool) => {
            let rows = sqlx::query(sql).fetch_all(pool).await?;
            let mut columns: Vec<String> = vec![];
            if let Some(first) = rows.first() {
                columns = first.columns().iter().map(|c| c.name().to_string()).collect();
            }
            let mut out_rows = vec![];
            for r in &rows {
                let mut obj = serde_json::Map::new();
                for (i, col) in columns.iter().enumerate() {
                    let val: Value = r
                        .try_get::<Option<i64>, _>(i)
                        .map(|v| v.map(Value::from).unwrap_or(Value::Null))
                        .or_else(|_| r.try_get::<Option<f64>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
                        .or_else(|_| r.try_get::<Option<String>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
                        .unwrap_or(Value::Null);
                    obj.insert(col.clone(), val);
                }
                out_rows.push(Value::Object(obj));
            }
            Ok(json!({"columns": columns, "rows": out_rows}))
        }
    }
}
