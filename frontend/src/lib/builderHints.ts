// Education for the strategy Builder's ENTRY TRIGGER step.
//
// Maps an indicator key (rule.indicator) to:
//   - a concise hint (what it measures + the sensible operator + value),
//   - well-formed "suggested triggers" the user can click to insert,
//   - a non-blocking sanity check for rules that look off.
//
// Hints reuse the prose from TRIGGER_EXPLAINERS where useful but stay tight.
// Suggested-trigger values use the correct dot-path keys the backend resolves
// (macd.hist, bbands.lower, stoch.k, …) — see strategyTemplates.ts header.

import type { BotRule } from '@/api/types';
import { TRIGGER_EXPLAINERS } from '@/data/strategyTemplates';

export interface SuggestedTrigger {
  label: string; // human label shown on the chip
  rule: Omit<BotRule, 'join'>; // applied to the current row (join preserved)
}

export interface IndicatorHint {
  hint: string;
  suggestions: SuggestedTrigger[];
}

const explainer = (key: string): string =>
  TRIGGER_EXPLAINERS.find((e) => e.key === key)?.text ?? '';

// Normalize a rule.indicator key to a hint "family".
function family(indicator: string): string {
  const k = indicator.toLowerCase();
  if (k.startsWith('rsi')) return 'rsi';
  if (k.startsWith('macd')) return 'macd';
  if (k.startsWith('ema') || k.startsWith('sma')) return 'ma';
  if (k.startsWith('bbands')) return 'bbands';
  if (k.startsWith('vwap')) return 'vwap';
  if (k.startsWith('adx')) return 'adx';
  if (k.startsWith('stoch')) return 'stoch';
  if (k === 'volume' || k === 'avg_volume20' || k === 'obv') return 'volume';
  if (k.startsWith('atr')) return 'atr';
  if (k === 'price') return 'price';
  return 'generic';
}

