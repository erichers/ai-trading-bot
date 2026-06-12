"""SQLite persistence for watchlist, strategies, and settings (stdlib sqlite3)."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from typing import Any

from config import settings

_LOCK = threading.Lock()

DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"]


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _LOCK, _connect() as conn:
        conn.execute(
            "CREATE TABLE IF NOT EXISTS watchlist (symbol TEXT PRIMARY KEY, added_at REAL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS strategies (id TEXT PRIMARY KEY, data TEXT, updated_at REAL)"
        )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
        )
        # Seed watchlist if empty
        cur = conn.execute("SELECT COUNT(*) AS n FROM watchlist")
        if cur.fetchone()["n"] == 0:
            for sym in DEFAULT_WATCHLIST:
                conn.execute(
                    "INSERT OR IGNORE INTO watchlist(symbol, added_at) VALUES (?, ?)",
                    (sym, time.time()),
                )
        conn.commit()


# ---- Watchlist ----
def get_watchlist() -> list[str]:
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT symbol FROM watchlist ORDER BY added_at ASC"
        ).fetchall()
        return [r["symbol"] for r in rows]


def add_watchlist(symbol: str) -> list[str]:
    symbol = symbol.strip().upper()
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO watchlist(symbol, added_at) VALUES (?, ?)",
            (symbol, time.time()),
        )
        conn.commit()
    return get_watchlist()


def remove_watchlist(symbol: str) -> list[str]:
    symbol = symbol.strip().upper()
    with _LOCK, _connect() as conn:
        conn.execute("DELETE FROM watchlist WHERE symbol = ?", (symbol,))
        conn.commit()
    return get_watchlist()


# ---- Strategies ----
def list_strategies() -> list[dict[str, Any]]:
    with _LOCK, _connect() as conn:
        rows = conn.execute(
            "SELECT data FROM strategies ORDER BY updated_at DESC"
        ).fetchall()
        return [json.loads(r["data"]) for r in rows]


def get_strategy(strategy_id: str) -> dict[str, Any] | None:
    with _LOCK, _connect() as conn:
        row = conn.execute(
            "SELECT data FROM strategies WHERE id = ?", (strategy_id,)
        ).fetchone()
        return json.loads(row["data"]) if row else None


def create_strategy(strategy: dict[str, Any]) -> dict[str, Any]:
    strategy = dict(strategy)
    strategy["id"] = strategy.get("id") or str(uuid.uuid4())
    with _LOCK, _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO strategies(id, data, updated_at) VALUES (?, ?, ?)",
            (strategy["id"], json.dumps(strategy), time.time()),
        )
        conn.commit()
    return strategy


def update_strategy(strategy_id: str, strategy: dict[str, Any]) -> dict[str, Any] | None:
    existing = get_strategy(strategy_id)
    if existing is None:
        return None
    merged = {**existing, **strategy, "id": strategy_id}
    with _LOCK, _connect() as conn:
        conn.execute(
            "UPDATE strategies SET data = ?, updated_at = ? WHERE id = ?",
            (json.dumps(merged), time.time(), strategy_id),
        )
        conn.commit()
    return merged


def delete_strategy(strategy_id: str) -> bool:
    with _LOCK, _connect() as conn:
        cur = conn.execute("DELETE FROM strategies WHERE id = ?", (strategy_id,))
        conn.commit()
        return cur.rowcount > 0
