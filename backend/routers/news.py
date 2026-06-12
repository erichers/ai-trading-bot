"""News feed routes."""
from __future__ import annotations

from fastapi import APIRouter, Query

from services import alpaca_service

router = APIRouter(tags=["news"])


@router.get("/news")
def news(symbols: str = "", limit: int = Query(30, ge=1, le=100)):
    syms = [s.strip().upper() for s in symbols.split(",") if s.strip()]
    return alpaca_service.get_news(syms, limit)
