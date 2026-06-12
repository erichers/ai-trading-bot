"""Account / trading / orders / trades / clock / calendar routes."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

import db
from config import logger
from models import AccountResponse, OrderRequest
from services import alpaca_service, risk

router = APIRouter(tags=["trading"])


@router.get("/account", response_model=AccountResponse)
def account():
    return alpaca_service.get_account()


@router.get("/positions")
def positions():
    return alpaca_service.get_positions()


@router.get("/orders")
def orders(status: str = Query("open", pattern="^(open|closed|all)$")):
    result = alpaca_service.get_orders(status)
    # Reconcile current Alpaca orders into the trades table (fills/cancels).
    for o in result:
        try:
            db.upsert_trade_from_alpaca(o)
        except Exception as exc:  # never break the read path
            logger.warning("reconcile upsert failed for %s (%s).", o.get("id"), exc)
    return result


def _build_risk_rules(decision: dict) -> list[dict]:
    """Flatten vetoes+warnings into a single rules list with a 'kind' tag."""
    rules = [{**v, "kind": "veto"} for v in decision.get("vetoes", [])]
    rules += [{**w, "kind": "warning"} for w in decision.get("warnings", [])]
    return rules


@router.post("/orders")
def create_order(order: OrderRequest):
    payload = order.model_dump()
    source = payload.get("source", "manual")
    bypass = bool(payload.pop("bypass_risk", False))

    # ---- Risk Engine: evaluate BEFORE touching the broker -------------------
    decision = None
    try:
        account = alpaca_service.get_account()
        positions = alpaca_service.get_positions()
        limits = db.get_risk_limits()
        market_open = alpaca_service.market_open()
        day_trade_count = int(account.get("daytrade_count") or 0)
        decision = risk.evaluate_order(
            payload, account, positions, limits, market_open, day_trade_count)
    except HTTPException:
        raise
    except Exception as exc:  # risk-engine math should never 500 the route
        logger.warning("risk evaluate_order failed (%s) — allowing order.", exc)
        decision = None

    if decision is not None and not decision["approved"] and not bypass:
        # VETOED: do not submit, do not log a trade. Record the risk event.
        try:
            db.insert_risk_event({
                "symbol": payload.get("symbol"),
                "side": payload.get("side"),
                "qty": payload.get("qty"),
                "order_type": payload.get("type"),
                "decision": "vetoed",
                "rules": _build_risk_rules(decision),
                "computed": decision.get("computed"),
                "source": source,
            })
        except Exception as exc:
            logger.warning("insert_risk_event (veto) failed (%s).", exc)
        return {
            "rejected": True,
            "decision": "vetoed",
            "vetoes": decision["vetoes"],
            "computed": decision["computed"],
            "risk": decision,
        }

    result = alpaca_service.place_order(payload)
    # Persist the real order ack to the trades table.
    try:
        is_option = result.get("asset_class") == "option" or \
            alpaca_service._is_option_order(payload)
        db.insert_trade({
            "alpaca_order_id": result.get("id"),
            "client_order_id": result.get("client_order_id"),
            "symbol": result.get("symbol"),
            "asset_class": "option" if is_option else "us_equity",
            "side": result.get("side"),
            "qty": result.get("qty"),
            "order_type": result.get("type"),
            "order_class": result.get("order_class"),
            "time_in_force": result.get("time_in_force"),
            "limit_price": result.get("limit_price"),
            "stop_price": result.get("stop_price"),
            "take_profit": payload.get("take_profit"),
            "stop_loss": payload.get("stop_loss"),
            "status": result.get("status"),
            "filled_qty": result.get("filled_qty"),
            "filled_avg_price": result.get("filled_avg_price"),
            "submitted_at": result.get("submitted_at"),
            "filled_at": result.get("filled_at"),
            "source": payload.get("source", "manual"),
            "strategy_id": payload.get("strategy_id"),
            "raw": result.get("raw"),
        })
    except Exception as exc:
        logger.warning("insert_trade failed (%s).", exc)

    # ---- Record the approved/warned (or bypassed) risk event ----------------
    if decision is not None:
        try:
            rules = _build_risk_rules(decision)
            event_decision = decision["decision"]
            if bypass and not decision["approved"]:
                # Emergency override: record as approved with a 'bypassed' warning.
                event_decision = "approved"
                rules = rules + [{
                    "rule": "bypassed",
                    "message": "Risk veto bypassed via bypass_risk=true.",
                    "kind": "warning",
                }]
            db.insert_risk_event({
                "symbol": result.get("symbol") or payload.get("symbol"),
                "side": payload.get("side"),
                "qty": payload.get("qty"),
                "order_type": payload.get("type"),
                "decision": event_decision,
                "rules": rules,
                "computed": decision.get("computed"),
                "source": source,
            })
        except Exception as exc:
            logger.warning("insert_risk_event (approved) failed (%s).", exc)
        result["risk"] = decision
    return result


@router.get("/trades")
def trades(
    status: str | None = None,
    symbol: str | None = None,
    limit: int = Query(100, ge=1, le=500),
):
    return db.list_trades(status=status, symbol=symbol, limit=limit)


@router.delete("/orders/{order_id}")
def cancel_order(order_id: str):
    result = alpaca_service.cancel_order(order_id)
    try:
        db.upsert_trade_from_alpaca({"id": order_id, "status": "canceled"})
    except Exception as exc:
        logger.warning("cancel reconcile failed (%s).", exc)
    return result


@router.delete("/orders")
def kill_switch():
    """KILL SWITCH: cancel ALL open orders."""
    return alpaca_service.cancel_all_orders()


@router.get("/clock")
def clock():
    return alpaca_service.get_clock()


@router.get("/calendar")
def calendar(start: str | None = None, end: str | None = None):
    return alpaca_service.get_calendar(start, end)
