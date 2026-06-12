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

    let account = safe_account(state).await;
    let positions = safe_positions(state).await;
    let limits = db::get_risk_limits(&state.pool).await.unwrap_or(db::default_limits());
    let market_open = state.alpaca.market_open().await;
    let day_trades = account["daytrade_count"].as_i64().unwrap_or(0);

    let mut proposals = vec![];
    let empty = vec![];
    for sym_v in bot["symbols"].as_array().unwrap_or(&empty) {
        let symbol = sym_v.as_str().unwrap_or("").to_uppercase();
        let bars_v = match state.alpaca.get_bars(&symbol, "1Day", 120).await {
            Ok(b) => b,
            Err(e) => {
                proposals.push(json!({"symbol": symbol, "action": "skip", "rationale": format!("error: {}", e.detail)}));
                continue;
            }
        };
        let bars = bars_v.as_array().cloned().unwrap_or_default();
        let ind = indicators::compute_all(&bars);
        let snapshot = match state.alpaca.get_snapshot(&symbol).await {
            Ok(s) => s,
            Err(e) => {
                proposals.push(json!({"symbol": symbol, "action": "skip", "rationale": format!("error: {}", e.detail)}));
                continue;
            }
        };
        let price = {
            let p = num(&snapshot["price"], 0.0);
            if p == 0.0 { 100.0 } else { p }
        };
        let research = latest_research(state, &symbol).await;
        let (side_opt, rationale) = decide_direction(bot, &research, &ind, price);
        let side = match side_opt {
            None => {
                proposals.push(json!({
                    "symbol": symbol, "action": "skip", "rationale": rationale,
                    "conviction": research["conviction"], "sentiment": research["sentiment_score"],
                    "indicators_snapshot": ind_snap(&ind, price),
                }));
                continue;
            }
            Some(s) => s,
        };
        let act = action_of(bot);
        let (contract_opt, pick_note) = pick_contract(state, &symbol, &side, &act, cfg).await;
        let contract = match contract_opt {
            None => {
                proposals.push(json!({
                    "symbol": symbol, "action": "skip", "right": side, "rationale": rationale,
                    "error": pick_note, "note": pick_note,
                    "conviction": research["conviction"], "sentiment": research["sentiment_score"],
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

        let order = json!({
            "symbol": occ_symbol, "asset_class": "option", "side": "buy",
            "qty": contracts, "type": "limit",
            "limit_price": if mid != 0.0 { mid } else { ask }, "ref_price": if mid != 0.0 { mid } else { ask },
            "time_in_force": "day",
        });
        let risk_decision = risk::evaluate_order(&order, &account, &positions, &limits, market_open, day_trades);

        let mut note = pick_note.clone();
        if skip_premium {
            let extra = format!("Premium ${:.0} exceeds max_premium ${:.0}.", ask * 100.0, max_premium);
            note = Some(match note { Some(n) => format!("{n} {extra}"), None => extra });
        }
        let mut full_rationale = rationale.clone();
        if let Some(rc) = contract["rationale_contract"].as_str() {
            full_rationale = format!("{rationale} {rc}");
        }
        proposals.push(json!({
            "symbol": symbol,
            "action": if skip_premium { "skip" } else { "propose" },
            "occ_symbol": occ_symbol,
            "right": side,
            "strike": contract["strike"],
            "expiration": contract["expiration"],
            "mid_price": mid,
            "est_premium": est_premium,
            "qty": contracts,
            "conviction": research["conviction"],
            "sentiment": research["sentiment_score"],
            "rationale": full_rationale,
            "contract": {
                "occ_symbol": occ_symbol, "strike": contract["strike"], "right": side,
                "expiration": contract["expiration"], "bid": contract["bid"], "ask": contract["ask"],
                "mid": mid, "last": contract["last"], "implied_volatility": contract["implied_volatility"],
                "delta": contract["delta"], "gamma": contract["gamma"], "theta": contract["theta"],
                "vega": contract["vega"], "open_interest": contract["open_interest"],
                "volume": contract["volume"], "moneyness": contract["moneyness"],
                "underlying_price": contract["underlying_price"],
            },
            "indicators_snapshot": ind_snap(&ind, price),
            "risk_decision": risk_decision,
            "note": note,
        }));
    }

    json!({
        "bot_id": bot["id"],
        "bot_name": bot["name"],
        "mode": bot["mode"],
        "generated_at": now(),
        "proposals": proposals,
    })
}

pub async fn run_bot(state: &AppState, bot: &Value, place: bool) -> Value {
    let evaluation = evaluate_bot(state, bot).await;
    let mode = bot["mode"].as_str().unwrap_or("signal").to_lowercase();
    let do_place = place && (mode == "semi" || mode == "auto");
    let mut placed = vec![];
    let mut signals_recorded = 0;
    let empty = vec![];

    for p in evaluation["proposals"].as_array().unwrap_or(&empty) {
        if p["action"].as_str() != Some("propose") {
            continue;
        }
        let _ = db::insert_signal(&state.pool, &json!({
            "strategy_id": bot["id"],
            "symbol": p["symbol"],
            "timeframe": "weekly_options",
            "fired": true,
            "matched": [{"rule": "bot_direction", "message": p["rationale"]}],
            "snapshot": {
                "occ_symbol": p["occ_symbol"], "right": p["right"],
                "strike": p["strike"], "expiration": p["expiration"],
                "mid_price": p["mid_price"], "qty": p["qty"],
            },
        })).await;
        signals_recorded += 1;

        if !do_place {
            continue;
        }
        let decision = &p["risk_decision"];
        if !decision["approved"].as_bool().unwrap_or(true) {
            let _ = db::insert_risk_event(&state.pool, &json!({
                "symbol": p["occ_symbol"], "side": "buy", "qty": p["qty"],
                "order_type": "limit", "decision": "vetoed",
                "rules": decision["vetoes"], "computed": decision["computed"], "source": "bot",
            })).await;
            continue;
        }
        let order = json!({
            "symbol": p["occ_symbol"], "asset_class": "option", "side": "buy",
            "qty": p["qty"], "type": "limit", "limit_price": p["mid_price"], "time_in_force": "day",
        });
        if let Ok(ack) = state.alpaca.place_order(&order).await {
            let _ = db::insert_trade(&state.pool, &json!({
                "alpaca_order_id": ack["id"], "client_order_id": ack["client_order_id"],
                "symbol": ack["symbol"], "asset_class": "option", "side": "buy", "qty": p["qty"],
                "order_type": "limit", "limit_price": p["mid_price"], "status": ack["status"],
                "source": "bot", "strategy_id": bot["id"], "raw": ack["raw"],
            })).await;
            let _ = db::insert_risk_event(&state.pool, &json!({
                "symbol": p["occ_symbol"], "side": "buy", "qty": p["qty"], "order_type": "limit",
                "decision": decision["decision"], "rules": decision["warnings"],
                "computed": decision["computed"], "source": "bot",
            })).await;
            placed.push(ack);
        }
    }
    let mut out = evaluation;
    out["placed_orders"] = json!(placed);
    out["signals_recorded"] = json!(signals_recorded);
    out["placed"] = json!(do_place);
    out
}
