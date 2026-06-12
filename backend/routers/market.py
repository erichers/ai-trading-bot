"""Market data routes: assets, bars, quote, snapshot(s)."""
from __future__ import annotations

from fastapi import APIRouter, Query

from services import alpaca_service

router = APIRouter(tags=["market"])


@router.get("/assets")
def assets(search: str = "", limit: int = Query(20, ge=1, le=100)):
    return alpaca_service.search_assets(search, limit)


@router.get("/bars/{symbol}")
def bars(
    symbol: str,
    timeframe: str = Query("1Day", pattern="^(1Min|5Min|15Min|1Hour|1Day)$"),
    limit: int = Query(300, ge=1, le=1000),
):
    return alpaca_service.get_bars(symbol.upper(), timeframe, limit)


@router.get("/quote/{symbol}")
def quote(symbol: str):
    return alpaca_service.get_quote(symbol.upper())


@router.get("/snapshot/{symbol}")
def snapshot(symbol: str):
    return alpaca_service.get_snapshot(symbol.upper())


@router.get("/snapshots")
def snapshots(symbols: str = Query(..., description="Comma-separated symbols")):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return alpaca_service.get_snapshots(syms)
