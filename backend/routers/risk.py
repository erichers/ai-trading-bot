"""Risk Engine routes (prefix /api/risk).

Deterministic risk limits, dry-run order checks, position sizing, account risk
status, the kill switch, and the risk-event audit log.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

import db
from config import logger
from models import (
    KillSwitchRequest,
    RiskCheckRequest,
    RiskLimitsUpdate,
    RiskSizeRequest,
)
from services import alpaca_service, risk

router = APIRouter(prefix="/risk", tags=["risk"])

# Heuristic stop estimate (matches the frontend) when no real stop is known.
_STOP_ESTIMATE_PCT = 0.02


def _safe_account() -> dict:
    try:
        return alpaca_service.get_account()
    except Exception as exc:  # never 500
        logger.warning("risk: get_account failed (%s).", exc)
        return {}


def _safe_positions() -> list[dict]:
    try:
        return alpaca_service.get_positions()
    except Exception as exc:
        logger.warning("risk: get_positions failed (%s).", exc)
        return []


def _safe_market_open() -> bool:
    try:
        return alpaca_service.market_open()
    except Exception:
        return False


@router.get("/limits")
def get_limits():
    return db.get_risk_limits()


@router.put("/limits")
def update_limits(body: RiskLimitsUpdate):
    return db.set_risk_limits(body.model_dump(exclude_unset=True))


@router.get("/status")
def status():
    account = _safe_account()
    positions = _safe_positions()
    limits = db.get_risk_limits()

    equity = float(account.get("equity") or 0.0)
    buying_power = float(account.get("buying_power") or 0.0)
    day_pl = float(account.get("day_pl") or 0.0)
    day_pl_pct = float(account.get("day_pl_pct") or 0.0)

    max_daily_loss = float(limits.get("max_daily_loss_pct") or 0.0)
    max_open = int(limits.get("max_open_positions") or 0)

    # Open risk = sum over positions of qty * (current_price - stop_estimate).
    open_risk = 0.0
    for p in positions:
        qty = float(p.get("qty") or 0.0)
        cur = float(p.get("current_price") or p.get("avg_entry_price") or 0.0)
        stop_est = cur * (1 - _STOP_ESTIMATE_PCT)
        open_risk += qty * (cur - stop_est)
    open_risk = round(open_risk, 2)
    open_risk_pct = round((open_risk / equity * 100.0) if equity else 0.0, 4)

    circuit_breaker_tripped = bool(day_pl_pct <= -abs(max_daily_loss)) if max_daily_loss else False
    open_positions = len(positions)

    return {
        "equity": round(equity, 2),
        "buying_power": round(buying_power, 2),
        "day_pl": round(day_pl, 2),
        "day_pl_pct": round(day_pl_pct, 4),
        "open_positions": open_positions,
        "max_open_positions": max_open,
        "open_risk": open_risk,
        "open_risk_pct": open_risk_pct,
        "circuit_breaker_tripped": circuit_breaker_tripped,
        "kill_switch_engaged": bool(limits.get("kill_switch_engaged")),
        "utilization": {
            "position_slots_used_pct": round((open_positions / max_open * 100.0) if max_open else 0.0, 2),
            "buying_power_used_pct": round(
                ((equity - buying_power) / equity * 100.0) if equity else 0.0, 2),
            "daily_loss_used_pct": round(
                (min(0.0, day_pl_pct) / -abs(max_daily_loss) * 100.0) if max_daily_loss else 0.0, 2),
        },
        "limits": limits,
    }


@router.post("/check")
def check(body: RiskCheckRequest):
    """Dry-run evaluate_order — no DB write, no order submitted."""
    order = body.model_dump()
    account = _safe_account()
    positions = _safe_positions()
    limits = db.get_risk_limits()
    market_open = _safe_market_open()
    day_trade_count = int(account.get("daytrade_count") or 0)
    return risk.evaluate_order(order, account, positions, limits, market_open, day_trade_count)


@router.post("/size")
def size(body: RiskSizeRequest):
    limits = db.get_risk_limits()
    account = _safe_account()
    equity = float(account.get("equity") or 0.0)
    rpt = body.risk_per_trade_pct
    if rpt is None:
        rpt = float(limits.get("default_risk_per_trade_pct") or 1.0)
    return risk.size_position(equity, rpt, body.entry, body.stop)


@router.post("/kill-switch")
def kill_switch(body: KillSwitchRequest):
    limits = db.set_risk_limits({"kill_switch_engaged": body.engaged})
    result: dict = {"kill_switch_engaged": bool(limits.get("kill_switch_engaged"))}
    if body.engaged and body.flatten:
        try:
            cancelled = alpaca_service.cancel_all_orders()
            result["cancelled"] = cancelled.get("cancelled", 0) if isinstance(cancelled, dict) else 0
        except Exception as exc:
            logger.warning("kill-switch cancel_all failed (%s).", exc)
            result["cancelled"] = 0
        if body.close_positions:
            closed = 0
            for p in _safe_positions():
                sym = p.get("symbol")
                qty = abs(float(p.get("qty") or 0.0))
                side = "sell" if (p.get("side") == "long") else "buy"
                if not sym or qty <= 0:
                    continue
                try:
                    alpaca_service.place_order({
                        "symbol": sym, "qty": qty, "side": side,
                        "type": "market", "time_in_force": "day",
                    })
                    closed += 1
                except Exception as exc:
                    logger.warning("flatten %s failed (%s).", sym, exc)
            result["positions_closed"] = closed
    return result


@router.get("/events")
def events(limit: int = Query(50, ge=1, le=500)):
    return db.list_risk_events(limit=limit)
