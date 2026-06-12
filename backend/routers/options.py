"""Options routes: expirations, chain, flow."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Query

from services import alpaca_service

router = APIRouter(prefix="/options", tags=["options"])


@router.get("/expirations/{symbol}")
def expirations(symbol: str):
    exps = alpaca_service.get_option_expirations(symbol.upper())
    out = []
    for e in exps:
        try:
            d = datetime.fromisoformat(e).date()
            # Monthly = the 3rd Friday of its month.
            is_monthly = d.weekday() == 4 and 15 <= d.day <= 21
        except Exception:
            is_monthly = False
        out.append({"date": e, "type": "monthly" if is_monthly else "weekly"})
    return out


@router.get("/chain/{symbol}")
def chain(
    symbol: str,
    expiration: str | None = None,
    type: str = Query("all", pattern="^(call|put|all)$"),
):
    return alpaca_service.get_option_chain(symbol.upper(), expiration, type)


@router.get("/flow/{symbol}")
def flow(symbol: str, period: str = Query("weekly", pattern="^(weekly|daily)$")):
    return alpaca_service.get_option_flow(symbol.upper(), period)
