import { useMemo, useState } from 'react';
import { ArrowUpDown, Search } from 'lucide-react';
import { api } from '@/api/client';
import type { Trade, TradeStatusFilter } from '@/api/types';
import { usePolling } from '@/hooks/usePolling';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { money, num, timeOnly, timeAgo } from '@/lib/format';

// ---- helpers -------------------------------------------------------------

function statusTone(status: string): 'neutral' | 'amber' | 'up' | 'down' {
  const s = (status || '').toLowerCase();
  if (s.includes('fill')) return 'up';
  if (s.includes('cancel') || s.includes('reject') || s.includes('expired')) return 'down';
  if (s.includes('new') || s.includes('accept') || s.includes('pending') || s.includes('held'))
    return 'amber';
  return 'neutral';
}

const isOpenStatus = (s: string) => {
  const l = (s || '').toLowerCase();
  return !(
    l.includes('fill') ||
    l.includes('cancel') ||
    l.includes('reject') ||
    l.includes('expired') ||
    l.includes('done')
  );
};

function SideBadge({ side }: { side: string }) {
  const isBuy = (side || '').toLowerCase() === 'buy' || (side || '').toLowerCase() === 'long';
  return <Badge tone={isBuy ? 'up' : 'down'}>{side}</Badge>;
}

function AssetClassBadge({ assetClass }: { assetClass: string }) {
  const isOpt = assetClass === 'option';
  return <Badge tone={isOpt ? 'amber' : 'neutral'}>{isOpt ? 'OPT' : 'EQ'}</Badge>;
}

function SourceBadge({ source }: { source: string }) {
  const tone =
    source === 'ai' || source === 'bot' ? 'amber' : source === 'strategy' ? 'up' : 'neutral';
  return <Badge tone={tone}>{source || 'manual'}</Badge>;
}

type SourceFilter = 'all' | 'manual' | 'strategy' | 'ai';

type SortKey = 'time' | 'symbol' | 'qty' | 'status';

// ---- header stats strip --------------------------------------------------

function StatBox({ label, value, tone = 'text-text' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-2.5 py-1 border-r border-border last:border-r-0">
      <span className="micro-label">{label}</span>
      <span className={`num text-sm tabular-nums ${tone}`}>{value}</span>
    </div>
  );
}

function StatsStrip({ trades }: { trades: Trade[] }) {
  const stats = useMemo(() => {
    let filled = 0;
    let open = 0;
    let options = 0;
    let equity = 0;
    for (const t of trades) {
      if ((t.status || '').toLowerCase().includes('fill')) filled++;
      if (isOpenStatus(t.status)) open++;
      if (t.asset_class === 'option') options++;
      else equity++;
    }
    return { total: trades.length, filled, open, options, equity };
  }, [trades]);

  return (
    <div className="panel flex flex-wrap items-stretch">
      <StatBox label="Total" value={num(stats.total, 0)} />
      <StatBox label="Filled" value={num(stats.filled, 0)} tone="text-up" />
      <StatBox label="Open" value={num(stats.open, 0)} tone="text-amber" />
      <StatBox label="Equity" value={num(stats.equity, 0)} />
      <StatBox label="Options" value={num(stats.options, 0)} tone="text-amber" />
    </div>
  );
}

// ---- main view -----------------------------------------------------------

