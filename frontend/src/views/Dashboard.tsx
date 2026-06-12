import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { X, Sparkles, ChevronDown, ChevronRight, Zap } from 'lucide-react';
import { api } from '@/api/client';
import type { Briefing, Order, ResearchReport, SnapshotMap, Timeframe } from '@/api/types';
import { useAppData } from '@/hooks/useAppData';
import { useSymbol } from '@/hooks/useSymbol';
import { usePolling } from '@/hooks/usePolling';
import { useBars } from '@/hooks/useBars';
import { CandleChart, type Overlay } from '@/components/CandleChart';
import { Sparkline } from '@/components/Sparkline';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import {
  money,
  moneyCompact,
  signed,
  pct,
  colorBySign,
  timeOnly,
  timeAgo,
} from '@/lib/format';

const TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: '1Min', label: '1m' },
  { value: '5Min', label: '5m' },
  { value: '15Min', label: '15m' },
  { value: '1Hour', label: '1H' },
  { value: '1Day', label: '1D' },
];

/* ---------- Equity strip ---------- */
function StatCell({
  label,
  value,
  sub,
  tone,
  big,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
  big?: boolean;
}) {
  return (
    <div className="flex flex-col justify-center px-4 py-2 border-r border-border last:border-r-0 flex-1">
      <span className="micro-label">{label}</span>
      <span className={`num ${big ? 'text-xl' : 'text-base'} ${tone ?? 'text-text'}`}>{value}</span>
      {sub && <span className={`num text-2xs ${tone ?? 'text-text-dim'}`}>{sub}</span>}
    </div>
  );
}

function EquityStrip() {
  const { account, openRisk } = useAppData();
  return (
    <div className="panel flex flex-row">
      <StatCell label="Equity" value={money(account?.equity ?? null)} />
      <StatCell label="Buying Power" value={money(account?.buying_power ?? null)} />
      <StatCell
        label="Day P&L"
        value={signed(account?.day_pl)}
        sub={pct(account?.day_pl_pct)}
        tone={colorBySign(account?.day_pl)}
      />
      <StatCell label="Cash" value={money(account?.cash ?? null)} />
      <StatCell
        label="Open Risk"
        value={moneyCompact(openRisk)}
        sub="Σ (price − stop) × qty"
        tone="text-amber"
        big
      />
    </div>
  );
}

