//! Vanna-style chat: Gemma generates a read-only SELECT; we validate + execute.

use crate::db;
use crate::llm::parse_json_loose;
use crate::state::AppState;
use serde_json::{json, Value};

pub fn schema() -> Value {
    json!([
        {"table": "trades", "columns": [
            {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
            {"name": "asset_class", "type": "string"}, {"name": "side", "type": "string"},
            {"name": "qty", "type": "float"}, {"name": "order_type", "type": "string"},
            {"name": "status", "type": "string"}, {"name": "filled_qty", "type": "float"},
            {"name": "filled_avg_price", "type": "float"}, {"name": "source", "type": "string"},
            {"name": "strategy_id", "type": "string"}, {"name": "created_at", "type": "datetime"}
        ]},
        {"table": "research_analyses", "columns": [
            {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
            {"name": "thesis", "type": "text"}, {"name": "sentiment_score", "type": "float"},
            {"name": "conviction", "type": "float"}, {"name": "suggested_action", "type": "string"},
            {"name": "regime", "type": "string"}, {"name": "provider", "type": "string"},
            {"name": "model", "type": "string"}, {"name": "generated_at", "type": "datetime"}
        ]},
        {"table": "deep_research", "columns": [
            {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
            {"name": "kind", "type": "string"}, {"name": "title", "type": "string"},
            {"name": "provider", "type": "string"}, {"name": "model", "type": "string"},
            {"name": "created_at", "type": "datetime"}
        ]},
        {"table": "signals", "columns": [
            {"name": "id", "type": "int"}, {"name": "strategy_id", "type": "string"},
            {"name": "symbol", "type": "string"}, {"name": "timeframe", "type": "string"},
            {"name": "fired", "type": "bool"}, {"name": "created_at", "type": "datetime"}
        ]},
        {"table": "risk_events", "columns": [
            {"name": "id", "type": "int"}, {"name": "symbol", "type": "string"},
            {"name": "side", "type": "string"}, {"name": "qty", "type": "float"},
            {"name": "order_type", "type": "string"}, {"name": "decision", "type": "string"},
            {"name": "source", "type": "string"}, {"name": "created_at", "type": "datetime"}
        ]},
        {"table": "bots", "columns": [
            {"name": "id", "type": "string"}, {"name": "name", "type": "string"},
            {"name": "enabled", "type": "bool"}, {"name": "kind", "type": "string"},
            {"name": "mode", "type": "string"}, {"name": "created_at", "type": "datetime"}
        ]},
        {"table": "strategies", "columns": [
            {"name": "id", "type": "string"}, {"name": "name", "type": "string"},
            {"name": "timeframe", "type": "string"}, {"name": "mode", "type": "string"},
            {"name": "enabled", "type": "bool"}, {"name": "created_at", "type": "datetime"}
        ]},
        {"table": "watchlist", "columns": [
            {"name": "symbol", "type": "string"}, {"name": "added_at", "type": "datetime"}
        ]}
    ])
}

fn schema_text() -> String {
    let s = schema();
    let mut lines = vec![];
    for t in s.as_array().unwrap() {
        let cols: Vec<String> = t["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| format!("{} {}", c["name"].as_str().unwrap(), c["type"].as_str().unwrap()))
            .collect();
        lines.push(format!("- {}({})", t["table"].as_str().unwrap(), cols.join(", ")));
    }
    lines.join("\n")
}

const FORBIDDEN: [&str; 17] = [
    "insert", "update", "delete", "drop", "alter", "create", "truncate", "replace", "grant",
    "revoke", "merge", "call", "exec", "execute", "attach", "pragma", "into",
];

fn validate_sql(sql: &str) -> Result<String, String> {
    if sql.trim().is_empty() {
        return Err("empty SQL".into());
    }
    let mut cleaned = sql.trim().trim_end_matches(';').trim().to_string();
    if cleaned.contains(';') {
        return Err("only a single statement is allowed".into());
    }
    if !cleaned.to_lowercase().trim_start().starts_with("select") {
        return Err("only SELECT statements are allowed".into());
    }
    // strip string literals before keyword scan
    let mut scan = String::new();
    let mut in_str = false;
    let mut quote = ' ';
    for c in cleaned.chars() {
        if in_str {
            if c == quote {
                in_str = false;
            }
        } else if c == '\'' || c == '"' {
            in_str = true;
            quote = c;
        } else {
            scan.push(c);
        }
    }
    let scan_lower = format!(" {} ", scan.to_lowercase().replace(['(', ')', ',', '\n', '\t'], " "));
    for kw in FORBIDDEN {
        if scan_lower.contains(&format!(" {} ", kw)) {
            return Err("forbidden keyword detected — read-only SELECT only".into());
        }
    }
    if !cleaned.to_lowercase().contains("limit") {
        cleaned = format!("{} LIMIT 200", cleaned);
    }
    Ok(cleaned)
}

const CLASSIFY_SYSTEM: &str = "You are a careful data analyst for a trading-terminal app. You answer with a single STRICT JSON object only. Decide if the user's question can be answered by querying the app's database. If yes, set mode='sql' and write ONE read-only MySQL SELECT (no semicolons, no writes) using ONLY the given tables/columns. If it's a general question about markets or the app, set mode='chat' and leave sql empty. JSON keys: mode ('sql'|'chat'), sql (string), reason (string).";

async fn app_context(state: &AppState) -> String {
    let (acct, pos) = match (state.alpaca.get_account().await, state.alpaca.get_positions().await) {
        (Ok(a), Ok(p)) => (a, p),
        _ => (json!({}), json!([])),
    };
    let empty = vec![];
    let pos_summary = pos
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .take(8)
        .map(|p| format!("{}({})", p["symbol"].as_str().unwrap_or(""), p["qty"]))
        .collect::<Vec<_>>()
        .join(", ");
    let pos_summary = if pos_summary.is_empty() { "none".to_string() } else { pos_summary };
    format!(
        "App: an AI trading terminal (Alpaca paper trading + local Gemma research). It has a deterministic risk engine (vetoes orders that breach position/loss/concentration limits, kill switch), a background research worker, weekly-options bots, strategies, and a watchlist.\nAccount equity ${}, buying power ${}, day P/L {}%. Open positions: {}.",
        acct["equity"], acct["buying_power"], acct["day_pl_pct"], pos_summary
    )
}

async fn summarize_rows(state: &AppState, message: &str, sql: &str, result: &Value) -> String {
    let empty = vec![];
    let rows = result["rows"].as_array().unwrap_or(&empty);
    let cols = &result["columns"];
    let preview: Vec<&Value> = rows.iter().take(20).collect();
    let user = format!(
        "User asked: {}\nExecuted SQL: {}\nColumns: {}\nRows (up to 20): {}\nTotal rows returned: {}.\nWrite a concise, friendly markdown answer (1-3 sentences) summarizing the result for the user. Reference concrete numbers from the rows.",
        message, sql, cols, Value::Array(preview.into_iter().cloned().collect()), rows.len()
    );
    match state
        .llm
        .ollama_chat(
            "You summarize SQL query results in plain English markdown. No JSON.",
            &user,
            false,
            300,
        )
        .await
    {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            if rows.is_empty() {
                "The query ran successfully but returned no rows.".to_string()
            } else {
                format!(
                    "The query returned {} row(s). Columns: {}.",
                    rows.len(),
                    cols.as_array().map(|c| c.iter().map(|x| x.as_str().unwrap_or("")).collect::<Vec<_>>().join(", ")).unwrap_or_default()
                )
            }
        }
    }
}

async fn chat_answer(state: &AppState, message: &str, history: &[Value]) -> String {
    let mut hist = String::new();
    for h in history.iter().rev().take(6).rev() {
        hist += &format!("{}: {}\n", h["role"].as_str().unwrap_or("user"), h["content"].as_str().unwrap_or(""));
    }
    let user = format!(
        "{}\n\nConversation so far:\n{}\nUser question: {}\n\nAnswer helpfully in concise markdown.",
        app_context(state).await,
        hist,
        message
    );
    match state
        .llm
        .ollama_chat(
            "You are the assistant inside an AI trading terminal app. Be concise, concrete, and helpful. Plain markdown, no JSON.",
            &user,
            false,
            500,
        )
        .await
    {
        Ok(s) => s.trim().to_string(),
        Err(_) => "I can answer questions about your trades, research, signals, risk events, bots, and the app itself. (The language model is currently unavailable, so this is a fallback response.)".to_string(),
    }
}

pub async fn ask(state: &AppState, message: &str, history: &[Value]) -> Value {
    let message = message.trim();
    if message.is_empty() {
        return json!({"answer": "Ask me about your trades, research, or how the app works.", "mode": "chat"});
    }
    let classify_user = format!(
        "Database schema (MySQL):\n{}\n\nUser question: {}\n\nRespond with STRICT JSON: {{mode, sql, reason}}.",
        schema_text(),
        message
    );
    let plan = match state.llm.ollama_chat(CLASSIFY_SYSTEM, &classify_user, true, 400).await {
        Ok(raw) => parse_json_loose(&raw).unwrap_or(json!({"mode": "chat"})),
        Err(_) => json!({"mode": "chat"}),
    };
    let mode = plan["mode"].as_str().unwrap_or("chat").to_lowercase();
    let sql = plan["sql"].as_str().unwrap_or("").trim().to_string();

    if mode == "sql" && !sql.is_empty() {
        let safe_sql = match validate_sql(&sql) {
            Ok(s) => s,
            Err(e) => {
                return json!({
                    "answer": format!("I couldn't run that query safely: {}. I only execute read-only SELECT statements.", e),
                    "sql": sql, "mode": "sql", "error": e,
                });
            }
        };
        match db::run_readonly_sql(&state.pool, &safe_sql).await {
            Ok(result) => {
                let answer = summarize_rows(state, message, &safe_sql, &result).await;
                json!({
                    "answer": answer, "sql": safe_sql, "mode": "sql",
                    "rows": result["rows"], "columns": result["columns"],
                })
            }
            Err(e) => json!({
                "answer": format!("The query failed to execute: {}", e.detail),
                "sql": safe_sql, "mode": "sql", "error": e.detail,
            }),
        }
    } else {
        json!({"answer": chat_answer(state, message, history).await, "mode": "chat"})
    }
}