export function Trades() {
  // Default to All/All so the user sees every trade (equity included) — the
  // old Options+Canceled default hid their equity fills.
  const [status, setStatus] = useState<TradeStatusFilter>('all');
  const [assetClass, setAssetClass] = useState<'all' | 'equity' | 'option'>('all');
  const [source, setSource] = useState<SourceFilter>('all');
  const [symbolQuery, setSymbolQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('time');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const { data, error, loading, refetch } = usePolling<Trade[]>(
    () => api.trades(status === 'all' ? undefined : status, undefined, 100),
    5000,
    [status],
  );

  const all = data ?? [];

  // Client-side filtering for symbol + asset class (status handled server-side).
  const filtered = useMemo(() => {
    const q = symbolQuery.trim().toUpperCase();
    return all.filter((t) => {
      if (q && !t.symbol.toUpperCase().includes(q)) return false;
      if (assetClass === 'equity' && t.asset_class !== 'us_equity') return false;
      if (assetClass === 'option' && t.asset_class !== 'option') return false;
      if (source !== 'all') {
        // 'ai' filter also matches bot-sourced trades.
        const s = t.source || 'manual';
        if (source === 'ai' ? !(s === 'ai' || s === 'bot') : s !== source) return false;
      }
      return true;
    });
  }, [all, symbolQuery, assetClass, source]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'symbol':
          cmp = a.symbol.localeCompare(b.symbol);
          break;
        case 'qty':
          cmp = (a.qty || 0) - (b.qty || 0);
          break;
        case 'status':
          cmp = (a.status || '').localeCompare(b.status || '');
          break;
        case 'time':
        default: {
          const ta = new Date(a.submitted_at || a.created_at || 0).getTime();
          const tb = new Date(b.submitted_at || b.created_at || 0).getTime();
          cmp = ta - tb;
          break;
        }
      }
      return cmp * dir;
    });
    return rows;
  }, [filtered, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'time' ? 'desc' : 'asc');
    }
  };

  const SortHeader = ({ label, sortableKey, align = 'left' }: { label: string; sortableKey: SortKey; align?: 'left' | 'right' }) => (
    <th className={`px-2 py-1 micro-label font-normal ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        className={`inline-flex items-center gap-1 hover:text-text-dim ${sortKey === sortableKey ? 'text-amber' : ''}`}
        onClick={() => toggleSort(sortableKey)}
      >
        {label}
        <ArrowUpDown size={10} className="opacity-60" />
      </button>
    </th>
  );

  let body: React.ReactNode;
  if (loading && all.length === 0) body = <Spinner label="Loading trades" />;
  else if (error && all.length === 0)
    body = <ErrorState label={`Failed to load trades — ${error.message}`} onRetry={refetch} />;
  else if (sorted.length === 0) body = <Empty label="No trades match the filters" />;
  else
    body = (
      <div className="overflow-auto h-full">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-panel z-10">
            <tr className="text-left text-muted border-b border-border">
              <SortHeader label="Time" sortableKey="time" />
              <SortHeader label="Symbol" sortableKey="symbol" />
              <th className="px-2 py-1 micro-label font-normal">Class</th>
              <th className="px-2 py-1 micro-label font-normal">Side</th>
              <SortHeader label="Qty / Filled" sortableKey="qty" align="right" />
              <th className="px-2 py-1 micro-label font-normal">Type</th>
              <th className="px-2 py-1 micro-label font-normal text-right">Limit</th>
              <th className="px-2 py-1 micro-label font-normal text-right">Stop</th>
              <th className="px-2 py-1 micro-label font-normal text-right">Fill Px</th>
              <SortHeader label="Status" sortableKey="status" />
              <th className="px-2 py-1 micro-label font-normal">Source</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {sorted.map((t) => {
              const ts = t.submitted_at || t.created_at;
              return (
                <tr key={t.id} className="border-b border-border/50 hover:bg-panel-2">
                  <td className="px-2 py-1 font-mono whitespace-nowrap" title={ts ? timeAgo(ts) : ''}>
                    {ts ? timeOnly(ts) : '—'}
                    {ts && <span className="text-muted ml-1 text-2xs">{timeAgo(ts)}</span>}
                  </td>
                  <td className="px-2 py-1 font-mono font-semibold text-text">{t.symbol}</td>
                  <td className="px-2 py-1">
                    <AssetClassBadge assetClass={t.asset_class} />
                  </td>
                  <td className="px-2 py-1">
                    <SideBadge side={t.side} />
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {num(t.qty, 0)}
                    <span className="text-muted"> / {num(t.filled_qty, 0)}</span>
                  </td>
                  <td className="px-2 py-1 font-mono text-text-dim">{t.order_type}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {t.limit_price != null ? money(t.limit_price) : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {t.stop_price != null ? money(t.stop_price) : '—'}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {t.filled_avg_price != null ? money(t.filled_avg_price) : '—'}
                  </td>
                  <td className="px-2 py-1">
                    <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                  </td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <SourceBadge source={t.source} />
                      {t.strategy_id && (
                        <span
                          className="text-2xs text-muted font-mono truncate max-w-[80px]"
                          title={t.strategy_id}
                        >
                          {t.strategy_id}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );

  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
        <input
          className="input font-mono uppercase pl-7 py-1 w-32 text-xs"
          value={symbolQuery}
          onChange={(e) => setSymbolQuery(e.target.value.toUpperCase())}
          placeholder="Symbol…"
          autoComplete="off"
        />
      </div>
      <Toggle
        value={assetClass}
        onChange={(v) => setAssetClass(v as 'all' | 'equity' | 'option')}
        options={[
          { value: 'all', label: 'All' },
          { value: 'equity', label: 'Equity' },
          { value: 'option', label: 'Options' },
        ]}
      />
      <Toggle
        value={status}
        onChange={(v) => setStatus(v as TradeStatusFilter)}
        options={[
          { value: 'all', label: 'All' },
          { value: 'open', label: 'Open' },
          { value: 'filled', label: 'Filled' },
          { value: 'canceled', label: 'Canceled' },
        ]}
      />
      <Toggle
        value={source}
        onChange={(v) => setSource(v as SourceFilter)}
        options={[
          { value: 'all', label: 'All src' },
          { value: 'manual', label: 'Manual' },
          { value: 'strategy', label: 'Strategy' },
          { value: 'ai', label: 'Bot/AI' },
        ]}
      />
    </div>
  );

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <StatsStrip trades={all} />
      <Panel
        title="Trade Ledger"
        right={filters}
        className="flex-1 min-h-0"
        bodyClassName="min-h-0"
      >
        {body}
      </Panel>
    </div>
  );
}
