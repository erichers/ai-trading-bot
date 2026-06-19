// Goal-based, research-backed prebuilt bots.
//
// Each goal is a complete, ready-to-add Bot tuned to a risk profile — from
// capital-preservation grinders to far-OTM lottery tickets. The user picks the
// outcome they want; we wire up sensible entries, contract selection and
// sizing. All bots start disabled + Signal-only so nothing trades until the
// user reviews and turns them on.
//
// Indicator keys follow the dot/flat convention verified against the backend
// signal evaluator + backtester (see strategyTemplates.ts header).

import type { Bot, BotAction, StrategyRule } from '@/api/types';

export type GoalId = 'conservative' | 'mix' | 'aggressive' | 'yolo';

export interface GoalBot {
  id: GoalId;
  name: string;
  emoji: string;
  tagline: string; // the goal, in one line
  target: string; // expected weekly outcome band (honest, not a promise)
  riskLabel: 'Low' | 'Moderate' | 'High' | 'Extreme';
  tone: 'up' | 'amber' | 'down';
  definition: string; // what it does + why
  warning?: string; // shown prominently for the spicy ones
  symbols: string[];
  rules: StrategyRule[];
  action: BotAction;
  ai_gate: { enabled: boolean; min_conviction: number };
  risk_per_trade_pct: number;
  contracts: number;
  max_premium: number;
  target_delta: number;
  params: string[]; // short chips summarizing the config
}

