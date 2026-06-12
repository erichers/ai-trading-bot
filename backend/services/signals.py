"""Evaluate composable indicator rules against a current indicator snapshot."""
from __future__ import annotations

from typing import Any

from services import alpaca_service, indicators

_OPERATORS = {
    ">": lambda a, b: a > b,
    "<": lambda a, b: a < b,
    ">=": lambda a, b: a >= b,
    "<=": lambda a, b: a <= b,
    "==": lambda a, b: a == b,
    "crosses_above": lambda a, b: a > b,  # simplified single-snapshot crossover
    "crosses_below": lambda a, b: a < b,
}


def _resolve(indicator: str, snapshot: dict[str, Any]) -> float | None:
    """Resolve a dotted indicator path (e.g. 'macd.hist', 'rsi14') from the snapshot."""
    parts = indicator.split(".")
    node: Any = snapshot
    for p in parts:
        if isinstance(node, dict) and p in node:
            node = node[p]
        else:
            return None
    return float(node) if isinstance(node, (int, float)) else None


def _resolve_value(value: Any, snapshot: dict[str, Any]) -> float | None:
    """RHS may be a number or another indicator reference (string)."""
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return _resolve(value, snapshot)
    return None


def evaluate(symbol: str, timeframe: str, rules: list[dict[str, Any]]) -> dict[str, Any]:
    bars = alpaca_service.get_bars(symbol.upper(), timeframe or "1Day", 250)
    snapshot = indicators.compute_all(bars)

    matched: list[dict[str, Any]] = []
    results: list[tuple[str, bool]] = []  # (join, result)

    for rule in rules or []:
        ind = rule.get("indicator")
        op = rule.get("operator")
        rhs = rule.get("value")
        join = (rule.get("join") or "AND").upper()

        lhs_val = _resolve(ind, snapshot) if ind else None
        rhs_val = _resolve_value(rhs, snapshot)
        ok = False
        if lhs_val is not None and rhs_val is not None and op in _OPERATORS:
            ok = bool(_OPERATORS[op](lhs_val, rhs_val))

        results.append((join, ok))
        if ok:
            matched.append({
                "indicator": ind, "operator": op, "value": rhs,
                "actual": lhs_val, "compared_to": rhs_val,
            })

    fired = _combine(results)
    return {"fired": fired, "matched": matched, "snapshot": snapshot}


def _combine(results: list[tuple[str, bool]]) -> bool:
    """Left-to-right boolean combination honoring per-rule AND/OR join with the prior result."""
    if not results:
        return False
    acc = results[0][1]
    for join, val in results[1:]:
        if join == "OR":
            acc = acc or val
        else:
            acc = acc and val
    return acc
