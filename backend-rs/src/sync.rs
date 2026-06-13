//! Bidirectional SQLite <-> MySQL sync for the native app.
//!
//! The native macOS app runs on SQLite; the web version + the 24/7 research
//! worker run on MySQL. This module merges the two databases both directions so
//! the native app sees the worker's accumulated research, and anything created
//! locally is pushed back to MySQL.
//!
//! Design:
//!   * Append-only tables (trades, research_analyses, deep_research, signals,
//!     risk_events, briefings, chat_messages): each row is identified by a STABLE
//!     natural key. Rows present on one side but not the other are inserted on the
//!     missing side. Never duplicated (idempotent — re-running inserts nothing).
//!   * Config tables (watchlist, strategies, bots, settings): last-write-wins by
//!     `updated_at`; watchlist is a symbol union.
//!
//! Safety: sync only runs when a MySQL URL is configured AND reachable (short
//! connect timeout). If MySQL is down we log and skip — never crash or block the
//! app. The whole thing is gated to DB_BACKEND=sqlite (the native app) by callers.

use crate::config::Settings;
use crate::database::Db;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::mysql::MySqlPool;
use sqlx::sqlite::SqlitePool;
use sqlx::{Column, Row};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

/// Append-only tables synced by natural key (both directions, insert-missing).
const APPEND_TABLES: [&str; 7] = [
    "trades",
    "research_analyses",
    "deep_research",
    "signals",
    "risk_events",
    "briefings",
    "chat_messages",
];

/// Last successful sync summary, exposed via GET /api/sync/status.
static LAST_SYNC: Mutex<Option<Value>> = Mutex::new(None);

/// Result of a single sync run.
#[derive(Default, Debug)]
pub struct SyncReport {
    pub pulled: i64, // rows inserted into SQLite (from MySQL)
    pub pushed: i64, // rows inserted into MySQL (from SQLite)
    pub per_table: HashMap<String, (i64, i64)>, // table -> (pulled, pushed)
}

impl SyncReport {
    fn to_json(&self) -> Value {
        let mut tables = serde_json::Map::new();
        for (t, (pu, ps)) in &self.per_table {
            tables.insert(t.clone(), json!({ "pulled": pu, "pushed": ps }));
        }
        json!({
            "pulled": self.pulled,
            "pushed": self.pushed,
            "tables": Value::Object(tables),
        })
    }
}

/// Try to open a MySQL pool from the env config with a short timeout.
/// Returns None (and logs) if MySQL is not reachable — callers must skip.
pub async fn try_mysql_pool(settings: &Settings) -> Option<MySqlPool> {
    let url = settings.database_url();
    let pool = sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(3))
        .connect(&url)
        .await;
    match pool {
        Ok(p) => {
            // Confirm it actually answers within the timeout.
            match tokio::time::timeout(Duration::from_secs(3), sqlx::query("SELECT 1").execute(&p))
                .await
            {
                Ok(Ok(_)) => Some(p),
                _ => {
                    tracing::warn!("sync: MySQL connected but did not respond — skipping");
                    None
                }
            }
        }
        Err(e) => {
            tracing::info!("sync: MySQL not reachable ({e}) — skipping sync this cycle");
            None
        }
    }
}

/// Whether MySQL is reachable right now (used by status endpoint).
pub async fn mysql_reachable(settings: &Settings) -> bool {
    try_mysql_pool(settings).await.is_some()
}

pub fn last_sync() -> Option<Value> {
    LAST_SYNC.lock().unwrap().clone()
}

fn record_last_sync(report: &SyncReport, mysql_reachable: bool) {
    let mut v = report.to_json();
    v["last_sync"] = json!(Utc::now().to_rfc3339());
    v["mysql_reachable"] = json!(mysql_reachable);
    *LAST_SYNC.lock().unwrap() = Some(v);
}

/// Public status: last sync info + live reachability + current counts.
pub async fn status(db: &Db, settings: &Settings) -> Value {
    let reachable = mysql_reachable(settings).await;
    let mut counts = serde_json::Map::new();
    for t in APPEND_TABLES {
        let c = count_sqlite(db, t).await.unwrap_or(0);
        counts.insert(t.to_string(), json!(c));
    }
    json!({
        "last_sync": last_sync(),
        "mysql_reachable": reachable,
        "sqlite_counts": Value::Object(counts),
    })
}

