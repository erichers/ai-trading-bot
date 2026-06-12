"""Account / trading / clock / calendar routes."""
from __future__ import annotations

from fastapi import APIRouter, Query

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
    return alpaca_service.get_orders(status)


@router.post("/orders")
def create_order(order: OrderRequest):
    return alpaca_service.place_order(order.model_dump())


@router.delete("/orders/{order_id}")
def cancel_order(order_id: str):
    return alpaca_service.cancel_order(order_id)


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
