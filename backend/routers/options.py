"""Options routes: expirations, chain, flow, select — REAL Alpaca data only."""
from __future__ import annotations

from fastapi import APIRouter, Query

from services import options as options_svc

router = APIRouter(prefix="/options", tags=["options"])


@router.get("/expirations/{symbol}")
def expirations(symbol: str):
    return options_svc.expirations_with_type(symbol.upper())


@router.get("/chain/{symbol}")
def chain(
    symbol: str,
    expiration: str | None = None,
    type: str = Query("all", pattern="^(call|put|all)$"),
):
    return options_svc.get_option_chain(symbol.upper(), expiration, type)


@router.get("/flow/{symbol}")
def flow(symbol: str, period: str = Query("weekly", pattern="^(weekly|daily)$")):
    return options_svc.get_option_flow(symbol.upper(), period)


@router.get("/select/{symbol}")
def select(
    symbol: str,
    right: str = Query("call", pattern="^(call|put)$"),
    expiry: str = Query("nearest_weekly"),
    moneyness: str | None = Query(None, pattern="^(ATM|OTM|ITM)$"),
    count: int = Query(9, ge=1, le=50),
):
    """Real option contracts centered on ATM for picking calls/puts + strike.

    Raises 503 if the live chain/underlying is unavailable (no mock)."""
    return options_svc.select_contracts(
        symbol.upper(), right=right, expiry=expiry, moneyness=moneyness, count=count)