export const GOAL_BOTS: GoalBot[] = [
  {
    id: 'conservative',
    name: 'Conservative — Capital Preservation',
    emoji: '🛡️',
    tagline: 'Protect the account first; grind steady gains.',
    target: '≈ 1–5% / week',
    riskLabel: 'Low',
    tone: 'up',
    definition:
      'Trend-aligned entries on the most liquid index ETFs, using deep in-the-money weekly calls (delta ≈ 0.7) that move almost like the stock with little time-decay risk. Tiny position size, a tight stop and a high AI-conviction gate mean it only acts on the cleanest setups. Built to compound slowly and survive bad weeks.',
    symbols: ['SPY', 'QQQ'],
    rules: [
      { indicator: 'price', operator: '>', value: 'sma200', join: 'AND' },
      { indicator: 'rsi14', operator: 'crosses_above', value: 50, join: 'AND' },
    ],
    action: { asset: 'option', right: 'call', moneyness: 'ITM', otm_strikes: 0, expiry: 'nearest_weekly', contract_symbol: null },
    ai_gate: { enabled: true, min_conviction: 70 },
    risk_per_trade_pct: 0.5,
    contracts: 1,
    max_premium: 300,
    target_delta: 0.7,
    params: ['ITM weekly calls (Δ≈0.7)', '0.5% risk / trade', 'AI gate ≥ 70', 'Trend filter (>200 SMA)', 'SPY · QQQ'],
  },
  {
    id: 'mix',
    name: 'Balanced — Steady Growth',
    emoji: '⚖️',
    tagline: 'A sensible all-rounder: real growth, survivable drawdowns.',
    target: '≈ 5–15% / week',
    riskLabel: 'Moderate',
    tone: 'amber',
    definition:
      'Blends trend and momentum on large-cap leaders using at-the-money weekly calls (delta ≈ 0.45). Moderate sizing and a balanced AI gate. Aims for meaningful weekly growth while keeping losses recoverable — the default starting point for most people.',
    symbols: ['QQQ', 'NVDA', 'AAPL'],
    rules: [
      { indicator: 'ema9', operator: 'crosses_above', value: 'ema21', join: 'AND' },
      { indicator: 'rsi14', operator: '>', value: 50, join: 'AND' },
    ],
    action: { asset: 'option', right: 'call', moneyness: 'ATM', otm_strikes: 0, expiry: 'nearest_weekly', contract_symbol: null },
    ai_gate: { enabled: true, min_conviction: 60 },
    risk_per_trade_pct: 1.5,
    contracts: 1,
    max_premium: 500,
    target_delta: 0.45,
    params: ['ATM weekly calls (Δ≈0.45)', '1.5% risk / trade', 'AI gate ≥ 60', 'EMA 9/21 + RSI momentum', 'QQQ · NVDA · AAPL'],
  },
  {
    id: 'aggressive',
    name: 'Aggressive — High Growth',
    emoji: '🚀',
    tagline: 'Push for outsized weekly gains; accept the swings.',
    target: '≈ 20–50% / week (volatile)',
    riskLabel: 'High',
    tone: 'down',
    definition:
      'Momentum-ignition breakouts on the highest-beta megacaps, buying slightly out-of-the-money weekly calls (delta ≈ 0.30) for leverage. Larger size and a looser AI gate to catch fast moves, with a wider stop so it can ride them. Expect sharp swings and losing streaks between the big wins.',
    warning: 'Big drawdowns are normal here. Keep this to a slice of your capital and watch it.',
    symbols: ['NVDA', 'TSLA', 'QQQ'],
    rules: [
      { indicator: 'ema9', operator: 'crosses_above', value: 'ema21', join: 'AND' },
      { indicator: 'adx14', operator: '>', value: 20, join: 'AND' },
      { indicator: 'rsi14', operator: '>', value: 55, join: 'AND' },
    ],
    action: { asset: 'option', right: 'call', moneyness: 'OTM', otm_strikes: 1, expiry: 'nearest_weekly', contract_symbol: null },
    ai_gate: { enabled: true, min_conviction: 55 },
    risk_per_trade_pct: 3,
    contracts: 2,
    max_premium: 1000,
    target_delta: 0.3,
    params: ['OTM weekly calls (Δ≈0.30)', '3% risk / trade', 'ADX>20 trend strength', 'EMA 9/21 ignition', 'NVDA · TSLA · QQQ'],
  },
  {
    id: 'yolo',
    name: 'YOLO — Moonshot',
    emoji: '🎰',
    tagline: 'Swing for the fences: 5×–10× the account in a week — or zero.',
    target: '5×–10× … or –100%',
    riskLabel: 'Extreme',
    tone: 'down',
    definition:
      'Far-out-of-the-money weekly calls (delta ≈ 0.10–0.15) on the most volatile names, sized big, with the AI gate OFF so nothing dampens a momentum burst. Most of these expire worthless; the rare winner can multiply many times over. This is a lottery ticket, not a plan — it stays in Signal-only until you deliberately turn it loose.',
    warning:
      '⚠ You will lose 100% on most of these trades. Only ever use money you are completely fine vaporizing. Never run YOLO on Full-auto unattended.',
    symbols: ['TSLA', 'NVDA'],
    rules: [
      { indicator: 'ema9', operator: 'crosses_above', value: 'ema21', join: 'AND' },
      { indicator: 'rsi14', operator: '>', value: 60, join: 'AND' },
    ],
    action: { asset: 'option', right: 'call', moneyness: 'OTM', otm_strikes: 4, expiry: 'nearest_weekly', contract_symbol: null },
    ai_gate: { enabled: false, min_conviction: 50 },
    risk_per_trade_pct: 10,
    contracts: 5,
    max_premium: 2000,
    target_delta: 0.12,
    params: ['Far-OTM weekly calls (Δ≈0.12)', '10% risk / trade', 'AI gate OFF', 'Pure momentum burst', 'TSLA · NVDA'],
  },
];

// Build the createBot payload for a goal. Always disabled + Signal-only.
export function goalToBot(g: GoalBot): Partial<Bot> {
  return {
    name: g.name,
    symbols: g.symbols,
    kind: 'options_weekly',
    rules: g.rules,
    ai_gate: g.ai_gate,
    action: g.action,
    risk: { risk_per_trade_pct: g.risk_per_trade_pct },
    mode: 'signal',
    enabled: false,
    config: {
      direction: 'research',
      side: 'call',
      expiry: 'nearest_weekly',
      strike: 'ATM',
      target_delta: g.target_delta,
      contracts: g.contracts,
      max_premium: g.max_premium,
    },
  };
}
