import * as React from 'react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { X, Sparkles, ChevronDown, ChevronRight, Zap, GripVertical, RotateCcw, Move, Check, Lock } from 'lucide-react';
import * as RGLNamespace from 'react-grid-layout';

// react-grid-layout's CJS exposes Responsive/WidthProvider as NAMED exports;
// the default export is only the basic GridLayout (no namespace members), so
// pull them off the module namespace instead.
const { Responsive, WidthProvider } = RGLNamespace as unknown as {
  Responsive: React.ComponentType<Record<string, unknown>>;
  WidthProvider: <P>(c: React.ComponentType<P>) => React.ComponentType<P>;
};

// Minimal layout-item shape we persist (matches react-grid-layout's Layout).
interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}
type GridLayouts = Record<string, GridItem[]>;
import { api } from '@/api/client';
import type { Briefing, Order, ResearchReport, RiskEvent, SnapshotMap, Timeframe } from '@/api/types';
import { useAppData } from '@/hooks/useAppData';
import { useSymbol } from '@/hooks/useSymbol';
import { usePolling } from '@/hooks/usePolling';
import { useBars } from '@/hooks/useBars';
import { CandleChart, type Overlay } from '@/components/CandleChart';
import { Sparkline } from '@/components/Sparkline';
import { BotSetup } from '@/components/BotSetup';
import { ContractLabel } from '@/components/ContractLabel';
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

// A grip rendered in a Panel's `right` slot. Only this element is the grid
// drag handle (draggableHandle=".drag-handle"), so all other controls inside a
// panel stay fully clickable.
function DragHandle({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {children}
      <span className="drag-handle inline-flex" title="Drag to move">
        <GripVertical size={13} />
      </span>
    </div>
  );
}

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
    <div className="flex flex-col justify-center px-3 py-1.5 border-r border-border last:border-r-0 flex-1">
      <span className="micro-label">{label}</span>
      <span className={`num ${big ? 'text-lg' : 'text-sm'} ${tone ?? 'text-text'}`}>{value}</span>
      {sub && <span className={`num text-2xs ${tone ?? 'text-text-dim'}`}>{sub}</span>}
    </div>
  );
}

