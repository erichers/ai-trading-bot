//! Retrieval-augmented knowledge index over the user's REAL trading data.
//!
//! - Indexes rows from trades/signals/risk_events/research_analyses/deep_research/
//!   briefings into a `rag_documents` table as readable `doc_text`, with an optional
//!   Ollama embedding (JSON f32 array). When embeddings are unavailable we store a
//!   NULL embedding and retrieval falls back to keyword/LIKE matching over the SAME
//!   real text (never mock data).
//! - Computes auto-improving insights from real trade outcomes and stores a few
//!   natural-language insight docs (source_table='insight') so they're retrievable.
//! - Provides cosine-similarity search used by the chat layer for grounding.

use crate::database::Db;
use crate::error::ApiResult;
use crate::state::AppState;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::Row;

// =============================================================================
// rag_documents persistence
// =============================================================================

/// Fetch the set of already-indexed (source_table, source_id) -> source_updated_at.
/// Used to skip unchanged rows (incremental / idempotent).
async fn existing_keys(db: &Db) -> ApiResult<std::collections::HashMap<String, String>> {
    let mut map = std::collections::HashMap::new();
    match db {
        Db::My(pool) => {
            let rows = sqlx::query(
                "SELECT source_table, source_id, source_updated_at FROM rag_documents",
            )
            .fetch_all(pool)
            .await?;
            for r in rows {
                let st: String = r.try_get("source_table").unwrap_or_default();
                let sid: String = r.try_get("source_id").unwrap_or_default();
                let su: Option<String> = r.try_get("source_updated_at").ok();
                map.insert(format!("{st}|{sid}"), su.unwrap_or_default());
            }
        }
        Db::Sq(pool) => {
            let rows = sqlx::query(
                "SELECT source_table, source_id, source_updated_at FROM rag_documents",
            )
            .fetch_all(pool)
            .await?;
            for r in rows {
                let st: String = r.try_get("source_table").unwrap_or_default();
                let sid: String = r.try_get("source_id").unwrap_or_default();
                let su: Option<String> = r.try_get("source_updated_at").ok().flatten();
                map.insert(format!("{st}|{sid}"), su.unwrap_or_default());
            }
        }
    }
    Ok(map)
}

