//! Weekly-options bot engine. Mirrors backend/services/bots.py.

use crate::db;
use crate::indicators;
use crate::options;
use crate::research;
use crate::risk;
use crate::state::AppState;
use chrono::Utc;
use serde_json::{json, Value};

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn num(v: &Value, default: f64) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(default),
        Value::String(s) => s.parse().unwrap_or(default),
        _ => default,
    }
}

async fn safe_account(state: &AppState) -> Value {
    state.alpaca.get_account().await.unwrap_or(json!({}))
}
async fn safe_positions(state: &AppState) -> Vec<Value> {
    state
        .alpaca
        .get_positions()
        .await
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
}

async fn latest_research(state: &AppState, symbol: &str) -> Value {
    if let Ok(rows) = db::list_research(&state.pool, Some(symbol), 1).await {
        if let Some(first) = rows.as_array().and_then(|a| a.first()) {
            return first.clone();
        }
    }
    research::analyze(state, symbol, None, "standard")
        .await
        .unwrap_or(json!({"sentiment_score": 0.0, "conviction": 0.0}))
}

fn action_of(bot: &Value) -> Value {
    let mut act = db::default_option_action();
    if let Some(obj) = bot["action"].as_object() {
        for (k, v) in obj {
            act[k] = v.clone();
        }
    }
    act
}

fn decide_direction(bot: &Value, research: &Value, ind: &Value, price: f64) -> (Option<String>, String) {
    let cfg = &bot["config"];
    let act = action_of(bot);
    let act_right = act["right"].as_str().unwrap_or("auto").to_lowercase();
    if act_right == "call" || act_right == "put" {
        return (Some(act_right.clone()), format!("Forced {act_right} via action.right."));
    }
    let forced = cfg["side"].as_str().unwrap_or("auto").to_lowercase();
    if forced == "call" || forced == "put" {
        return (Some(forced.clone()), format!("Forced {forced} via bot config."));
    }
    let direction_mode = cfg["direction"].as_str().unwrap_or("research").to_lowercase();
    let ai_gate = &bot["ai_gate"];
    let min_conv = num(&ai_gate["min_conviction"], 60.0);
    let sentiment = num(&research["sentiment_score"], 0.0);
    let conviction = num(&research["conviction"], 0.0);
    let sma20 = ind["sma20"].as_f64();
    let rsi = ind["rsi14"].as_f64();
    let macd_hist = ind["macd"]["hist"].as_f64();

    if direction_mode == "momentum" {
        if let Some(mh) = macd_hist {
            if mh > 0.0 && rsi.map(|r| r < 70.0).unwrap_or(true) {
                return (Some("call".into()), format!("Momentum: MACD hist {:+.3}>0, RSI {:?}.", mh, rsi));
            }
            if mh < 0.0 && rsi.map(|r| r > 30.0).unwrap_or(true) {
                return (Some("put".into()), format!("Momentum: MACD hist {:+.3}<0, RSI {:?}.", mh, rsi));
            }
        }
        return (None, "Momentum: no clear MACD signal.".into());
    }
    let gate_ok = !ai_gate["enabled"].as_bool().unwrap_or(true) || conviction >= min_conv;
    let above_sma = sma20.map(|s| price > s).unwrap_or(true);
    let below_sma = sma20.map(|s| price < s).unwrap_or(true);
    if sentiment > 0.15 && gate_ok && above_sma {
        return (Some("call".into()), format!("Bullish: sentiment {:+.2}, conviction {:.0}>={:.0}, price {:.2}>SMA20 {:?}.", sentiment, conviction, min_conv, price, sma20));
    }
    if sentiment < -0.15 && gate_ok && below_sma {
        return (Some("put".into()), format!("Bearish: sentiment {:+.2}, conviction {:.0}>={:.0}, price {:.2}<SMA20 {:?}.", sentiment, conviction, min_conv, price, sma20));
    }
    (None, format!("No edge: sentiment {:+.2}, conviction {:.0} (gate {}), price vs SMA20 {:?}.", sentiment, conviction, if gate_ok { "ok" } else { "fail" }, sma20))
}

// ---- Trigger (indicator rule) evaluation -----------------------------------

fn resolve_indicator(indicator: &str, snapshot: &Value) -> Option<f64> {
    let mut node = snapshot;
    for p in indicator.split('.') {
        node = node.get(p)?;
    }
    node.as_f64()
}

/// Map a friendly rule indicator id (e.g. "rsi14", "macd_hist", "rsi") to the
/// dotted path inside the indicators snapshot.
fn indicator_path(id: &str) -> String {
    let key = id.trim().to_lowercase();
    match key.as_str() {
        "rsi" | "rsi14" => "rsi14".into(),
        "sma" | "sma20" => "sma20".into(),
        "sma50" => "sma50".into(),
        "sma200" => "sma200".into(),
        "ema" | "ema21" => "ema21".into(),
        "ema9" => "ema9".into(),
        "macd" => "macd.macd".into(),
        "macd_hist" | "macd.hist" => "macd.hist".into(),
        "macd_signal" | "macd.signal" => "macd.signal".into(),
        "atr" | "atr14" => "atr14".into(),
        "adx" | "adx14" => "adx14".into(),
        "vwap" => "vwap".into(),
        "obv" => "obv".into(),
        "volume" => "volume".into(),
        "price" | "close" => "price".into(),
        other => other.to_string(),
    }
}

