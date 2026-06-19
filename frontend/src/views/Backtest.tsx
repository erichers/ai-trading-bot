import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from 'lightweight-charts';
import { FlaskConical, Play, History } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type {
  Backtest as BacktestResult,
  BacktestLookback,
  BacktestMetrics,
  BacktestEquityPoint,
  BacktestTrade,
  Bot,
  Strategy,
} from '@/api/types';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { pct, money, num, timeOnly, dateShort, colorBySign } from '@/lib/format';

// ---- selectable config (bot or strategy) --------------------------------

type SelOption = {
  key: string; // e.g. "bot:abc" / "strat:xyz"
  kind: 'bot' | 'strategy';
  id: string;
  name: string;
  mode: string;
  timeframe: string;
};

const LOOKBACKS: { value: BacktestLookback; label: string }[] = [
  { value: '1D', label: '1D' },
  { value: '2D', label: '2D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
];

const TIMEFRAMES = ['', '1Min', '5Min', '15Min', '1Hour', '1Day'];

// ---- equity curve chart (lightweight-charts area series) ----------------

const toTime = (iso: string): UTCTimestamp =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

function EquityChart({ points }: { points: BacktestEquityPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0d1117' },
        textColor: '#8b94a3',
        fontFamily: 'monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: '#1f2530' },
        horzLines: { color: '#1f2530' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1f2530' },
      timeScale: { borderColor: '#1f2530', timeVisible: true, secondsVisible: false },
      width: el.clientWidth || 600,
      height: el.clientHeight || 280,
      autoSize: false,
    });
    chartRef.current = chart;
    areaRef.current = chart.addAreaSeries({
      lineColor: '#f7a01d',
      topColor: 'rgba(247,160,29,0.28)',
      bottomColor: 'rgba(247,160,29,0.02)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      if (w > 0 && h > 0) {
        chart.applyOptions({ width: w, height: h });
        chart.timeScale().fitContent();
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!areaRef.current || !chartRef.current) return;
    // De-dup + sort by time (lightweight-charts requires ascending, unique).
    const seen = new Map<number, number>();
    for (const p of points) {
      const t = toTime(p.t);
      if (!Number.isNaN(t)) seen.set(t as number, p.equity);
    }
    const data: AreaData[] = [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, value]) => ({ time: t as UTCTimestamp, value }));
    areaRef.current.setData(data);
    chartRef.current.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="h-full w-full" />;
}

// ---- metric cards --------------------------------------------------------

function MetricCard({
  label,
  value,
  tone = 'text-text',
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="panel flex flex-col gap-1 px-3 py-2.5 min-w-0">
      <span className="micro-label">{label}</span>
      <span className={`num text-lg tabular-nums leading-none ${tone}`}>{value}</span>
      {sub && <span className="text-2xs text-muted tabular-nums">{sub}</span>}
    </div>
  );
}

function MetricsCards({ m }: { m: BacktestMetrics }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <MetricCard
        label="Total Return"
        value={pct(m.total_return_pct)}
        tone={colorBySign(m.total_return_pct)}
      />
      <MetricCard
        label="Win Rate"
        value={`${num(m.win_rate, 1)}%`}
        sub={`${num(m.wins, 0)}W / ${num(m.losses, 0)}L`}
      />
      <MetricCard label="# Trades" value={num(m.num_trades, 0)} />
      <MetricCard
        label="Profit Factor"
        value={Number.isFinite(m.profit_factor) ? num(m.profit_factor, 2) : '∞'}
        tone={m.profit_factor >= 1 ? 'text-up' : 'text-down'}
      />
      <MetricCard
        label="Max Drawdown"
        value={pct(-Math.abs(m.max_drawdown_pct))}
        tone="text-down"
      />
      <MetricCard
        label="Avg Win / Loss"
        value={pct(m.avg_win_pct)}
        tone="text-up"
        sub={pct(m.avg_loss_pct)}
      />
    </div>
  );
}

// ---- trades table --------------------------------------------------------

function SideBadge({ side, right }: { side: 'long' | 'short'; right?: 'call' | 'put' }) {
  if (right) return <Badge tone={right === 'call' ? 'up' : 'down'}>{right}</Badge>;
  return <Badge tone={side === 'long' ? 'up' : 'down'}>{side}</Badge>;
}

