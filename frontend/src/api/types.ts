// Backend contract types. Shapes mirror the API exactly.

export interface Health {
  status: string;
  alpaca_connected: boolean;
  anthropic_configured: boolean;
  paper: boolean;
  market_open: boolean;
  research_provider?: string;
  research_model?: string;
  ollama_connected?: boolean;
}

export interface Account {
  equity: number;
  buying_power: number;
  cash: number;
  portfolio_value: number;
  last_equity: number;
  day_pl: number;
  day_pl_pct: number;
  daytrade_count: number;
  status: string;
}

export interface Position {
  symbol: string;
  qty: number;
  side: string;
  avg_entry_price: number;
  current_price: number;
  market_value: number;
  unrealized_pl: number;
  unrealized_plpc: number;
  change_today: number;
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit';
export type TimeInForce = 'day' | 'gtc' | 'ioc' | 'fok' | 'opg' | 'cls';

export interface Order {
  id: string;
  symbol: string;
  qty: number;
  side: OrderSide;
  type: OrderType;
  time_in_force: TimeInForce;
  status: string;
  limit_price: number | null;
  stop_price: number | null;
  filled_avg_price: number | null;
  filled_qty: number;
  submitted_at: string;
}

export interface NewOrder {
  symbol: string;
  qty: number;
  side: OrderSide;
  type: OrderType;
  time_in_force: TimeInForce;
  limit_price?: number;
  stop_price?: number;
  take_profit?: number;
  stop_loss?: number;
  /** Deliberate override: skip the risk-engine veto for this one order. */
  bypass_risk?: boolean;
}

export interface Clock {
  is_open: boolean;
  next_open: string;
  next_close: string;
  timestamp: string;
}

export interface Asset {
  symbol: string;
  name: string;
  exchange: string;
  asset_class: string;
  tradable: boolean;
}

export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Snapshot {
  price: number;
  change: number;
  change_pct: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  prev_close: number;
}

export type SnapshotMap = Record<string, Snapshot>;

export interface NewsItem {
  id: string | number;
  headline: string;
  summary: string;
  source: string;
  author: string;
  url: string;
  created_at: string;
  symbols: string[];
  image: string;
}

export interface OptionExpiration {
  date: string;
  type: 'weekly' | 'monthly';
}

export interface OptionContract {
  symbol: string;
  strike: number;
  type: 'call' | 'put';
  expiration: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  open_interest: number;
  implied_volatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface FlowStrike {
  strike: number;
  volume: number;
  open_interest: number;
  premium: number;
  iv: number;
}

export interface UnusualActivity {
  strike: number;
  type: 'call' | 'put';
  volume: number;
  oi: number;
  vol_oi_ratio: number;
  premium: number;
}

export interface OptionsFlow {
  expiration: string;
  calls: FlowStrike[];
  puts: FlowStrike[];
  put_call_ratio: number;
  total_call_volume: number;
  total_put_volume: number;
  unusual: UnusualActivity[];
}

export interface Indicators {
  sma20: number;
  sma50: number;
  sma200: number;
  ema9: number;
  ema21: number;
  rsi14: number;
  macd: { macd: number; signal: number; hist: number };
  bbands: { upper: number; mid: number; lower: number };
  atr14: number;
  vwap: number;
  adx14: number;
  stoch: { k: number; d: number };
  obv: number;
  volume: number;
  avg_volume20: number;
}

export interface IndicatorCatalogItem {
  id: string;
  name: string;
  params: Record<string, unknown>;
  description: string;
}

export type StrategyMode = 'signal' | 'semi' | 'auto';
export type RuleJoin = 'AND' | 'OR';

// ---- Bot / Strategy action (asset + contract selection) ------------------

export type ActionAsset = 'option' | 'equity';
export type ActionRight = 'call' | 'put' | 'auto';
export type ActionMoneyness = 'ATM' | 'OTM' | 'ITM';

export interface BotAction {
  asset: ActionAsset;
  right: ActionRight;
  moneyness: ActionMoneyness;
  otm_strikes: number;
  expiry: 'nearest_weekly' | string;
  contract_symbol: string | null;
}

export function blankAction(): BotAction {
  return {
    asset: 'option',
    right: 'auto',
    moneyness: 'ATM',
    otm_strikes: 0,
    expiry: 'nearest_weekly',
    contract_symbol: null,
  };
}

// ---- Live options contract picker (/api/options/select) ------------------

export interface SelectableContract {
  occ_symbol: string;
  strike: number;
  right: 'call' | 'put';
  expiration: string;
  bid: number;
  ask: number;
  mid: number;
  last: number;
  implied_volatility: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  open_interest: number;
  volume: number;
  moneyness: ActionMoneyness;
  distance_pct: number;
}

export interface OptionsSelectResponse {
  symbol: string;
  underlying_price: number;
  expiration: string;
  right: 'call' | 'put';
  contracts: SelectableContract[];
}

export interface StrategyRule {
  indicator: string;
  operator: string;
  value: string | number;
  join: RuleJoin;
}

export interface Strategy {
  id: string;
  name: string;
  symbols: string[];
  timeframe: string;
  rules: StrategyRule[];
  ai_gate: { enabled: boolean; min_conviction: number };
  exits: {
    stop_type: string;
    stop_value: number;
    target_type: string;
    target_value: number;
    trailing: boolean;
  };
  sizing: {
    risk_per_trade_pct: number;
    max_position_pct: number;
    max_positions: number;
  };
  action?: BotAction;
  mode: StrategyMode;
  enabled: boolean;
}

export interface SignalEvalResult {
  fired: boolean;
  matched: { indicator: string; operator: string; value: string | number; result: boolean }[];
  snapshot: Record<string, number>;
}

export interface ResearchReport {
  symbol: string;
  thesis: string;
  sentiment_score: number;
  conviction: number;
  key_risks: string[];
  suggested_action: string;
  suggested_stop: number;
  suggested_target: number;
  regime: string;
  bear_case: string;
  generated_at: string;
  model: string;
}

export interface BriefingItem {
  symbol: string;
  note: string;
  sentiment: number;
}

export interface Briefing {
  generated_at: string;
  summary: string;
  items: BriefingItem[];
  regime: string;
}

export interface Regime {
  regime: string;
  vix_proxy: number;
  breadth: number;
  note: string;
}

export type AssetClass = 'us_equity' | 'option';
export type TradeSource = 'manual' | 'strategy' | 'ai' | 'bot';

// Full persisted trade ledger row from MySQL.
export interface Trade {
  id: number | string;
  alpaca_order_id: string | null;
  client_order_id: string | null;
  symbol: string;
  asset_class: AssetClass;
  side: OrderSide;
  qty: number;
  order_type: string;
  order_class: string | null;
  time_in_force: string;
  limit_price: number | null;
  stop_price: number | null;
  take_profit: number | null;
  stop_loss: number | null;
  status: string;
  filled_qty: number;
  filled_avg_price: number | null;
  submitted_at: string | null;
  filled_at: string | null;
  source: TradeSource;
  strategy_id: string | null;
  created_at: string;
  updated_at: string;
}

export type TradeStatusFilter = 'all' | 'open' | 'filled' | 'canceled';

export interface ResearchHistoryItem {
  id: number | string;
  symbol: string;
  thesis: string;
  sentiment_score: number;
  conviction: number;
  key_risks: string[];
  suggested_action: string;
  suggested_stop: number;
  suggested_target: number;
  regime: string;
  bear_case: string;
  provider: string;
  model: string;
  generated_at: string;
}

// ---- Research worker / feed / deep-dive ----------------------------------

export type ResearchProvider = 'gemma' | 'kimi';
export type ResearchDepth = 'quick' | 'standard' | 'deep';

export interface ResearchWorker {
  enabled: boolean;
  provider: ResearchProvider;
  depth: ResearchDepth;
  interval_sec: number;
  universe: string[];
  running: boolean;
  last_run: string | null;
  count_today: number;
  cycles: number;
}

export interface RunOnceResult {
  ran: boolean;
  count: number;
}

export type ResearchFeedSource = 'analysis' | 'deep' | 'earnings' | 'market' | 'briefing';

export interface ResearchFeedItem {
  id: number | string;
  source: ResearchFeedSource;
  symbol: string;
  title: string;
  summary: string;
  conviction?: number;
  sentiment_score?: number;
  regime?: string;
  provider: string;
  model: string;
  created_at: string;
}

export interface ResearchDeepDoc {
  id: number | string;
  symbol: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  provider: string;
  model: string;
  created_at: string;
}

export interface SignalHistoryItem {
  id: number | string;
  strategy_id: string;
  symbol: string;
  timeframe: string;
  fired: boolean;
  matched: { indicator: string; operator: string; value: string | number; result: boolean }[];
  snapshot: Record<string, number>;
  created_at: string;
}

export type Timeframe = '1Min' | '5Min' | '15Min' | '1Hour' | '1Day';

// ---- Risk Engine ---------------------------------------------------------

export interface RiskLimits {
  max_position_pct: number;
  max_open_positions: number;
  max_daily_loss_pct: number;
  max_per_trade_risk_pct: number;
  max_concentration_pct: number;
  min_price: number;
  default_risk_per_trade_pct: number;
  skip_first_minutes: number;
  kill_switch_engaged: boolean;
  // Failsafes
  trading_enabled?: boolean;
  max_orders_per_day?: number;
}

export interface RiskUtilization {
  position_slots_used_pct: number;
  buying_power_used_pct: number;
  daily_loss_used_pct: number;
}

export interface RiskStatus {
  equity: number;
  buying_power: number;
  day_pl: number;
  day_pl_pct: number;
  open_positions: number;
  max_open_positions: number;
  open_risk: number;
  open_risk_pct: number;
  circuit_breaker_tripped: boolean;
  kill_switch_engaged: boolean;
  utilization: RiskUtilization;
  limits: RiskLimits;
}

export interface RiskRuleHit {
  rule: string;
  message: string;
}

export interface RiskCheckResult {
  approved: boolean;
  decision: string;
  vetoes: RiskRuleHit[];
  warnings: RiskRuleHit[];
  computed: Record<string, number | string | boolean>;
}

export interface RiskSizeResult {
  qty: number;
  risk_amount: number;
  position_value: number;
}

export interface KillSwitchResult {
  kill_switch_engaged: boolean;
  cancelled?: number;
}

export type RiskDecision = 'approved' | 'vetoed' | 'warned';
export type RiskRuleKind = 'veto' | 'warning' | 'info';

export interface RiskEventRule {
  rule: string;
  message: string;
  kind: RiskRuleKind;
}

export interface RiskEvent {
  id: number | string;
  symbol: string;
  side: OrderSide;
  qty: number;
  order_type: string;
  decision: RiskDecision;
  rules: RiskEventRule[];
  computed: Record<string, number | string | boolean>;
  source: string;
  created_at: string;
}

// ---- Weekly-options Bots -------------------------------------------------

export type BotMode = 'signal' | 'semi' | 'auto';
export type BotDirection = 'research' | 'momentum';
export type BotSide = 'auto' | 'call' | 'put';
export type BotStrike = 'ATM' | 'delta';
export type OptionRight = 'call' | 'put';

export interface BotConfig {
  direction: BotDirection;
  side: BotSide;
  expiry: 'nearest_weekly';
  strike: BotStrike;
  target_delta: number;
  contracts: number;
  max_premium: number;
}

export interface BotRule {
  indicator: string;
  operator: string;
  value: string | number;
  join: RuleJoin;
}

export interface Bot {
  id: string;
  name: string;
  enabled: boolean;
  symbols: string[];
  kind: 'options_weekly';
  config: BotConfig;
  rules: BotRule[];
  ai_gate: { enabled: boolean; min_conviction: number };
  risk: { risk_per_trade_pct: number };
  action?: BotAction;
  mode: BotMode;
  created_at: string;
  updated_at: string;
}

export interface ProposalRiskDecision {
  approved: boolean;
  decision: string;
  vetoes?: { rule: string; message: string }[];
  warnings?: { rule: string; message: string }[];
}

export interface Proposal {
  symbol: string;
  occ_symbol: string;
  right: OptionRight;
  strike: number;
  expiration: string;
  mid_price: number;
  est_premium: number;
  qty: number;
  conviction: number;
  sentiment: number;
  rationale: string;
  risk_decision: ProposalRiskDecision;
}

// ---- Richer evaluate/run proposal shape (new backend contract) -----------
// The backend now returns a per-symbol decision breakdown. Older fields above
// may still be present; treat everything optional and degrade gracefully.

export interface ProposalTrigger {
  indicator: string;
  operator: string;
  value: string | number;
  actual: number | string | null;
  passed: boolean;
}

export interface ProposalAiGate {
  enabled: boolean;
  conviction: number;
  min_conviction: number;
  sentiment?: number;
  passed: boolean;
}

export interface ProposalDirection {
  right: 'call' | 'put' | 'skip';
  rationale: string;
}

export interface ProposalContract {
  occ_symbol: string;
  strike: number;
  expiration: string;
  mid: number;
  delta?: number;
  [key: string]: unknown;
}

export interface ProposalRisk {
  approved: boolean;
  decision: string;
  vetoes?: { rule: string; message: string }[];
  warnings?: { rule: string; message: string }[];
}

// A single evaluation item. Combines the legacy Proposal fields (optional) with
// the new structured breakdown (also optional). evaluate/run may return either.
export interface EvalItem {
  symbol: string;
  // new structured fields
  firing?: boolean;
  reason?: string;
  triggers?: ProposalTrigger[];
  trigger_result?: boolean;
  ai_gate?: ProposalAiGate;
  direction?: ProposalDirection;
  contract?: ProposalContract | null;
  risk?: ProposalRisk;
  // legacy fields (older simpler shape)
  occ_symbol?: string;
  right?: OptionRight;
  strike?: number;
  expiration?: string;
  mid_price?: number;
  est_premium?: number;
  qty?: number;
  conviction?: number;
  sentiment?: number;
  rationale?: string;
  risk_decision?: ProposalRiskDecision;
}

// Full evaluate/run response. Top level may carry mode/note/placed/recorded.
export interface EvalResult {
  proposals: EvalItem[];
  mode?: BotMode;
  note?: string;
  placed?: unknown[];
  recorded_signals?: number;
}

// /evaluate and /run may return { proposals, ... } or a bare array — handle both.
export type ProposalsResponse = EvalResult | EvalItem[] | { proposals: Proposal[] } | Proposal[];

// ---- Bot live status -----------------------------------------------------

export interface BotStatus {
  bot: Bot;
  last_evaluated_at: string | null;
  last_result: EvalResult | null;
  mode: BotMode;
  enabled: boolean;
}

// ---- AI ("Build with AI" / Kimi) -----------------------------------------

export interface BotFromPromptResponse {
  draft: Partial<Bot>;
  explanation: string;
}

// ---- DB Chat (Vanna-style natural-language → SQL) ------------------------

export interface ChatMessageTurn {
  role: string;
  content: string;
}

export interface ChatResponse {
  answer: string;
  sql?: string;
  rows?: Record<string, unknown>[];
  columns?: string[];
  mode: 'sql' | 'chat';
  error?: string;
}

export interface ChatSchemaColumn {
  name: string;
  type: string;
}

export interface ChatSchemaTable {
  table: string;
  columns: ChatSchemaColumn[];
}

// Backend may return { tables: [...] } or a bare list — handle both.
export type ChatSchemaResponse = { tables: ChatSchemaTable[] } | ChatSchemaTable[];

export interface ChatHistoryMessage {
  role: string;
  content: string;
  created_at?: string;
}

// ---- Backtest ------------------------------------------------------------

export type BacktestLookback = '1D' | '2D' | '1W' | '1M' | '3M';

export interface BacktestRequest {
  bot_id?: string;
  strategy_id?: string;
  symbol?: string;
  symbols?: string[];
  timeframe?: string;
  lookback: BacktestLookback;
  rules?: unknown[];
  action?: unknown;
  ai_gate?: unknown;
  /** Starting account cash for the dollar simulation (default 10,000). */
  account_size?: number;
  /** Cash deployed per trade — the "max bet" per setup (default 10% of account). */
  cash_per_trade?: number;
  /** Per-side slippage in basis points. */
  slippage_bps?: number;
  /** Flat commission per round-trip trade ($). */
  commission?: number;
}

export interface BacktestMetrics {
  total_return_pct: number;
  win_rate: number;
  num_trades: number;
  wins: number;
  losses: number;
  profit_factor: number;
  max_drawdown_pct: number;
  avg_win_pct: number;
  avg_loss_pct: number;
  // Dollar simulation (present on newer backend; optional for safety).
  starting_equity?: number;
  ending_equity?: number;
  total_pnl_dollars?: number;
  total_traded_dollars?: number;
  avg_win_dollars?: number;
  avg_loss_dollars?: number;
  sharpe?: number;
  sortino?: number;
  expectancy_dollars?: number;
}

export interface BacktestEquityPoint {
  t: string;
  equity: number;
}

export interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  right?: 'call' | 'put';
  entry_time: string;
  entry_price: number;
  exit_time: string;
  exit_price: number;
  pnl_pct: number;
  cash_deployed?: number;
  pnl_dollars?: number;
  exit_reason: string;
}

export interface BacktestPerSymbol {
  symbol: string;
  metrics: BacktestMetrics;
  equity_curve: BacktestEquityPoint[];
  trades: BacktestTrade[];
}

export interface Backtest {
  config_name: string;
  timeframe: string;
  lookback: BacktestLookback;
  start: string;
  end: string;
  account_size?: number;
  cash_per_trade?: number;
  slippage_bps?: number;
  commission?: number;
  combined: BacktestMetrics;
  per_symbol: BacktestPerSymbol[];
  note?: string;
}

export interface BotPerformance {
  bot_id: string;
  name: string;
  enabled: boolean;
  mode: BotMode;
  orders: number;
  filled: number;
  fill_rate: number;
  deployed: number;
  filled_notional: number;
  last_at: string | null;
}

export interface BotWorkerStatus {
  enabled: boolean;
  interval_sec: number;
  running: boolean;
  market_open: boolean;
  ticks: number;
  orders_placed: number;
  last_tick: string | null;
  last_note: string | null;
}

export interface PortfolioPoint {
  t: number; // unix seconds
  equity: number;
  pnl: number;
  pnl_pct: number;
}

export interface PortfolioHistory {
  period: string;
  timeframe: string;
  base_value: number;
  end_equity: number;
  total_pl: number;
  total_pl_pct: number;
  points: PortfolioPoint[];
}

export interface WSMessage {
  type: 'quote' | 'news' | 'signal' | 'notification' | 'status';
  [key: string]: unknown;
}

export interface QuoteUpdate {
  type: 'quote';
  symbol: string;
  price: number;
  change?: number;
  change_pct?: number;
}