fn resolve_rhs(value: &Value, snapshot: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s
            .parse::<f64>()
            .ok()
            .or_else(|| resolve_indicator(&indicator_path(s), snapshot)),
        _ => None,
    }
}

fn apply_op(op: &str, a: f64, b: f64) -> bool {
    // NOTE: crosses_above/below are NOT handled here — they need the previous bar
    // and are resolved in evaluate_triggers. Treating them as plain >/< (the old
    // bug) made them fire on every bar above/below the level.
    match op {
        ">" | "above" => a > b,
        "<" | "below" => a < b,
        ">=" => a >= b,
        "<=" => a <= b,
        "==" | "eq" => (a - b).abs() < 1e-6,
        _ => false,
    }
}

/// Evaluate the bot's indicator rules against the current snapshot. `prev` is the
/// previous-bar snapshot, required for true crosses_above/below detection (a cross
/// fires only on the bar where the relationship flips). Returns
/// (trigger_result, [trigger explanations]).
fn evaluate_triggers(
    rules: &[Value],
    snapshot: &Value,
    prev: Option<&Value>,
) -> (bool, Vec<Value>) {
    if rules.is_empty() {
        // No rules configured → trigger gate is open (direction logic decides).
        return (true, vec![]);
    }
    let mut explanations = vec![];
    let mut results: Vec<(String, bool)> = vec![];
    for rule in rules {
        let ind = rule["indicator"].as_str().unwrap_or("");
        let op = rule["operator"].as_str().unwrap_or("");
        let rhs = &rule["value"];
        let join = rule["join"].as_str().unwrap_or("AND").to_uppercase();

        let lhs_val = if ind.is_empty() {
            None
        } else {
            resolve_indicator(&indicator_path(ind), snapshot)
        };
        let rhs_val = resolve_rhs(rhs, snapshot);
        let passed = match (lhs_val, rhs_val) {
            (Some(l), Some(r)) => {
                if op == "crosses_above" || op == "crosses_below" {
                    // Need prev lhs/rhs; if we don't have a previous bar, a cross
                    // can't be confirmed → do not fire.
                    match prev {
                        Some(p) => {
                            let lp = if ind.is_empty() {
                                None
                            } else {
                                resolve_indicator(&indicator_path(ind), p)
                            };
                            let rp = resolve_rhs(rhs, p);
                            match (lp, rp) {
                                (Some(lp), Some(rp)) => {
                                    if op == "crosses_above" {
                                        lp <= rp && l > r
                                    } else {
                                        lp >= rp && l < r
                                    }
                                }
                                _ => false,
                            }
                        }
                        None => false,
                    }
                } else {
                    apply_op(op, l, r)
                }
            }
            _ => false,
        };
        results.push((join, passed));
        explanations.push(json!({
            "indicator": ind,
            "operator": op,
            "value": rhs_val.map(|v| (v * 10000.0).round() / 10000.0),
            "actual": lhs_val.map(|v| (v * 10000.0).round() / 10000.0),
            "passed": passed,
        }));
    }
    let combined = combine_rules(&results);
    (combined, explanations)
}

fn combine_rules(results: &[(String, bool)]) -> bool {
    if results.is_empty() {
        return true;
    }
    let mut acc = results[0].1;
    for (join, val) in &results[1..] {
        if join == "OR" {
            acc = acc || *val;
        } else {
            acc = acc && *val;
        }
    }
    acc
}

fn ind_snap(ind: &Value, price: f64) -> Value {
    json!({
        "price": (price * 100.0).round() / 100.0,
        "sma20": ind["sma20"],
        "sma50": ind["sma50"],
        "rsi14": ind["rsi14"],
        "macd_hist": ind["macd"]["hist"],
        "atr14": ind["atr14"],
    })
}

async fn pick_contract(state: &AppState, symbol: &str, side: &str, act: &Value, cfg: &Value) -> (Option<Value>, Option<String>) {
    let contract_symbol = act["contract_symbol"].as_str().unwrap_or("").trim().to_string();
    let expiry = act["expiry"].as_str().or_else(|| cfg["expiry"].as_str()).unwrap_or("nearest_weekly").to_string();
    let moneyness = act["moneyness"].as_str().unwrap_or("ATM").to_uppercase();
    let otm_strikes = act["otm_strikes"].as_i64().unwrap_or(1);
    if !contract_symbol.is_empty() {
        // Fetch explicit contract from chain.
        if let Some(parsed) = parse_occ_root(&contract_symbol) {
            match options::get_option_chain(state, &parsed.0, Some(&parsed.1), &parsed.2).await {
                Ok(chain) => {
                    if let Some(c) = chain.iter().find(|c| c["symbol"].as_str().map(|s| s.to_uppercase()) == Some(contract_symbol.to_uppercase())) {
                        let mut cc = build_contract(c);
                        cc["rationale_contract"] = json!(format!("Explicit contract {contract_symbol}."));
                        return (Some(cc), None);
                    }
                }
                Err(e) => return (None, Some(format!("Real options data unavailable: {}", e.detail))),
            }
        }
        return (None, Some(format!("Real options data unavailable: contract {contract_symbol} not found.")));
    }
    match select_one(state, symbol, side, Some(&expiry), &moneyness, otm_strikes).await {
        Ok(mut c) => {
            c["rationale_contract"] = json!(format!(
                "{}{} {} from live {} chain (strike {}, underlying {}).",
                moneyness,
                if (moneyness == "OTM" || moneyness == "ITM") && otm_strikes != 0 { format!(" +{otm_strikes}") } else { String::new() },
                side, expiry, c["strike"], c["underlying_price"]
            ));
            (Some(c), None)
        }
        Err(e) => (None, Some(format!("Real options data unavailable: {}", e.detail))),
    }
}

