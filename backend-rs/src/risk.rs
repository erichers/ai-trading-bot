//! Deterministic Risk Engine — pure port of backend/services/risk.py.

use crate::alpaca::is_occ_symbol;
use serde_json::{json, Value};

pub const OPTION_MULTIPLIER: f64 = 100.0;

fn f(v: &Value, default: f64) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(default),
        Value::String(s) => s.parse().unwrap_or(default),
        Value::Null => default,
        _ => default,
    }
}

fn is_option(order: &Value) -> bool {
    let sym = order["symbol"].as_str().unwrap_or("");
    order["asset_class"].as_str() == Some("option") || is_occ_symbol(sym)
}

fn underlying(occ: &str) -> String {
    let s = occ.trim().to_uppercase();
    if is_occ_symbol(&s) {
        let n = s.len();
        s[..n - 15].to_string()
    } else {
        s
    }
}

pub fn size_position(equity: f64, risk_per_trade_pct: f64, entry: f64, stop: f64) -> Value {
    let risk_amount = equity * (risk_per_trade_pct / 100.0);
    let per_share_risk = (entry - stop).abs();
    if per_share_risk <= 0.0 {
        return json!({
            "qty": 0,
            "risk_amount": (risk_amount * 100.0).round() / 100.0,
            "position_value": 0.0,
            "per_share_risk": 0.0,
            "note": "entry equals stop (or missing) — cannot size",
        });
    }
    let mut qty = (risk_amount / per_share_risk).floor() as i64;
    if qty < 0 {
        qty = 0;
    }
    json!({
        "qty": qty,
        "risk_amount": (risk_amount * 100.0).round() / 100.0,
        "position_value": ((qty as f64 * entry) * 100.0).round() / 100.0,
        "per_share_risk": (per_share_risk * 10000.0).round() / 10000.0,
    })
}

