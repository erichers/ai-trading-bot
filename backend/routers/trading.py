"""Account / trading / orders / trades / clock / calendar routes."""
from __future__ import annotations

from fastapi import APIRouter, Query

import db
from config import logger
from models import AccountResponse, OrderRequest
from services import alpaca_service

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


@router.post("/orders")
def create_order(order: OrderRequest):
    payload = order.model_dump()
    result = alpaca_service.place_order(payload)
    # Persist every attempt (real fills or mock acks) to the trades table.
    try:
        is_option = result.get("asset_class") == "option" or \
            alpaca_service._is_option_order(payload)
        db.insert_trade({
            "alpaca_order_id": result.get("id") if result.get("id") != "mock-new-order" else None,
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
