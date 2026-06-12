"""Options routes: expirations, chain, flow (real Alpaca data, mock fallback)."""
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