function EquityStrip() {
  const { account, openRisk } = useAppData();
  return (
    <div className="panel flex flex-row items-stretch h-full">
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
      <div className="drag-handle flex items-center px-3 border-l border-border" title="Drag to move">
        <GripVertical size={14} />
      </div>
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
    <Panel title="Watchlist" right={<DragHandle><span className="micro-label">{watchlist.length}</span></DragHandle>}>
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
        <DragHandle>
          {price !== undefined && (
            <span className={`num text-sm ${colorBySign(chg)}`}>
              {money(price)} {chg !== undefined && <span className="text-2xs">{pct(chg)}</span>}
            </span>
          )}
          <Toggle value={tf} onChange={(v) => setTf(v as Timeframe)} options={TIMEFRAMES} />
        </DragHandle>
      }
    >
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
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
        <div className="flex-1 min-h-0 p-1">
          {barsQ.loading && bars.length === 0 ? (
            <Spinner label="loading bars" />
          ) : barsQ.error && bars.length === 0 ? (
            <ErrorState label="No bar data" onRetry={barsQ.refetch} />
          ) : bars.length === 0 ? (
            <Empty label="No data" />
          ) : (
            <CandleChart bars={bars} overlays={ov} />
          )}
        </div>
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
      right={
        <DragHandle>
          {briefing && <span className="micro-label">{timeAgo(briefing.generated_at)}</span>}
        </DragHandle>
      }
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
type ActivityRow =
  | { kind: 'order'; id: string; ts: string; order: Order }
  | { kind: 'risk'; id: string; ts: string; event: RiskEvent };

function ActivityLog() {
  const ordersQ = usePolling<Order[]>(() => api.orders('all'), 6000);
  // Only veto/warned risk events surface here — these must never be silent.
  const riskQ = usePolling<RiskEvent[]>(() => api.riskEvents(50), 6000);

  const statusTone = (s: string): 'up' | 'down' | 'amber' | 'neutral' => {
    const v = s.toLowerCase();
    if (v.includes('fill')) return 'up';
    if (v.includes('cancel') || v.includes('reject') || v.includes('veto')) return 'down';
    if (v.includes('new') || v.includes('accept') || v.includes('pending')) return 'amber';
    return 'neutral';
  };

  const rows = useMemo<ActivityRow[]>(() => {
    const orderRows: ActivityRow[] = (ordersQ.data ?? []).map((o) => ({
      kind: 'order',
      id: `o-${o.id}`,
      ts: o.submitted_at,
      order: o,
    }));
    const riskRows: ActivityRow[] = (riskQ.data ?? [])
      .filter((e) => e.decision === 'vetoed' || e.decision === 'warned')
      .map((e) => ({ kind: 'risk', id: `r-${e.id}`, ts: e.created_at, event: e }));
    return [...orderRows, ...riskRows]
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
      .slice(0, 30);
  }, [ordersQ.data, riskQ.data]);

  const loading = ordersQ.loading && riskQ.loading && rows.length === 0;

  return (
    <Panel
      title="Activity Log"
      right={
        <DragHandle>
          <Link to="/trades" className="text-2xs uppercase tracking-wider text-amber hover:underline">
            View ledger →
          </Link>
        </DragHandle>
      }
    >
      {loading ? (
        <Spinner label="loading" />
      ) : rows.length === 0 ? (
        <Empty label="No recent activity" />
      ) : (
        <div className="overflow-auto h-full">
          {rows.map((row) =>
            row.kind === 'order' ? (
              <div key={row.id} className="flex items-center gap-2 px-3 h-8 data-row text-xs">
                <span className="num text-muted w-12 shrink-0">{timeOnly(row.order.submitted_at)}</span>
                <span
                  className={`uppercase font-medium w-9 ${
                    row.order.side === 'buy' ? 'text-up' : 'text-down'
                  }`}
                >
                  {row.order.side}
                </span>
                <ContractLabel symbol={row.order.symbol} className="text-2xs flex-1 min-w-0 truncate" />
                <span className="num text-text-dim w-10 text-right">{row.order.qty}</span>
                <span className="text-muted uppercase text-2xs w-14">{row.order.type}</span>
                <span className="ml-auto">
                  <Badge tone={statusTone(row.order.status)}>{row.order.status}</Badge>
                </span>
              </div>
            ) : (
              <div
                key={row.id}
                className={`flex items-center gap-2 px-3 h-8 data-row text-xs ${
                  row.event.decision === 'vetoed' ? 'bg-down/5' : 'bg-amber/5'
                }`}
                title={row.event.rules.map((r) => r.message).join(' · ')}
              >
                <span className="num text-muted w-12 shrink-0">{timeOnly(row.event.created_at)}</span>
                <span
                  className={`uppercase font-medium w-9 ${
                    row.event.side === 'buy' ? 'text-up' : 'text-down'
                  }`}
                >
                  {row.event.side}
                </span>
                <ContractLabel symbol={row.event.symbol} className="text-2xs w-28 shrink-0 truncate" />
                <span className="num text-text-dim w-10 text-right">{row.event.qty}</span>
                <span
                  className={`truncate flex-1 text-2xs ${
                    row.event.decision === 'vetoed' ? 'text-down' : 'text-amber'
                  }`}
                >
                  {row.event.rules[0]?.message ?? 'risk'}
                </span>
                <span className="ml-auto">
                  <Badge tone={row.event.decision === 'vetoed' ? 'down' : 'amber'}>
                    {row.event.decision}
                  </Badge>
                </span>
              </div>
            ),
          )}
        </div>
      )}
    </Panel>
  );
}

/* ---------- Draggable / resizable dashboard ---------- */

const ResponsiveGridLayout = WidthProvider(Responsive);

const LAYOUT_KEY = 'tt_dashboard_layouts';
const ROW_HEIGHT = 30;
// Smart autofit: fewer columns as the viewport shrinks so tiles reflow/stack
// instead of getting crushed. react-grid-layout generates the per-breakpoint
// layouts from `lg` for any breakpoint we haven't explicitly saved.
const BREAKPOINTS = { lg: 1280, md: 996, sm: 768, xs: 480, xxs: 0 };
const COLS = { lg: 12, md: 12, sm: 6, xs: 4, xxs: 1 };

// 12-col grid. Strip full-width on top; chart large; AI feed tall on the right.
const DEFAULT_LAYOUT: GridItem[] = [
  { i: 'equity', x: 0, y: 0, w: 12, h: 2, minW: 4, minH: 2 },
  { i: 'watchlist', x: 0, y: 2, w: 3, h: 12, minW: 2, minH: 4 },
  { i: 'chart', x: 3, y: 2, w: 6, h: 16, minW: 3, minH: 6 },
  { i: 'research', x: 9, y: 2, w: 3, h: 16, minW: 2, minH: 6 },
  { i: 'activity', x: 0, y: 14, w: 3, h: 8, minW: 2, minH: 4 },
  { i: 'bots', x: 3, y: 18, w: 9, h: 12, minW: 3, minH: 6 },
];

const TILES: { i: string; render: () => ReactNode }[] = [
  { i: 'equity', render: () => <EquityStrip /> },
  { i: 'watchlist', render: () => <WatchlistPanel /> },
  { i: 'chart', render: () => <ChartPanel /> },
  { i: 'research', render: () => <ResearchFeed /> },
  { i: 'activity', render: () => <ActivityLog /> },
  { i: 'bots', render: () => <BotSetup /> },
];

// Ensure every known tile exists in a stored breakpoint layout (merge in any
// newly-added tiles using their defaults).
function mergeTiles(items: GridItem[]): GridItem[] {
  const byId = new Map(items.map((l) => [l.i, l]));
  return DEFAULT_LAYOUT.map((def) => byId.get(def.i) ?? def);
}

function loadLayouts(): GridLayouts {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as GridLayouts;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const out: GridLayouts = {};
        for (const k of Object.keys(parsed)) {
          if (Array.isArray(parsed[k])) out[k] = mergeTiles(parsed[k]);
        }
        if (!out.lg) out.lg = DEFAULT_LAYOUT;
        return out;
      }
    }
  } catch {
    /* ignore */
  }
  return { lg: DEFAULT_LAYOUT };
}

