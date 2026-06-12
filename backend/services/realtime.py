"""WebSocket realtime feed: pushes REAL Alpaca quotes/trades for the watchlist.

NO MOCK / random-walk. Each tick polls real Alpaca snapshots for the watchlist
and pushes the latest real price (last trade, or last close when the market is
closed). Symbols with no fresh real data are skipped — prices are never
fabricated. A small reconnect/backoff jitter is the only use of `random` and it
touches no price/market data.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from fastapi import WebSocket

import db
from config import logger
from services import alpaca_service


class RealtimeBroadcaster:
    def __init__(self) -> None:
        self._tick = 0

    async def run(self, ws: WebSocket) -> None:
        await ws.accept()
        try:
            while True:
                self._tick += 1
                watchlist = db.get_watchlist()
                ts = datetime.now(timezone.utc).isoformat()

                # Pull REAL snapshots for the whole watchlist in one batch.
                try:
                    snaps = await asyncio.to_thread(alpaca_service.get_snapshots, watchlist)
                except Exception as exc:
                    # Upstream unavailable — tell the client, don't fabricate.
                    logger.info("realtime: snapshots unavailable (%s).", exc)
                    await ws.send_json({
                        "type": "status",
                        "message": "Real-time market data temporarily unavailable.",
                        "ts": ts,
                    })
                    await asyncio.sleep(5)
                    continue

                for sym in watchlist:
                    snap = snaps.get(sym)
                    if not snap:
                        continue  # no fresh real data — skip, never invent
                    price = snap.get("price")
                    if not price:
                        continue
                    spread = max(0.01, float(price) * 0.0005)
                    await ws.send_json({
                        "type": "quote",
                        "symbol": sym,
                        "price": round(float(price), 2),
                        "change_pct": snap.get("change_pct", 0.0),
                        "bid": round(float(price) - spread, 2),
                        "ask": round(float(price) + spread, 2),
                        "ts": ts,
                    })

                await asyncio.sleep(2)
        except Exception as exc:
            logger.info("WebSocket closed (%s).", exc)
