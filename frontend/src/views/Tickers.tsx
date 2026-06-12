import { useCallback, useEffect, useState } from 'react';
import { X, Plus } from 'lucide-react';
import { api } from '@/api/client';
import type { Bar, Snapshot, SnapshotMap, Timeframe } from '@/api/types';
import { money, compact, pct, signed, colorBySign } from '@/lib/format';
import { Panel, Spinner, Empty, ErrorState, Toggle, Skeleton } from '@/components/ui';
import { CandleChart } from '@/components/CandleChart';
import { TickerSearch } from '@/components/TickerSearch';
import { useAppData } from '@/hooks/useAppData';
import { useSymbol } from '@/hooks/useSymbol';
import { usePolling } from '@/hooks/usePolling';

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: '1Min', label: '1Min' },
  { value: '5Min', label: '5Min' },
  { value: '15Min', label: '15Min' },
  { value: '1Hour', label: '1Hour' },
  { value: '1Day', label: '1Day' },
];

function Stat({
  label,
  value,
  className = '',
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="micro-label">{label}</span>
      <span className={`font-mono tabular-nums text-sm text-text ${className}`}>{value}</span>
    </div>
  );
}

export function Tickers() {
  const { watchlist, addWatch, removeWatch, quotes } = useAppData();
  const { symbol, setSymbol } = useSymbol();

  const [active, setActive] = useState<string>(symbol || '');
  const [timeframe, setTimeframe] = useState<Timeframe>('1Day');

  // Poll snapshots for the watchlist every 8s.
  const snapsQ = usePolling<SnapshotMap>(
    () => api.snapshots(watchlist),
    8000,
    [watchlist.join(',')],
  );
  const snaps: SnapshotMap = snapsQ.data ?? {};

  // Active symbol snapshot — refetch when symbol changes (poll 8s too).
  const activeSnapQ = usePolling<SnapshotMap>(
    () => (active ? api.snapshot(active) : Promise.resolve({} as SnapshotMap)),
    8000,
    [active],
  );
  const activeSnap: Snapshot | undefined = active ? activeSnapQ.data?.[active] : undefined;

  // Active symbol bars — refetch when symbol or timeframe changes.
  const barsQ = usePolling<Bar[]>(
    () => (active ? api.bars(active, timeframe, 200) : Promise.resolve([] as Bar[])),
    30000,
    [active, timeframe],
  );
  const bars: Bar[] = barsQ.data ?? [];

  const select = useCallback(
    (sym: string) => {
      const s = sym.toUpperCase();
      setActive(s);
      setSymbol(s);
    },
    [setSymbol],
  );

  // Keep local active in sync if it was never set.
  useEffect(() => {
    if (!active && symbol) setActive(symbol);
  }, [active, symbol]);

  const onSearchSelect = useCallback(
    (sym: string) => {
      select(sym);
    },
    [select],
  );

  const priceFor = (sym: string): number | undefined => {
    const live = quotes[sym]?.price;
    if (live !== undefined && live !== null && !Number.isNaN(live)) return live;
    return snaps[sym]?.price;
  };

  const inWatchlist = !!active && watchlist.includes(active);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3 h-full min-h-0 p-3">
      {/* Left column: search + watchlist */}
      <Panel
        title="Tickers"
        className="min-h-0"
        bodyClassName="flex flex-col min-h-0"
      >
        <div className="p-2 border-b border-border shrink-0">
          <TickerSearch onSelect={onSearchSelect} placeholder="Search ticker…" />
        </div>

        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
          <span className="micro-label">Watchlist</span>
          {!!active && !inWatchlist && (
            <button
              onClick={() => addWatch(active)}
              className="flex items-center gap-1 text-2xs uppercase tracking-wider text-amber hover:text-amber/80"
              title={`Add ${active} to watchlist`}
            >
              <Plus size={11} /> Add {active}
            </button>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {snapsQ.loading && watchlist.length > 0 && !snapsQ.data ? (
            <div className="p-2 flex flex-col gap-1.5">
              {watchlist.map((s) => (
                <Skeleton key={s} className="h-9 w-full" />
              ))}
            </div>
          ) : watchlist.length === 0 ? (
            <Empty label="No symbols — search to add" />
          ) : (
            <ul>
              {watchlist.map((sym) => {
                const snap = snaps[sym];
                const price = priceFor(sym);
                const changePct = snap?.change_pct;
                const isActive = sym === active;
                return (
                  <li key={sym}>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => select(sym)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          select(sym);
                        }
                      }}
                      className={`group flex items-center justify-between px-3 py-2 border-b border-border cursor-pointer ${
                        isActive ? 'bg-amber/10' : 'hover:bg-panel-2'
                      }`}
                    >
                      <div className="flex flex-col min-w-0">
                        <span className="font-mono text-sm text-text">{sym}</span>
                        <span className="font-mono tabular-nums text-2xs text-text-dim">
                          {price !== undefined ? money(price) : '—'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className={`font-mono tabular-nums text-xs ${colorBySign(changePct)}`}
                        >
                          {changePct !== undefined ? pct(changePct) : '—'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeWatch(sym);
                          }}
                          className="text-muted hover:text-down opacity-60 group-hover:opacity-100"
                          title={`Remove ${sym}`}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Panel>

      {/* Right column: active symbol detail */}
      <div className="flex flex-col gap-3 min-h-0">
        <Panel
          title={active ? active : 'Snapshot'}
          right={
            !!active && !inWatchlist ? (
              <button
                onClick={() => addWatch(active)}
                className="flex items-center gap-1 text-2xs uppercase tracking-wider text-amber hover:text-amber/80"
              >
                <Plus size={11} /> Add
              </button>
            ) : undefined
          }
          bodyClassName="p-3"
        >
          {!active ? (
            <Empty label="Select a ticker" />
          ) : activeSnapQ.loading && !activeSnap ? (
            <Spinner label="Loading snapshot" />
          ) : activeSnapQ.error && !activeSnap ? (
            <ErrorState label="Snapshot unavailable" onRetry={activeSnapQ.refetch} />
          ) : !activeSnap ? (
            <Empty label="No data" />
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-end gap-4 flex-wrap">
                <div className="flex flex-col gap-0.5">
                  <span className="micro-label">Price</span>
                  <span className="font-mono tabular-nums text-2xl text-text">
                    {money(priceFor(active) ?? activeSnap.price)}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 pb-1">
                  <span
                    className={`font-mono tabular-nums text-sm ${colorBySign(activeSnap.change)}`}
                  >
                    {signed(activeSnap.change)}
                  </span>
                  <span
                    className={`font-mono tabular-nums text-sm ${colorBySign(activeSnap.change_pct)}`}
                  >
                    {pct(activeSnap.change_pct)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                <Stat label="Open" value={money(activeSnap.open)} />
                <Stat label="High" value={money(activeSnap.high)} />
                <Stat label="Low" value={money(activeSnap.low)} />
                <Stat label="Prev Close" value={money(activeSnap.prev_close)} />
                <Stat label="Volume" value={compact(activeSnap.volume)} />
                <Stat
                  label="Change %"
                  value={pct(activeSnap.change_pct)}
                  className={colorBySign(activeSnap.change_pct)}
                />
              </div>
            </div>
          )}
        </Panel>

        <Panel
          title="Chart"
          right={
            <Toggle
              value={timeframe}
              onChange={(v) => setTimeframe(v as Timeframe)}
              options={TIMEFRAMES}
            />
          }
          className="flex-1 min-h-0"
          bodyClassName="p-2"
        >
          {!active ? (
            <Empty label="Select a ticker" />
          ) : barsQ.loading && bars.length === 0 ? (
            <Spinner label="Loading bars" />
          ) : barsQ.error && bars.length === 0 ? (
            <ErrorState label="Chart data unavailable" onRetry={barsQ.refetch} />
          ) : bars.length === 0 ? (
            <Empty label="No bars" />
          ) : (
            <CandleChart bars={bars} overlays={{ sma: true, volume: true }} height={280} />
          )}
        </Panel>
      </div>
    </div>
  );
}
