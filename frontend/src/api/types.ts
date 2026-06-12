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
export type TradeSource = 'manual' | 'strategy' | 'ai';

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

export interface WSMessage {
  type: 'quote' | 'news' | 'signal';
  [key: string]: unknown;
}

export interface QuoteUpdate {
  type: 'quote';
  symbol: string;
  price: number;
  change?: number;
  change_pct?: number;
}
