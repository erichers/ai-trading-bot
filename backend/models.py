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
    research_provider: str = "kimi"
    research_backup_provider: str = "ollama"
    research_model: str = "kimi-k2.5"
    kimi_configured: bool = False
    chat_provider: str = "ollama"
    ollama_connected: bool = False
    kill_switch_engaged: bool = False
    circuit_breaker_tripped: bool = False
    worker_enabled: bool = False
    worker_provider: str = "gemma"


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
    asset_class: Optional[Literal["us_equity", "option"]] = None
    source: Optional[Literal["manual", "strategy", "ai"]] = "manual"
    strategy_id: Optional[str] = None
    ref_price: Optional[float] = None  # reference price for market-order risk sizing
    bypass_risk: bool = False  # emergency override of the risk veto


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


class Action(BaseModel):
    """Shared action config for bots and strategies.

    For equity strategies the default is {asset:'equity', side:'buy'}. For option
    actions, set asset='option' and choose right/moneyness/expiry. When
    contract_symbol is set, that EXACT OCC contract is used. right='auto' decides
    from research (bullish->call, bearish->put)."""
    asset: Literal["equity", "option"] = "equity"
    side: Literal["buy", "sell"] = "buy"
    right: Literal["call", "put", "auto"] = "auto"
    moneyness: Literal["ATM", "OTM", "ITM"] = "ATM"
    otm_strikes: int = 1
    expiry: str = "nearest_weekly"
    contract_symbol: Optional[str] = None


class Strategy(BaseModel):
    id: Optional[str] = None
    name: str
    symbols: list[str] = Field(default_factory=list)
    timeframe: str = "1Day"
    rules: list[Rule] = Field(default_factory=list)
    ai_gate: AIGate = Field(default_factory=AIGate)
    exits: Exits = Field(default_factory=Exits)
    sizing: Sizing = Field(default_factory=Sizing)
    action: Optional[dict[str, Any]] = None
    mode: Literal["signal", "semi", "auto"] = "signal"
    enabled: bool = True


class AnalyzeRequest(BaseModel):
    symbol: str
    # On-demand analyze: provider None -> kimi-primary (quality, user-initiated).
    # Pass 'gemma'/'ollama' to force the free local model. 'kimi' forces cloud.
    provider: Optional[Literal["gemma", "ollama", "kimi"]] = None
    depth: Literal["quick", "standard", "deep"] = "standard"


# ---- Risk Engine ------------------------------------------------------------
class RiskLimits(BaseModel):
    max_position_pct: float = 20
    max_open_positions: int = 10
    max_daily_loss_pct: float = 5
    max_per_trade_risk_pct: float = 1
    max_concentration_pct: float = 25
    min_price: float = 1
    default_risk_per_trade_pct: float = 1
    skip_first_minutes: int = 5
    kill_switch_engaged: bool = False


class RiskLimitsUpdate(BaseModel):
    """Partial update — any omitted field is left unchanged."""
    max_position_pct: Optional[float] = None
    max_open_positions: Optional[int] = None
    max_daily_loss_pct: Optional[float] = None
    max_per_trade_risk_pct: Optional[float] = None
    max_concentration_pct: Optional[float] = None
    min_price: Optional[float] = None
    default_risk_per_trade_pct: Optional[float] = None
    skip_first_minutes: Optional[int] = None
    kill_switch_engaged: Optional[bool] = None


class RiskCheckRequest(BaseModel):
    symbol: str
    qty: float
    side: Literal["buy", "sell"] = "buy"
    type: Literal["market", "limit", "stop"] = "market"
    time_in_force: str = "day"
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    ref_price: Optional[float] = None
    source: Optional[str] = "manual"


class RiskSizeRequest(BaseModel):
    entry: float
    stop: float
    risk_per_trade_pct: Optional[float] = None


class KillSwitchRequest(BaseModel):
    engaged: bool
    flatten: bool = False
    close_positions: bool = False


# ---- Deep research / worker -------------------------------------------------
class DeepResearchRequest(BaseModel):
    symbol: str
    kind: Literal["deep", "earnings"] = "deep"


class ResearchWorkerUpdate(BaseModel):
    """Partial update of the background research worker config.

    The continuous worker defaults to provider='gemma' so 24/7 background runs
    are free (local) and never burn Kimi cloud credits.
    """
    enabled: Optional[bool] = None
    provider: Optional[Literal["gemma", "ollama", "kimi"]] = None
    depth: Optional[Literal["quick", "standard", "deep"]] = None
    interval_sec: Optional[int] = None
    universe: Optional[list[str]] = None


# ---- Bots -------------------------------------------------------------------
class BotConfig(BaseModel):
    direction: Literal["research", "momentum"] = "research"
    side: Literal["auto", "call", "put"] = "auto"
    expiry: str = "nearest_weekly"
    strike: Literal["ATM", "delta"] = "ATM"
    target_delta: float = 0.4
    contracts: int = 1
    max_premium: float = 1500


class BotAIGate(BaseModel):
    enabled: bool = True
    min_conviction: int = 60


class BotRisk(BaseModel):
    risk_per_trade_pct: float = 1.0


class BotCreate(BaseModel):
    name: str = "Bot"
    enabled: bool = True
    symbols: list[str] = Field(default_factory=lambda: ["QQQ", "SPY", "TSLA", "META", "NVDA"])
    kind: str = "options_weekly"
    config: BotConfig = Field(default_factory=BotConfig)
    rules: list[Rule] = Field(default_factory=list)
    ai_gate: BotAIGate = Field(default_factory=BotAIGate)
    risk: BotRisk = Field(default_factory=BotRisk)
    action: Optional[dict[str, Any]] = None
    mode: Literal["signal", "semi", "auto"] = "signal"


class BotUpdate(BaseModel):
    name: Optional[str] = None
    enabled: Optional[bool] = None
    symbols: Optional[list[str]] = None
    kind: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    rules: Optional[list[Any]] = None
    ai_gate: Optional[dict[str, Any]] = None
    risk: Optional[dict[str, Any]] = None
    action: Optional[dict[str, Any]] = None
    mode: Optional[Literal["signal", "semi", "auto"]] = None


class BotRunRequest(BaseModel):
    place: bool = False


# ---- Chat -------------------------------------------------------------------
class ChatTurn(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str
    history: Optional[list[ChatTurn]] = None
