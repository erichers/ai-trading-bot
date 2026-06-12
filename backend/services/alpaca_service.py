"""Alpaca wrappers. Every method falls back to realistic mock data on failure.

Uses alpaca-py SDK (TradingClient / StockHistoricalDataClient / NewsClient).
Paper accounts use the IEX feed for market data.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from config import logger, settings
from services import mock

# ---- Lazy SDK import & client construction ----------------------------------
_trading_client = None
_data_client = None
_news_client = None
_option_client = None
_sdk_ok = False

try:
    from alpaca.trading.client import TradingClient
    from alpaca.data.historical import StockHistoricalDataClient
    from alpaca.data.requests import (
        StockBarsRequest,
        StockLatestQuoteRequest,
        StockSnapshotRequest,
    )
    from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
    from alpaca.data.enums import DataFeed

    try:
        from alpaca.data.historical.news import NewsClient
        from alpaca.data.requests import NewsRequest
    except Exception:  # NewsClient may not exist in some versions
        NewsClient = None
        NewsRequest = None

    try:
        from alpaca.data.historical.option import OptionHistoricalDataClient
        from alpaca.trading.requests import GetOptionContractsRequest
    except Exception:
        OptionHistoricalDataClient = None
        GetOptionContractsRequest = None

    from alpaca.trading.requests import (
        MarketOrderRequest,
        LimitOrderRequest,
        StopOrderRequest,
        GetOrdersRequest,
        GetCalendarRequest,
        TakeProfitRequest,
        StopLossRequest,
        GetAssetsRequest,
    )
    from alpaca.trading.enums import (
        OrderSide,
        TimeInForce,
        OrderType,
        OrderClass,
        QueryOrderStatus,
        AssetClass,
        AssetStatus,
    )

    _sdk_ok = True
except Exception as exc:  # pragma: no cover - import guard
    logger.warning("alpaca-py SDK not importable (%s) — running in mock-only mode.", exc)
    _sdk_ok = False


def _get_trading():
    global _trading_client
    if not (_sdk_ok and settings.alpaca_configured):
        return None
    if _trading_client is None:
        _trading_client = TradingClient(
            settings.alpaca_api_key,
            settings.alpaca_secret_key,
            paper=settings.alpaca_paper_trade,
        )
    return _trading_client


def _get_data():
    global _data_client
    if not (_sdk_ok and settings.alpaca_configured):
        return None
    if _data_client is None:
        _data_client = StockHistoricalDataClient(
            settings.alpaca_api_key, settings.alpaca_secret_key
        )
    return _data_client


def _get_news():
    global _news_client
    if not (_sdk_ok and settings.alpaca_configured and NewsClient):
        return None
    if _news_client is None:
        _news_client = NewsClient(settings.alpaca_api_key, settings.alpaca_secret_key)
    return _news_client


def _get_option():
    global _option_client
    if not (_sdk_ok and settings.alpaca_configured and OptionHistoricalDataClient):
        return None
    if _option_client is None:
        _option_client = OptionHistoricalDataClient(
            settings.alpaca_api_key, settings.alpaca_secret_key
        )
    return _option_client


def alpaca_connected() -> bool:
    """Cheap connectivity probe used by /health."""
    client = _get_trading()
    if client is None:
        return False
    try:
        client.get_account()
        return True
    except Exception:
        return False


def _tf(timeframe: str):
    mapping = {
        "1Min": TimeFrame(1, TimeFrameUnit.Minute),
        "5Min": TimeFrame(5, TimeFrameUnit.Minute),
        "15Min": TimeFrame(15, TimeFrameUnit.Minute),
        "1Hour": TimeFrame(1, TimeFrameUnit.Hour),
        "1Day": TimeFrame(1, TimeFrameUnit.Day),
    }
    return mapping.get(timeframe, TimeFrame(1, TimeFrameUnit.Day))


# ---- Account / trading ------------------------------------------------------
def get_account() -> dict[str, Any]:
    client = _get_trading()
    if client is None:
        return mock.mock_account()
    try:
        a = client.get_account()
        equity = float(a.equity)
        last_equity = float(a.last_equity)
        day_pl = equity - last_equity
        return {
            "equity": equity,
            "buying_power": float(a.buying_power),
            "cash": float(a.cash),
            "portfolio_value": float(a.portfolio_value),
            "last_equity": last_equity,
            "day_pl": round(day_pl, 2),
            "day_pl_pct": round((day_pl / last_equity * 100) if last_equity else 0.0, 4),
            "daytrade_count": int(a.daytrade_count),
            "status": str(a.status.value if hasattr(a.status, "value") else a.status),
        }
    except Exception as exc:
        logger.warning("get_account failed (%s) — returning mock.", exc)
        return mock.mock_account()


def get_positions() -> list[dict[str, Any]]:
    client = _get_trading()
    if client is None:
        return mock.mock_positions()
    try:
        positions = client.get_all_positions()
        return [
            {
                "symbol": p.symbol,
                "qty": float(p.qty),
                "side": str(p.side.value if hasattr(p.side, "value") else p.side),
                "avg_entry_price": float(p.avg_entry_price),
                "current_price": float(p.current_price) if p.current_price else 0.0,
                "market_value": float(p.market_value) if p.market_value else 0.0,
                "unrealized_pl": float(p.unrealized_pl) if p.unrealized_pl else 0.0,
                "unrealized_plpc": float(p.unrealized_plpc) if p.unrealized_plpc else 0.0,
                "change_today": float(p.change_today) if p.change_today else 0.0,
            }
            for p in positions
        ]
    except Exception as exc:
        logger.warning("get_positions failed (%s) — returning mock.", exc)
        return mock.mock_positions()


def _order_to_dict(o) -> dict[str, Any]:
    def _val(x):
        return x.value if hasattr(x, "value") else x

    asset_class = _val(getattr(o, "asset_class", None)) or "us_equity"
    order_class = getattr(o, "order_class", None)
    return {
        "id": str(o.id),
        "client_order_id": getattr(o, "client_order_id", None),
        "symbol": o.symbol,
        "asset_class": str(asset_class),
        "qty": float(o.qty) if o.qty else None,
        "side": str(_val(o.side)),
        "type": str(_val(o.order_type if hasattr(o, "order_type") else o.type)),
        "order_class": str(_val(order_class)) if order_class else None,
        "time_in_force": str(_val(o.time_in_force)),
        "status": str(_val(o.status)),
        "limit_price": float(o.limit_price) if o.limit_price else None,
        "stop_price": float(o.stop_price) if o.stop_price else None,
        "filled_avg_price": float(o.filled_avg_price) if o.filled_avg_price else None,
        "filled_qty": float(o.filled_qty) if o.filled_qty else 0.0,
        "submitted_at": o.submitted_at.isoformat() if o.submitted_at else None,
        "filled_at": o.filled_at.isoformat() if getattr(o, "filled_at", None) else None,
    }


def get_orders(status: str = "all") -> list[dict[str, Any]]:
    client = _get_trading()
    if client is None:
        return mock.mock_orders(status)
    try:
        status_map = {
            "open": QueryOrderStatus.OPEN,
            "closed": QueryOrderStatus.CLOSED,
            "all": QueryOrderStatus.ALL,
        }
        req = GetOrdersRequest(status=status_map.get(status, QueryOrderStatus.ALL), limit=100)
        orders = client.get_orders(filter=req)
        return [_order_to_dict(o) for o in orders]
    except Exception as exc:
        logger.warning("get_orders failed (%s) — returning mock.", exc)
        return mock.mock_orders(status)


import re as _re

# OCC option symbol: ROOT + YYMMDD + C|P + strike*1000 padded to 8.
_OCC_RE = _re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")


def _is_option_order(payload: dict[str, Any]) -> bool:
    sym = (payload.get("symbol") or "").strip().upper()
    return payload.get("asset_class") == "option" or bool(_OCC_RE.match(sym))


def _mock_order_ack(payload: dict[str, Any], *, error: str | None = None) -> dict[str, Any]:
    ack = {
        "id": "mock-new-order",
        "client_order_id": None,
        "symbol": payload["symbol"].upper(),
        "asset_class": "option" if _is_option_order(payload) else "us_equity",
        "qty": float(payload["qty"]),
        "side": payload["side"],
        "type": payload.get("type", "market"),
        "order_class": None,
        "time_in_force": payload.get("time_in_force", "day"),
        "status": "accepted",
        "limit_price": payload.get("limit_price"),
        "stop_price": payload.get("stop_price"),
        "filled_avg_price": None,
        "filled_qty": 0.0,
        "submitted_at": mock.now_iso(),
        "filled_at": None,
    }
    if error:
        ack["error"] = error
    return ack


def place_order(payload: dict[str, Any]) -> dict[str, Any]:
    client = _get_trading()
    if client is None:
        ack = _mock_order_ack(payload)
        ack["raw"] = {"mock": True, "reason": "no_alpaca_client"}
        return ack

    is_option = _is_option_order(payload)
    try:
        side = OrderSide.BUY if payload["side"].lower() == "buy" else OrderSide.SELL
        tif_map = {
            "day": TimeInForce.DAY, "gtc": TimeInForce.GTC, "ioc": TimeInForce.IOC,
            "fok": TimeInForce.FOK, "opg": TimeInForce.OPG, "cls": TimeInForce.CLS,
        }
        tif_raw = payload.get("time_in_force", "day").lower()
        symbol = payload["symbol"].upper()
        otype = payload.get("type", "market").lower()

        if is_option:
            # Options constraints: whole-number qty; market/limit/stop/stop_limit
            # single-leg; tif in {day, gtc}; no bracket; no extended hours.
            qty = float(int(round(float(payload["qty"]))))
            tif = TimeInForce.GTC if tif_raw == "gtc" else TimeInForce.DAY
            common: dict[str, Any] = {
                "symbol": symbol, "qty": qty, "side": side,
                "time_in_force": tif, "extended_hours": False,
            }
            if otype == "limit":
                req = LimitOrderRequest(limit_price=float(payload["limit_price"]), **common)
            elif otype == "stop":
                req = StopOrderRequest(stop_price=float(payload["stop_price"]), **common)
            else:
                req = MarketOrderRequest(**common)
        else:
            tif = tif_map.get(tif_raw, TimeInForce.DAY)
            qty = float(payload["qty"])
            take_profit = payload.get("take_profit")
            stop_loss = payload.get("stop_loss")
            bracket = take_profit is not None and stop_loss is not None
            common = {"symbol": symbol, "qty": qty, "side": side, "time_in_force": tif}
            if bracket:
                common["order_class"] = OrderClass.BRACKET
                common["take_profit"] = TakeProfitRequest(limit_price=float(take_profit))
                common["stop_loss"] = StopLossRequest(stop_price=float(stop_loss))
            if otype == "limit":
                req = LimitOrderRequest(limit_price=float(payload["limit_price"]), **common)
            elif otype == "stop":
                req = StopOrderRequest(stop_price=float(payload["stop_price"]), **common)
            else:
                req = MarketOrderRequest(**common)

        o = client.submit_order(order_data=req)
        out = _order_to_dict(o)
        if is_option:
            out["asset_class"] = "option"
        try:
            out["raw"] = o.model_dump(mode="json") if hasattr(o, "model_dump") else dict(o)
        except Exception:
            out["raw"] = {"id": out.get("id")}
        return out
    except Exception as exc:
        logger.warning("place_order failed (%s) — returning mock ack.", exc)
        ack = _mock_order_ack(payload, error=str(exc))
        ack["raw"] = {"mock": True, "error": str(exc)}
        return ack


def cancel_order(order_id: str) -> dict[str, Any]:
    client = _get_trading()
    if client is None:
        return {"id": order_id, "status": "canceled"}
    try:
        client.cancel_order_by_id(order_id)
        return {"id": order_id, "status": "canceled"}
    except Exception as exc:
        logger.warning("cancel_order failed (%s).", exc)
        return {"id": order_id, "status": "canceled", "error": str(exc)}


def cancel_all_orders() -> dict[str, Any]:
    client = _get_trading()
    if client is None:
        return {"cancelled": len(mock.mock_orders("open"))}
    try:
        responses = client.cancel_orders()
        return {"cancelled": len(responses) if responses else 0}
    except Exception as exc:
        logger.warning("cancel_all_orders failed (%s).", exc)
        return {"cancelled": 0, "error": str(exc)}


def get_clock() -> dict[str, Any]:
    client = _get_trading()
    if client is None:
        return mock.mock_clock()
    try:
        c = client.get_clock()
        return {
            "is_open": bool(c.is_open),
            "next_open": c.next_open.isoformat() if c.next_open else None,
            "next_close": c.next_close.isoformat() if c.next_close else None,
            "timestamp": c.timestamp.isoformat() if c.timestamp else mock.now_iso(),
        }
    except Exception as exc:
        logger.warning("get_clock failed (%s) — returning mock.", exc)
        return mock.mock_clock()


def market_open() -> bool:
    return bool(get_clock().get("is_open"))


def get_calendar(start: str | None, end: str | None) -> list[dict[str, Any]]:
    client = _get_trading()
    if client is None:
        return mock.mock_calendar(start, end)
    try:
        kwargs = {}
        if start:
            kwargs["start"] = datetime.fromisoformat(start).date()
        if end:
            kwargs["end"] = datetime.fromisoformat(end).date()
        req = GetCalendarRequest(**kwargs) if kwargs else None
        cal = client.get_calendar(filters=req) if req else client.get_calendar()
        return [
            {
                "date": str(d.date),
                "open": str(d.open),
                "close": str(d.close),
                "session_open": getattr(d, "session_open", None) and str(d.session_open),
                "session_close": getattr(d, "session_close", None) and str(d.session_close),
            }
            for d in cal
        ]
    except Exception as exc:
        logger.warning("get_calendar failed (%s) — returning mock.", exc)
        return mock.mock_calendar(start, end)


# ---- Assets -----------------------------------------------------------------
def search_assets(search: str, limit: int) -> list[dict[str, Any]]:
    client = _get_trading()
    if client is None:
        return mock.mock_assets(search, limit)
    try:
        req = GetAssetsRequest(status=AssetStatus.ACTIVE, asset_class=AssetClass.US_EQUITY)
        assets = client.get_all_assets(req)
        q = (search or "").upper()
        out = []
        for a in assets:
            if q and q not in a.symbol.upper() and q not in (a.name or "").upper():
                continue
            out.append({
                "symbol": a.symbol,
                "name": a.name or a.symbol,
                "exchange": str(a.exchange.value if hasattr(a.exchange, "value") else a.exchange),
                "asset_class": str(a.asset_class.value if hasattr(a.asset_class, "value") else a.asset_class),
                "tradable": bool(a.tradable),
            })
            if len(out) >= limit:
                break
        return out or mock.mock_assets(search, limit)
    except Exception as exc:
        logger.warning("search_assets failed (%s) — returning mock.", exc)
        return mock.mock_assets(search, limit)


# ---- Market data ------------------------------------------------------------
def get_bars(symbol: str, timeframe: str, limit: int) -> list[dict[str, Any]]:
    client = _get_data()
    if client is None:
        return mock.mock_bars(symbol, timeframe, limit)
    try:
        start = datetime.now(timezone.utc) - timedelta(days=400)
        req = StockBarsRequest(
            symbol_or_symbols=symbol,
            timeframe=_tf(timeframe),
            start=start,
            limit=limit,
            feed=DataFeed.IEX,
        )
        resp = client.get_stock_bars(req)
        bars = resp.data.get(symbol, []) if hasattr(resp, "data") else []
        out = [
            {
                "t": b.timestamp.isoformat(),
                "o": float(b.open), "h": float(b.high), "l": float(b.low),
                "c": float(b.close), "v": int(b.volume),
            }
            for b in bars
        ]
        return out[-limit:] if out else mock.mock_bars(symbol, timeframe, limit)
    except Exception as exc:
        logger.warning("get_bars failed for %s (%s) — returning mock.", symbol, exc)
        return mock.mock_bars(symbol, timeframe, limit)


def get_quote(symbol: str) -> dict[str, Any]:
    client = _get_data()
    if client is None:
        return mock.mock_quote(symbol)
    try:
        req = StockLatestQuoteRequest(symbol_or_symbols=symbol, feed=DataFeed.IEX)
        resp = client.get_stock_latest_quote(req)
        q = resp[symbol]
        return {
            "symbol": symbol,
            "bid": float(q.bid_price),
            "ask": float(q.ask_price),
            "bid_size": int(q.bid_size),
            "ask_size": int(q.ask_size),
            "last": round((float(q.bid_price) + float(q.ask_price)) / 2, 2),
            "timestamp": q.timestamp.isoformat() if q.timestamp else mock.now_iso(),
        }
    except Exception as exc:
        logger.warning("get_quote failed for %s (%s) — returning mock.", symbol, exc)
        return mock.mock_quote(symbol)


def _snapshot_obj_to_dict(symbol: str, snap) -> dict[str, Any]:
    daily = snap.daily_bar
    prev = snap.previous_daily_bar
    price = float(snap.latest_trade.price) if snap.latest_trade else (
        float(daily.close) if daily else 0.0
    )
    prev_close = float(prev.close) if prev else (float(daily.open) if daily else price)
    change = price - prev_close
    return {
        "symbol": symbol,
        "price": round(price, 2),
        "change": round(change, 2),
        "change_pct": round((change / prev_close * 100) if prev_close else 0.0, 4),
        "volume": int(daily.volume) if daily else 0,
        "high": float(daily.high) if daily else price,
        "low": float(daily.low) if daily else price,
        "open": float(daily.open) if daily else price,
        "prev_close": round(prev_close, 2),
    }


def get_snapshot(symbol: str) -> dict[str, Any]:
    client = _get_data()
    if client is None:
        return mock.mock_snapshot(symbol)
    try:
        req = StockSnapshotRequest(symbol_or_symbols=symbol, feed=DataFeed.IEX)
        resp = client.get_stock_snapshot(req)
        snap = resp[symbol]
        return _snapshot_obj_to_dict(symbol, snap)
    except Exception as exc:
        logger.warning("get_snapshot failed for %s (%s) — returning mock.", symbol, exc)
        return mock.mock_snapshot(symbol)


def get_snapshots(symbols: list[str]) -> dict[str, Any]:
    client = _get_data()
    if client is None:
        return {s: mock.mock_snapshot(s) for s in symbols}
    try:
        req = StockSnapshotRequest(symbol_or_symbols=symbols, feed=DataFeed.IEX)
        resp = client.get_stock_snapshot(req)
        out: dict[str, Any] = {}
        for s in symbols:
            snap = resp.get(s) if hasattr(resp, "get") else resp[s]
            out[s] = _snapshot_obj_to_dict(s, snap) if snap else mock.mock_snapshot(s)
        return out
    except Exception as exc:
        logger.warning("get_snapshots failed (%s) — returning mock.", exc)
        return {s: mock.mock_snapshot(s) for s in symbols}


# ---- News -------------------------------------------------------------------
def get_news(symbols: list[str], limit: int) -> list[dict[str, Any]]:
    client = _get_news()
    if client is None:
        return mock.mock_news(symbols, limit)
    try:
        req = NewsRequest(symbols=",".join(symbols) if symbols else None, limit=limit)
        resp = client.get_news(req)
        items = resp.data.get("news", []) if hasattr(resp, "data") else []
        out = []
        for n in items:
            images = getattr(n, "images", None) or []
            img = images[0].url if images and hasattr(images[0], "url") else (
                images[0].get("url") if images and isinstance(images[0], dict) else None
            )
            out.append({
                "id": str(n.id),
                "headline": n.headline,
                "summary": n.summary or "",
                "source": n.source,
                "author": n.author,
                "url": n.url,
                "created_at": n.created_at.isoformat() if n.created_at else mock.now_iso(),
                "symbols": list(n.symbols) if n.symbols else [],
                "image": img,
            })
        return out or mock.mock_news(symbols, limit)
    except Exception as exc:
        logger.warning("get_news failed (%s) — returning mock.", exc)
        return mock.mock_news(symbols, limit)


# ---- Options ----------------------------------------------------------------
def get_option_expirations(symbol: str) -> list[str]:
    # Alpaca options availability varies; default to realistic mock chains.
    return mock.mock_expirations(symbol)


def get_option_chain(symbol: str, expiration: str | None, opt_type: str) -> list[dict[str, Any]]:
    return mock.mock_option_chain(symbol, expiration, opt_type)


def get_option_flow(symbol: str, period: str) -> dict[str, Any]:
    return mock.mock_option_flow(symbol, period)