fn parse_occ_root(occ: &str) -> Option<(String, String, String)> {
    let s = occ.trim().to_uppercase();
    if !crate::alpaca::is_occ_symbol(&s) {
        return None;
    }
    let n = s.len();
    let root = s[..n - 15].to_string();
    let ymd = &s[n - 15..n - 9];
    let cp = &s[n - 9..n - 8];
    let exp = chrono::NaiveDate::parse_from_str(ymd, "%y%m%d").ok()?.format("%Y-%m-%d").to_string();
    let t = if cp == "C" { "call" } else { "put" }.to_string();
    Some((root, exp, t))
}

fn build_contract(c: &Value) -> Value {
    let bid = num(&c["bid"], 0.0);
    let ask = num(&c["ask"], 0.0);
    let mid = if bid != 0.0 || ask != 0.0 {
        ((bid + ask) / 2.0 * 10000.0).round() / 10000.0
    } else {
        num(&c["last"], 0.0)
    };
    json!({
        "occ_symbol": c["symbol"], "symbol": c["symbol"],
        "strike": num(&c["strike"], 0.0), "right": c["type"], "type": c["type"],
        "expiration": c["expiration"], "bid": bid, "ask": ask, "mid": mid,
        "last": num(&c["last"], 0.0),
        "implied_volatility": num(&c["implied_volatility"], 0.0),
        "delta": num(&c["delta"], 0.0), "gamma": num(&c["gamma"], 0.0),
        "theta": num(&c["theta"], 0.0), "vega": num(&c["vega"], 0.0),
        "open_interest": c["open_interest"].as_i64().unwrap_or(0),
        "volume": c["volume"].as_i64().unwrap_or(0),
    })
}

async fn select_one(state: &AppState, symbol: &str, right: &str, expiry: Option<&str>, moneyness: &str, otm_strikes: i64) -> crate::error::ApiResult<Value> {
    let sel = options::select_contracts(state, symbol, right, expiry, Some(moneyness), 9.max((otm_strikes as usize) * 2 + 3)).await?;
    let under = num(&sel["underlying_price"], 0.0);
    let empty = vec![];
    let contracts = sel["contracts"].as_array().unwrap_or(&empty);
    // choose nearest to ATM stepped by otm_strikes
    let mut sorted: Vec<&Value> = contracts.iter().collect();
    sorted.sort_by(|a, b| num(&a["strike"], 0.0).partial_cmp(&num(&b["strike"], 0.0)).unwrap());
    if sorted.is_empty() {
        return Err(crate::error::ApiError::upstream(format!("No {right} contracts for {symbol}.")));
    }
    let atm_idx = sorted
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| (num(&a["strike"], 0.0) - under).abs().partial_cmp(&(num(&b["strike"], 0.0) - under).abs()).unwrap())
        .map(|(i, _)| i)
        .unwrap_or(0);
    let steps = otm_strikes.max(0) as usize;
    let mut idx = atm_idx as i64;
    let mny = moneyness.to_uppercase();
    if mny == "OTM" {
        idx = if right == "call" { atm_idx as i64 + steps as i64 } else { atm_idx as i64 - steps as i64 };
    } else if mny == "ITM" {
        idx = if right == "call" { atm_idx as i64 - steps as i64 } else { atm_idx as i64 + steps as i64 };
    }
    let idx = idx.clamp(0, sorted.len() as i64 - 1) as usize;
    let c = sorted[idx];
    let mut out = c.clone();
    out["symbol"] = c["occ_symbol"].clone();
    out["type"] = json!(right);
    out["underlying_price"] = json!((under * 10000.0).round() / 10000.0);
    Ok(out)
}

