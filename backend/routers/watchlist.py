"""Watchlist routes (SQLite persisted)."""
from __future__ import annotations

from fastapi import APIRouter

import db
from models import WatchlistAdd

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


@router.get("")
def get_watchlist():
    return db.get_watchlist()


@router.post("")
def add_watchlist(body: WatchlistAdd):
    return db.add_watchlist(body.symbol)


@router.delete("/{symbol}")
def remove_watchlist(symbol: str):
    return db.remove_watchlist(symbol)
