import type {
  Account,
  Asset,
  Bar,
  Briefing,
  Clock,
  Health,
  IndicatorCatalogItem,
  Indicators,
  NewOrder,
  NewsItem,
  OptionContract,
  OptionsFlow,
  Order,
  Position,
  Regime,
  ResearchReport,
  SignalEvalResult,
  SnapshotMap,
  Strategy,
  StrategyRule,
  Timeframe,
} from './types';

const BASE = '/api';

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

  optionExpirations: (symbol: string) => request<string[]>(`/options/expirations/${symbol}`),
  optionChain: (symbol: string, expiration?: string, type: 'call' | 'put' | 'all' = 'all') =>
    request<OptionContract[]>(`/options/chain/${symbol}${qs({ expiration, type })}`),
  optionFlow: (symbol: string, period: 'weekly' | 'daily' = 'weekly') =>
    request<OptionsFlow>(`/options/flow/${symbol}${qs({ period })}`),

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
};

export type Api = typeof api;