pub async fn evaluate_bot(state: &AppState, bot: &Value) -> Value {
    let cfg = &bot["config"];
    let contracts = cfg["contracts"].as_i64().unwrap_or(1).max(1);
    let max_premium = num(&cfg["max_premium"], 1500.0);
    let mode = bot["mode"].as_str().unwrap_or("signal").to_lowercase();
    let timeframe = cfg["timeframe"]
        .as_str()
        .or_else(|| bot["timeframe"].as_str())
        .unwrap_or("1Day")
        .to_string();
    let ai_gate_cfg = &bot["ai_gate"];
    let gate_enabled = ai_gate_cfg["enabled"].as_bool().unwrap_or(true);
    let min_conviction = num(&ai_gate_cfg["min_conviction"], 60.0);
    let rules: Vec<Value> = bot["rules"].as_array().cloned().unwrap_or_default();

    let account = safe_account(state).await;
    let positions = safe_positions(state).await;
    let limits = db::get_risk_limits(&state.pool).await.unwrap_or(db::default_limits());
    let market_open = state.alpaca.market_open().await;
    let day_trades = account["daytrade_count"].as_i64().unwrap_or(0);

    let mut proposals = vec![];
    let mut firing_count = 0;
    let empty = vec![];
    for sym_v in bot["symbols"].as_array().unwrap_or(&empty) {
        let symbol = sym_v.as_str().unwrap_or("").to_uppercase();

        // --- market data --------------------------------------------------
        let bars_v = match state.alpaca.get_bars(&symbol, &timeframe, 250).await {
            Ok(b) => b,
            Err(e) => {
                proposals.push(skip_proposal(&symbol, &format!("Market data unavailable: {}", e.detail)));
                continue;
            }
        };
        let bars = bars_v.as_array().cloned().unwrap_or_default();
        let ind = indicators::compute_all(&bars);
        let snapshot = match state.alpaca.get_snapshot(&symbol).await {
            Ok(s) => s,
            Err(e) => {
                proposals.push(skip_proposal(&symbol, &format!("Snapshot unavailable: {}", e.detail)));
                continue;
            }
        };
        // NO MOCK DATA: a 0/unknown live price means real data is missing — skip
        // rather than fabricating a price that could (de)trigger rules.
        let price = num(&snapshot["price"], 0.0);
        if price <= 0.0 {
            proposals.push(skip_proposal(
                &symbol,
                "Live price unavailable (0) — skipped to avoid trading on bad data.",
            ));
            continue;
        }
        // indicator snapshot with price merged in for rule resolution
        let mut rule_snap = ind.clone();
        rule_snap["price"] = json!((price * 10000.0).round() / 10000.0);

        // Previous-bar snapshot so crosses_above/below can be detected correctly.
        let prev_snap = if bars.len() >= 2 {
            let mut ps = indicators::compute_all(&bars[..bars.len() - 1]);
            let prev_close = num(&bars[bars.len() - 2]["c"], price);
            ps["price"] = json!((prev_close * 10000.0).round() / 10000.0);
            Some(ps)
        } else {
            None
        };

        // --- 1) triggers --------------------------------------------------
        let (trigger_result, triggers) = evaluate_triggers(&rules, &rule_snap, prev_snap.as_ref());

        // --- 2) AI gate ---------------------------------------------------
        let research = latest_research(state, &symbol).await;
        let conviction = num(&research["conviction"], 0.0);
        let sentiment = num(&research["sentiment_score"], 0.0);
        let gate_passed = !gate_enabled || conviction >= min_conviction;
        let ai_gate = json!({
            "enabled": gate_enabled,
            "conviction": (conviction * 100.0).round() / 100.0,
            "min_conviction": min_conviction,
            "sentiment": (sentiment * 1000.0).round() / 1000.0,
            "passed": gate_passed,
        });

        // --- 3) direction -------------------------------------------------
        let (side_opt, dir_rationale) = decide_direction(bot, &research, &ind, price);
        let direction = json!({
            "right": side_opt.clone().unwrap_or_else(|| "skip".into()),
            "rationale": dir_rationale,
        });

        // Determine why (if) this symbol is blocked, in priority order.
        let mut firing = trigger_result && gate_passed && side_opt.is_some();
        let mut reason = String::new();
        if !trigger_result {
            let failing: Vec<String> = triggers
                .iter()
                .filter(|t| !t["passed"].as_bool().unwrap_or(false))
                .map(|t| format!(
                    "{} {} {} (actual {})",
                    t["indicator"].as_str().unwrap_or("?"),
                    t["operator"].as_str().unwrap_or("?"),
                    t["value"], t["actual"]
                ))
                .collect();
            reason = format!("Trigger not met: {}", if failing.is_empty() { "no rule passed".into() } else { failing.join("; ") });
        } else if !gate_passed {
            reason = format!("AI gate blocked: conviction {:.0} < min {:.0}.", conviction, min_conviction);
        } else if side_opt.is_none() {
            reason = format!("No directional edge: {}", dir_rationale);
        }

        let side = match side_opt.clone() {
            Some(s) => s,
            None => {
                proposals.push(json!({
                    "symbol": symbol,
                    "firing": false,
                    "reason": reason,
                    "triggers": triggers,
                    "trigger_result": trigger_result,
                    "ai_gate": ai_gate,
                    "direction": direction,
                    "contract": Value::Null,
                    "risk": Value::Null,
                    "indicators_snapshot": ind_snap(&ind, price),
                }));
                continue;
            }
        };

        // If triggers/gate blocked, still surface direction+blocked reason; no contract pick.
        if !trigger_result || !gate_passed {
            proposals.push(json!({
                "symbol": symbol,
                "firing": false,
                "reason": reason,
                "triggers": triggers,
                "trigger_result": trigger_result,
                "ai_gate": ai_gate,
                "direction": direction,
                "contract": Value::Null,
                "risk": Value::Null,
                "indicators_snapshot": ind_snap(&ind, price),
            }));
            continue;
        }

        // --- 4) contract --------------------------------------------------
        let act = action_of(bot);
        let (contract_opt, pick_note) = pick_contract(state, &symbol, &side, &act, cfg).await;
        let contract = match contract_opt {
            None => {
                proposals.push(json!({
                    "symbol": symbol,
                    "firing": false,
                    "reason": pick_note.clone().unwrap_or_else(|| "Contract unavailable.".into()),
                    "triggers": triggers,
                    "trigger_result": trigger_result,
                    "ai_gate": ai_gate,
                    "direction": direction,
                    "contract": Value::Null,
                    "risk": Value::Null,
                    "indicators_snapshot": ind_snap(&ind, price),
                }));
                continue;
            }
            Some(c) => c,
        };
        let ask = {
            let a = num(&contract["ask"], 0.0);
            if a != 0.0 { a } else { num(&contract["last"], 0.0) }
        };
        let bid = num(&contract["bid"], 0.0);
        let mid_calc = (bid + num(&contract["ask"], 0.0)) / 2.0;
        let mid = ((if mid_calc != 0.0 { mid_calc } else { num(&contract["last"], 0.0) }) * 100.0).round() / 100.0;
        let est_premium = (ask * 100.0 * contracts as f64 * 100.0).round() / 100.0;
        let skip_premium = ask != 0.0 && (ask * 100.0) > max_premium;
        let occ_symbol = contract["occ_symbol"].as_str().or_else(|| contract["symbol"].as_str()).unwrap_or("").to_string();

        // --- 5) risk ------------------------------------------------------
        let order = json!({
            "symbol": occ_symbol, "asset_class": "option", "side": "buy",
            "qty": contracts, "type": "limit",
            "limit_price": if mid != 0.0 { mid } else { ask }, "ref_price": if mid != 0.0 { mid } else { ask },
            "time_in_force": "day",
        });
        let risk_eval = risk::evaluate_order(&order, &account, &positions, &limits, market_open, day_trades);
        let risk_approved = risk_eval["approved"].as_bool().unwrap_or(false) && !skip_premium;
        let mut risk = json!({
            "approved": risk_approved,
            "decision": risk_eval["decision"],
            "vetoes": risk_eval["vetoes"],
            "warnings": risk_eval["warnings"],
            "computed": risk_eval["computed"],
        });
        if skip_premium {
            let msg = format!("Premium ${:.0} exceeds max_premium ${:.0}.", ask * 100.0, max_premium);
            if let Some(arr) = risk["vetoes"].as_array_mut() {
                arr.push(json!({"rule": "max_premium", "message": msg}));
            }
            risk["decision"] = json!("vetoed");
        }

        let contract_obj = json!({
            "occ_symbol": occ_symbol, "strike": contract["strike"], "right": side,
            "expiration": contract["expiration"], "bid": contract["bid"], "ask": contract["ask"],
            "mid": mid, "last": contract["last"], "implied_volatility": contract["implied_volatility"],
            "delta": contract["delta"], "gamma": contract["gamma"], "theta": contract["theta"],
            "vega": contract["vega"], "open_interest": contract["open_interest"],
            "volume": contract["volume"], "moneyness": contract["moneyness"],
            "underlying_price": contract["underlying_price"],
            "qty": contracts, "est_premium": est_premium,
        });

        // Final firing decision now folds in risk.
        firing = firing && risk_approved;
        if !risk_approved {
            let veto_msgs: Vec<String> = risk["vetoes"].as_array().map(|a| {
                a.iter().map(|v| v["rule"].as_str().unwrap_or("?").to_string()).collect()
            }).unwrap_or_default();
            reason = format!("Risk vetoed: {}.", veto_msgs.join(", "));
        } else if firing {
            reason = format!("Firing: {} {} — trigger met, AI gate ok, risk approved.", side, occ_symbol);
        }
        if firing {
            firing_count += 1;
        }

        let full_rationale = dir_rationale_concat(&direction, &contract);

        proposals.push(json!({
            "symbol": symbol,
            "firing": firing,
            "reason": reason,
            "triggers": triggers,
            "trigger_result": trigger_result,
            "ai_gate": ai_gate,
            "direction": direction,
            "contract": contract_obj,
            "risk": risk,
            // legacy/compat fields used by run_bot + UI
            "action": if firing { "propose" } else { "skip" },
            "occ_symbol": occ_symbol,
            "right": side,
            "strike": contract["strike"],
            "expiration": contract["expiration"],
            "mid_price": mid,
            "est_premium": est_premium,
            "qty": contracts,
            "conviction": conviction,
            "sentiment": sentiment,
            "rationale": full_rationale,
            "indicators_snapshot": ind_snap(&ind, price),
            "risk_decision": risk_eval,
        }));
    }

    let total = proposals.len();
    let blocked = total - firing_count;
    let mode_note = match mode.as_str() {
        "signal" => "Mode=signal → records signals only (no orders placed).".to_string(),
        "semi" => "Mode=semi → orders placed only when run with place=true on firing+approved proposals.".to_string(),
        "auto" => "Mode=auto → firing+approved proposals are placed on run.".to_string(),
        other => format!("Mode={other}."),
    };
    let note = format!(
        "{} firing; {} blocked (trigger not met / AI gate / risk veto). {}",
        firing_count, blocked, mode_note
    );

    json!({
        "bot_id": bot["id"],
        "bot_name": bot["name"],
        "mode": mode,
        "enabled": bot["enabled"],
        "firing_count": firing_count,
        "note": note,
        "generated_at": now(),
        "proposals": proposals,
    })
}

