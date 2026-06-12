"""Deterministic Risk Engine — "the LLM proposes; deterministic code disposes."

Pure functions only: no external calls beyond what is passed in. Every order
proposed by a human, a strategy, or an AI must pass through ``evaluate_order``
before it can reach the broker. A *veto* blocks the order; a *warning* lets it
through but is recorded.
"""
from __future__ import annotations

import math
import re
from typing import Any, Optional

# OCC option symbol: ROOT + YYMMDD + C|P + strike*1000 padded to 8.
_OCC_RE = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")
# Standard US equity-option contract multiplier (1 contract = 100 shares).
OPTION_MULTIPLIER = 100


def _is_option(order: dict[str, Any]) -> bool:
    sym = (order.get("symbol") or "").strip().upper()
    return order.get("asset_class") == "option" or bool(_OCC_RE.match(sym))


def _underlying(occ_symbol: str) -> str:
    """Underlying root from an OCC option symbol (e.g. NVDA260615C00205000 -> NVDA)."""
    sym = (occ_symbol or "").strip().upper()
    m = re.match(r"^([A-Z]{1,6})\d{6}[CP]\d{8}$", sym)
    return m.group(1) if m else sym


# Canonical limit defaults — also persisted in the ``settings`` table under the
# ``risk_limits`` key (see db.get_risk_limits / db.set_risk_limits).
DEFAULT_LIMITS: dict[str, Any] = {
    "max_position_pct": 20,
    "max_open_positions": 10,
    "max_daily_loss_pct": 5,
    "max_per_trade_risk_pct": 1,
    "max_concentration_pct": 25,
    "min_price": 1,
    "default_risk_per_trade_pct": 1,
    "skip_first_minutes": 5,
    "kill_switch_engaged": False,
}


