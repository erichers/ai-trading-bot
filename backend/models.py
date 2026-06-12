"""Pydantic request/response models for typed endpoints."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str = "ok"
    alpaca_connected: bool
    anthropic_configured: bool
    paper: bool = True
    market_open: bool


class AccountResponse(BaseModel):
    equity: float
    buying_power: float
    cash: float
    portfolio_value: float
    last_equity: float
    day_pl: float
    day_pl_pct: float
    daytrade_count: int
    status: str


class OrderRequest(BaseModel):
    symbol: str
    qty: float
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop"] = "market"
    time_in_force: str = "day"
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    take_profit: Optional[float] = None
    stop_loss: Optional[float] = None


class WatchlistAdd(BaseModel):
    symbol: str


class Rule(BaseModel):
    indicator: str
    operator: str
    value: Any
    join: str = "AND"


class SignalEvaluateRequest(BaseModel):
    symbol: str
    timeframe: str = "1Day"
    rules: list[Rule] = Field(default_factory=list)


class AIGate(BaseModel):
    enabled: bool = False
    min_conviction: int = 60


class Exits(BaseModel):
    stop_type: str = "atr"
    stop_value: float = 2.0
    target_type: str = "rr"
    target_value: float = 2.0
    trailing: Optional[bool] = False


class Sizing(BaseModel):
    risk_per_trade_pct: float = 1.0
    max_position_pct: float = 10.0
    max_positions: int = 5


class Strategy(BaseModel):
    id: Optional[str] = None
    name: str
    symbols: list[str] = Field(default_factory=list)
    timeframe: str = "1Day"
    rules: list[Rule] = Field(default_factory=list)
    ai_gate: AIGate = Field(default_factory=AIGate)
    exits: Exits = Field(default_factory=Exits)
    sizing: Sizing = Field(default_factory=Sizing)
    mode: Literal["signal", "semi", "auto"] = "signal"
    enabled: bool = True


class AnalyzeRequest(BaseModel):
    symbol: str