fn skip_proposal(symbol: &str, reason: &str) -> Value {
    json!({
        "symbol": symbol,
        "firing": false,
        "reason": reason,
        "triggers": [],
        "trigger_result": false,
        "ai_gate": Value::Null,
        "direction": {"right": "skip", "rationale": reason},
        "contract": Value::Null,
        "risk": Value::Null,
        "action": "skip",
    })
}

fn dir_rationale_concat(direction: &Value, contract: &Value) -> String {
    let base = direction["rationale"].as_str().unwrap_or("").to_string();
    match contract["rationale_contract"].as_str() {
        Some(rc) => format!("{base} {rc}"),
        None => base,
    }
}

pub async fn run_bot(state: &AppState, bot: &Value, place: bool) -> Value {
    let evaluation = evaluate_bot(state, bot).await;
    let bot_id = bot["id"].clone();
    let mode = bot["mode"].as_str().unwrap_or("signal").to_lowercase();
    let do_place = place && (mode == "semi" || mode == "auto");
    let mut placed = vec![];
    let mut recorded_signals = 0;
    let mut place_notes: Vec<String> = vec![];
    let empty = vec![];

    for p in evaluation["proposals"].as_array().unwrap_or(&empty) {
        if !p["firing"].as_bool().unwrap_or(false) {
            continue;
        }
        // Record a signal for every firing proposal (all modes).
        let _ = db::insert_signal(&state.pool, &json!({
            "strategy_id": bot_id,
            "symbol": p["symbol"],
            "timeframe": "weekly_options",
            "fired": true,
            "matched": [{"rule": "bot_direction", "message": p["reason"]}],
            "snapshot": {
                "occ_symbol": p["occ_symbol"], "right": p["right"],
                "strike": p["strike"], "expiration": p["expiration"],
                "mid_price": p["mid_price"], "qty": p["qty"],
            },
        })).await;
        recorded_signals += 1;

        if mode == "signal" {
            place_notes.push(format!("{}: mode=signal → signal recorded, no order placed.", p["symbol"].as_str().unwrap_or("?")));
            continue;
        }
        if !do_place {
            place_notes.push(format!("{}: place=false → not submitted.", p["symbol"].as_str().unwrap_or("?")));
            continue;
        }
        // mode is semi/auto AND place=true AND firing (already risk-approved).
        let order = json!({
            "symbol": p["occ_symbol"], "asset_class": "option", "side": "buy",
            "qty": p["qty"], "type": "limit", "limit_price": p["mid_price"], "time_in_force": "day",
        });
        match state.alpaca.place_order(&order).await {
            Ok(ack) => {
                let _ = db::insert_trade(&state.pool, &json!({
                    "alpaca_order_id": ack["id"], "client_order_id": ack["client_order_id"],
                    "symbol": ack["symbol"], "asset_class": "option", "side": "buy", "qty": p["qty"],
                    "order_type": "limit", "limit_price": p["mid_price"], "status": ack["status"],
                    "source": "bot", "strategy_id": bot_id, "raw": ack["raw"],
                })).await;
                let _ = db::insert_risk_event(&state.pool, &json!({
                    "symbol": p["occ_symbol"], "side": "buy", "qty": p["qty"], "order_type": "limit",
                    "decision": p["risk"]["decision"], "rules": p["risk"]["warnings"],
                    "computed": p["risk"]["computed"], "source": "bot",
                })).await;
                place_notes.push(format!("{}: order submitted ({}).", p["symbol"].as_str().unwrap_or("?"), ack["status"].as_str().unwrap_or("?")));
                placed.push(ack);
            }
            Err(e) => {
                place_notes.push(format!("{}: order rejected by Alpaca: {}", p["symbol"].as_str().unwrap_or("?"), e.detail));
            }
        }
    }

    let why = if placed.is_empty() {
        if mode == "signal" {
            format!("Nothing placed: bot mode=signal records signals only ({} recorded).", recorded_signals)
        } else if !place {
            "Nothing placed: run was called with place=false (dry run).".to_string()
        } else if recorded_signals == 0 {
            "Nothing placed: no proposal is firing (see per-symbol reasons).".to_string()
        } else {
            "Nothing placed: see place_notes for per-symbol detail.".to_string()
        }
    } else {
        format!("{} order(s) placed.", placed.len())
    };

    let mut out = evaluation;
    out["placed"] = json!(placed);
    out["placed_orders"] = json!(placed); // legacy alias
    out["recorded_signals"] = json!(recorded_signals);
    out["did_place"] = json!(do_place);
    out["place_notes"] = json!(place_notes);
    out["placement_summary"] = json!(why);

    // Persist the latest evaluation.
    if let Some(id) = bot_id.as_str() {
        let _ = db::save_bot_evaluation(&state.pool, id, &out).await;
    }
    out
}

