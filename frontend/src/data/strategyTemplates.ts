// Research-backed Strategy Library templates.
//
// IMPORTANT — indicator keys: the backend evaluates rules against a nested
// indicator snapshot and resolves keys by dot-path traversal (see
// backend-rs/src/signals.rs `resolve` and backtest.rs `indicator_path`). So
// nested indicators MUST use dot notation to fire in BOTH the live signal
// evaluator and the backtester:
//   macd.hist · macd.macd · macd.signal · bbands.upper · bbands.mid ·
//   bbands.lower · stoch.k · stoch.d
// Flat keys resolve directly: sma20 sma50 sma200 ema9 ema21 rsi14 atr14
//   adx14 vwap obv volume avg_volume20 price (close→price).
// A rule `value` is a number OR another indicator key (e.g. sma50 vs sma200).
// All keys below were verified against POST /api/backtest (real bars, trades
// produced, no rule errors).

import type { BotAction, StrategyRule } from '@/api/types';
import { blankAction } from '@/api/types';

export type StrategyStyle = 'day' | 'swing' | 'position';
export type StrategyCategory = 'Mean Reversion' | 'Momentum' | 'Trend' | 'Breakout';

export interface TemplateExits {
  stop_type: 'pct' | 'atr';
  stop_value: number;
  target_type: 'rr' | 'pct';
  target_value: number;
  trailing: boolean;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  style: StrategyStyle;
  category: StrategyCategory;
  summary: string;
  education: string; // markdown
  defaultSymbols: string[];
  timeframe: string;
  rules: StrategyRule[];
  action: BotAction;
  exits: TemplateExits;
  ai_gate: { enabled: boolean; min_conviction: number };
  sizing: { risk_per_trade_pct: number; max_position_pct: number; max_positions: number };
  suggestedLookback: '1W' | '1M' | '3M';
  indicatorsUsed: string[];
}