// =============================================================================
// Public entry point
// =============================================================================

/// Run a full bidirectional sync. `db` is the native app's SQLite handle.
/// Opens a temporary MySQL pool from settings; if unreachable, returns a report
/// with `mysql_reachable=false` and does nothing else.
pub async fn sync(db: &Db, settings: &Settings) -> anyhow::Result<Value> {
    // Only meaningful from the SQLite side (the native app).
    let sqlite = match db {
        Db::Sq(p) => p,
        Db::My(_) => {
            tracing::debug!("sync: called on MySQL backend — no-op");
            return Ok(json!({ "skipped": "mysql_backend", "mysql_reachable": false }));
        }
    };

    let mysql = match try_mysql_pool(settings).await {
        Some(p) => p,
        None => {
            let report = SyncReport::default();
            record_last_sync(&report, false);
            return Ok(json!({
                "skipped": "mysql_unreachable",
                "mysql_reachable": false,
                "pulled": 0,
                "pushed": 0,
            }));
        }
    };

    let mut report = SyncReport::default();

    for table in APPEND_TABLES {
        match sync_append_table(sqlite, &mysql, table).await {
            Ok((pulled, pushed)) => {
                report.pulled += pulled;
                report.pushed += pushed;
                report.per_table.insert(table.to_string(), (pulled, pushed));
            }
            Err(e) => tracing::warn!("sync: table {table} failed: {e:#}"),
        }
    }

    // Config tables.
    if let Err(e) = sync_watchlist(sqlite, &mysql).await {
        tracing::warn!("sync: watchlist failed: {e:#}");
    }
    for table in ["strategies", "bots"] {
        if let Err(e) = sync_lww_table(sqlite, &mysql, table).await {
            tracing::warn!("sync: {table} (lww) failed: {e:#}");
        }
    }
    if let Err(e) = sync_settings(sqlite, &mysql).await {
        tracing::warn!("sync: settings failed: {e:#}");
    }

    record_last_sync(&report, true);
    let mut out = report.to_json();
    out["mysql_reachable"] = json!(true);
    tracing::info!(
        "sync done: pulled {} (MySQL->SQLite), pushed {} (SQLite->MySQL)",
        report.pulled,
        report.pushed
    );
    Ok(out)
}

// =============================================================================
// Generic row fetch -> Vec<serde_json::Map> (column name -> JSON value)
// =============================================================================