/// Insert or replace one document. `embedding` is a JSON array string or None.
async fn upsert_doc(
    db: &Db,
    source_table: &str,
    source_id: &str,
    doc_text: &str,
    embedding: Option<&str>,
    metadata: &Value,
    source_updated_at: &str,
) -> ApiResult<()> {
    match db {
        Db::My(pool) => {
            sqlx::query(
                "INSERT INTO rag_documents (source_table, source_id, doc_text, embedding, metadata, source_updated_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?) \
                 ON DUPLICATE KEY UPDATE doc_text=VALUES(doc_text), embedding=VALUES(embedding), metadata=VALUES(metadata), source_updated_at=VALUES(source_updated_at), updated_at=VALUES(updated_at)",
            )
            .bind(source_table)
            .bind(source_id)
            .bind(doc_text)
            .bind(embedding)
            .bind(metadata)
            .bind(source_updated_at)
            .bind(Utc::now().naive_utc())
            .execute(pool)
            .await?;
        }
        Db::Sq(pool) => {
            sqlx::query(
                "INSERT INTO rag_documents (source_table, source_id, doc_text, embedding, metadata, source_updated_at, updated_at) \
                 VALUES (?, ?, ?, ?, ?, ?, ?) \
                 ON CONFLICT(source_table, source_id) DO UPDATE SET doc_text=excluded.doc_text, embedding=excluded.embedding, metadata=excluded.metadata, source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at",
            )
            .bind(source_table)
            .bind(source_id)
            .bind(doc_text)
            .bind(embedding)
            .bind(metadata.to_string())
            .bind(source_updated_at)
            .bind(Utc::now().to_rfc3339())
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}

async fn count_docs(db: &Db) -> ApiResult<i64> {
    let n: i64 = match db {
        Db::My(pool) => sqlx::query("SELECT COUNT(*) AS c FROM rag_documents")
            .fetch_one(pool)
            .await?
            .try_get("c")?,
        Db::Sq(pool) => sqlx::query("SELECT COUNT(*) AS c FROM rag_documents")
            .fetch_one(pool)
            .await?
            .try_get("c")?,
    };
    Ok(n)
}

/// A stored document loaded for retrieval.
struct StoredDoc {
    source_table: String,
    source_id: String,
    doc_text: String,
    embedding: Option<Vec<f32>>,
    metadata: Value,
}

async fn load_all_docs(db: &Db) -> ApiResult<Vec<StoredDoc>> {
    let mut out = vec![];
    match db {
        Db::My(pool) => {
            let rows = sqlx::query(
                "SELECT source_table, source_id, doc_text, embedding, metadata FROM rag_documents",
            )
            .fetch_all(pool)
            .await?;
            for r in rows {
                let emb_s: Option<String> = r.try_get("embedding").ok();
                let meta: Value = r.try_get("metadata").unwrap_or(Value::Null);
                out.push(StoredDoc {
                    source_table: r.try_get("source_table").unwrap_or_default(),
                    source_id: r.try_get("source_id").unwrap_or_default(),
                    doc_text: r.try_get("doc_text").unwrap_or_default(),
                    embedding: emb_s.and_then(|s| serde_json::from_str(&s).ok()),
                    metadata: meta,
                });
            }
        }
        Db::Sq(pool) => {
            let rows = sqlx::query(
                "SELECT source_table, source_id, doc_text, embedding, metadata FROM rag_documents",
            )
            .fetch_all(pool)
            .await?;
            for r in rows {
                let emb_s: Option<String> = r.try_get("embedding").ok().flatten();
                let meta_s: Option<String> = r.try_get("metadata").ok().flatten();
                out.push(StoredDoc {
                    source_table: r.try_get("source_table").unwrap_or_default(),
                    source_id: r.try_get("source_id").unwrap_or_default(),
                    doc_text: r.try_get("doc_text").unwrap_or_default(),
                    embedding: emb_s.and_then(|s| serde_json::from_str(&s).ok()),
                    metadata: meta_s.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null),
                });
            }
        }
    }
    Ok(out)
}

// =============================================================================
// Indexer
// =============================================================================

fn fnum(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}
fn fstr<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

/// Build a readable doc_text for one source row. Returns (doc_text, metadata).
fn doc_for(source_table: &str, row: &Value) -> (String, Value) {
    match source_table {
        "trades" => {
            let mut pnl = String::new();
            // realized P&L if filled (best-effort; raw may carry more detail).
            if let Some(p) = fnum(row, "filled_avg_price") {
                if p > 0.0 {
                    pnl = format!(" filled @ ${p:.2}");
                }
            }
            let txt = format!(
                "Trade #{}: {} {} {} {} ({}), status={}, source={}, strategy={}{}.",
                fstr(row, "id"),
                fstr(row, "side").to_uppercase(),
                row.get("qty").map(|q| q.to_string()).unwrap_or_default(),
                fstr(row, "symbol"),
                fstr(row, "order_type"),
                fstr(row, "asset_class"),
                fstr(row, "status"),
                fstr(row, "source"),
                {
                    let s = fstr(row, "strategy_id");
                    if s.is_empty() { "none".to_string() } else { s.to_string() }
                },
                pnl,
            );
            let meta = json!({
                "symbol": fstr(row, "symbol"), "side": fstr(row, "side"),
                "status": fstr(row, "status"), "strategy_id": fstr(row, "strategy_id"),
                "asset_class": fstr(row, "asset_class"),
            });
            (txt, meta)
        }
        "signals" => {
            let txt = format!(
                "Signal: strategy={} {} on {} ({}), fired={}.",
                fstr(row, "strategy_id"),
                fstr(row, "symbol"),
                fstr(row, "timeframe"),
                fstr(row, "symbol"),
                row.get("fired").map(|x| x.to_string()).unwrap_or_default(),
            );
            (txt, json!({"symbol": fstr(row, "symbol"), "strategy_id": fstr(row, "strategy_id")}))
        }
        "risk_events" => {
            // rule + message come from the rules/computed JSON columns.
            let rules = &row["rules"];
            let mut reasons = vec![];
            if let Some(arr) = rules.as_array() {
                for r in arr {
                    let kind = fstr(r, "kind");
                    let msg = fstr(r, "message");
                    let rule = fstr(r, "rule");
                    let bit = [rule, msg].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(": ");
                    if !bit.is_empty() {
                        reasons.push(if kind.is_empty() { bit } else { format!("{kind} {bit}") });
                    }
                }
            }
            let reason_txt = if reasons.is_empty() { "no specific rule".to_string() } else { reasons.join("; ") };
            let txt = format!(
                "Risk event: {} {} {} {} -> decision={}. Reasons: {}.",
                fstr(row, "side").to_uppercase(),
                row.get("qty").map(|q| q.to_string()).unwrap_or_default(),
                fstr(row, "symbol"),
                fstr(row, "order_type"),
                fstr(row, "decision"),
                reason_txt,
            );
            (txt, json!({"symbol": fstr(row, "symbol"), "decision": fstr(row, "decision"), "reasons": reasons}))
        }
        "research_analyses" => {
            let txt = format!(
                "Research on {}: thesis: {} | suggested_action={}, conviction={}, sentiment={}, regime={}, provider={}.",
                fstr(row, "symbol"),
                fstr(row, "thesis").chars().take(600).collect::<String>(),
                fstr(row, "suggested_action"),
                fnum(row, "conviction").unwrap_or(0.0),
                fnum(row, "sentiment_score").unwrap_or(0.0),
                fstr(row, "regime"),
                fstr(row, "provider"),
            );
            (txt, json!({"symbol": fstr(row, "symbol"), "suggested_action": fstr(row, "suggested_action"), "regime": fstr(row, "regime")}))
        }
        "deep_research" => {
            let body = fstr(row, "body");
            let txt = format!(
                "{} [{}] {}: {}",
                fstr(row, "symbol"),
                fstr(row, "kind"),
                fstr(row, "title"),
                body.chars().take(800).collect::<String>(),
            );
            (txt, json!({"symbol": fstr(row, "symbol"), "kind": fstr(row, "kind"), "title": fstr(row, "title")}))
        }
        "briefings" => {
            let items = row["items"].as_array().map(|a| {
                a.iter().filter_map(|i| i.get("note").and_then(|n| n.as_str())).collect::<Vec<_>>().join("; ")
            }).unwrap_or_default();
            let txt = format!(
                "Market briefing (regime={}): {} Watchlist notes: {}",
                fstr(row, "regime"),
                fstr(row, "summary").chars().take(600).collect::<String>(),
                items,
            );
            (txt, json!({"regime": fstr(row, "regime")}))
        }
        _ => (String::new(), Value::Null),
    }
}

/// Pull recent rows from a source table via the read-only SQL path.
async fn fetch_rows(db: &Db, sql: &str) -> Vec<Value> {
    match crate::db::run_readonly_sql(db, sql).await {
        Ok(v) => v["rows"].as_array().cloned().unwrap_or_default(),
        Err(e) => {
            tracing::warn!("rag indexer: query failed ({}): {}", sql, e.detail);
            vec![]
        }
    }
}

/// Each source table: (name, SQL pulling rows incl. id + updated marker).
fn source_queries() -> Vec<(&'static str, &'static str)> {
    vec![
        ("trades", "SELECT id, symbol, asset_class, side, qty, order_type, status, filled_qty, filled_avg_price, source, strategy_id, created_at, updated_at FROM trades ORDER BY id DESC LIMIT 2000"),
        ("signals", "SELECT id, strategy_id, symbol, timeframe, fired, created_at FROM signals ORDER BY id DESC LIMIT 1000"),
        ("risk_events", "SELECT id, symbol, side, qty, order_type, decision, rules, source, created_at FROM risk_events ORDER BY id DESC LIMIT 1000"),
        ("research_analyses", "SELECT id, symbol, thesis, sentiment_score, conviction, suggested_action, regime, provider, generated_at FROM research_analyses ORDER BY id DESC LIMIT 1000"),
        ("deep_research", "SELECT id, symbol, kind, title, body, provider, created_at FROM deep_research ORDER BY id DESC LIMIT 1000"),
        ("briefings", "SELECT id, summary, items, regime, generated_at FROM briefings ORDER BY id DESC LIMIT 500"),
    ]
}

fn updated_marker(row: &Value) -> String {
    for k in ["updated_at", "created_at", "generated_at"] {
        if let Some(s) = row.get(k).and_then(|v| v.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    // numeric id fallback ensures idempotency even with no timestamp.
    row.get("id").map(|v| v.to_string()).unwrap_or_default()
}

/// Reindex all sources. Embeds new/changed docs (keyword fallback if Ollama down).
/// Returns {indexed, total, embeddings_active}.
pub async fn reindex(state: &AppState) -> Value {
    let db = &state.pool;
    let existing = match existing_keys(db).await {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!("rag reindex: failed to load existing keys: {}", e.detail);
            std::collections::HashMap::new()
        }
    };

    // Probe embeddings once so we don't hammer Ollama if it's down.
    let embeddings_active = state.llm.embed("probe").await.is_ok();
    if !embeddings_active {
        tracing::warn!("rag reindex: embeddings unavailable — using keyword/LIKE retrieval fallback (real data, not mock).");
    }

    let mut indexed = 0i64;
    for (table, sql) in source_queries() {
        let rows = fetch_rows(db, sql).await;
        for row in rows {
            let id = row.get("id").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            let marker = updated_marker(&row);
            let key = format!("{table}|{id}");
            if existing.get(&key).map(|m| m == &marker).unwrap_or(false) {
                continue; // unchanged — skip (idempotent)
            }
            let (doc_text, metadata) = doc_for(table, &row);
            if doc_text.trim().is_empty() {
                continue;
            }
            let emb_json = if embeddings_active {
                match state.llm.embed(&doc_text).await {
                    Ok(v) => serde_json::to_string(&v).ok(),
                    Err(e) => {
                        tracing::warn!("rag: embed failed for {key}: {e}");
                        None
                    }
                }
            } else {
                None
            };
            if upsert_doc(db, table, &id, &doc_text, emb_json.as_deref(), &metadata, &marker)
                .await
                .is_ok()
            {
                indexed += 1;
            }
        }
    }

    // Insights (also stored as retrievable docs).
    let insights = compute_insights(state).await;
    store_insight_docs(state, &insights, embeddings_active).await;

    let total = count_docs(db).await.unwrap_or(0);
    json!({"indexed": indexed, "total": total, "embeddings_active": embeddings_active})
}

// =============================================================================
// Search (cosine over embeddings, or keyword fallback)
// =============================================================================

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Keyword overlap score in [0,1]: fraction of query terms present in doc_text.
fn keyword_score(query: &str, doc: &str) -> f32 {
    let doc_l = doc.to_lowercase();
    let terms: Vec<String> = query
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() >= 3)
        .map(|t| t.to_string())
        .collect();
    if terms.is_empty() {
        return 0.0;
    }
    let hits = terms.iter().filter(|t| doc_l.contains(t.as_str())).count();
    hits as f32 / terms.len() as f32
}

/// Top-k retrieval. Returns an array of {source_table, source_id, doc_text, score, metadata}.
pub async fn search(state: &AppState, query: &str, k: usize) -> Value {
    let docs = match load_all_docs(&state.pool).await {
        Ok(d) => d,
        Err(e) => {
            return json!({"results": [], "error": e.detail, "mode": "error"});
        }
    };
    if docs.is_empty() {
        return json!({"results": [], "mode": "empty"});
    }

    // Try embedding the query; if any docs have embeddings, rank by cosine.
    let q_emb = state.llm.embed(query).await.ok();
    let any_emb = docs.iter().any(|d| d.embedding.is_some());
    let use_vec = q_emb.is_some() && any_emb;

    let mut scored: Vec<(f32, &StoredDoc)> = docs
        .iter()
        .map(|d| {
            let score = if use_vec {
                match (&q_emb, &d.embedding) {
                    (Some(q), Some(e)) => cosine(q, e),
                    // doc has no embedding: fall back to keyword for this doc
                    _ => keyword_score(query, &d.doc_text) * 0.5,
                }
            } else {
                keyword_score(query, &d.doc_text)
            };
            (score, d)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

    let mode = if use_vec { "embedding" } else { "keyword" };
    let results: Vec<Value> = scored
        .into_iter()
        .take(k)
        .filter(|(s, _)| *s > 0.0)
        .map(|(s, d)| {
            json!({
                "source_table": d.source_table,
                "source_id": d.source_id,
                "doc_text": d.doc_text,
                "score": (s * 1000.0).round() / 1000.0,
                "metadata": d.metadata,
            })
        })
        .collect();
    json!({"results": results, "mode": mode})
}

// =============================================================================
// Auto-improving insights
// =============================================================================

/// Compute real aggregates from trades (+signals/risk_events) and return structured JSON.
pub async fn compute_insights(state: &AppState) -> Value {
    let db = &state.pool;

    let trades = fetch_rows(db, "SELECT id, symbol, side, status, filled_avg_price, filled_qty, strategy_id, source FROM trades ORDER BY id DESC LIMIT 5000").await;
    let total_trades = trades.len();

    // Outcome proxy: realized PnL needs entry/exit pairing. We don't have a closed
    // P&L column, so we report fill-based aggregates honestly: filled vs other, by
    // strategy, by symbol. (NO fabricated P&L.)
    let mut filled = 0usize;
    let mut canceled = 0usize;
    let mut by_strategy: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new(); // (filled, total)
    let mut by_symbol: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for t in &trades {
        let status = fstr(t, "status").to_lowercase();
        let is_filled = status == "filled";
        if is_filled {
            filled += 1;
        }
        if status == "canceled" || status == "cancelled" || status == "rejected" || status == "expired" {
            canceled += 1;
        }
        let strat = {
            let s = fstr(t, "strategy_id");
            if s.is_empty() { "manual/none".to_string() } else { s.to_string() }
        };
        let e = by_strategy.entry(strat).or_insert((0, 0));
        e.1 += 1;
        if is_filled {
            e.0 += 1;
        }
        let sym = fstr(t, "symbol");
        if !sym.is_empty() {
            *by_symbol.entry(sym.to_string()).or_insert(0) += 1;
        }
    }
    let fill_rate = if total_trades > 0 { filled as f64 / total_trades as f64 } else { 0.0 };

    // By-strategy fill rates.
    let mut strat_stats: Vec<Value> = by_strategy
        .iter()
        .map(|(k, (f, tot))| {
            let rate = if *tot > 0 { *f as f64 / *tot as f64 } else { 0.0 };
            json!({"strategy_id": k, "trades": tot, "filled": f, "fill_rate": (rate * 1000.0).round() / 1000.0})
        })
        .collect();
    strat_stats.sort_by(|a, b| b["trades"].as_i64().cmp(&a["trades"].as_i64()));

    // Most-traded symbols.
    let mut sym_stats: Vec<(String, usize)> = by_symbol.into_iter().collect();
    sym_stats.sort_by(|a, b| b.1.cmp(&a.1));
    let top_symbols: Vec<Value> = sym_stats.iter().take(8).map(|(s, c)| json!({"symbol": s, "trades": c})).collect();

    // Risk-veto reasons.
    let risk_events = fetch_rows(db, "SELECT decision, rules FROM risk_events ORDER BY id DESC LIMIT 2000").await;
    let mut vetoed = 0usize;
    let mut reason_counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for ev in &risk_events {
        let decision = fstr(ev, "decision").to_lowercase();
        if decision.contains("veto") || decision == "reject" || decision == "blocked" || decision == "deny" {
            vetoed += 1;
        }
        if let Some(arr) = ev["rules"].as_array() {
            for r in arr {
                if fstr(r, "kind") == "veto" {
                    let reason = {
                        let m = fstr(r, "message");
                        let rl = fstr(r, "rule");
                        if !rl.is_empty() { rl.to_string() } else if !m.is_empty() { m.to_string() } else { "unspecified".to_string() }
                    };
                    *reason_counts.entry(reason).or_insert(0) += 1;
                }
            }
        }
    }
    let mut veto_reasons: Vec<(String, usize)> = reason_counts.into_iter().collect();
    veto_reasons.sort_by(|a, b| b.1.cmp(&a.1));
    let top_veto_reasons: Vec<Value> = veto_reasons.iter().take(6).map(|(r, c)| json!({"reason": r, "count": c})).collect();

    // Signal -> fill ratio.
    let sig_rows = fetch_rows(db, "SELECT COUNT(*) AS c FROM signals WHERE fired = 1").await;
    let signals_fired = sig_rows.first().and_then(|r| r["c"].as_i64()).unwrap_or(0);
    let signal_fill_ratio = if signals_fired > 0 { filled as f64 / signals_fired as f64 } else { 0.0 };

    // Natural-language hints.
    let mut hints: Vec<String> = vec![];
    for s in &strat_stats {
        let tot = s["trades"].as_i64().unwrap_or(0);
        let rate = s["fill_rate"].as_f64().unwrap_or(0.0);
        let id = s["strategy_id"].as_str().unwrap_or("?");
        if tot >= 10 && rate < 0.5 {
            hints.push(format!(
                "Strategy '{}': only {:.0}% of {} orders filled — entries/limit prices may be too tight; consider marketable limits or wider slippage.",
                id, rate * 100.0, tot
            ));
        }
    }
    if vetoed > 0 {
        if let Some(top) = top_veto_reasons.first() {
            hints.push(format!(
                "Risk engine vetoed {} order(s); most common reason: '{}' ({} times) — adjust sizing/concentration to reduce blocked orders.",
                vetoed, top["reason"].as_str().unwrap_or("?"), top["count"].as_i64().unwrap_or(0)
            ));
        }
    }
    if signals_fired > 0 && signal_fill_ratio < 0.3 {
        hints.push(format!(
            "Signal->fill ratio is low ({:.0}%): {} signals fired but only {} fills — many signals aren't converting to executed trades.",
            signal_fill_ratio * 100.0, signals_fired, filled
        ));
    }
    if hints.is_empty() {
        hints.push(format!(
            "Across {} trades, {:.0}% filled. Not enough closed-outcome data yet for deeper win-rate analysis.",
            total_trades, fill_rate * 100.0
        ));
    }

    json!({
        "total_trades": total_trades,
        "filled": filled,
        "canceled_or_rejected": canceled,
        "fill_rate": (fill_rate * 1000.0).round() / 1000.0,
        "by_strategy": strat_stats,
        "top_symbols": top_symbols,
        "signals_fired": signals_fired,
        "signal_fill_ratio": (signal_fill_ratio * 1000.0).round() / 1000.0,
        "risk_events_total": risk_events.len(),
        "vetoed": vetoed,
        "top_veto_reasons": top_veto_reasons,
        "hints": hints,
        "computed_at": Utc::now().to_rfc3339(),
        "note": "Aggregates are fill/outcome-based from REAL rows; no realized P&L column exists so win-rate is reported as fill-rate (no fabricated P&L).",
    })
}

/// Persist a few insight docs into rag_documents (source_table='insight') so they're retrievable.
async fn store_insight_docs(state: &AppState, insights: &Value, embeddings_active: bool) {
    let db = &state.pool;
    let mut docs: Vec<(String, String, Value)> = vec![];

    let overview = format!(
        "Trading overview: {} total trades, {:.0}% fill rate ({} filled, {} canceled/rejected). {} signals fired (signal->fill ratio {:.0}%). Risk engine vetoed {} of {} risk events.",
        insights["total_trades"].as_i64().unwrap_or(0),
        insights["fill_rate"].as_f64().unwrap_or(0.0) * 100.0,
        insights["filled"].as_i64().unwrap_or(0),
        insights["canceled_or_rejected"].as_i64().unwrap_or(0),
        insights["signals_fired"].as_i64().unwrap_or(0),
        insights["signal_fill_ratio"].as_f64().unwrap_or(0.0) * 100.0,
        insights["vetoed"].as_i64().unwrap_or(0),
        insights["risk_events_total"].as_i64().unwrap_or(0),
    );
    docs.push(("overview".into(), overview, json!({"kind": "overview"})));

    if let Some(arr) = insights["by_strategy"].as_array() {
        let txt = arr.iter().map(|s| format!(
            "{}: {} trades, {:.0}% filled",
            s["strategy_id"].as_str().unwrap_or("?"), s["trades"].as_i64().unwrap_or(0), s["fill_rate"].as_f64().unwrap_or(0.0) * 100.0
        )).collect::<Vec<_>>().join("; ");
        if !txt.is_empty() {
            docs.push(("by_strategy".into(), format!("Performance by strategy/bot: {txt}."), json!({"kind": "by_strategy"})));
        }
    }

    if let Some(hints) = insights["hints"].as_array() {
        let txt = hints.iter().filter_map(|h| h.as_str()).collect::<Vec<_>>().join(" ");
        if !txt.is_empty() {
            docs.push(("hints".into(), format!("Improvement hints: {txt}"), json!({"kind": "hints"})));
        }
    }

    for (id, text, meta) in docs {
        let emb_json = if embeddings_active {
            state.llm.embed(&text).await.ok().and_then(|v| serde_json::to_string(&v).ok())
        } else {
            None
        };
        let marker = Utc::now().to_rfc3339();
        let _ = upsert_doc(db, "insight", &id, &text, emb_json.as_deref(), &meta, &marker).await;
    }
}

// =============================================================================
// Background refresh worker
// =============================================================================

/// Spawn a non-blocking background task: index once on startup, then every ~5 min.
pub fn start(state: AppState) {
    tokio::spawn(async move {
        // Small delay so the main research worker / startup logs settle first.
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        loop {
            let r = reindex(&state).await;
            tracing::info!(
                "rag: reindex complete (indexed={}, total={}, embeddings={})",
                r["indexed"], r["total"], r["embeddings_active"]
            );
            tokio::time::sleep(std::time::Duration::from_secs(300)).await;
        }
    });
}
