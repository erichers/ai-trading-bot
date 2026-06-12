"""Indicator routes: catalog and per-symbol computed snapshot."""
from __future__ import annotations

from fastapi import APIRouter, Query

from services import alpaca_service, indicators

router = APIRouter(prefix="/indicators", tags=["indicators"])


# IMPORTANT: declare /catalog before /{symbol} so it isn't captured as a symbol.
@router.get("/catalog")
def catalog():
    return indicators.CATALOG


@router.get("/{symbol}")
def indicator_snapshot(
    symbol: str,
    timeframe: str = Query("1Day", pattern="^(1Min|5Min|15Min|1Hour|1Day)$"),
):
    bars = alpaca_service.get_bars(symbol.upper(), timeframe, 300)
    return indicators.compute_all(bars)
