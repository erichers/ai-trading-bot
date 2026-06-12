"""MySQL persistence via SQLAlchemy 2.0 ORM.

Stores watchlist, strategies, settings, trades, research analyses, signals, and
briefings. JSON columns hold nested structures (MySQL 8 native JSON).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    Integer,
    String,
    Text,
    create_engine,
    func,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

from config import logger, settings

# ---- Engine / session -------------------------------------------------------
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_recycle=3600,
    future=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)

DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _uid() -> str:
    return str(uuid.uuid4())


class Base(DeclarativeBase):
    pass


# ---- Tables -----------------------------------------------------------------
class Watchlist(Base):
    __tablename__ = "watchlist"
    symbol: Mapped[str] = mapped_column(String(20), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Strategy(Base):
    __tablename__ = "strategies"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    symbols: Mapped[Any] = mapped_column(JSON, default=list)
    timeframe: Mapped[str] = mapped_column(String(16), default="1Day")
    rules: Mapped[Any] = mapped_column(JSON, default=list)
    ai_gate: Mapped[Any] = mapped_column(JSON, default=dict)
    exits: Mapped[Any] = mapped_column(JSON, default=dict)
    sizing: Mapped[Any] = mapped_column(JSON, default=dict)
    mode: Mapped[str] = mapped_column(String(16), default="signal")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "symbols": self.symbols or [],
            "timeframe": self.timeframe,
            "rules": self.rules or [],
            "ai_gate": self.ai_gate or {},
            "exits": self.exits or {},
            "sizing": self.sizing or {},
            "mode": self.mode,
            "enabled": self.enabled,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class Setting(Base):
    __tablename__ = "settings"
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


class Trade(Base):
    __tablename__ = "trades"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    alpaca_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True, index=True)
    client_order_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    asset_class: Mapped[str] = mapped_column(String(16), default="us_equity")
    side: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    qty: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    order_type: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    order_class: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    time_in_force: Mapped[Optional[str]] = mapped_column(String(8), nullable=True)
    limit_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    stop_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    take_profit: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    stop_loss: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    status: Mapped[Optional[str]] = mapped_column(String(32), nullable=True, index=True)
    filled_qty: Mapped[Optional[float]] = mapped_column(Float, default=0.0)
    filled_avg_price: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    submitted_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    filled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    source: Mapped[str] = mapped_column(String(16), default="manual")
    strategy_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    raw: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "alpaca_order_id": self.alpaca_order_id,
            "client_order_id": self.client_order_id,
            "symbol": self.symbol,
            "asset_class": self.asset_class,
            "side": self.side,
            "qty": self.qty,
            "order_type": self.order_type,
            "order_class": self.order_class,
            "time_in_force": self.time_in_force,
            "limit_price": self.limit_price,
            "stop_price": self.stop_price,
            "take_profit": self.take_profit,
            "stop_loss": self.stop_loss,
            "status": self.status,
            "filled_qty": self.filled_qty,
            "filled_avg_price": self.filled_avg_price,
            "submitted_at": self.submitted_at.isoformat() if self.submitted_at else None,
            "filled_at": self.filled_at.isoformat() if self.filled_at else None,
            "source": self.source,
            "strategy_id": self.strategy_id,
            "raw": self.raw,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class ResearchAnalysis(Base):
    __tablename__ = "research_analyses"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    thesis: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    sentiment_score: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    conviction: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    key_risks: Mapped[Any] = mapped_column(JSON, nullable=True)
    suggested_action: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    suggested_stop: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    suggested_target: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    regime: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    bear_case: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    provider: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    model: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    raw: Mapped[Any] = mapped_column(JSON, nullable=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "thesis": self.thesis,
            "sentiment_score": self.sentiment_score,
            "conviction": self.conviction,
            "key_risks": self.key_risks or [],
            "suggested_action": self.suggested_action,
            "suggested_stop": self.suggested_stop,
            "suggested_target": self.suggested_target,
            "regime": self.regime,
            "bear_case": self.bear_case,
            "provider": self.provider,
            "model": self.model,
            "generated_at": self.generated_at.isoformat() if self.generated_at else None,
        }


class Signal(Base):
    __tablename__ = "signals"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    strategy_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    symbol: Mapped[str] = mapped_column(String(32), index=True)
    timeframe: Mapped[Optional[str]] = mapped_column(String(16), nullable=True)
    fired: Mapped[bool] = mapped_column(Boolean, default=False)
    matched: Mapped[Any] = mapped_column(JSON, nullable=True)
    snapshot: Mapped[Any] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "strategy_id": self.strategy_id,
            "symbol": self.symbol,
            "timeframe": self.timeframe,
            "fired": self.fired,
            "matched": self.matched or [],
            "snapshot": self.snapshot or {},
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class Briefing(Base):
    __tablename__ = "briefings"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    items: Mapped[Any] = mapped_column(JSON, nullable=True)
    regime: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=_now)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "summary": self.summary,
            "items": self.items or [],
            "regime": self.regime,
            "generated_at": self.generated_at.isoformat() if self.generated_at else None,
        }


# ---- Init -------------------------------------------------------------------
def init_db() -> None:
    Base.metadata.create_all(engine)
    with SessionLocal() as s:
        count = s.scalar(select(func.count()).select_from(Watchlist))
        if not count:
            for sym in DEFAULT_WATCHLIST:
                s.add(Watchlist(symbol=sym, added_at=_now()))
            s.commit()
            logger.info("Seeded default watchlist (%d symbols).", len(DEFAULT_WATCHLIST))


def _parse_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt
    except Exception:
        return None


# ---- Watchlist --------------------------------------------------------------
def get_watchlist() -> list[str]:
    with SessionLocal() as s:
        rows = s.scalars(select(Watchlist).order_by(Watchlist.added_at.asc())).all()
        return [r.symbol for r in rows]


def add_watchlist(symbol: str) -> list[str]:
    symbol = symbol.strip().upper()
    with SessionLocal() as s:
        if not s.get(Watchlist, symbol):
            s.add(Watchlist(symbol=symbol, added_at=_now()))
            s.commit()
    return get_watchlist()


def remove_watchlist(symbol: str) -> list[str]:
    symbol = symbol.strip().upper()
    with SessionLocal() as s:
        obj = s.get(Watchlist, symbol)
        if obj:
            s.delete(obj)
            s.commit()
    return get_watchlist()


# ---- Strategies -------------------------------------------------------------
def list_strategies() -> list[dict[str, Any]]:
    with SessionLocal() as s:
        rows = s.scalars(select(Strategy).order_by(Strategy.updated_at.desc())).all()
        return [r.to_dict() for r in rows]


def get_strategy(strategy_id: str) -> dict[str, Any] | None:
    with SessionLocal() as s:
        obj = s.get(Strategy, strategy_id)
        return obj.to_dict() if obj else None


def create_strategy(strategy: dict[str, Any]) -> dict[str, Any]:
    strategy = dict(strategy)
    sid = strategy.get("id") or _uid()
    with SessionLocal() as s:
        obj = Strategy(
            id=sid,
            name=strategy.get("name", ""),
            symbols=strategy.get("symbols", []),
            timeframe=strategy.get("timeframe", "1Day"),
            rules=strategy.get("rules", []),
            ai_gate=strategy.get("ai_gate", {}),
            exits=strategy.get("exits", {}),
            sizing=strategy.get("sizing", {}),
            mode=strategy.get("mode", "signal"),
            enabled=strategy.get("enabled", True),
        )
        s.add(obj)
        s.commit()
        return obj.to_dict()


def update_strategy(strategy_id: str, strategy: dict[str, Any]) -> dict[str, Any] | None:
    with SessionLocal() as s:
        obj = s.get(Strategy, strategy_id)
        if obj is None:
            return None
        for field in ("name", "symbols", "timeframe", "rules", "ai_gate",
                      "exits", "sizing", "mode", "enabled"):
            if field in strategy and strategy[field] is not None:
                setattr(obj, field, strategy[field])
        s.commit()
        return obj.to_dict()


def delete_strategy(strategy_id: str) -> bool:
    with SessionLocal() as s:
        obj = s.get(Strategy, strategy_id)
        if obj is None:
            return False
        s.delete(obj)
        s.commit()
        return True


# ---- Settings ---------------------------------------------------------------
def get_setting(key: str) -> Any:
    with SessionLocal() as s:
        obj = s.get(Setting, key)
        return obj.value if obj else None


def set_setting(key: str, value: Any) -> None:
    with SessionLocal() as s:
        obj = s.get(Setting, key)
        if obj:
            obj.value = value
        else:
            s.add(Setting(key=key, value=value))
        s.commit()


# ---- Trades -----------------------------------------------------------------
def insert_trade(data: dict[str, Any]) -> dict[str, Any]:
    """Insert a trade row from an order-placement payload + alpaca response."""
    with SessionLocal() as s:
        obj = Trade(
            alpaca_order_id=data.get("alpaca_order_id"),
            client_order_id=data.get("client_order_id"),
            symbol=(data.get("symbol") or "").upper(),
            asset_class=data.get("asset_class", "us_equity"),
            side=data.get("side"),
            qty=data.get("qty"),
            order_type=data.get("order_type"),
            order_class=data.get("order_class"),
            time_in_force=data.get("time_in_force"),
            limit_price=data.get("limit_price"),
            stop_price=data.get("stop_price"),
            take_profit=data.get("take_profit"),
            stop_loss=data.get("stop_loss"),
            status=data.get("status"),
            filled_qty=data.get("filled_qty") or 0.0,
            filled_avg_price=data.get("filled_avg_price"),
            submitted_at=_parse_dt(data.get("submitted_at")),
            filled_at=_parse_dt(data.get("filled_at")),
            source=data.get("source", "manual"),
            strategy_id=data.get("strategy_id"),
            raw=data.get("raw"),
        )
        s.add(obj)
        s.commit()
        return obj.to_dict()


def upsert_trade_from_alpaca(order: dict[str, Any], *, source: str = "manual",
                             strategy_id: str | None = None) -> dict[str, Any]:
    """Insert or update a trade row keyed on alpaca_order_id (from an order dict)."""
    aid = order.get("id") or order.get("alpaca_order_id")
    with SessionLocal() as s:
        obj = None
        if aid:
            obj = s.scalars(select(Trade).where(Trade.alpaca_order_id == str(aid))).first()
        if obj is None:
            obj = Trade(
                alpaca_order_id=str(aid) if aid else None,
                symbol=(order.get("symbol") or "").upper(),
                source=source,
                strategy_id=strategy_id,
                asset_class=order.get("asset_class", "us_equity"),
            )
            s.add(obj)
        # Update mutable fields from the latest Alpaca view.
        obj.symbol = (order.get("symbol") or obj.symbol or "").upper()
        if order.get("asset_class"):
            obj.asset_class = order["asset_class"]
        obj.side = order.get("side", obj.side)
        if order.get("qty") is not None:
            obj.qty = order["qty"]
        obj.order_type = order.get("type", obj.order_type)
        obj.time_in_force = order.get("time_in_force", obj.time_in_force)
        if order.get("limit_price") is not None:
            obj.limit_price = order["limit_price"]
        if order.get("stop_price") is not None:
            obj.stop_price = order["stop_price"]
        obj.status = order.get("status", obj.status)
        if order.get("filled_qty") is not None:
            obj.filled_qty = order["filled_qty"]
        if order.get("filled_avg_price") is not None:
            obj.filled_avg_price = order["filled_avg_price"]
        if order.get("submitted_at"):
            obj.submitted_at = _parse_dt(order["submitted_at"])
        if order.get("filled_at"):
            obj.filled_at = _parse_dt(order["filled_at"])
        s.commit()
        return obj.to_dict()


def list_trades(status: str | None = None, symbol: str | None = None,
                limit: int = 100) -> list[dict[str, Any]]:
    with SessionLocal() as s:
        stmt = select(Trade).order_by(Trade.id.desc())
        if status:
            stmt = stmt.where(Trade.status == status)
        if symbol:
            stmt = stmt.where(Trade.symbol == symbol.upper())
        stmt = stmt.limit(limit)
        return [r.to_dict() for r in s.scalars(stmt).all()]


# ---- Research ---------------------------------------------------------------
def insert_research(data: dict[str, Any]) -> dict[str, Any]:
    with SessionLocal() as s:
        obj = ResearchAnalysis(
            symbol=(data.get("symbol") or "").upper(),
            thesis=data.get("thesis"),
            sentiment_score=data.get("sentiment_score"),
            conviction=data.get("conviction"),
            key_risks=data.get("key_risks"),
            suggested_action=data.get("suggested_action"),
            suggested_stop=data.get("suggested_stop"),
            suggested_target=data.get("suggested_target"),
            regime=data.get("regime"),
            bear_case=data.get("bear_case"),
            provider=data.get("provider"),
            model=data.get("model"),
            raw=data.get("raw") or data,
            generated_at=_parse_dt(data.get("generated_at")) or _now(),
        )
        s.add(obj)
        s.commit()
        return obj.to_dict()


def list_research(symbol: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with SessionLocal() as s:
        stmt = select(ResearchAnalysis).order_by(ResearchAnalysis.id.desc())
        if symbol:
            stmt = stmt.where(ResearchAnalysis.symbol == symbol.upper())
        stmt = stmt.limit(limit)
        return [r.to_dict() for r in s.scalars(stmt).all()]


# ---- Signals ----------------------------------------------------------------
def insert_signal(data: dict[str, Any]) -> dict[str, Any]:
    with SessionLocal() as s:
        obj = Signal(
            strategy_id=data.get("strategy_id"),
            symbol=(data.get("symbol") or "").upper(),
            timeframe=data.get("timeframe"),
            fired=bool(data.get("fired")),
            matched=data.get("matched"),
            snapshot=data.get("snapshot"),
            created_at=_parse_dt(data.get("created_at")) or _now(),
        )
        s.add(obj)
        s.commit()
        return obj.to_dict()


def list_signals(symbol: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    with SessionLocal() as s:
        stmt = select(Signal).order_by(Signal.id.desc())
        if symbol:
            stmt = stmt.where(Signal.symbol == symbol.upper())
        stmt = stmt.limit(limit)
        return [r.to_dict() for r in s.scalars(stmt).all()]


# ---- Briefings --------------------------------------------------------------
def insert_briefing(data: dict[str, Any]) -> dict[str, Any]:
    with SessionLocal() as s:
        obj = Briefing(
            summary=data.get("summary"),
            items=data.get("items"),
            regime=data.get("regime"),
            generated_at=_parse_dt(data.get("generated_at")) or _now(),
        )
        s.add(obj)
        s.commit()
        return obj.to_dict()
