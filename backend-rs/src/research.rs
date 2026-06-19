//! AI research service. Kimi primary -> Gemma backup. NO MOCK FALLBACK.

use crate::indicators;
use crate::llm::parse_json_loose;
use crate::state::AppState;
use chrono::Utc;
use serde_json::{json, Value};

fn now() -> String {
    Utc::now().to_rfc3339()
}

const SYSTEM: &str = "You are a disciplined equity analyst. You always respond with a single STRICT JSON object and nothing else. Keys: thesis (string), sentiment_score (number in [-1,1]), conviction (number in [0,100]), key_risks (array of strings), suggested_action (one of buy/hold/reduce/sell), suggested_stop (number, a price), suggested_target (number, a price), regime (one of trend-up/trend-down/range/high-vol), bear_case (string articulating the strongest opposing case).";

/// Ordered list of distinct providers: primary then backup.
fn provider_order(state: &AppState) -> Vec<String> {
    let mut out = vec![];
    for p in [
        &state.settings.research_provider,
        &state.settings.research_backup_provider,
    ] {
        let p = p.to_lowercase();
        let p = normalize_provider(Some(&p)).unwrap_or(p);
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    if out.is_empty() {
        out.push("ollama".into());
    }
    out
}

pub fn normalize_provider(provider: Option<&str>) -> Option<String> {
    let p = provider?.to_lowercase();
    let p = p.trim();
    if p == "gemma" {
        Some("ollama".into())
    } else {
        Some(p.to_string())
    }
}

fn depth_preset(depth: &str) -> (usize, usize, usize, u32) {
    // (bars, recent_bars, news, num_predict)
    match depth {
        "quick" => (40, 10, 0, 400),
        "deep" => (120, 40, 8, 1200),
        _ => (120, 20, 5, 900),
    }
}

async fn call_provider(
    state: &AppState,
    provider: &str,
    system: &str,
    user: &str,
    json_format: bool,
    num_predict: u32,
) -> anyhow::Result<(String, String)> {
    match provider {
        "kimi" => {
            let content = state
                .llm
                .kimi_chat(system, user, json_format, num_predict.max(1500))
                .await?;
            Ok((content, state.settings.kimi_model.clone()))
        }
        "ollama" => {
            let content = state
                .llm
                .ollama_chat(system, user, json_format, num_predict)
                .await?;
            Ok((content, state.settings.research_model.clone()))
        }
        other => anyhow::bail!("unknown research provider '{}'", other),
    }
}

fn build_prompt(symbol: &str, snapshot: &Value, ind: &Value, bars: &[Value], news: &[Value], depth: &str) -> String {
    let (_, recent_n, _, _) = depth_preset(depth);
    let recent: Vec<&Value> = bars.iter().rev().take(recent_n).rev().collect();
    let bar_lines: String = recent
        .iter()
        .map(|b| {
            let t = b["t"].as_str().unwrap_or("");
            let t = if t.len() >= 10 { &t[..10] } else { t };
            format!(
                "{} O{} H{} L{} C{} V{}",
                t, b["o"], b["h"], b["l"], b["c"], b["v"]
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    if depth == "quick" {
        return format!(
            "Analyze {} quickly.\n\nLatest snapshot: {}\n\nIndicator snapshot: {}\n\nRecent daily bars (oldest->newest):\n{}\n\nGive a brief trading thesis, a short bear_case, sentiment_score in [-1,1], conviction in [0,100], suggested_stop and suggested_target near the current price, a suggested_action, and the market regime. STRICT JSON only.",
            symbol, snapshot, ind, bar_lines
        );
    }
    let news_lines: String = news
        .iter()
        .map(|n| format!("- {} ({})", n["headline"].as_str().unwrap_or(""), n["source"].as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Analyze {}.\n\nLatest snapshot: {}\n\nIndicator snapshot: {}\n\nRecent daily bars (oldest->newest):\n{}\n\nRecent headlines:\n{}\n\nProduce a concise trading thesis, then reason through the strongest bear_case. Give a sentiment_score in [-1,1], a conviction in [0,100], concrete suggested_stop and suggested_target price levels near the current price, a suggested_action, and the current market regime. Return STRICT JSON only.",
        symbol, snapshot, ind, bar_lines, if news_lines.is_empty() { "(none)".to_string() } else { news_lines }
    )
}

fn num(v: &Value, default: f64) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(default),
        Value::String(s) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn coerce(data: &Value, symbol: &str, snapshot: &Value, provider: &str, model: &str) -> Value {
    let price = num(&snapshot["price"], 0.0);
    let mut risks: Vec<Value> = match &data["key_risks"] {
        Value::Array(a) => a.iter().map(|r| json!(r.as_str().map(|s| s.to_string()).unwrap_or_else(|| r.to_string()))).collect(),
        Value::String(s) => vec![json!(s)],
        _ => vec![],
    };
    risks.truncate(8);

    // NO MOCK DATA: do not invent missing fields. Track what the model omitted so
    // consumers (e.g. the bot AI gate) can fail-safe instead of trusting fabricated
    // confidence. Conviction defaults to 0 (gate will not pass on it), and
    // stop/target stay null unless the model actually provided them.
    let mut degraded: Vec<&str> = vec![];
    let thesis = data["thesis"].as_str().unwrap_or("").trim().to_string();
    if thesis.is_empty() {
        degraded.push("thesis");
    }
    let sentiment = if data["sentiment_score"].is_null() {
        degraded.push("sentiment_score");
        0.0
    } else {
        num(&data["sentiment_score"], 0.0).clamp(-1.0, 1.0)
    };
    let conviction = if data["conviction"].is_null() {
        degraded.push("conviction");
        0.0
    } else {
        num(&data["conviction"], 0.0).clamp(0.0, 100.0)
    };
    // Only carry a stop/target the model actually returned (and only if we know price).
    let suggested_stop = if data["suggested_stop"].is_null() {
        Value::Null
    } else {
        json!((num(&data["suggested_stop"], 0.0) * 100.0).round() / 100.0)
    };
    let suggested_target = if data["suggested_target"].is_null() {
        Value::Null
    } else {
        json!((num(&data["suggested_target"], 0.0) * 100.0).round() / 100.0)
    };
    let _ = price;

    json!({
        "symbol": symbol,
        "thesis": thesis,
        "sentiment_score": sentiment,
        "conviction": conviction,
        "key_risks": risks,
        "suggested_action": data["suggested_action"].as_str().unwrap_or("hold").to_lowercase(),
        "suggested_stop": suggested_stop,
        "suggested_target": suggested_target,
        "regime": data["regime"].as_str().unwrap_or("unknown"),
        "bear_case": data["bear_case"].as_str().unwrap_or("").trim(),
        "provider": provider,
        "model": model,
        "degraded": !degraded.is_empty(),
        "degraded_fields": degraded,
        "generated_at": now(),
    })
}

async fn safe_news(state: &AppState, symbols: &[String], limit: usize) -> Vec<Value> {
    if limit == 0 {
        return vec![];
    }
    match state.alpaca.get_news(symbols, limit).await {
        Ok(v) => v.as_array().cloned().unwrap_or_default(),
        Err(_) => vec![],
    }
}

pub async fn analyze(
    state: &AppState,
    symbol: &str,
    provider: Option<&str>,
    depth: &str,
) -> anyhow::Result<Value> {
    let symbol = symbol.to_uppercase();
    let depth = if depth.is_empty() { "standard" } else { depth };
    let (bars_n, _, news_n, num_predict) = depth_preset(depth);

    let forced = normalize_provider(provider);
    let providers = match &forced {
        Some(p) => vec![p.clone()],
        None => provider_order(state),
    };

    let bars_v = state.alpaca.get_bars(&symbol, "1Day", bars_n).await?;
    let bars = bars_v.as_array().cloned().unwrap_or_default();
    let ind = indicators::compute_all(&bars);
    let snapshot = state.alpaca.get_snapshot(&symbol).await?;
    let news = safe_news(state, &[symbol.clone()], news_n).await;
    let prompt = build_prompt(&symbol, &snapshot, &ind, &bars, &news, depth);

    let mut last_err = String::new();
    for prov in &providers {
        match call_provider(state, prov, SYSTEM, &prompt, true, num_predict).await {
            Ok((content, model)) => match parse_json_loose(&content) {
                Ok(data) => {
                    let mut result = coerce(&data, &symbol, &snapshot, prov, &model);
                    // Reject a hollow analysis (no thesis) — try the next provider
                    // rather than returning fabricated/empty content as real.
                    if result["thesis"].as_str().unwrap_or("").trim().is_empty() {
                        last_err = format!("{prov} returned an empty/invalid analysis");
                        continue;
                    }
                    result["depth"] = json!(depth);
                    return Ok(result);
                }
                Err(e) => last_err = e.to_string(),
            },
            Err(e) => last_err = e.to_string(),
        }
    }
    anyhow::bail!("research analyze failed for {}: {}", symbol, last_err)
}

pub async fn briefing(state: &AppState, watchlist: &[String], provider: Option<&str>) -> anyhow::Result<Value> {
    let forced = normalize_provider(provider);
    let snapshots = state.alpaca.get_snapshots(watchlist).await?;
    let mut items = vec![];
    for sym in watchlist {
        let snap = &snapshots[sym];
        let chg = num(&snap["change_pct"], 0.0);
        let sentiment = (chg / 5.0).clamp(-1.0, 1.0);
        let note = format!(
            "{} {} {:.2}% at ${:.2}.",
            sym,
            if chg >= 0.0 { "up" } else { "down" },
            chg.abs(),
            num(&snap["price"], 0.0)
        );
        items.push(json!({"symbol": sym, "note": note, "sentiment": (sentiment * 1000.0).round() / 1000.0}));
    }
    let avg = if items.is_empty() {
        0.0
    } else {
        items.iter().map(|i| num(&i["sentiment"], 0.0)).sum::<f64>() / items.len() as f64
    };
    let regime = if avg > 0.15 {
        "trend-up"
    } else if avg < -0.15 {
        "trend-down"
    } else {
        "range"
    };
    let mut summary = format!(
        "Watchlist breadth is {} this session. Average sentiment {:+.2}; regime reads {}.",
        if avg > 0.0 { "positive" } else { "mixed" },
        avg,
        regime
    );
    let user = format!(
        "Write a concise 2-sentence morning market briefing for this watchlist snapshot: {}. Be concrete. Respond as JSON {{\"summary\": string}}.",
        Value::Array(items.clone())
    );
    let providers = match &forced {
        Some(p) => vec![p.clone()],
        None => provider_order(state),
    };
    for prov in &providers {
        if let Ok((content, _)) = call_provider(
            state,
            prov,
            "You are a market strategist. Respond with STRICT JSON only.",
            &user,
            true,
            400,
        )
        .await
        {
            if let Ok(parsed) = parse_json_loose(&content) {
                if let Some(s) = parsed["summary"].as_str() {
                    summary = s.to_string();
                    break;
                }
            }
        }
    }
    Ok(json!({
        "generated_at": now(),
        "summary": summary,
        "items": items,
        "regime": regime,
    }))
}

const DEEP_SYSTEM: &str = "You are a senior equity research analyst writing an internal markdown report. Write clear, well-structured GitHub-flavored markdown with section headers (##), bullet points, and concrete numbers drawn from the supplied data. Do NOT invent specific figures you were not given. Be decisive but balanced.";

fn deep_disclaimer(kind: &str) -> String {
    if kind == "earnings" {
        "> _Note: earnings detail below is LLM-synthesized from recent price action and available news headlines — it is NOT a verified earnings transcript or fundamentals feed. Treat dates/figures as indicative only._\n\n".to_string()
    } else {
        "> _Note: this report is LLM-synthesized from market data and news headlines available to the app. Verify any specific claims independently._\n\n".to_string()
    }
}

pub async fn generate_deep(state: &AppState, symbol: &str, kind: &str, provider: Option<&str>) -> anyhow::Result<Value> {
    let symbol = symbol.to_uppercase();
    let kind = if kind == "earnings" { "earnings" } else { "deep" };
    let forced = normalize_provider(provider);
    let bars_v = state.alpaca.get_bars(&symbol, "1Day", 120).await?;
    let bars = bars_v.as_array().cloned().unwrap_or_default();
    let ind = indicators::compute_all(&bars);
    let snapshot = state.alpaca.get_snapshot(&symbol).await?;
    let news = safe_news(state, &[symbol.clone()], 8).await;

    let recent: Vec<&Value> = bars.iter().rev().take(30).rev().collect();
    let bar_lines: String = recent
        .iter()
        .map(|b| {
            let t = b["t"].as_str().unwrap_or("");
            let t = if t.len() >= 10 { &t[..10] } else { t };
            format!("{} O{} H{} L{} C{} V{}", t, b["o"], b["h"], b["l"], b["c"], b["v"])
        })
        .collect::<Vec<_>>()
        .join("\n");
    let news_lines: String = news
        .iter()
        .map(|n| format!("- {} ({})", n["headline"].as_str().unwrap_or(""), n["source"].as_str().unwrap_or("")))
        .collect::<Vec<_>>()
        .join("\n");

    let ask = if kind == "earnings" {
        format!("Write an EARNINGS-FOCUSED markdown report for {}. Sections: ## Setup into earnings, ## What the market expects, ## Key items to watch, ## Bull case, ## Bear case, ## Options-implied move (qualitative), ## Trade plan. Be explicit that earnings specifics are synthesized from news, not a verified transcript.", symbol)
    } else {
        format!("Write a DEEP-DIVE markdown research report for {}. Sections: ## Overview, ## Technical picture, ## Momentum & trend, ## Catalysts & news, ## Bull case, ## Bear case, ## Risks, ## Trade plan (entries, stops, targets).", symbol)
    };
    let user = format!(
        "{}\n\nLatest snapshot: {}\n\nIndicator snapshot: {}\n\nRecent daily bars (oldest->newest):\n{}\n\nRecent headlines:\n{}\n\nReturn ONLY markdown (no JSON, no preamble).",
        ask, snapshot, ind, bar_lines, if news_lines.is_empty() { "(none)".to_string() } else { news_lines }
    );

    let providers = match &forced {
        Some(p) => vec![p.clone()],
        None => provider_order(state),
    };
    let mut provider_used = None;
    let mut model = None;
    let mut body = String::new();
    let mut last_err = String::new();
    for prov in &providers {
        match call_provider(state, prov, DEEP_SYSTEM, &user, false, 1400).await {
            Ok((content, mdl)) => {
                let content = content.trim().to_string();
                if !content.is_empty() {
                    provider_used = Some(prov.clone());
                    model = Some(mdl);
                    body = content;
                    break;
                }
            }
            Err(e) => last_err = e.to_string(),
        }
    }
    if body.is_empty() {
        anyhow::bail!("deep research unavailable for {}: {}", symbol, last_err);
    }
    let title = format!("{} {}", symbol, if kind == "earnings" { "earnings preview" } else { "deep dive" });
    let full_body = format!("{}{}", deep_disclaimer(kind), body);
    let news_slice: Vec<Value> = news.iter().take(8).cloned().collect();
    Ok(json!({
        "symbol": symbol,
        "kind": kind,
        "title": title,
        "body": full_body,
        "data": {"snapshot": snapshot, "indicators": ind, "news": news_slice},
        "provider": provider_used,
        "model": model,
        "generated_at": now(),
    }))
}

pub async fn regime(state: &AppState) -> anyhow::Result<Value> {
    let spy = state.alpaca.get_snapshot("SPY").await?;
    let qqq = state.alpaca.get_snapshot("QQQ").await?;
    let spy_chg = num(&spy["change_pct"], 0.0);
    let qqq_chg = num(&qqq["change_pct"], 0.0);
    let avg = (spy_chg + qqq_chg) / 2.0;

    let bars_v = state.alpaca.get_bars("SPY", "1Day", 60).await?;
    let bars = bars_v.as_array().cloned().unwrap_or_default();
    let ind = indicators::compute_all(&bars);
    let atr = num(&ind["atr14"], 0.0);
    let price = {
        let p = num(&spy["price"], 1.0);
        if p == 0.0 {
            1.0
        } else {
            p
        }
    };
    let vix_proxy = ((atr / price) * 100.0 * 16.0 * 100.0).round() / 100.0;
    let reg = if vix_proxy > 25.0 {
        "high-vol"
    } else if avg > 0.3 {
        "trend-up"
    } else if avg < -0.3 {
        "trend-down"
    } else {
        "range"
    };
    let breadth = (0.5 + avg / 4.0).clamp(0.0, 1.0);
    let breadth = (breadth * 1000.0).round() / 1000.0;
    Ok(json!({
        "regime": reg,
        "vix_proxy": vix_proxy,
        "breadth": breadth,
        "note": format!("SPY {:+.2}% / QQQ {:+.2}%. Volatility proxy {}. Regime: {}.", spy_chg, qqq_chg, vix_proxy, reg),
    }))
}