/* ---------- Watchlist panel ---------- */
function WatchRow({
  sym,
  snap,
  history,
  livePrice,
}: {
  sym: string;
  snap: SnapshotMap[string] | undefined;
  history: number[];
  livePrice?: number;
}) {
  const { removeWatch } = useAppData();
  const { setSymbol } = useSymbol();
  const price = livePrice ?? snap?.price ?? 0;
  const changePct = snap?.change_pct ?? 0;
  const prevPrice = useRef(price);
  const [flash, setFlash] = useState('');
  useEffect(() => {
    if (price && prevPrice.current && price !== prevPrice.current) {
      setFlash(price > prevPrice.current ? 'flash-up' : 'flash-down');
      const t = setTimeout(() => setFlash(''), 600);
      prevPrice.current = price;
      return () => clearTimeout(t);
    }
    prevPrice.current = price;
  }, [price]);

  return (
    <div
      className={`group flex items-center gap-2 px-3 h-9 data-row cursor-pointer ${flash}`}
      onClick={() => setSymbol(sym)}
    >
      <span className="font-mono text-sm text-text w-14 shrink-0">{sym}</span>
      <Sparkline data={history} positive={changePct >= 0} />
      <span className="num text-sm text-text ml-auto w-20 text-right">{money(price)}</span>
      <span className={`num text-xs w-16 text-right ${colorBySign(changePct)}`}>{pct(changePct)}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          void removeWatch(sym);
        }}
        className="opacity-0 group-hover:opacity-100 text-muted hover:text-down transition-opacity"
        title="Remove"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function WatchlistPanel() {
  const { watchlist, quotes } = useAppData();
  const histories = useRef<Record<string, number[]>>({});

  const snapQ = usePolling<SnapshotMap>(
    () => api.snapshots(watchlist),
    8000,
    [watchlist.join(',')],
  );

  // Accumulate price history for sparklines from snapshot + live quotes.
  const snaps = snapQ.data ?? {};
  for (const sym of watchlist) {
    const p = quotes[sym]?.price ?? snaps[sym]?.price;
    if (p) {
      const arr = histories.current[sym] ?? [];
      if (arr[arr.length - 1] !== p) {
        arr.push(p);
        if (arr.length > 40) arr.shift();
        histories.current[sym] = arr;
      }
    }
  }

  return (
    <Panel title="Watchlist" right={<span className="micro-label">{watchlist.length}</span>}>
      {snapQ.loading && watchlist.length === 0 ? (
        <Spinner label="loading" />
      ) : watchlist.length === 0 ? (
        <Empty label="Watchlist empty — add tickers" />
      ) : (
        <div className="overflow-auto h-full">
          {watchlist.map((sym) => (
            <WatchRow
              key={sym}
              sym={sym}
              snap={snaps[sym]}
              history={histories.current[sym] ?? []}
              livePrice={quotes[sym]?.price}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ---------- Main chart ---------- */
function ChartPanel() {
  const { symbol } = useSymbol();
  const { quotes } = useAppData();
  const [tf, setTf] = useState<Timeframe>('1Day');
  const [ov, setOv] = useState<Overlay>({ sma: true, volume: true, ema: false, bbands: false });
  const barsQ = useBars(symbol, tf);
  const bars = barsQ.data ?? [];

  const live = quotes[symbol];
  const last = bars[bars.length - 1];
  const price = live?.price ?? last?.c;
  const chg = bars.length > 1 ? ((price ?? 0) - bars[0].o) / bars[0].o * 100 : undefined;

  const toggleOv = (k: keyof Overlay) => setOv((o) => ({ ...o, [k]: !o[k] }));

  return (
    <Panel
      title={`Chart · ${symbol}`}
      right={
        <div className="flex items-center gap-2">
          {price !== undefined && (
            <span className={`num text-sm ${colorBySign(chg)}`}>
              {money(price)} {chg !== undefined && <span className="text-2xs">{pct(chg)}</span>}
            </span>
          )}
          <Toggle value={tf} onChange={(v) => setTf(v as Timeframe)} options={TIMEFRAMES} />
        </div>
      }
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border">
        {(['sma', 'ema', 'bbands', 'volume'] as (keyof Overlay)[]).map((k) => (
          <button
            key={k}
            onClick={() => toggleOv(k)}
            className={`px-2 py-0.5 text-2xs uppercase tracking-wider rounded border transition-colors ${
              ov[k]
                ? 'border-amber/40 text-amber bg-amber/10'
                : 'border-border-2 text-muted hover:text-text'
            }`}
          >
            {k === 'bbands' ? 'BB' : k}
          </button>
        ))}
      </div>
      <div className="p-1">
        {barsQ.loading && bars.length === 0 ? (
          <Spinner label="loading bars" />
        ) : barsQ.error && bars.length === 0 ? (
          <ErrorState label="No bar data" onRetry={barsQ.refetch} />
        ) : bars.length === 0 ? (
          <Empty label="No data" />
        ) : (
          <CandleChart bars={bars} overlays={ov} height={360} />
        )}
      </div>
    </Panel>
  );
}

/* ---------- AI Research feed ---------- */
function ResearchCard({ symbol }: { symbol: string }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<ResearchReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { setSymbol } = useSymbol();
  const navigate = useNavigate();

  const analyze = async () => {
    if (report) {
      setOpen((o) => !o);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const r = await api.analyze(symbol);
      setReport(r);
      setOpen(true);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-border rounded bg-panel-2/50">
      <button
        onClick={analyze}
        className="flex items-center gap-2 w-full px-2.5 py-2 text-left hover:bg-panel-2"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="font-mono text-sm text-text">{symbol}</span>
        {report && (
          <Badge tone={report.sentiment_score >= 0 ? 'up' : 'down'}>
            {report.suggested_action}
          </Badge>
        )}
        <span className="ml-auto text-muted">
          {loading ? <Sparkles size={13} className="animate-pulse text-amber" /> : <Sparkles size={13} />}
        </span>
      </button>
      {err && <div className="px-2.5 pb-2 text-2xs text-down">{err}</div>}
      {open && report && (
        <div className="px-2.5 pb-2.5 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="micro-label">Conviction</span>
            <div className="flex-1 h-1.5 bg-bg-2 rounded overflow-hidden">
              <div className="h-full bg-amber" style={{ width: `${report.conviction}%` }} />
            </div>
            <span className="num text-amber">{report.conviction}</span>
          </div>
          <p className="text-text-dim leading-relaxed">{report.thesis}</p>
          <div className="flex gap-3">
            <span className="micro-label">Stop {money(report.suggested_stop)}</span>
            <span className="micro-label">Target {money(report.suggested_target)}</span>
          </div>
          <button
            className="btn-amber w-full flex items-center justify-center gap-1.5"
            onClick={() => {
              setSymbol(symbol);
              navigate('/positions');
            }}
          >
            <Zap size={12} /> Trade this
          </button>
        </div>
      )}
    </div>
  );
}

function ResearchFeed() {
  const { watchlist } = useAppData();
  const briefingQ = usePolling<Briefing>(() => api.briefing(), 60000);
  const briefing = briefingQ.data;
  const symbols = useMemo(() => {
    const fromBriefing = briefing?.items.map((i) => i.symbol) ?? [];
    return Array.from(new Set([...fromBriefing, ...watchlist])).slice(0, 8);
  }, [briefing, watchlist]);

  return (
    <Panel
      title="AI Research"
      right={briefing && <span className="micro-label">{timeAgo(briefing.generated_at)}</span>}
    >
      <div className="overflow-auto h-full p-2 space-y-2">
        {briefing && (
          <div className="border border-amber/20 rounded bg-amber/5 p-2.5 space-y-1">
            <div className="flex items-center justify-between">
              <span className="micro-label text-amber">Morning Briefing</span>
              <Badge tone="amber">{briefing.regime}</Badge>
            </div>
            <p className="text-xs text-text-dim leading-relaxed">{briefing.summary}</p>
          </div>
        )}
        {briefingQ.loading && !briefing && <Spinner label="briefing" />}
        {symbols.length === 0 && !briefingQ.loading && <Empty label="No symbols to analyze" />}
        {symbols.map((s) => (
          <ResearchCard key={s} symbol={s} />
        ))}
      </div>
    </Panel>
  );
}

/* ---------- Activity log ---------- */
function ActivityLog() {
  const ordersQ = usePolling<Order[]>(() => api.orders('all'), 6000);
  const orders = (ordersQ.data ?? [])
    .slice()
    .sort((a, b) => +new Date(b.submitted_at) - +new Date(a.submitted_at))
    .slice(0, 25);

  const statusTone = (s: string): 'up' | 'down' | 'amber' | 'neutral' => {
    const v = s.toLowerCase();
    if (v.includes('fill')) return 'up';
    if (v.includes('cancel') || v.includes('reject') || v.includes('veto')) return 'down';
    if (v.includes('new') || v.includes('accept') || v.includes('pending')) return 'amber';
    return 'neutral';
  };

  return (
    <Panel
      title="Activity Log"
      right={
        <Link to="/trades" className="text-2xs uppercase tracking-wider text-amber hover:underline">
          View ledger →
        </Link>
      }
    >
      {ordersQ.loading && orders.length === 0 ? (
        <Spinner label="loading" />
      ) : orders.length === 0 ? (
        <Empty label="No recent activity" />
      ) : (
        <div className="overflow-auto h-full">
          {orders.map((o) => (
            <div key={o.id} className="flex items-center gap-2 px-3 h-8 data-row text-xs">
              <span className="num text-muted w-12 shrink-0">{timeOnly(o.submitted_at)}</span>
              <span
                className={`uppercase font-medium w-9 ${
                  o.side === 'buy' ? 'text-up' : 'text-down'
                }`}
              >
                {o.side}
              </span>
              <span className="font-mono text-text w-14">{o.symbol}</span>
              <span className="num text-text-dim w-10 text-right">{o.qty}</span>
              <span className="text-muted uppercase text-2xs w-14">{o.type}</span>
              <span className="ml-auto">
                <Badge tone={statusTone(o.status)}>{o.status}</Badge>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* ---------- Dashboard ---------- */
export function Dashboard() {
  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <EquityStrip />
      <div className="grid grid-cols-12 gap-3 flex-1 min-h-0">
        {/* Left: watchlist + activity */}
        <div className="col-span-3 flex flex-col gap-3 min-h-0">
          <div className="flex-1 min-h-0">
            <WatchlistPanel />
          </div>
          <div className="h-64 shrink-0">
            <ActivityLog />
          </div>
        </div>
        {/* Center: chart */}
        <div className="col-span-6 min-h-0">
          <ChartPanel />
        </div>
        {/* Right: AI research */}
        <div className="col-span-3 min-h-0">
          <ResearchFeed />
        </div>
      </div>
    </div>
  );
}