def _f(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def size_position(equity: float, risk_per_trade_pct: float, entry: float,
                  stop: float) -> dict[str, Any]:
    """Position-size from account risk.

    qty = floor((equity * risk_per_trade_pct/100) / abs(entry - stop)).
    Guards division-by-zero (entry == stop or missing) by returning qty 0.
    """
    equity = _f(equity)
    risk_per_trade_pct = _f(risk_per_trade_pct)
    entry = _f(entry)
    stop = _f(stop)

    risk_amount = equity * (risk_per_trade_pct / 100.0)
    per_share_risk = abs(entry - stop)
    if per_share_risk <= 0:
        return {
            "qty": 0,
            "risk_amount": round(risk_amount, 2),
            "position_value": 0.0,
            "per_share_risk": 0.0,
            "note": "entry equals stop (or missing) — cannot size",
        }
    qty = int(math.floor(risk_amount / per_share_risk))
    if qty < 0:
        qty = 0
    return {
        "qty": qty,
        "risk_amount": round(risk_amount, 2),
        "position_value": round(qty * entry, 2),
        "per_share_risk": round(per_share_risk, 4),
    }


def _order_price(order: dict[str, Any]) -> float:
    """Resolve a reference price from the order dict.

    Priority: limit_price -> stop_price -> ref_price/price/last. Returns 0.0 if
    nothing usable is present (callers should pass a ref_price for market orders).
    """
    for key in ("limit_price", "stop_price", "ref_price", "price", "last"):
        v = order.get(key)
        if v is not None:
            p = _f(v)
            if p > 0:
                return p
    return 0.0


def evaluate_order(
    order: dict[str, Any],
    account: dict[str, Any],
    positions: list[dict[str, Any]],
    limits: dict[str, Any],
    market_open: bool,
    day_trade_count: int,
) -> dict[str, Any]:
    """Run every deterministic rule against a proposed order.

    Returns a RiskDecision dict::

        {approved, decision, vetoes:[{rule,message}], warnings:[{rule,message}],
         computed:{...}}
    """
    lim = {**DEFAULT_LIMITS, **(limits or {})}
    vetoes: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    symbol = (order.get("symbol") or "").upper()
    side = (order.get("side") or "buy").lower()
    qty = _f(order.get("qty"))
    tif = (order.get("time_in_force") or "day").lower()
    price = _order_price(order)
    stop = order.get("stop_loss")
    if stop is None:
        stop = order.get("stop")
    stop_val = _f(stop) if stop is not None else None

    equity = _f(account.get("equity"))
    buying_power = _f(account.get("buying_power"))
    day_pl = _f(account.get("day_pl"))
    last_equity = _f(account.get("last_equity"))
    if account.get("day_pl_pct") is not None:
        day_pl_pct = _f(account.get("day_pl_pct"))
    else:
        day_pl_pct = (day_pl / last_equity * 100.0) if last_equity else 0.0

    # Options use a 100x contract multiplier: position_value = premium * qty * 100,
    # and per-trade risk is the premium at stake (defined-risk long option) rather
    # than equity-style per-share (entry-stop) math.
    is_option = _is_option(order)
    multiplier = OPTION_MULTIPLIER if is_option else 1
    position_value = qty * price * multiplier
    position_pct = (position_value / equity * 100.0) if equity else 0.0
    if is_option:
        # Premium at risk for a long option = full premium paid; for a short/sell
        # we still bound risk by the premium notional captured here.
        premium_risk = price * qty * OPTION_MULTIPLIER
        per_trade_risk_pct = (premium_risk / equity * 100.0) if equity else 0.0
    else:
        per_trade_risk_pct = (
            (abs(price - stop_val) * qty) / equity * 100.0
            if (stop_val is not None and equity and price)
            else 0.0
        )

    # Existing exposure in this symbol (long market value).
    # For options, the relevant exposure key is the UNDERLYING root (e.g. NVDA),
    # not the OCC contract symbol — so a call on an already-held name is not a
    # brand-new position for open-count/concentration purposes.
    match_symbol = _underlying(symbol) if is_option else symbol

    held = next((p for p in (positions or [])
                 if (p.get("symbol") or "").upper() == match_symbol), None)
    held_value = _f(held.get("market_value")) if held else 0.0
    if not held_value and held:
        held_value = _f(held.get("qty")) * _f(held.get("current_price") or held.get("avg_entry_price"))

    is_entry = side == "buy"
    concentration_value = held_value + (position_value if is_entry else 0.0)
    concentration_pct = (concentration_value / equity * 100.0) if equity else 0.0

    buying_power_after = buying_power - (position_value if is_entry else 0.0)

    # Open-position count, excluding this symbol/underlying if we already hold it.
    open_symbols = {(p.get("symbol") or "").upper() for p in (positions or [])}
    open_positions = len(open_symbols)
    new_symbol = match_symbol not in open_symbols

    # ---- Rules --------------------------------------------------------------
    # kill_switch: master off-switch.
    if lim.get("kill_switch_engaged"):
        vetoes.append({"rule": "kill_switch",
                       "message": "Kill switch engaged — all new orders blocked."})

    # circuit_breaker: daily loss limit blocks new entries (BUY).
    if is_entry and day_pl_pct <= -abs(_f(lim.get("max_daily_loss_pct"))):
        vetoes.append({"rule": "circuit_breaker",
                       "message": f"Daily loss {day_pl_pct:.2f}% breached limit "
                                  f"-{_f(lim.get('max_daily_loss_pct')):.2f}% — new entries blocked."})

    # max_position_pct.
    if is_entry and equity and position_pct > _f(lim.get("max_position_pct")):
        vetoes.append({"rule": "max_position_pct",
                       "message": f"Position size {position_pct:.2f}% of equity exceeds "
                                  f"max {_f(lim.get('max_position_pct')):.2f}%."})

    # max_open_positions (only for a brand-new symbol entry).
    if is_entry and new_symbol and open_positions >= int(_f(lim.get("max_open_positions"))):
        vetoes.append({"rule": "max_open_positions",
                       "message": f"Open positions {open_positions} would exceed max "
                                  f"{int(_f(lim.get('max_open_positions')))}."})

    # max_per_trade_risk_pct: for equities only when a stop is provided; for
    # options the premium at stake is the defined per-trade risk.
    if is_entry and equity and (is_option or stop_val is not None) and price:
        if per_trade_risk_pct > _f(lim.get("max_per_trade_risk_pct")):
            vetoes.append({"rule": "max_per_trade_risk_pct",
                           "message": f"Per-trade risk {per_trade_risk_pct:.2f}% exceeds max "
                                      f"{_f(lim.get('max_per_trade_risk_pct')):.2f}%."})

    # max_concentration_pct.
    if is_entry and equity and concentration_pct > _f(lim.get("max_concentration_pct")):
        vetoes.append({"rule": "max_concentration_pct",
                       "message": f"Concentration in {symbol} {concentration_pct:.2f}% exceeds max "
                                  f"{_f(lim.get('max_concentration_pct')):.2f}%."})

    # buying_power.
    if is_entry and price and position_value > buying_power:
        vetoes.append({"rule": "buying_power",
                       "message": f"Order value ${position_value:,.2f} exceeds buying power "
                                  f"${buying_power:,.2f}."})

    # min_price (equities only — an option *premium* is not a share price and a
    # cheap weekly is normal, so the min-share-price floor must not veto options).
    if not is_option and price and price < _f(lim.get("min_price")):
        vetoes.append({"rule": "min_price",
                       "message": f"Price ${price:.2f} below minimum ${_f(lim.get('min_price')):.2f}."})

    # pdt: warn only (PDT no longer enforced by Alpaca as of 2026-06-04).
    if int(_f(day_trade_count)) >= 3:
        warnings.append({"rule": "pdt",
                         "message": f"Day-trade count {int(_f(day_trade_count))} >= 3 "
                                    "(PDT no longer enforced; informational warning)."})

    # market_hours: warn if closed and not GTC.
    if not market_open and tif != "gtc":
        warnings.append({"rule": "market_hours",
                         "message": "Market is closed and order is not GTC — may be queued/rejected."})

    computed = {
        "position_value": round(position_value, 2),
        "position_pct": round(position_pct, 4),
        "open_positions": open_positions,
        "day_pl": round(day_pl, 2),
        "day_pl_pct": round(day_pl_pct, 4),
        "per_trade_risk_pct": round(per_trade_risk_pct, 4),
        "is_option": is_option,
        "contract_multiplier": multiplier,
        "buying_power_after": round(buying_power_after, 2),
        "concentration_pct": round(concentration_pct, 4),
        "ref_price": round(price, 4),
        "qty": qty,
    }

    approved = len(vetoes) == 0
    if not approved:
        decision = "vetoed"
    elif warnings:
        decision = "warned"
    else:
        decision = "approved"

    return {
        "approved": approved,
        "decision": decision,
        "vetoes": vetoes,
        "warnings": warnings,
        "computed": computed,
    }