export function Dashboard() {
  const [layouts, setLayouts] = useState<GridLayouts>(() => loadLayouts());
  // Default LOCKED: the whole dashboard is fully clickable/scrollable. Flip to
  // "Arrange" to drag/resize tiles. This guarantees inner controls stay usable.
  const [editing, setEditing] = useState(false);

  const onLayoutChange = (_current: GridItem[], all: GridLayouts) => {
    setLayouts(all);
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(all));
    } catch {
      /* storage may be unavailable (private mode) — ignore */
    }
  };

  const resetLayout = () => {
    setLayouts({ lg: DEFAULT_LAYOUT });
    try {
      localStorage.removeItem(LAYOUT_KEY);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="micro-label flex items-center gap-1.5">
          {editing ? (
            <>
              <Move size={12} className="text-amber" /> Arrange mode — drag the grip to move, edges to resize
            </>
          ) : (
            <>
              <Lock size={11} /> Dashboard — interactive (click anywhere)
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          {editing && (
            <button className="btn flex items-center gap-1" onClick={resetLayout}>
              <RotateCcw size={12} /> Reset
            </button>
          )}
          <button
            className={`btn flex items-center gap-1 ${editing ? 'btn-amber' : ''}`}
            onClick={() => setEditing((e) => !e)}
            title={editing ? 'Lock layout' : 'Rearrange tiles'}
          >
            {editing ? (
              <>
                <Check size={12} /> Done
              </>
            ) : (
              <>
                <Move size={12} /> Arrange
              </>
            )}
          </button>
        </div>
      </div>
      <ResponsiveGridLayout
        className={`layout ${editing ? 'editing' : 'locked'}`}
        layouts={layouts}
        breakpoints={BREAKPOINTS}
        cols={COLS}
        rowHeight={ROW_HEIGHT}
        margin={[8, 8]}
        containerPadding={[2, 2]}
        isDraggable={editing}
        isResizable={editing}
        draggableHandle=".drag-handle"
        draggableCancel="input,textarea,select,button,a,[role='button'],.no-drag"
        onLayoutChange={onLayoutChange}
        compactType="vertical"
        resizeHandles={['se']}
        useCSSTransforms
      >
        {TILES.map((t) => (
          <div key={t.i}>{t.render()}</div>
        ))}
      </ResponsiveGridLayout>
    </div>
  );
}