fn mysql_value_at(row: &sqlx::mysql::MySqlRow, i: usize) -> Value {
    use chrono::{DateTime, NaiveDateTime};
    row.try_get::<Option<i64>, _>(i)
        .map(|v| v.map(Value::from).unwrap_or(Value::Null))
        .or_else(|_| row.try_get::<Option<f64>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
        .or_else(|_| row.try_get::<Option<bool>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
        .or_else(|_| {
            row.try_get::<Option<NaiveDateTime>, _>(i).map(|v| {
                v.map(|d| Value::from(DateTime::<Utc>::from_naive_utc_and_offset(d, Utc).to_rfc3339()))
                    .unwrap_or(Value::Null)
            })
        })
        // JSON columns come back as serde_json::Value.
        .or_else(|_| row.try_get::<Option<Value>, _>(i).map(|v| v.unwrap_or(Value::Null)))
        .or_else(|_| row.try_get::<Option<String>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
        .unwrap_or(Value::Null)
}

fn sqlite_value_at(row: &sqlx::sqlite::SqliteRow, i: usize) -> Value {
    row.try_get::<Option<i64>, _>(i)
        .map(|v| v.map(Value::from).unwrap_or(Value::Null))
        .or_else(|_| row.try_get::<Option<f64>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
        .or_else(|_| row.try_get::<Option<String>, _>(i).map(|v| v.map(Value::from).unwrap_or(Value::Null)))
        .unwrap_or(Value::Null)
}

async fn fetch_all_mysql(pool: &MySqlPool, table: &str) -> anyhow::Result<Vec<Value>> {
    let rows = sqlx::query(&format!("SELECT * FROM {table}")).fetch_all(pool).await?;
    let mut out = vec![];
    for r in &rows {
        let cols: Vec<String> = r.columns().iter().map(|c| c.name().to_string()).collect();
        let mut obj = serde_json::Map::new();
        for (i, c) in cols.iter().enumerate() {
            obj.insert(c.clone(), mysql_value_at(r, i));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

async fn fetch_all_sqlite(pool: &SqlitePool, table: &str) -> anyhow::Result<Vec<Value>> {
    let rows = sqlx::query(&format!("SELECT * FROM {table}")).fetch_all(pool).await?;
    let mut out = vec![];
    for r in &rows {
        let cols: Vec<String> = r.columns().iter().map(|c| c.name().to_string()).collect();
        let mut obj = serde_json::Map::new();
        for (i, c) in cols.iter().enumerate() {
            obj.insert(c.clone(), sqlite_value_at(r, i));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

async fn count_sqlite(db: &Db, table: &str) -> anyhow::Result<i64> {
    if let Db::Sq(pool) = db {
        let c: i64 = sqlx::query(&format!("SELECT COUNT(*) AS c FROM {table}"))
            .fetch_one(pool)
            .await?
            .try_get("c")?;
        Ok(c)
    } else {
        Ok(0)
    }
}

// =============================================================================
// Natural keys
// =============================================================================

fn s(v: &Value, k: &str) -> String {
    match &v[k] {
        Value::String(x) => x.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Normalize a timestamp-ish field to a stable comparable string.
/// MySQL DATETIME and SQLite ISO text differ in formatting; reduce both to the
/// "YYYY-MM-DDTHH:MM:SS" prefix (drop fractional secs / timezone) for keying.
fn norm_ts(v: &Value, k: &str) -> String {
    let raw = s(v, k);
    let raw = raw.replace(' ', "T");
    let trimmed: String = raw.chars().take(19).collect();
    trimmed
}

/// Stable natural key for an append-only row in the given table.
fn natural_key(table: &str, row: &Value) -> String {
    match table {
        "trades" => {
            let aid = s(row, "alpaca_order_id");
            if !aid.is_empty() {
                return format!("aid:{aid}");
            }
            let cid = s(row, "client_order_id");
            if !cid.is_empty() {
                return format!("cid:{cid}");
            }
            format!(
                "t:{}|{}|{}|{}",
                s(row, "symbol"),
                s(row, "side"),
                s(row, "qty"),
                norm_ts(row, "submitted_at")
            )
        }
        "research_analyses" => format!(
            "{}|{}|{}|{}|{:x}",
            s(row, "symbol"),
            norm_ts(row, "generated_at"),
            s(row, "provider"),
            s(row, "model"),
            // The worker can write many analyses for the same symbol+provider in the
            // same second; the thesis text distinguishes them.
            md5_like(&s(row, "thesis"))
        ),
        "deep_research" => format!(
            "{}|{}|{}|{}|{:x}",
            s(row, "symbol"),
            s(row, "kind"),
            norm_ts(row, "created_at"),
            s(row, "title"),
            // Same-symbol/title docs at the same second are distinguished by body.
            md5_like(&s(row, "body"))
        ),
        "signals" => format!(
            "{}|{}|{}|{}",
            s(row, "symbol"),
            s(row, "timeframe"),
            s(row, "strategy_id"),
            norm_ts(row, "created_at")
        ),
        "risk_events" => format!(
            "{}|{}|{}|{}|{}",
            s(row, "symbol"),
            s(row, "side"),
            s(row, "decision"),
            s(row, "source"),
            norm_ts(row, "created_at")
        ),
        "briefings" => format!(
            "{}|{}|{:x}",
            s(row, "regime"),
            norm_ts(row, "generated_at"),
            md5_like(&s(row, "summary"))
        ),
        "chat_messages" => format!(
            "{}|{}|{:x}",
            s(row, "role"),
            norm_ts(row, "created_at"),
            md5_like(&s(row, "content"))
        ),
        _ => row.to_string(),
    }
}

/// Cheap stable content hash (FNV-1a 64-bit) — we only need determinism, not crypto.
fn md5_like(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

// =============================================================================
// Append-only table sync
// =============================================================================

/// Columns we insert for each append table (id/auto columns excluded — the
/// destination assigns its own autoincrement id). Order matters: placeholders
/// follow this list.
fn insert_columns(table: &str) -> Vec<&'static str> {
    match table {
        "trades" => vec![
            "alpaca_order_id", "client_order_id", "symbol", "asset_class", "side", "qty",
            "order_type", "order_class", "time_in_force", "limit_price", "stop_price",
            "take_profit", "stop_loss", "status", "filled_qty", "filled_avg_price",
            "submitted_at", "filled_at", "source", "strategy_id", "raw", "created_at", "updated_at",
        ],
        "research_analyses" => vec![
            "symbol", "thesis", "sentiment_score", "conviction", "key_risks", "suggested_action",
            "suggested_stop", "suggested_target", "regime", "bear_case", "provider", "model",
            "raw", "generated_at",
        ],
        "deep_research" => vec![
            "symbol", "kind", "title", "body", "data", "provider", "model", "created_at",
        ],
        "signals" => vec![
            "strategy_id", "symbol", "timeframe", "fired", "matched", "snapshot", "created_at",
        ],
        "risk_events" => vec![
            "symbol", "side", "qty", "order_type", "decision", "rules", "computed", "source", "created_at",
        ],
        "briefings" => vec!["summary", "items", "regime", "generated_at"],
        "chat_messages" => vec!["role", "content", "meta", "created_at"],
        _ => vec![],
    }
}

/// JSON-typed columns: stored as native JSON in MySQL, TEXT in SQLite.
fn json_columns(table: &str) -> &'static [&'static str] {
    match table {
        "trades" => &["raw"],
        "research_analyses" => &["key_risks", "raw"],
        "deep_research" => &["data"],
        "signals" => &["matched", "snapshot"],
        "risk_events" => &["rules", "computed"],
        "briefings" => &["items"],
        "chat_messages" => &["meta"],
        _ => &[],
    }
}

fn bool_columns(table: &str) -> &'static [&'static str] {
    match table {
        "signals" => &["fired"],
        _ => &[],
    }
}

async fn sync_append_table(
    sqlite: &SqlitePool,
    mysql: &MySqlPool,
    table: &str,
) -> anyhow::Result<(i64, i64)> {
    let sq_rows = fetch_all_sqlite(sqlite, table).await?;
    let my_rows = fetch_all_mysql(mysql, table).await?;

    let sq_keys: HashSet<String> = sq_rows.iter().map(|r| natural_key(table, r)).collect();
    let my_keys: HashSet<String> = my_rows.iter().map(|r| natural_key(table, r)).collect();

    // Pull: rows in MySQL not in SQLite -> insert into SQLite.
    let mut pulled = 0i64;
    for r in &my_rows {
        let k = natural_key(table, r);
        if !sq_keys.contains(&k) {
            insert_sqlite_row(sqlite, table, r).await?;
            pulled += 1;
        }
    }
    // Push: rows in SQLite not in MySQL -> insert into MySQL.
    let mut pushed = 0i64;
    for r in &sq_rows {
        let k = natural_key(table, r);
        if !my_keys.contains(&k) {
            insert_mysql_row(mysql, table, r).await?;
            pushed += 1;
        }
    }
    if pulled > 0 || pushed > 0 {
        tracing::info!("sync[{table}]: pulled {pulled}, pushed {pushed}");
    }
    Ok((pulled, pushed))
}

async fn insert_sqlite_row(pool: &SqlitePool, table: &str, row: &Value) -> anyhow::Result<()> {
    let cols = insert_columns(table);
    let json_cols = json_columns(table);
    let bool_cols = bool_columns(table);
    let placeholders = vec!["?"; cols.len()].join(",");
    let sql = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        cols.join(","),
        placeholders
    );
    let mut q = sqlx::query(&sql);
    for c in &cols {
        let v = &row[*c];
        if json_cols.contains(c) {
            // store JSON as TEXT
            if v.is_null() {
                q = q.bind(None::<String>);
            } else if let Some(text) = v.as_str() {
                q = q.bind(text.to_string());
            } else {
                q = q.bind(v.to_string());
            }
        } else if bool_cols.contains(c) {
            q = q.bind(value_to_i64_bool(v));
        } else {
            q = bind_scalar_sqlite(q, v);
        }
    }
    q.execute(pool).await?;
    Ok(())
}

async fn insert_mysql_row(pool: &MySqlPool, table: &str, row: &Value) -> anyhow::Result<()> {
    use chrono::NaiveDateTime;
    let cols = insert_columns(table);
    let json_cols = json_columns(table);
    let bool_cols = bool_columns(table);
    let dt_cols = datetime_columns(table);
    let placeholders = vec!["?"; cols.len()].join(",");
    // Backtick column names for MySQL reserved words safety.
    let collist = cols.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(",");
    let sql = format!("INSERT INTO {table} ({collist}) VALUES ({placeholders})");
    let mut q = sqlx::query(&sql);
    for c in &cols {
        let v = &row[*c];
        if json_cols.contains(c) {
            if v.is_null() {
                q = q.bind(None::<Value>);
            } else if let Some(text) = v.as_str() {
                // SQLite stored JSON as text; parse back to Value for MySQL JSON col.
                let parsed: Value = serde_json::from_str(text).unwrap_or(Value::String(text.to_string()));
                q = q.bind(Some(parsed));
            } else {
                q = q.bind(Some(v.clone()));
            }
        } else if bool_cols.contains(c) {
            q = q.bind(value_to_i64_bool(v) != 0);
        } else if dt_cols.contains(c) {
            // MySQL DATETIME — parse ISO/text into NaiveDateTime.
            let parsed: Option<NaiveDateTime> = parse_naive_dt(v);
            q = q.bind(parsed);
        } else {
            q = bind_scalar_mysql(q, v);
        }
    }
    q.execute(pool).await?;
    Ok(())
}

fn datetime_columns(table: &str) -> &'static [&'static str] {
    match table {
        "trades" => &["submitted_at", "filled_at", "created_at", "updated_at"],
        "research_analyses" => &["generated_at"],
        "deep_research" => &["created_at"],
        "signals" => &["created_at"],
        "risk_events" => &["created_at"],
        "briefings" => &["generated_at"],
        "chat_messages" => &["created_at"],
        _ => &[],
    }
}

fn parse_naive_dt(v: &Value) -> Option<chrono::NaiveDateTime> {
    use chrono::{DateTime, NaiveDateTime};
    let raw = v.as_str()?;
    if raw.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(&raw.replace('Z', "+00:00")) {
        return Some(dt.naive_utc());
    }
    let candidate = raw.replace('T', " ");
    let candidate = candidate.split('.').next().unwrap_or(&candidate);
    NaiveDateTime::parse_from_str(candidate, "%Y-%m-%d %H:%M:%S").ok()
}

fn value_to_i64_bool(v: &Value) -> i64 {
    match v {
        Value::Bool(b) => *b as i64,
        Value::Number(n) => n.as_i64().unwrap_or(0),
        Value::String(s) => matches!(s.as_str(), "1" | "true" | "TRUE") as i64,
        _ => 0,
    }
}

fn bind_scalar_sqlite<'q>(
    q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    v: &Value,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else {
                q.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => q.bind(s.clone()),
        other => q.bind(other.to_string()),
    }
}

fn bind_scalar_mysql<'q>(
    q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    v: &Value,
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    match v {
        Value::Null => q.bind(None::<String>),
        Value::Bool(b) => q.bind(*b as i64),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                q.bind(i)
            } else {
                q.bind(n.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(s) => q.bind(s.clone()),
        other => q.bind(other.to_string()),
    }
}

// =============================================================================
// Config tables
// =============================================================================

/// watchlist: union of symbols on both sides.
async fn sync_watchlist(sqlite: &SqlitePool, mysql: &MySqlPool) -> anyhow::Result<()> {
    let sq = fetch_all_sqlite(sqlite, "watchlist").await?;
    let my = fetch_all_mysql(mysql, "watchlist").await?;
    let sq_syms: HashSet<String> = sq.iter().map(|r| s(r, "symbol")).collect();
    let my_syms: HashSet<String> = my.iter().map(|r| s(r, "symbol")).collect();
    let now = Utc::now().to_rfc3339();

    for r in &my {
        let sym = s(r, "symbol");
        if !sym.is_empty() && !sq_syms.contains(&sym) {
            sqlx::query("INSERT OR IGNORE INTO watchlist (symbol, added_at) VALUES (?, ?)")
                .bind(&sym)
                .bind(&now)
                .execute(sqlite)
                .await?;
        }
    }
    for r in &sq {
        let sym = s(r, "symbol");
        if !sym.is_empty() && !my_syms.contains(&sym) {
            sqlx::query("INSERT IGNORE INTO watchlist (symbol, added_at) VALUES (?, ?)")
                .bind(&sym)
                .bind(Utc::now().naive_utc())
                .execute(mysql)
                .await?;
        }
    }
    Ok(())
}

/// settings: last-write-wins is hard without a timestamp, so union by key —
/// insert keys missing on either side. (Values rarely conflict; risk_limits /
/// worker config are authored on whichever side is active.)
async fn sync_settings(sqlite: &SqlitePool, mysql: &MySqlPool) -> anyhow::Result<()> {
    let sq = fetch_all_sqlite(sqlite, "settings").await?;
    let my = fetch_all_mysql(mysql, "settings").await?;
    let sq_keys: HashSet<String> = sq.iter().map(|r| s(r, "key")).collect();
    let my_keys: HashSet<String> = my.iter().map(|r| s(r, "key")).collect();

    for r in &my {
        let k = s(r, "key");
        if k.is_empty() || sq_keys.contains(&k) {
            continue;
        }
        let val = &r["value"];
        let text = if let Some(t) = val.as_str() { t.to_string() } else { val.to_string() };
        sqlx::query("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)")
            .bind(&k)
            .bind(text)
            .execute(sqlite)
            .await?;
    }
    for r in &sq {
        let k = s(r, "key");
        if k.is_empty() || my_keys.contains(&k) {
            continue;
        }
        let val = &r["value"];
        let parsed: Value = match val.as_str() {
            Some(t) => serde_json::from_str(t).unwrap_or(Value::String(t.to_string())),
            None => val.clone(),
        };
        sqlx::query("INSERT IGNORE INTO settings (`key`, value) VALUES (?, ?)")
            .bind(&k)
            .bind(parsed)
            .execute(mysql)
            .await?;
    }
    Ok(())
}

/// strategies / bots: last-write-wins by `updated_at` on a shared string id.
async fn sync_lww_table(sqlite: &SqlitePool, mysql: &MySqlPool, table: &str) -> anyhow::Result<()> {
    let sq = fetch_all_sqlite(sqlite, table).await?;
    let my = fetch_all_mysql(mysql, table).await?;
    let sq_by_id: HashMap<String, &Value> = sq.iter().map(|r| (s(r, "id"), r)).collect();
    let my_by_id: HashMap<String, &Value> = my.iter().map(|r| (s(r, "id"), r)).collect();

    let lww_cols = lww_columns(table);

    // Rows only in MySQL -> insert into SQLite.
    for (id, r) in &my_by_id {
        if id.is_empty() {
            continue;
        }
        if !sq_by_id.contains_key(id) {
            insert_lww_sqlite(sqlite, table, r, &lww_cols).await?;
        }
    }
    // Rows only in SQLite -> insert into MySQL; rows on both -> newer wins.
    for (id, r) in &sq_by_id {
        if id.is_empty() {
            continue;
        }
        match my_by_id.get(id) {
            None => insert_lww_mysql(mysql, table, r, &lww_cols).await?,
            Some(my_row) => {
                let sq_ts = norm_ts(r, "updated_at");
                let my_ts = norm_ts(my_row, "updated_at");
                if sq_ts > my_ts {
                    // SQLite newer -> overwrite MySQL.
                    delete_by_id(mysql, table, id).await?;
                    insert_lww_mysql(mysql, table, r, &lww_cols).await?;
                } else if my_ts > sq_ts {
                    // MySQL newer -> overwrite SQLite.
                    delete_by_id_sqlite(sqlite, table, id).await?;
                    insert_lww_sqlite(sqlite, table, my_row, &lww_cols).await?;
                }
            }
        }
    }
    Ok(())
}

fn lww_columns(table: &str) -> Vec<&'static str> {
    match table {
        "strategies" => vec![
            "id", "name", "symbols", "timeframe", "rules", "ai_gate", "exits", "sizing",
            "action", "mode", "enabled", "created_at", "updated_at",
        ],
        "bots" => vec![
            "id", "name", "enabled", "symbols", "kind", "config", "rules", "ai_gate",
            "risk", "action", "mode", "created_at", "updated_at",
        ],
        _ => vec![],
    }
}

fn lww_json_columns(table: &str) -> &'static [&'static str] {
    match table {
        "strategies" => &["symbols", "rules", "ai_gate", "exits", "sizing", "action"],
        "bots" => &["symbols", "config", "rules", "ai_gate", "risk", "action"],
        _ => &[],
    }
}

fn lww_bool_columns(_table: &str) -> &'static [&'static str] {
    &["enabled"]
}

fn lww_dt_columns(_table: &str) -> &'static [&'static str] {
    &["created_at", "updated_at"]
}

async fn delete_by_id(pool: &MySqlPool, table: &str, id: &str) -> anyhow::Result<()> {
    sqlx::query(&format!("DELETE FROM {table} WHERE id = ?")).bind(id).execute(pool).await?;
    Ok(())
}
async fn delete_by_id_sqlite(pool: &SqlitePool, table: &str, id: &str) -> anyhow::Result<()> {
    sqlx::query(&format!("DELETE FROM {table} WHERE id = ?")).bind(id).execute(pool).await?;
    Ok(())
}

async fn insert_lww_sqlite(
    pool: &SqlitePool,
    table: &str,
    row: &Value,
    cols: &[&str],
) -> anyhow::Result<()> {
    let json_cols = lww_json_columns(table);
    let bool_cols = lww_bool_columns(table);
    let placeholders = vec!["?"; cols.len()].join(",");
    let sql = format!("INSERT OR REPLACE INTO {table} ({}) VALUES ({placeholders})", cols.join(","));
    let mut q = sqlx::query(&sql);
    for c in cols {
        let v = &row[*c];
        if json_cols.contains(c) {
            if v.is_null() {
                q = q.bind(None::<String>);
            } else if let Some(t) = v.as_str() {
                q = q.bind(t.to_string());
            } else {
                q = q.bind(v.to_string());
            }
        } else if bool_cols.contains(c) {
            q = q.bind(value_to_i64_bool(v));
        } else {
            q = bind_scalar_sqlite(q, v);
        }
    }
    q.execute(pool).await?;
    Ok(())
}

async fn insert_lww_mysql(
    pool: &MySqlPool,
    table: &str,
    row: &Value,
    cols: &[&str],
) -> anyhow::Result<()> {
    use chrono::NaiveDateTime;
    let json_cols = lww_json_columns(table);
    let bool_cols = lww_bool_columns(table);
    let dt_cols = lww_dt_columns(table);
    let placeholders = vec!["?"; cols.len()].join(",");
    let collist = cols.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(",");
    let sql = format!("REPLACE INTO {table} ({collist}) VALUES ({placeholders})");
    let mut q = sqlx::query(&sql);
    for c in cols {
        let v = &row[*c];
        if json_cols.contains(c) {
            if v.is_null() {
                q = q.bind(None::<Value>);
            } else if let Some(t) = v.as_str() {
                let parsed: Value = serde_json::from_str(t).unwrap_or(Value::String(t.to_string()));
                q = q.bind(Some(parsed));
            } else {
                q = q.bind(Some(v.clone()));
            }
        } else if bool_cols.contains(c) {
            q = q.bind(value_to_i64_bool(v) != 0);
        } else if dt_cols.contains(c) {
            let parsed: Option<NaiveDateTime> = parse_naive_dt(v);
            q = q.bind(parsed);
        } else {
            q = bind_scalar_mysql(q, v);
        }
    }
    q.execute(pool).await?;
    Ok(())
}