fn order_price(order: &Value) -> f64 {
    for key in ["limit_price", "stop_price", "ref_price", "price", "last"] {
        let v = &order[key];
        if !v.is_null() {
            let p = f(v, 0.0);
            if p > 0.0 {
                return p;
            }
        }
    }
    0.0
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
fn r4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

pub fn evaluate_order(
    order: &Value,
    account: &Value,
    positions: &[Value],
    limits: &Value,
    market_open: bool,
    day_trade_count: i64,
) -> Value {
    let mut lim = crate::db::default_limits();
    if let Some(obj) = limits.as_object() {
        for (k, v) in obj {
            lim[k] = v.clone();
        }
    }
    let mut vetoes: Vec<Value> = vec![];
    let mut warnings: Vec<Value> = vec![];

    let symbol = order["symbol"].as_str().unwrap_or("").to_uppercase();
    let side = order["side"].as_str().unwrap_or("buy").to_lowercase();
    let qty = f(&order["qty"], 0.0);
    let tif = order["time_in_force"].as_str().unwrap_or("day").to_lowercase();
    let price = order_price(order);
    let stop_val: Option<f64> = {
        let s = if !order["stop_loss"].is_null() {
            &order["stop_loss"]
        } else {
            &order["stop"]
        };
        if s.is_null() {
            None
        } else {
            Some(f(s, 0.0))
        }
    };

    let equity = f(&account["equity"], 0.0);
    let buying_power = f(&account["buying_power"], 0.0);
    let day_pl = f(&account["day_pl"], 0.0);
    let last_equity = f(&account["last_equity"], 0.0);
    let day_pl_pct = if !account["day_pl_pct"].is_null() {
        f(&account["day_pl_pct"], 0.0)
    } else if last_equity != 0.0 {
        day_pl / last_equity * 100.0
    } else {
        0.0
    };

    let is_opt = is_option(order);
    let multiplier = if is_opt { OPTION_MULTIPLIER } else { 1.0 };
    let position_value = qty * price * multiplier;
    let position_pct = if equity != 0.0 {
        position_value / equity * 100.0
    } else {
        0.0
    };
    let per_trade_risk_pct = if is_opt {
        let premium_risk = price * qty * OPTION_MULTIPLIER;
        if equity != 0.0 {
            premium_risk / equity * 100.0
        } else {
            0.0
        }
    } else if stop_val.is_some() && equity != 0.0 && price != 0.0 {
        (price - stop_val.unwrap()).abs() * qty / equity * 100.0
    } else {
        0.0
    };

    let match_symbol = if is_opt { underlying(&symbol) } else { symbol.clone() };
    let held = positions
        .iter()
        .find(|p| p["symbol"].as_str().unwrap_or("").to_uppercase() == match_symbol);
    let mut held_value = held.map(|h| f(&h["market_value"], 0.0)).unwrap_or(0.0);
    if held_value == 0.0 {
        if let Some(h) = held {
            let cur = if !h["current_price"].is_null() {
                f(&h["current_price"], 0.0)
            } else {
                f(&h["avg_entry_price"], 0.0)
            };
            held_value = f(&h["qty"], 0.0) * cur;
        }
    }

    let is_entry = side == "buy";
    let concentration_value = held_value + if is_entry { position_value } else { 0.0 };
    let concentration_pct = if equity != 0.0 {
        concentration_value / equity * 100.0
    } else {
        0.0
    };
    let buying_power_after = buying_power - if is_entry { position_value } else { 0.0 };

    let open_symbols: std::collections::HashSet<String> = positions
        .iter()
        .map(|p| p["symbol"].as_str().unwrap_or("").to_uppercase())
        .collect();
    let open_positions = open_symbols.len() as i64;
    let new_symbol = !open_symbols.contains(&match_symbol);

    if lim["kill_switch_engaged"].as_bool().unwrap_or(false) {
        vetoes.push(json!({"rule": "kill_switch", "message": "Kill switch engaged — all new orders blocked."}));
    }
    if is_entry && day_pl_pct <= -(f(&lim["max_daily_loss_pct"], 0.0)).abs() {
        vetoes.push(json!({"rule": "circuit_breaker", "message": format!("Daily loss {:.2}% breached limit -{:.2}% — new entries blocked.", day_pl_pct, f(&lim["max_daily_loss_pct"], 0.0))}));
    }
    if is_entry && equity != 0.0 && position_pct > f(&lim["max_position_pct"], 0.0) {
        vetoes.push(json!({"rule": "max_position_pct", "message": format!("Position size {:.2}% of equity exceeds max {:.2}%.", position_pct, f(&lim["max_position_pct"], 0.0))}));
    }
    if is_entry && new_symbol && open_positions >= f(&lim["max_open_positions"], 0.0) as i64 {
        vetoes.push(json!({"rule": "max_open_positions", "message": format!("Open positions {} would exceed max {}.", open_positions, f(&lim["max_open_positions"], 0.0) as i64)}));
    }
    if is_entry && equity != 0.0 && (is_opt || stop_val.is_some()) && price != 0.0 {
        if per_trade_risk_pct > f(&lim["max_per_trade_risk_pct"], 0.0) {
            vetoes.push(json!({"rule": "max_per_trade_risk_pct", "message": format!("Per-trade risk {:.2}% exceeds max {:.2}%.", per_trade_risk_pct, f(&lim["max_per_trade_risk_pct"], 0.0))}));
        }
    }
    if is_entry && equity != 0.0 && concentration_pct > f(&lim["max_concentration_pct"], 0.0) {
        vetoes.push(json!({"rule": "max_concentration_pct", "message": format!("Concentration in {} {:.2}% exceeds max {:.2}%.", symbol, concentration_pct, f(&lim["max_concentration_pct"], 0.0))}));
    }
    if is_entry && price != 0.0 && position_value > buying_power {
        vetoes.push(json!({"rule": "buying_power", "message": format!("Order value ${:.2} exceeds buying power ${:.2}.", position_value, buying_power)}));
    }
    if !is_opt && price != 0.0 && price < f(&lim["min_price"], 0.0) {
        vetoes.push(json!({"rule": "min_price", "message": format!("Price ${:.2} below minimum ${:.2}.", price, f(&lim["min_price"], 0.0))}));
    }
    if day_trade_count >= 3 {
        warnings.push(json!({"rule": "pdt", "message": format!("Day-trade count {} >= 3 (PDT no longer enforced; informational warning).", day_trade_count)}));
    }
    if !market_open && tif != "gtc" {
        warnings.push(json!({"rule": "market_hours", "message": "Market is closed and order is not GTC — may be queued/rejected."}));
    }

    let computed = json!({
        "position_value": r2(position_value),
        "position_pct": r4(position_pct),
        "open_positions": open_positions,
        "day_pl": r2(day_pl),
        "day_pl_pct": r4(day_pl_pct),
        "per_trade_risk_pct": r4(per_trade_risk_pct),
        "is_option": is_opt,
        "contract_multiplier": multiplier,
        "buying_power_after": r2(buying_power_after),
        "concentration_pct": r4(concentration_pct),
        "ref_price": r4(price),
        "qty": qty,
    });

    let approved = vetoes.is_empty();
    let decision = if !approved {
        "vetoed"
    } else if !warnings.is_empty() {
        "warned"
    } else {
        "approved"
    };

    json!({
        "approved": approved,
        "decision": decision,
        "vetoes": vetoes,
        "warnings": warnings,
        "computed": computed,
    })
}