const HINTS: Record<string, IndicatorHint> = {
  rsi: {
    hint: 'Momentum 0–100. Oversold <30, overbought >70. Common: crosses_above 30 (bounce) or crosses_below 70 (fade).',
    suggestions: [
      { label: 'RSI crosses above 30', rule: { indicator: 'rsi14', operator: 'crosses_above', value: 30 } },
      { label: 'RSI crosses below 70', rule: { indicator: 'rsi14', operator: 'crosses_below', value: 70 } },
      { label: 'RSI < 40 (pullback)', rule: { indicator: 'rsi14', operator: '<', value: 40 } },
      { label: 'RSI > 50 (bullish bias)', rule: { indicator: 'rsi14', operator: '>', value: 50 } },
    ],
  },
  macd: {
    hint: 'Use `macd.hist` crosses_above 0 for bullish momentum — it oscillates around 0, NOT a price level.',
    suggestions: [
      { label: 'MACD hist crosses above 0', rule: { indicator: 'macd.hist', operator: 'crosses_above', value: 0 } },
      { label: 'MACD hist crosses below 0', rule: { indicator: 'macd.hist', operator: 'crosses_below', value: 0 } },
      { label: 'MACD hist > 0 (up momentum)', rule: { indicator: 'macd.hist', operator: '>', value: 0 } },
    ],
  },
  ma: {
    hint: 'Trend. Use crossovers like `ema9 crosses_above ema21`, or `price > sma50`. Compare to another MA key, not a raw number.',
    suggestions: [
      { label: 'EMA9 crosses above EMA21', rule: { indicator: 'ema9', operator: 'crosses_above', value: 'ema21' } },
      { label: 'price > SMA50 (uptrend)', rule: { indicator: 'price', operator: '>', value: 'sma50' } },
      { label: 'SMA50 crosses above SMA200', rule: { indicator: 'sma50', operator: 'crosses_above', value: 'sma200' } },
    ],
  },
  bbands: {
    hint: '`price < bbands.lower` = oversold fade; `price crosses_above bbands.upper` = breakout. Compare price to a band key.',
    suggestions: [
      { label: 'price < lower band (fade)', rule: { indicator: 'price', operator: '<', value: 'bbands.lower' } },
      { label: 'price crosses above upper band', rule: { indicator: 'price', operator: 'crosses_above', value: 'bbands.upper' } },
    ],
  },
  vwap: {
    hint: 'Session fair-value anchor. `price crosses_above vwap` = bullish reclaim; staying above VWAP = intraday strength.',
    suggestions: [
      { label: 'price crosses above VWAP', rule: { indicator: 'price', operator: 'crosses_above', value: 'vwap' } },
      { label: 'price > VWAP (holding strength)', rule: { indicator: 'price', operator: '>', value: 'vwap' } },
    ],
  },
  adx: {
    hint: 'Trend STRENGTH (0–100), not direction. >25 = real trend, <20 = chop. Pair with a direction filter.',
    suggestions: [
      { label: 'ADX > 25 (trend in force)', rule: { indicator: 'adx14', operator: '>', value: 25 } },
      { label: 'ADX > 20', rule: { indicator: 'adx14', operator: '>', value: 20 } },
    ],
  },
  stoch: {
    hint: '0–100 oscillator (`stoch.k` / `stoch.d`). %K crossing above %D in oversold territory confirms a turn up.',
    suggestions: [
      { label: 'stoch %K crosses above %D', rule: { indicator: 'stoch.k', operator: 'crosses_above', value: 'stoch.d' } },
      { label: 'stoch %K crosses above 20', rule: { indicator: 'stoch.k', operator: 'crosses_above', value: 20 } },
    ],
  },
  volume: {
    hint: 'Conviction filter. `volume > avg_volume20` confirms real participation behind a move — guards against fakeouts.',
    suggestions: [
      { label: 'volume > 20-day average', rule: { indicator: 'volume', operator: '>', value: 'avg_volume20' } },
    ],
  },
  atr: {
    hint: 'Average True Range — typical bar size in dollars (volatility), not a buy/sell level. Best used for stop sizing, not entries.',
    suggestions: [],
  },
  price: {
    hint: 'The last close. Compare it to an indicator key (sma50, vwap, bbands.lower) rather than a fixed dollar amount.',
    suggestions: [
      { label: 'price > SMA50', rule: { indicator: 'price', operator: '>', value: 'sma50' } },
      { label: 'price crosses above VWAP', rule: { indicator: 'price', operator: 'crosses_above', value: 'vwap' } },
      { label: 'price < lower Bollinger', rule: { indicator: 'price', operator: '<', value: 'bbands.lower' } },
    ],
  },
  generic: {
    hint: 'Pick an operator and a value (a number, or another indicator key like sma50 / vwap) to complete the condition.',
    suggestions: [],
  },
};

export function indicatorHint(indicator: string): IndicatorHint {
  const fam = family(indicator);
  const base = HINTS[fam] ?? HINTS.generic;
  // Prefer the longer explainer prose when we have one for this family.
  const long = explainer(fam === 'ma' ? 'ma-cross' : fam);
  return { hint: long || base.hint, suggestions: base.suggestions };
}

// Non-blocking sanity check. Returns an amber helper string when a rule looks
// like a likely mistake (oscillator vs an out-of-range constant, price vs a
// tiny number, etc.). Returns null when the rule looks reasonable.
export function ruleWarning(rule: BotRule): string | null {
  const fam = family(rule.indicator);
  const raw = rule.value;
  // Only constants can be "out of range"; indicator-vs-indicator is fine.
  const isNumeric =
    raw !== '' && raw !== undefined && raw !== null && !Number.isNaN(Number(raw));
  if (!isNumeric) return null;
  const n = Number(raw);

  switch (fam) {
    case 'macd':
      if (Math.abs(n) > 5) {
        return `MACD histogram hovers near 0 — ${n} will rarely trigger. Did you mean crosses_above 0?`;
      }
      return null;
    case 'rsi':
    case 'stoch':
      if (n < 1 || n > 99) {
        return `${rule.indicator} is a 0–100 oscillator — ${n} is outside its range. Try 30 (oversold) or 70 (overbought).`;
      }
      return null;
    case 'adx':
      if (n < 0 || n > 100) {
        return `ADX runs 0–100 — ${n} is out of range. Common threshold is 25.`;
      }
      return null;
    case 'price':
      if (n > 0 && n < 5) {
        return `Comparing price to ${n} (a tiny dollar value) rarely makes sense — compare to an indicator like sma50 or vwap.`;
      }
      return null;
    default:
      return null;
  }
}
