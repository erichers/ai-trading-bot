"""WebSocket realtime feed: pushes simulated quote/news/signal updates ~every 2s.

Uses real Alpaca snapshots when the market is open; random-walks mock prices otherwise.
"""
from __future__ import annotations

import asyncio
import random
from datetime import datetime, timezone

from fastapi import WebSocket

import db
from config import logger
from services import alpaca_service, mock


class RealtimeBroadcaster:
    def __init__(self) -> None:
        self._prices: dict[str, float] = {}
        self._tick = 0

    def _price_for(self, symbol: str, use_live: bool) -> float:
        if use_live:
            snap = alpaca_service.get_snapshot(symbol)
            p = snap.get("price")
            if p:
                self._prices[symbol] = float(p)
                return float(p)
        # random walk from last known / seed
        last = self._prices.get(symbol) or mock.mock_snapshot(symbol)["price"]
        nxt = max(0.5, last * (1 + random.uniform(-0.004, 0.004)))
        self._prices[symbol] = nxt
        return nxt

    async def run(self, ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                self._tick += 1
                watchlist = db.get_watchlist()
                market_open = alpaca_service.market_open()
                ts = datetime.now(timezone.utc).isoformat()

                for sym in watchlist:
                    price = self._price_for(sym, use_live=market_open and self._tick % 5 == 0)
                    base = mock.mock_snapshot(sym)["prev_close"]
                    change_pct = round((price - base) / base * 100, 4) if base else 0.0
                    spread = max(0.01, price * 0.0005)
                    await ws.send_json({
                        "type": "quote",
                        "symbol": sym,
                        "price": round(price, 2),
                        "change_pct": change_pct,
                        "bid": round(price - spread, 2),
                        "ask": round(price + spread, 2),
                        "ts": ts,
                    })

                # Occasional news push
                if self._tick % 8 == 0 and watchlist:
                    item = mock.mock_news([random.choice(watchlist)], 1)[0]
                    await ws.send_json({"type": "news", **item})

                # Occasional signal push
                if self._tick % 11 == 0 and watchlist:
                    sym = random.choice(watchlist)
                    await ws.send_json({
                        "type": "signal",
                        "symbol": sym,
                        "fired": random.random() > 0.5,
                        "rule": random.choice(["RSI<30", "MACD cross up", "Price>SMA50"]),
                        "ts": ts,
                    })

                await asyncio.sleep(2)
        except Exception as exc:
            logger.info("WebSocket closed (%s).", exc)
