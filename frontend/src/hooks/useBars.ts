import { api } from '@/api/client';
import type { Bar, Timeframe } from '@/api/types';
import { usePolling } from './usePolling';

export function useBars(symbol: string, timeframe: Timeframe, limit = 300) {
  return usePolling<Bar[]>(() => api.bars(symbol, timeframe, limit), 15000, [symbol, timeframe, limit]);
}