// Helper to build a bullish call action.
const callAction = (): BotAction => ({ ...blankAction(), asset: 'option', right: 'call', moneyness: 'ATM' });
const equityAction = (): BotAction => ({ ...blankAction(), asset: 'equity', right: 'auto', moneyness: 'ATM' });

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  // ======================= DAY =======================
  {
    id: 'day-rsi-oversold-bounce',
    name: 'RSI(14) Oversold Bounce',
    style: 'day',
    category: 'Mean Reversion',
    summary: 'Buy the intraday snap-back when RSI(14) crosses back above 30 after a flush.',
    education: `**How it works**

When RSI(14) drops below 30 the asset is statistically over-sold for the short term. The entry fires on the *cross back above 30* — confirmation that selling pressure is exhausting and a bounce is starting, rather than blindly catching a falling knife at 30.

**Why it has an edge**

Liquid index ETFs and megacaps mean-revert intraday because most flow is rebalancing, hedging and short-term liquidity provision rather than informed directional bets. Wilder's RSI normalizes recent gains vs losses, so the <30 → >30 transition marks a measurable shift from net-selling to net-buying.

**Best conditions**

- Range-bound or mildly trending sessions (not gap-and-go trend days)
- High-liquidity tickers where the spread is a penny or two
- Normal-to-elevated volatility so the bounce is worth more than costs

**Key risks**

- In a strong downtrend RSI can stay pinned in single digits ("oversold can get more oversold")
- News-driven flushes don't mean-revert — that's why the AI gate / regime check matters
- Whipsaw in chop: many small crosses around 30

**Timeframe / holding**

5-minute bars, intraday hold of minutes to a few hours; flat by the close.`,
    defaultSymbols: ['QQQ', 'SPY', 'AAPL'],
    timeframe: '5Min',
    rules: [{ indicator: 'rsi14', operator: 'crosses_above', value: 30, join: 'AND' }],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 1.5, target_type: 'rr', target_value: 2, trailing: false },
    ai_gate: { enabled: true, min_conviction: 55 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 10, max_positions: 3 },
    suggestedLookback: '1W',
    indicatorsUsed: ['rsi14'],
  },
  {
    id: 'day-ema-9-21-cross',
    name: 'EMA 9/21 Crossover',
    style: 'day',
    category: 'Momentum',
    summary: 'Go long when the fast EMA(9) crosses above the slow EMA(21) — intraday momentum ignition.',
    education: `**How it works**

The 9-period EMA tracks the most recent price; the 21-period EMA is the slower baseline. When EMA(9) crosses above EMA(21), short-term momentum has turned up relative to the established trend — a classic momentum-ignition trigger.

**Why it has an edge**

EMAs weight recent bars more heavily, so the crossover reacts quickly to a genuine shift while filtering single-bar noise. On trending index/megacap names the 9/21 pair is a well-worn intraday momentum gauge used by a large pool of traders, which makes the level partly self-fulfilling.

**Best conditions**

- Trend days and momentum sessions (post-open drives, breakout continuations)
- Avoid tight pre-news ranges where the EMAs braid and produce false crosses

**Key risks**

- Lagging signal: in fast reversals the cross arrives late
- Choppy, sideways tape causes repeated false crossovers ("EMA chop")

**Timeframe / holding**

5-minute bars; hold while EMA(9) stays above EMA(21), typically the rest of the move within the session.`,
    defaultSymbols: ['QQQ', 'NVDA', 'TSLA'],
    timeframe: '5Min',
    rules: [{ indicator: 'ema9', operator: 'crosses_above', value: 'ema21', join: 'AND' }],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 2, target_type: 'rr', target_value: 1.5, trailing: true },
    ai_gate: { enabled: false, min_conviction: 55 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 10, max_positions: 3 },
    suggestedLookback: '1W',
    indicatorsUsed: ['ema9', 'ema21'],
  },
  {
    id: 'day-vwap-pullback',
    name: 'VWAP Pullback Reclaim',
    style: 'day',
    category: 'Trend',
    summary: 'In an up-day, buy the dip to VWAP and the reclaim back above it.',
    education: `**How it works**

VWAP (volume-weighted average price) is the session's fair-value anchor — the average price every share traded at so far. On an up-trending day, price often pulls back toward VWAP and then *reclaims* it. The entry fires when price crosses back above VWAP after dipping.

**Why it has an edge**

VWAP is the benchmark institutions are measured against, so passive and rebalancing flow tends to defend it on the buy side during accumulation days. A reclaim signals buyers stepping back in at fair value — a high-probability continuation spot with a tight, well-defined stop just below VWAP.

**Best conditions**

- Clear intraday up-trend with price holding above VWAP most of the day
- Healthy volume so VWAP is meaningful
- Skip the first few minutes — VWAP is noisy right after the open

**Key risks**

- On down-days price loses VWAP and keeps falling — direction filter / regime gate matters
- Tight stops below VWAP can get wicked out in volatile tape

**Timeframe / holding**

5-minute bars; intraday hold, exit before the close.`,
    defaultSymbols: ['SPY', 'QQQ', 'MSFT'],
    timeframe: '5Min',
    rules: [{ indicator: 'price', operator: 'crosses_above', value: 'vwap', join: 'AND' }],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 1.5, target_type: 'rr', target_value: 2, trailing: false },
    ai_gate: { enabled: true, min_conviction: 55 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 10, max_positions: 2 },
    suggestedLookback: '1W',
    indicatorsUsed: ['vwap', 'price'],
  },
  {
    id: 'day-macd-hist-momentum',
    name: 'MACD Histogram Momentum',
    style: 'day',
    category: 'Momentum',
    summary: 'Enter when the MACD histogram crosses above zero — MACD line crossing its signal line.',
    education: `**How it works**

The MACD histogram is the gap between the MACD line (12/26 EMA difference) and its 9-period signal line. When the histogram crosses above zero, the MACD line has just crossed above its signal — the standard MACD bullish trigger, captured in one clean condition.

**Why it has an edge**

It compresses two moving-average relationships into a single momentum oscillator that flips early in a move. Because it is derived from EMAs it filters noise while still turning before slow trend filters, giving a timely intraday momentum read.

**Best conditions**

- Trending or expanding-range sessions
- Works best after a base/consolidation when momentum first turns up

**Key risks**

- Zero-line whipsaws in flat tape
- Like all MACD signals it lags sharp V-reversals

**Timeframe / holding**

5-minute bars; hold while the histogram stays positive.`,
    defaultSymbols: ['QQQ', 'AAPL', 'AMD'],
    timeframe: '5Min',
    rules: [{ indicator: 'macd.hist', operator: 'crosses_above', value: 0, join: 'AND' }],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 2, target_type: 'rr', target_value: 1.5, trailing: true },
    ai_gate: { enabled: false, min_conviction: 55 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 10, max_positions: 3 },
    suggestedLookback: '1W',
    indicatorsUsed: ['macd.hist'],
  },
  {
    id: 'day-bollinger-lower-fade',
    name: 'Bollinger Lower-Band Fade',
    style: 'day',
    category: 'Mean Reversion',
    summary: 'Fade an over-extended drop: buy when price closes below the lower Bollinger band.',
    education: `**How it works**

Bollinger Bands sit two standard deviations around a 20-period mean. A close below the *lower* band is a statistically stretched move. This template buys that stretch, betting on a snap back toward the band/mean (the middle band).

**Why it has an edge**

Volatility is mean-reverting: extreme deviations from the 20-period average tend to revert, especially on liquid names where no new information drove the move. The band adapts to current volatility, so the trigger self-calibrates between quiet and busy sessions.

**Best conditions**

- Range / mean-reverting regimes, not strong trend days
- Higher-volatility tape where bands are wide enough to matter
- Confirmation from RSI or the AI gate improves the hit rate

**Key risks**

- In a trend, price can "walk the band" lower for a long time
- A close below the band during a breakdown is continuation, not reversion — the regime gate guards this

**Timeframe / holding**

5-minute bars; short intraday hold targeting the middle band.`,
    defaultSymbols: ['SPY', 'QQQ', 'META'],
    timeframe: '5Min',
    rules: [{ indicator: 'price', operator: '<', value: 'bbands.lower', join: 'AND' }],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 1.5, target_type: 'rr', target_value: 2, trailing: false },
    ai_gate: { enabled: true, min_conviction: 60 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 10, max_positions: 2 },
    suggestedLookback: '1W',
    indicatorsUsed: ['bbands.lower', 'price'],
  },

  // ======================= SWING =======================
  {
    id: 'swing-ema-trend-pullback',
    name: 'Trend Pullback (above SMA50, RSI dip)',
    style: 'swing',
    category: 'Trend',
    summary: 'In an up-trend (price > SMA50), buy the pullback when RSI(14) dips below 40.',
    education: `**How it works**

Two conditions combine: price above the 50-day SMA confirms an established up-trend, and RSI(14) below 40 marks a short-term pullback inside that trend. Buying weakness within strength is the core "buy-the-dip" swing edge.

**Why it has an edge**

Trends persist more often than they reverse (momentum/autocorrelation in equity indices and leaders). Requiring price > SMA50 keeps you on the right side of the trend, while the RSI dip gives a better entry price and reward-to-risk than chasing highs.

**Best conditions**

- Healthy up-trends and bull regimes
- Liquid leaders that respect their moving averages
- Note: a true RSI<40 dip *while* still above SMA50 is selective — it won't fire every week, which is by design

**Key risks**

- A pullback can become a trend change; SMA50 break is your invalidation
- Catching the dip too early if the trend is rolling over

**Timeframe / holding**

Daily bars; multi-day to multi-week swing hold.`,
    defaultSymbols: ['AAPL', 'MSFT', 'NVDA'],
    timeframe: '1Day',
    rules: [
      { indicator: 'price', operator: '>', value: 'sma50', join: 'AND' },
      { indicator: 'rsi14', operator: '<', value: 40, join: 'AND' },
    ],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 2, target_type: 'rr', target_value: 2.5, trailing: false },
    ai_gate: { enabled: true, min_conviction: 60 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 15, max_positions: 4 },
    suggestedLookback: '3M',
    indicatorsUsed: ['price', 'sma50', 'rsi14'],
  },
  {
    id: 'swing-macd-trend',
    name: 'MACD Trend (hist > 0, above SMA50)',
    style: 'swing',
    category: 'Momentum',
    summary: 'Ride up-momentum: MACD histogram positive while price holds above SMA50.',
    education: `**How it works**

This aligns two timeframes of momentum: the MACD histogram above zero means short/medium momentum is up, and price above the 50-day SMA confirms the broader trend agrees. Entries happen only when both point the same way.

**Why it has an edge**

Combining a fast momentum oscillator with a slower trend filter cuts the false signals each gives alone. You participate in established up-trends while momentum is actually expanding, which is where trend-following pays.

**Best conditions**

- Sustained up-trends and momentum regimes
- Index ETFs and trend-leading megacaps

**Key risks**

- Late entries near the end of a run
- Both conditions can stay true into a top, so trail your stop

**Timeframe / holding**

Daily bars; multi-day to multi-week swings, trailing the stop as the trend extends.`,
    defaultSymbols: ['QQQ', 'NVDA', 'META'],
    timeframe: '1Day',
    rules: [
      { indicator: 'macd.hist', operator: '>', value: 0, join: 'AND' },
      { indicator: 'price', operator: '>', value: 'sma50', join: 'AND' },
    ],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 2.5, target_type: 'rr', target_value: 2, trailing: true },
    ai_gate: { enabled: false, min_conviction: 60 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 15, max_positions: 4 },
    suggestedLookback: '3M',
    indicatorsUsed: ['macd.hist', 'price', 'sma50'],
  },
  {
    id: 'swing-bollinger-reversion',
    name: 'Bollinger Reversion (Stoch cross)',
    style: 'swing',
    category: 'Mean Reversion',
    summary: 'Buy a stretched pullback: price below the lower band with Stochastic %K crossing above %D.',
    education: `**How it works**

Price below the lower Bollinger band flags a volatility-stretched move; the Stochastic %K crossing above %D is the momentum-turning confirmation. Together they time a mean-reversion entry — stretched *and* turning, not just stretched.

**Why it has an edge**

The band identifies *where* (an over-extension), the Stochastic cross identifies *when* (momentum flipping up). Requiring both avoids the classic mean-reversion trap of buying into continued weakness. On liquid names these stretches revert to the 20-period mean often enough to be profitable with disciplined stops.

**Best conditions**

- Range-bound or gently up-trending swing markets
- Pullbacks within a broader up-trend (best when also above SMA50)

**Key risks**

- During fast declines the band keeps expanding and reversion fails
- Stochastic can cross repeatedly in a downtrend

**Timeframe / holding**

Daily bars; several-day mean-reversion hold targeting the middle band.`,
    defaultSymbols: ['SPY', 'AAPL', 'AMD'],
    timeframe: '1Day',
    rules: [
      { indicator: 'price', operator: '<', value: 'bbands.lower', join: 'AND' },
      { indicator: 'stoch.k', operator: 'crosses_above', value: 'stoch.d', join: 'OR' },
    ],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 2, target_type: 'rr', target_value: 2, trailing: false },
    ai_gate: { enabled: true, min_conviction: 60 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 12, max_positions: 3 },
    suggestedLookback: '3M',
    indicatorsUsed: ['bbands.lower', 'price', 'stoch.k', 'stoch.d'],
  },
  {
    id: 'swing-breakout-volume',
    name: 'Volume Breakout (upper band + volume)',
    style: 'swing',
    category: 'Breakout',
    summary: 'Breakout: price crosses above the upper Bollinger band on above-average volume.',
    education: `**How it works**

A close-through above the upper Bollinger band is a volatility-expansion breakout. Pairing it with volume above the 20-day average demands that real participation confirms the move — the entry needs *price* and *volume* together.

**Why it has an edge**

Genuine breakouts are accompanied by a surge in volume as new buyers commit; low-volume pokes above the band tend to fail. The volume filter is the single most effective way to separate sustainable breakouts from fakeouts, which is why this is a staple of momentum/breakout systems.

**Best conditions**

- Stocks emerging from a base or consolidation
- Momentum/bull regimes where breakouts follow through
- News/catalyst-driven expansion (AI gate can confirm the catalyst)

**Key risks**

- Failed breakouts ("bull traps") snap back below the band fast — keep stops tight
- Buying extended after a multi-day run-up

**Timeframe / holding**

Daily bars; trend/breakout hold of days to weeks, trailing the stop.`,
    defaultSymbols: ['NVDA', 'TSLA', 'AMD'],
    timeframe: '1Day',
    rules: [
      { indicator: 'price', operator: 'crosses_above', value: 'bbands.upper', join: 'AND' },
      { indicator: 'volume', operator: '>', value: 'avg_volume20', join: 'AND' },
    ],
    action: callAction(),
    exits: { stop_type: 'atr', stop_value: 2.5, target_type: 'rr', target_value: 2.5, trailing: true },
    ai_gate: { enabled: true, min_conviction: 60 },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 12, max_positions: 4 },
    suggestedLookback: '3M',
    indicatorsUsed: ['bbands.upper', 'price', 'volume', 'avg_volume20'],
  },

  // ======================= POSITION =======================
  {
    id: 'position-golden-cross',
    name: 'Golden Cross (SMA50 × SMA200)',
    style: 'position',
    category: 'Trend',
    summary: 'Long-term trend entry when the 50-day SMA crosses above the 200-day SMA.',
    education: `**How it works**

The Golden Cross fires when the 50-day SMA crosses above the 200-day SMA — the most widely watched long-term trend-change signal. It marks the medium-term average overtaking the long-term average, i.e. the trend turning structurally bullish.

**Why it has an edge**

It is a low-frequency, high-conviction regime filter. Major up-trends in indices and leaders have historically begun after a Golden Cross, and because so many allocators watch it, it carries reflexive weight. Used as a position-level "risk-on" switch it keeps you invested through big trends and out during the worst drawdowns.

**Best conditions**

- Early-to-mid stages of a primary up-trend
- Broad indices and large-caps (the signal is noisy on small, erratic names)

**Key risks**

- Very lagging — it confirms a trend well after it starts
- Whipsaws in choppy, directionless multi-month markets (a cross, then a death cross)

**Timeframe / holding**

Daily bars; position hold of weeks to months. Needs enough history (≥200 bars) so use a 3M+ lookback to see crosses.`,
    defaultSymbols: ['SPY', 'QQQ', 'AAPL'],
    timeframe: '1Day',
    rules: [{ indicator: 'sma50', operator: 'crosses_above', value: 'sma200', join: 'AND' }],
    action: equityAction(),
    exits: { stop_type: 'pct', stop_value: 8, target_type: 'pct', target_value: 25, trailing: true },
    ai_gate: { enabled: false, min_conviction: 50 },
    sizing: { risk_per_trade_pct: 1.5, max_position_pct: 20, max_positions: 5 },
    suggestedLookback: '3M',
    indicatorsUsed: ['sma50', 'sma200'],
  },
  {
    id: 'position-long-term-momentum',
    name: 'Long-Term Momentum (SMA200 + ADX + RSI)',
    style: 'position',
    category: 'Momentum',
    summary: 'Own confirmed up-trends: price > SMA200, ADX(14) > 25, RSI(14) > 50.',
    education: `**How it works**

Three filters stack to define a strong, durable up-trend: price above the 200-day SMA (long-term trend up), ADX(14) above 25 (the trend is *strong*, not drifting), and RSI(14) above 50 (momentum bias is bullish). All three must agree.

**Why it has an edge**

This is classic cross-sectional/time-series momentum: assets in strong confirmed up-trends tend to keep outperforming over multi-month horizons. ADX is the key addition — it screens out weak, rangey tape where trend-following bleeds, so you only hold when trend strength is real.

**Best conditions**

- Established secular/cyclical up-trends in leaders and indices
- Risk-on regimes with broad participation

**Key risks**

- Late to exit at a top; trail stops and respect the SMA200 break
- ADX measures strength, not direction, so the SMA200/RSI filters must carry direction

**Timeframe / holding**

Daily bars; position hold of weeks to months. Requires ≥200 bars of history — use a 3M+ lookback.`,
    defaultSymbols: ['NVDA', 'MSFT', 'META'],
    timeframe: '1Day',
    rules: [
      { indicator: 'price', operator: '>', value: 'sma200', join: 'AND' },
      { indicator: 'adx14', operator: '>', value: 25, join: 'AND' },
      { indicator: 'rsi14', operator: '>', value: 50, join: 'AND' },
    ],
    action: equityAction(),
    exits: { stop_type: 'pct', stop_value: 8, target_type: 'pct', target_value: 30, trailing: true },
    ai_gate: { enabled: true, min_conviction: 60 },
    sizing: { risk_per_trade_pct: 1.5, max_position_pct: 20, max_positions: 5 },
    suggestedLookback: '3M',
    indicatorsUsed: ['price', 'sma200', 'adx14', 'rsi14'],
  },
];