// ---- Kimi NL strategy builder ----------------------------------------------

const BUILDER_SYSTEM: &str = "You translate a plain-English options/equity trading strategy into a STRICT JSON bot configuration for an automated trading terminal. Respond with a SINGLE JSON object and nothing else.";

fn builder_schema_prompt(prompt: &str, symbol_hint: Option<&str>) -> String {
    let catalog = indicators::catalog();
    let hint = symbol_hint
        .map(|s| format!("\n\nIf no symbol is named in the description, default to [\"{}\"].", s.to_uppercase()))
        .unwrap_or_default();
    format!(
        r#"Indicator catalog (use these `indicator` ids in rules): {catalog}

Rule operators: ">", "<", ">=", "<=", "crosses_above", "crosses_below". A rule's `value` is a number (or another indicator id). Multiple rules combine via each rule's `join` ("AND"/"OR").

Produce a JSON bot config with EXACTLY this shape:
{{
  "name": string,
  "symbols": [string, ...],            // uppercase tickers
  "timeframe": "1Min"|"5Min"|"15Min"|"1Hour"|"1Day",
  "rules": [ {{ "indicator": string, "operator": string, "value": number, "join": "AND"|"OR" }} ],
  "ai_gate": {{ "enabled": bool, "min_conviction": number 0-100 }},
  "action": {{ "asset": "option"|"equity", "right": "call"|"put"|"auto", "moneyness": "ATM"|"OTM"|"ITM", "otm_strikes": int, "expiry": "nearest_weekly"|"nearest_monthly", "contract_symbol": null }},
  "config": {{ "contracts": int, "max_premium": number, "timeframe": string, "direction": "research"|"momentum" }},
  "mode": "signal"|"semi"|"auto"
}}

Map indicator names like "RSI(14)" to id "rsi14", "SMA(20)" to "sma20", "MACD histogram" to "macd_hist". Clamp ai_gate.min_conviction to 0-100. Use sensible defaults (contracts 1, max_premium 1500) when unspecified.

User strategy description:
{prompt}{hint}

Return ONLY the JSON object."#,
        catalog = catalog,
        prompt = prompt,
        hint = hint
    )
}

