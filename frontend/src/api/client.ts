import type {
  Account,
  Asset,
  Bar,
  Bot,
  Briefing,
  Clock,
  Health,
  KillSwitchResult,
  IndicatorCatalogItem,
  Indicators,
  NewOrder,
  NewsItem,
  OptionContract,
  OptionExpiration,
  OptionsFlow,
  OptionsSelectResponse,
  Order,
  Position,
  Proposal,
  ProposalsResponse,
  Regime,
  RiskCheckResult,
  RiskEvent,
  RiskLimits,
  RiskSizeResult,
  RiskStatus,
  ResearchHistoryItem,
  ResearchReport,
  SignalEvalResult,
  SignalHistoryItem,
  SnapshotMap,
  Strategy,
  StrategyRule,
  Timeframe,
  Trade,
} from './types';

// Same-origin API base. Dev: '/api' (Vite proxy → :8000). Prod under Apache:
// '/sandbox/api' (mod_proxy → uvicorn :8000). Derived from Vite's base URL.
const BASE = `${import.meta.env.BASE_URL}api`.replace(/\/{2,}/g, '/');

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      ...init,
    });
  } catch (e) {
    throw new ApiError(`Network error: ${(e as Error).message}`, 0);
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body?.detail || body?.message || detail;
    } catch {
      /* ignore */
    }
    throw new ApiError(detail, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '');
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
};

