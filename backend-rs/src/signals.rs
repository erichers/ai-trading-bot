//! Evaluate composable indicator rules against a current indicator snapshot.

use crate::indicators;
use crate::state::AppState;
use serde_json::{json, Value};

fn resolve(indicator: &str, snapshot: &Value) -> Option<f64> {
    let mut node = snapshot;
    for p in indicator.split('.') {
        node = node.get(p)?;
    }
    node.as_f64()
}

fn resolve_value(value: &Value, snapshot: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok().or_else(|| resolve(s, snapshot)),
        _ => None,
    }
}

fn apply_op(op: &str, a: f64, b: f64) -> bool {
    match op {
        ">" | "crosses_above" => a > b,
        "<" | "crosses_below" => a < b,
        ">=" => a >= b,
        "<=" => a <= b,
        "==" => a == b,
        _ => false,
    }
}

pub async fn evaluate(
    state: &AppState,
    symbol: &str,
    timeframe: &str,
    rules: &[Value],
) -> anyhow::Result<Value> {
    let tf = if timeframe.is_empty() { "1Day" } else { timeframe };
    let bars_v = state.alpaca.get_bars(&symbol.to_uppercase(), tf, 250).await
        .map_err(|e| anyhow::anyhow!(e.detail))?;
    let bars = bars_v.as_array().cloned().unwrap_or_default();
    let snapshot = indicators::compute_all(&bars);

    let mut matched = vec![];
    let mut results: Vec<(String, bool)> = vec![];
    for rule in rules {
        let ind = rule["indicator"].as_str().unwrap_or("");
        let op = rule["operator"].as_str().unwrap_or("");
        let rhs = &rule["value"];
        let join = rule["join"].as_str().unwrap_or("AND").to_uppercase();

        let lhs_val = if ind.is_empty() { None } else { resolve(ind, &snapshot) };
        let rhs_val = resolve_value(rhs, &snapshot);
        let mut ok = false;
        if let (Some(l), Some(r)) = (lhs_val, rhs_val) {
            ok = apply_op(op, l, r);
        }
        results.push((join, ok));
        if ok {
            matched.push(json!({
                "indicator": ind, "operator": op, "value": rhs,
                "actual": lhs_val, "compared_to": rhs_val,
            }));
        }
    }
    let fired = combine(&results);
    Ok(json!({"fired": fired, "matched": matched, "snapshot": snapshot}))
}

fn combine(results: &[(String, bool)]) -> bool {
    if results.is_empty() {
        return false;
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
