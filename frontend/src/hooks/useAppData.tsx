import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { api } from '@/api/client';
import type { Account, Clock, Health, Position, RiskStatus } from '@/api/types';
import { usePolling } from './usePolling';
import { useWebSocket, type WSStatus, type LiveQuote } from './useWebSocket';

interface AppData {
  health: Health | undefined;
  account: Account | undefined;
  positions: Position[];
  clock: Clock | undefined;
  watchlist: string[];
  refetchWatchlist: () => void;
  refetchPositions: () => void;
  refetchAccount: () => void;
  addWatch: (symbol: string) => Promise<void>;
  removeWatch: (symbol: string) => Promise<void>;
  wsStatus: WSStatus;
  quotes: Record<string, LiveQuote>;
  backendDown: boolean;
  // Computed open risk = sum (current - stop)*qty; we approximate stop via
  // saved local stops or fall back to 2% below entry when unknown.
  openRisk: number;
  // Risk Engine status (polled ~5s) for global banner + open-risk readout.
  riskStatus: RiskStatus | undefined;
  refetchRiskStatus: () => void;
}

const Ctx = createContext<AppData | null>(null);

export function AppDataProvider({ children }: { children: ReactNode }) {
  const healthQ = usePolling<Health>(() => api.health(), 10000);
  const accountQ = usePolling<Account>(() => api.account(), 5000);
  const positionsQ = usePolling<Position[]>(() => api.positions(), 5000);
  const clockQ = usePolling<Clock>(() => api.clock(), 30000);
  const watchQ = usePolling<string[]>(() => api.watchlist(), 30000);
  const riskQ = usePolling<RiskStatus>(() => api.riskStatus(), 5000);
  const { status: wsStatus, quotes } = useWebSocket();

  const positions = positionsQ.data ?? [];
  const watchlist = watchQ.data ?? [];

  const addWatch = useCallback(
    async (symbol: string) => {
      await api.addWatch(symbol.toUpperCase());
      watchQ.refetch();
    },
    [watchQ],
  );

  const removeWatch = useCallback(
    async (symbol: string) => {
      await api.removeWatch(symbol.toUpperCase());
      watchQ.refetch();
    },
    [watchQ],
  );

  // Backend considered down if account+health+positions all error with no data.
  const backendDown = useMemo(() => {
    const errs = [healthQ.error, accountQ.error].filter(Boolean).length;
    const noData = !healthQ.data && !accountQ.data;
    return errs >= 1 && noData;
  }, [healthQ.error, healthQ.data, accountQ.error, accountQ.data]);

  const openRisk = useMemo(() => {
    return positions.reduce((acc, p) => {
      const stop = p.avg_entry_price * 0.98; // heuristic 2% stop when unknown
      const perShare = Math.max(p.current_price - stop, 0);
      return acc + perShare * Math.abs(p.qty);
    }, 0);
  }, [positions]);

  const value = useMemo<AppData>(
    () => ({
      health: healthQ.data,
      account: accountQ.data,
      positions,
      clock: clockQ.data,
      watchlist,
      refetchWatchlist: watchQ.refetch,
      refetchPositions: positionsQ.refetch,
      refetchAccount: accountQ.refetch,
      addWatch,
      removeWatch,
      wsStatus,
      quotes,
      backendDown,
      openRisk,
      riskStatus: riskQ.data,
      refetchRiskStatus: riskQ.refetch,
    }),
    [
      healthQ.data,
      accountQ.data,
      positions,
      clockQ.data,
      watchlist,
      watchQ.refetch,
      positionsQ.refetch,
      accountQ.refetch,
      addWatch,
      removeWatch,
      wsStatus,
      quotes,
      backendDown,
      openRisk,
      riskQ.data,
      riskQ.refetch,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppData(): AppData {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