fn clampi(v: i64, lo: i64, hi: i64) -> i64 {
    v.max(lo).min(hi)
}

/// Normalize/validate a raw bot draft from the LLM into a valid bot create config.
fn normalize_draft(raw: &Value, symbol_hint: Option<&str>) -> Value {
    let valid_ops = ["<", ">", "<=", ">=", "==", "crosses_above", "crosses_below"];

    // symbols
    let mut symbols: Vec<Value> = raw["symbols"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| json!(s.to_uppercase()))).collect())
        .unwrap_or_default();
    if symbols.is_empty() {
        if let Some(s) = symbol_hint {
            symbols.push(json!(s.to_uppercase()));
        } else {
            symbols.push(json!("QQQ"));
        }
    }

    // timeframe
    let valid_tf = ["1Min", "5Min", "15Min", "30Min", "1Hour", "1Day"];
    let timeframe = raw["timeframe"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| valid_tf.iter().any(|t| t.eq_ignore_ascii_case(s)))
        .unwrap_or_else(|| "1Day".into());

    // rules — keep only rules whose indicator resolves to a known path and op valid
    let mut rules = vec![];
    if let Some(arr) = raw["rules"].as_array() {
        for r in arr {
            let ind = r["indicator"].as_str().unwrap_or("").trim().to_string();
            let op = r["operator"].as_str().unwrap_or("").trim().to_string();
            if ind.is_empty() || !valid_ops.contains(&op.as_str()) {
                continue;
            }
            // value: number or numeric string
            let value = match &r["value"] {
                Value::Number(n) => json!(n),
                Value::String(s) => match s.parse::<f64>() {
                    Ok(v) => json!(v),
                    Err(_) => json!(s),
                },
                _ => continue,
            };
            let join = r["join"].as_str().unwrap_or("AND").to_uppercase();
            let join = if join == "OR" { "OR" } else { "AND" };
            rules.push(json!({"indicator": indicator_path(&ind), "operator": op, "value": value, "join": join}));
        }
    }

    // ai_gate
    let gate_enabled = raw["ai_gate"]["enabled"].as_bool().unwrap_or(true);
    let min_conv = num(&raw["ai_gate"]["min_conviction"], 60.0).clamp(0.0, 100.0);

    // action
    let ra = &raw["action"];
    let asset = match ra["asset"].as_str().unwrap_or("option").to_lowercase().as_str() {
        "equity" => "equity",
        _ => "option",
    };
    let right = match ra["right"].as_str().unwrap_or("auto").to_lowercase().as_str() {
        "call" => "call",
        "put" => "put",
        _ => "auto",
    };
    let moneyness = match ra["moneyness"].as_str().unwrap_or("ATM").to_uppercase().as_str() {
        "OTM" => "OTM",
        "ITM" => "ITM",
        _ => "ATM",
    };
    let otm_strikes = clampi(ra["otm_strikes"].as_i64().unwrap_or(1), 0, 10);
    let expiry = match ra["expiry"].as_str().unwrap_or("nearest_weekly").to_lowercase().as_str() {
        "nearest_monthly" | "monthly" => "nearest_monthly",
        _ => "nearest_weekly",
    };
    let action = json!({
        "asset": asset, "right": right, "moneyness": moneyness,
        "otm_strikes": otm_strikes, "expiry": expiry, "contract_symbol": Value::Null,
    });

    // config
    let contracts = clampi(raw["config"]["contracts"].as_i64().or_else(|| raw["contracts"].as_i64()).unwrap_or(1), 1, 100);
    let max_premium = num(&raw["config"]["max_premium"], num(&raw["max_premium"], 1500.0)).max(1.0);
    let direction = match raw["config"]["direction"].as_str().unwrap_or("research").to_lowercase().as_str() {
        "momentum" => "momentum",
        _ => "research",
    };
    let config = json!({
        "contracts": contracts, "max_premium": max_premium,
        "timeframe": timeframe, "direction": direction,
        "side": right, "expiry": expiry,
    });

    // mode
    let mode = match raw["mode"].as_str().unwrap_or("signal").to_lowercase().as_str() {
        "semi" | "semi-auto" | "semiauto" => "semi",
        "auto" => "auto",
        _ => "signal",
    };

    let name = raw["name"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("AI-built bot").to_string();

    json!({
        "name": name,
        "enabled": true,
        "symbols": symbols,
        "kind": "options_weekly",
        "timeframe": timeframe,
        "rules": rules,
        "ai_gate": {"enabled": gate_enabled, "min_conviction": min_conv},
        "risk": {"risk_per_trade_pct": 1},
        "action": action,
        "config": config,
        "mode": mode,
    })
}