export const api = {
  health: () => request<Health>('/health'),
  account: () => request<Account>('/account'),
  positions: () => request<Position[]>('/positions'),

  orders: (status: 'open' | 'closed' | 'all' = 'open') =>
    request<Order[]>(`/orders${qs({ status })}`),
  createOrder: (order: NewOrder) =>
    request<Order>('/orders', { method: 'POST', body: JSON.stringify(order) }),
  cancelAllOrders: () => request<void>('/orders', { method: 'DELETE' }),
  cancelOrder: (id: string) => request<void>(`/orders/${id}`, { method: 'DELETE' }),

  clock: () => request<Clock>('/clock'),

  assets: (search?: string, limit = 20) => request<Asset[]>(`/assets${qs({ search, limit })}`),

  bars: (symbol: string, timeframe: Timeframe = '1Day', limit = 300) =>
    request<Bar[]>(`/bars/${symbol}${qs({ timeframe, limit })}`),

  quote: (symbol: string) => request<SnapshotMap>(`/quote/${symbol}`),
  snapshot: (symbol: string) => request<SnapshotMap>(`/snapshot/${symbol}`),
  snapshots: (symbols: string[]) =>
    symbols.length
      ? request<SnapshotMap>(`/snapshots${qs({ symbols: symbols.join(',') })}`)
      : Promise.resolve({} as SnapshotMap),

  news: (symbols?: string[], limit = 30) =>
    request<NewsItem[]>(`/news${qs({ symbols: symbols?.join(','), limit })}`),

  optionExpirations: (symbol: string) =>
    request<OptionExpiration[]>(`/options/expirations/${symbol}`),
  optionChain: (symbol: string, expiration?: string, type: 'call' | 'put' | 'all' = 'all') =>
    request<OptionContract[]>(`/options/chain/${symbol}${qs({ expiration, type })}`),
  optionFlow: (symbol: string, period: 'weekly' | 'daily' = 'weekly') =>
    request<OptionsFlow>(`/options/flow/${symbol}${qs({ period })}`),

  // Live ATM/OTM/ITM contract picker around the underlying price.
  optionsSelect: (
    symbol: string,
    opts: {
      right: 'call' | 'put';
      expiry?: string;
      moneyness?: 'ATM' | 'OTM' | 'ITM';
      count?: number;
    },
  ) =>
    request<OptionsSelectResponse>(
      `/options/select/${symbol}${qs({
        right: opts.right,
        expiry: opts.expiry ?? 'nearest_weekly',
        moneyness: opts.moneyness ?? 'ATM',
        count: opts.count ?? 9,
      })}`,
    ),

  watchlist: () => request<string[]>('/watchlist'),
  addWatch: (symbol: string) =>
    request<string[]>('/watchlist', { method: 'POST', body: JSON.stringify({ symbol }) }),
  removeWatch: (symbol: string) => request<void>(`/watchlist/${symbol}`, { method: 'DELETE' }),

  indicators: (symbol: string, timeframe?: Timeframe) =>
    request<Indicators>(`/indicators/${symbol}${qs({ timeframe })}`),
  indicatorCatalog: () => request<IndicatorCatalogItem[]>('/indicators/catalog'),

  strategies: () => request<Strategy[]>('/strategies'),
  createStrategy: (s: Partial<Strategy>) =>
    request<Strategy>('/strategies', { method: 'POST', body: JSON.stringify(s) }),
  updateStrategy: (id: string, s: Partial<Strategy>) =>
    request<Strategy>(`/strategies/${id}`, { method: 'PUT', body: JSON.stringify(s) }),
  deleteStrategy: (id: string) => request<void>(`/strategies/${id}`, { method: 'DELETE' }),

  evaluateSignal: (symbol: string, timeframe: string, rules: StrategyRule[]) =>
    request<SignalEvalResult>('/signals/evaluate', {
      method: 'POST',
      body: JSON.stringify({ symbol, timeframe, rules }),
    }),

  analyze: (symbol: string) =>
    request<ResearchReport>('/research/analyze', {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    }),
  briefing: () => request<Briefing>('/research/briefing'),
  regime: () => request<Regime>('/research/regime'),
  researchHistory: (symbol?: string, limit = 50) =>
    request<ResearchHistoryItem[]>(`/research/history${qs({ symbol, limit })}`),

  trades: (status?: string, symbol?: string, limit = 100) =>
    request<Trade[]>(`/trades${qs({ status, symbol, limit })}`),

  signalsHistory: (symbol?: string, limit = 50) =>
    request<SignalHistoryItem[]>(`/signals/history${qs({ symbol, limit })}`),

  // ---- Risk Engine -------------------------------------------------------
  riskLimits: () => request<RiskLimits>('/risk/limits'),
  updateRiskLimits: (limits: Partial<RiskLimits>) =>
    request<RiskLimits>('/risk/limits', { method: 'PUT', body: JSON.stringify(limits) }),
  riskStatus: () => request<RiskStatus>('/risk/status'),
  riskCheck: (order: NewOrder) =>
    request<RiskCheckResult>('/risk/check', { method: 'POST', body: JSON.stringify(order) }),
  riskSize: (entry: number, stop: number, risk_per_trade_pct?: number) =>
    request<RiskSizeResult>('/risk/size', {
      method: 'POST',
      body: JSON.stringify({ entry, stop, risk_per_trade_pct }),
    }),
  riskKillSwitch: (engaged: boolean, flatten?: boolean) =>
    request<KillSwitchResult>('/risk/kill-switch', {
      method: 'POST',
      body: JSON.stringify({ engaged, flatten }),
    }),
  riskEvents: (limit = 50) => request<RiskEvent[]>(`/risk/events${qs({ limit })}`),

  // ---- Weekly-options Bots ----------------------------------------------
  bots: () => request<Bot[]>('/bots'),
  createBot: (b: Partial<Bot>) =>
    request<Bot>('/bots', { method: 'POST', body: JSON.stringify(b) }),
  updateBot: (id: string, b: Partial<Bot>) =>
    request<Bot>(`/bots/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  deleteBot: (id: string) => request<void>(`/bots/${id}`, { method: 'DELETE' }),
  evaluateBot: (id: string) =>
    request<ProposalsResponse>(`/bots/${id}/evaluate`, { method: 'POST' }).then(normalizeProposals),
  runBot: (id: string, place: boolean) =>
    request<ProposalsResponse>(`/bots/${id}/run`, {
      method: 'POST',
      body: JSON.stringify({ place }),
    }).then(normalizeProposals),
};

// Backend may return { proposals: [...] } or a bare Proposal[] — normalize both.
function normalizeProposals(res: ProposalsResponse): Proposal[] {
  if (Array.isArray(res)) return res;
  return res?.proposals ?? [];
}

export type Api = typeof api;