export const STYLE_ORDER: StrategyStyle[] = ['day', 'swing', 'position'];

export const STYLE_LABEL: Record<StrategyStyle, string> = {
  day: 'Day Trading',
  swing: 'Swing Trading',
  position: 'Position Trading',
};

export const STYLE_BLURB: Record<StrategyStyle, string> = {
  day: 'Intraday setups on 5-minute bars — opened and closed the same session.',
  swing: 'Multi-day to multi-week holds on daily bars riding a single move.',
  position: 'Weeks-to-months trend/regime plays on daily bars.',
};

// ---- "Triggers explained" reference --------------------------------------

export interface TriggerExplainer {
  key: string;
  name: string;
  text: string;
}

export const TRIGGER_EXPLAINERS: TriggerExplainer[] = [
  {
    key: 'rsi',
    name: 'RSI (Relative Strength Index)',
    text: 'A 0–100 oscillator measuring the speed of recent gains vs losses. Below 30 is over-sold, above 70 over-bought; crosses back through those levels are common mean-reversion triggers.',
  },
  {
    key: 'ma-cross',
    name: 'EMA / SMA Crossover',
    text: 'A faster moving average crossing a slower one signals a momentum/trend shift. Fast-over-slow (e.g. EMA9 over EMA21, or SMA50 over SMA200) is bullish; the reverse is bearish.',
  },
  {
    key: 'macd',
    name: 'MACD',
    text: 'The difference between a fast and slow EMA, plus a signal line. The histogram crossing above zero (MACD over signal) is a bullish momentum trigger; below zero is bearish.',
  },
  {
    key: 'adx',
    name: 'ADX / Momentum Strength',
    text: 'ADX measures how strong a trend is (not its direction). Above ~25 means a real trend is in force; below ~20 means range/chop where trend-following struggles.',
  },
  {
    key: 'bbands',
    name: 'Bollinger Bands',
    text: 'A 20-period mean with bands two standard deviations out. Tags of the lower band flag stretched pullbacks (reversion); a break above the upper band on volume flags a breakout.',
  },
  {
    key: 'vwap',
    name: 'VWAP',
    text: 'The volume-weighted average price of the session — the institutional fair-value anchor. Reclaiming VWAP after a dip is a bullish intraday continuation signal.',
  },
  {
    key: 'volume',
    name: 'Volume Breakout',
    text: 'Volume above its 20-day average confirms conviction behind a price move. A breakout without a volume surge is far more likely to be a fakeout.',
  },
  {
    key: 'stoch',
    name: 'Stochastic Oscillator',
    text: 'Compares the close to its recent high-low range via %K and %D lines. %K crossing above %D in over-sold territory is a momentum-turning confirmation for reversion entries.',
  },
];