fn explain_draft(draft: &Value) -> String {
    let symbols: Vec<String> = draft["symbols"].as_array().map(|a| {
        a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()
    }).unwrap_or_default();
    let tf = draft["timeframe"].as_str().unwrap_or("1Day");
    let rule_str: Vec<String> = draft["rules"].as_array().map(|a| {
        a.iter().map(|r| format!(
            "{} {} {}",
            r["indicator"].as_str().unwrap_or("?"),
            r["operator"].as_str().unwrap_or("?"),
            r["value"]
        )).collect()
    }).unwrap_or_default();
    let act = &draft["action"];
    let gate = &draft["ai_gate"];
    let mode = draft["mode"].as_str().unwrap_or("signal");
    let action_desc = if act["asset"].as_str() == Some("equity") {
        "buy equity".to_string()
    } else {
        format!(
            "buy {} {} {} options ({})",
            act["expiry"].as_str().unwrap_or("nearest_weekly"),
            act["moneyness"].as_str().unwrap_or("ATM"),
            act["right"].as_str().unwrap_or("auto"),
            act["expiry"].as_str().unwrap_or("nearest_weekly"),
        )
    };
    let gate_desc = if gate["enabled"].as_bool().unwrap_or(true) {
        format!("require AI conviction >= {}", gate["min_conviction"])
    } else {
        "no AI gate".to_string()
    };
    format!(
        "On the {tf} timeframe for {syms}: when {rules}, {action}; {gate}. Size {contracts} contract(s), max premium ${maxp}. Mode={mode} ({mode_desc}).",
        tf = tf,
        syms = if symbols.is_empty() { "the configured symbols".into() } else { symbols.join(", ") },
        rules = if rule_str.is_empty() { "the AI direction model signals an edge".into() } else { rule_str.join(" and ") },
        action = action_desc,
        gate = gate_desc,
        contracts = draft["config"]["contracts"],
        maxp = draft["config"]["max_premium"],
        mode = mode,
        mode_desc = match mode { "signal" => "records signals only", "semi" => "places on confirmation", "auto" => "places automatically", _ => "" },
    )
}

/// Build a bot draft from a natural-language prompt. Kimi primary, Gemma fallback.
pub async fn from_prompt(state: &AppState, prompt: &str, symbol_hint: Option<&str>) -> anyhow::Result<Value> {
    let user = builder_schema_prompt(prompt, symbol_hint);
    let mut last_err = String::new();
    let mut draft: Option<Value> = None;

    // Kimi first (user-initiated, credits fine), then Gemma/ollama.
    for provider in ["kimi", "ollama"] {
        let content = match provider {
            "kimi" => state.llm.kimi_chat(BUILDER_SYSTEM, &user, true, 2000).await,
            _ => state.llm.ollama_chat(BUILDER_SYSTEM, &user, true, 1200).await,
        };
        match content {
            Ok(text) => match crate::llm::parse_json_loose(&text) {
                Ok(raw) => {
                    draft = Some(normalize_draft(&raw, symbol_hint));
                    break;
                }
                Err(e) => last_err = format!("{provider} parse: {e}"),
            },
            Err(e) => last_err = format!("{provider}: {e}"),
        }
    }

    let draft = draft.ok_or_else(|| anyhow::anyhow!("strategy builder failed: {}", last_err))?;
    let explanation = explain_draft(&draft);
    Ok(json!({ "draft": draft, "explanation": explanation }))
}