function TradesTable({ trades }: { trades: BacktestTrade[] }) {
  if (trades.length === 0) return <Empty label="No trades fired over this window" />;
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-panel z-10">
          <tr className="text-left text-muted border-b border-border">
            <th className="px-2 py-1.5 micro-label font-normal">Symbol</th>
            <th className="px-2 py-1.5 micro-label font-normal">Side</th>
            <th className="px-2 py-1.5 micro-label font-normal">Entry</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Entry Px</th>
            <th className="px-2 py-1.5 micro-label font-normal">Exit</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Exit Px</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">P&amp;L %</th>
            <th className="px-2 py-1.5 micro-label font-normal">Reason</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {trades.map((t, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-panel-2">
              <td className="px-2 py-1.5 font-mono font-semibold text-text">{t.symbol}</td>
              <td className="px-2 py-1.5">
                <SideBadge side={t.side} right={t.right} />
              </td>
              <td
                className="px-2 py-1.5 font-mono whitespace-nowrap text-text-dim"
                title={t.entry_time}
              >
                {dateShort(t.entry_time)} {timeOnly(t.entry_time)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{money(t.entry_price)}</td>
              <td
                className="px-2 py-1.5 font-mono whitespace-nowrap text-text-dim"
                title={t.exit_time}
              >
                {dateShort(t.exit_time)} {timeOnly(t.exit_time)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{money(t.exit_price)}</td>
              <td className={`px-2 py-1.5 text-right font-mono font-semibold ${colorBySign(t.pnl_pct)}`}>
                {pct(t.pnl_pct)}
              </td>
              <td className="px-2 py-1.5 font-mono text-text-dim">{t.exit_reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- main view -----------------------------------------------------------

export function Backtest() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [bots, setBots] = useState<Bot[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);

  const [selKey, setSelKey] = useState<string>('');
  const [lookback, setLookback] = useState<BacktestLookback>('1W');
  const [timeframe, setTimeframe] = useState<string>(''); // '' = use config default

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engineDown, setEngineDown] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [symbolView, setSymbolView] = useState<string>('all'); // 'all' or a symbol

  // Build the unified option list (bots + strategies).
  const options = useMemo<SelOption[]>(() => {
    const botOpts: SelOption[] = bots.map((b) => ({
      key: `bot:${b.id}`,
      kind: 'bot',
      id: b.id,
      name: b.name || 'Untitled bot',
      mode: b.mode,
      timeframe: '',
    }));
    const stratOpts: SelOption[] = strategies.map((s) => ({
      key: `strat:${s.id}`,
      kind: 'strategy',
      id: s.id,
      name: s.name || 'Untitled strategy',
      mode: s.mode,
      timeframe: s.timeframe || '',
    }));
    return [...botOpts, ...stratOpts];
  }, [bots, strategies]);

  const selected = useMemo(() => options.find((o) => o.key === selKey), [options, selKey]);

  // Load both lists once.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [b, s] = await Promise.allSettled([api.bots(), api.strategies()]);
      if (!alive) return;
      if (b.status === 'fulfilled') setBots(b.value);
      if (s.status === 'fulfilled') setStrategies(s.value);
      setListsLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Deep-link: ?bot=<id> (or ?strategy=<id>) preselects + auto-runs once lists load.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!listsLoaded || autoRanRef.current) return;
    const botId = searchParams.get('bot');
    const stratId = searchParams.get('strategy');
    const lb = searchParams.get('lookback') as BacktestLookback | null;
    if (lb && LOOKBACKS.some((l) => l.value === lb)) setLookback(lb);

    let key = '';
    if (botId && bots.some((b) => b.id === botId)) key = `bot:${botId}`;
    else if (stratId && strategies.some((s) => s.id === stratId)) key = `strat:${stratId}`;
    if (key) {
      setSelKey(key);
      autoRanRef.current = true;
      // Run on next tick once selKey state is committed.
      const opt = options.find((o) => o.key === key);
      const useLb = lb && LOOKBACKS.some((l) => l.value === lb) ? lb : lookback;
      if (opt) void run(opt, useLb, '');
    } else if (!selKey && options.length > 0) {
      setSelKey(options[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listsLoaded]);

  async function run(opt?: SelOption, lb?: BacktestLookback, tf?: string) {
    const target = opt ?? selected;
    if (!target) {
      setError('Select a bot or strategy first');
      return;
    }
    const useLb = lb ?? lookback;
    const useTf = tf !== undefined ? tf : timeframe;
    setRunning(true);
    setError(null);
    setEngineDown(false);
    try {
      const body =
        target.kind === 'bot'
          ? { bot_id: target.id, lookback: useLb, timeframe: useTf || undefined }
          : { strategy_id: target.id, lookback: useLb, timeframe: useTf || undefined };
      const res = await api.backtest(body);
      setResult(res);
      setSymbolView('all');
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
        setEngineDown(true);
      } else {
        setError((e as Error).message || 'Backtest failed');
      }
    } finally {
      setRunning(false);
    }
  }

  // Sync the selection into the URL (no auto-run) so a refresh keeps context.
  function onSelect(key: string) {
    setSelKey(key);
    const opt = options.find((o) => o.key === key);
    const next = new URLSearchParams(searchParams);
    next.delete('bot');
    next.delete('strategy');
    if (opt) next.set(opt.kind === 'bot' ? 'bot' : 'strategy', opt.id);
    setSearchParams(next, { replace: true });
  }

  // Symbol switcher options + the metrics/curve/trades to display.
  const symbolOptions = useMemo(() => {
    if (!result) return [];
    const opts = [{ value: 'all', label: 'All' }];
    for (const ps of result.per_symbol) opts.push({ value: ps.symbol, label: ps.symbol });
    return opts;
  }, [result]);

  const activePerSymbol = useMemo(() => {
    if (!result || symbolView === 'all') return null;
    return result.per_symbol.find((ps) => ps.symbol === symbolView) ?? null;
  }, [result, symbolView]);

  // Equity curve for the chart: per-symbol when one is selected, otherwise the
  // first symbol's curve as a stand-in for "combined" (backend gives per-symbol).
  const chartPoints = useMemo<BacktestEquityPoint[]>(() => {
    if (!result) return [];
    if (activePerSymbol) return activePerSymbol.equity_curve;
    return result.per_symbol[0]?.equity_curve ?? [];
  }, [result, activePerSymbol]);

  const displayMetrics = activePerSymbol ? activePerSymbol.metrics : result?.combined;

  const allTrades = useMemo<BacktestTrade[]>(() => {
    if (!result) return [];
    if (activePerSymbol) return activePerSymbol.trades;
    return result.per_symbol.flatMap((ps) => ps.trades);
  }, [result, activePerSymbol]);

  // ---- selector row -------------------------------------------------------

  const selectorRow = (
    <div className="panel p-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1 min-w-[220px]">
          <span className="micro-label">Bot / Strategy</span>
          <select
            className="input font-mono text-xs py-1.5"
            value={selKey}
            onChange={(e) => onSelect(e.target.value)}
          >
            {options.length === 0 && <option value="">No bots or strategies</option>}
            {bots.length > 0 && (
              <optgroup label="Bots">
                {bots.map((b) => (
                  <option key={`bot:${b.id}`} value={`bot:${b.id}`}>
                    {(b.name || 'Untitled')} · {b.mode}
                  </option>
                ))}
              </optgroup>
            )}
            {strategies.length > 0 && (
              <optgroup label="Strategies">
                {strategies.map((s) => (
                  <option key={`strat:${s.id}`} value={`strat:${s.id}`}>
                    {(s.name || 'Untitled')} · {s.mode}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="micro-label">Lookback</span>
          <Toggle
            value={lookback}
            onChange={(v) => setLookback(v as BacktestLookback)}
            options={LOOKBACKS}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="micro-label">Timeframe</span>
          <select
            className="input font-mono text-xs py-1.5"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf || 'default'} value={tf}>
                {tf || 'Config default'}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn-amber flex items-center gap-1.5 py-1.5 px-4"
          onClick={() => void run()}
          disabled={running || !selected}
        >
          <Play size={13} /> {running ? 'Simulating…' : 'Run Backtest'}
        </button>

        {selected && (
          <div className="flex items-center gap-1.5 text-2xs text-muted ml-auto">
            <Badge tone={selected.kind === 'bot' ? 'amber' : 'up'}>{selected.kind}</Badge>
            <span className="micro-label">{selected.mode}</span>
          </div>
        )}
      </div>
    </div>
  );

  // ---- results body -------------------------------------------------------

  let body: React.ReactNode;
  if (running) {
    body = (
      <div className="panel flex-1 min-h-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 py-10">
          <Spinner label="Simulating over real history…" />
          <span className="text-2xs text-muted micro-label">
            Replaying {lookback} of bars — this can take 10–30s.
          </span>
        </div>
      </div>
    );
  } else if (engineDown) {
    body = (
      <div className="panel flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4 py-10">
        <FlaskConical size={22} className="text-amber animate-pulse" />
        <span className="text-amber text-xs micro-label">Backtest engine starting…</span>
        <button className="btn mt-1" onClick={() => void run()}>
          Retry
        </button>
      </div>
    );
  } else if (error) {
    body = (
      <div className="panel flex-1 min-h-0">
        <ErrorState label={error} onRetry={() => void run()} />
      </div>
    );
  } else if (!result) {
    body = (
      <div className="panel flex-1 min-h-0">
        <Empty label="Pick a bot or strategy and a lookback, then Run Backtest." />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 flex-1 min-h-0">
        {/* header summary */}
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
          <span className="text-text-dim text-sm font-mono">{result.config_name}</span>
          <Badge tone="amber">{result.lookback}</Badge>
          <Badge tone="neutral">{result.timeframe}</Badge>
          <span className="font-mono">
            {dateShort(result.start)} → {dateShort(result.end)}
          </span>
        </div>

        {displayMetrics && <MetricsCards m={displayMetrics} />}

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 flex-1 min-h-0">
          <Panel
            title="Equity Curve"
            right={
              symbolOptions.length > 1 ? (
                <Toggle value={symbolView} onChange={setSymbolView} options={symbolOptions} />
              ) : undefined
            }
            className="min-h-[300px]"
            bodyClassName="min-h-0 p-1"
          >
            {chartPoints.length > 0 ? (
              <EquityChart points={chartPoints} />
            ) : (
              <Empty label="No equity curve for this selection" />
            )}
          </Panel>

          <Panel title="Trades" className="min-h-[300px]" bodyClassName="min-h-0">
            <TradesTable trades={allTrades} />
          </Panel>
        </div>

        {result.note && (
          <div className="panel px-3 py-2 text-2xs text-amber/90 micro-label border border-amber/30 bg-amber/5">
            {result.note}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center gap-2">
        <History size={16} className="text-amber" />
        <h1 className="text-sm micro-label text-text-dim">Backtest</h1>
      </div>
      {selectorRow}
      {body}
    </div>
  );
}
