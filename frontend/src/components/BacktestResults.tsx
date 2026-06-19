import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type UTCTimestamp,
  ColorType,
  CrosshairMode,
} from 'lightweight-charts';
import type {
  Backtest as BacktestResult,
  BacktestMetrics,
  BacktestEquityPoint,
  BacktestTrade,
} from '@/api/types';
import { Panel, Empty, Badge, Toggle } from '@/components/ui';
import { pct, money, num, timeOnly, dateShort, colorBySign } from '@/lib/format';

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
        background: { type: ColorType.Solid, color: '#000000' },
        textColor: '#A8A8A8',
        fontFamily: 'monospace',
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false },
      width: el.clientWidth || 600,
      height: el.clientHeight || 280,
      autoSize: false,
    });
    chartRef.current = chart;
    areaRef.current = chart.addAreaSeries({
      lineColor: '#CCFF00',
      topColor: 'rgba(204,255,0,0.28)',
      bottomColor: 'rgba(204,255,0,0.02)',
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
    <div className="panel flex flex-col gap-0.5 px-2.5 py-1.5 min-w-0">
      <span className="micro-label">{label}</span>
      <span className={`num text-base tabular-nums leading-none ${tone}`}>{value}</span>
      {sub && <span className="text-2xs text-muted tabular-nums">{sub}</span>}
    </div>
  );
}

function MetricsCards({ m }: { m: BacktestMetrics }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-1.5">
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
            <th className="px-2 py-1 micro-label font-normal">Symbol</th>
            <th className="px-2 py-1 micro-label font-normal">Side</th>
            <th className="px-2 py-1 micro-label font-normal">Entry</th>
            <th className="px-2 py-1 micro-label font-normal text-right">Entry Px</th>
            <th className="px-2 py-1 micro-label font-normal">Exit</th>
            <th className="px-2 py-1 micro-label font-normal text-right">Exit Px</th>
            <th className="px-2 py-1 micro-label font-normal text-right">P&amp;L %</th>
            <th className="px-2 py-1 micro-label font-normal">Reason</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {trades.map((t, i) => (
            <tr key={i} className="border-b border-border/50 hover:bg-panel-2">
              <td className="px-2 py-1 font-mono font-semibold text-text">{t.symbol}</td>
              <td className="px-2 py-1">
                <SideBadge side={t.side} right={t.right} />
              </td>
              <td
                className="px-2 py-1 font-mono whitespace-nowrap text-text-dim"
                title={t.entry_time}
              >
                {dateShort(t.entry_time)} {timeOnly(t.entry_time)}
              </td>
              <td className="px-2 py-1 text-right font-mono">{money(t.entry_price)}</td>
              <td
                className="px-2 py-1 font-mono whitespace-nowrap text-text-dim"
                title={t.exit_time}
              >
                {dateShort(t.exit_time)} {timeOnly(t.exit_time)}
              </td>
              <td className="px-2 py-1 text-right font-mono">{money(t.exit_price)}</td>
              <td className={`px-2 py-1 text-right font-mono font-semibold ${colorBySign(t.pnl_pct)}`}>
                {pct(t.pnl_pct)}
              </td>
              <td className="px-2 py-1 font-mono text-text-dim">{t.exit_reason || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- combined results: metrics + per-symbol equity curve + trades + note --

export function BacktestResults({
  result,
  showHeader = true,
}: {
  result: BacktestResult;
  /** Show the config-name / lookback / date-range summary header row. */
  showHeader?: boolean;
}) {
  // Per-symbol switcher: 'all' (combined) or a specific symbol.
  const [symbolView, setSymbolView] = useState<string>('all');

  // Reset the view to "all" whenever a fresh result comes in.
  useEffect(() => {
    setSymbolView('all');
  }, [result]);

  const symbolOptions = useMemo(() => {
    const opts = [{ value: 'all', label: 'All' }];
    for (const ps of result.per_symbol) opts.push({ value: ps.symbol, label: ps.symbol });
    return opts;
  }, [result]);

  const activePerSymbol = useMemo(() => {
    if (symbolView === 'all') return null;
    return result.per_symbol.find((ps) => ps.symbol === symbolView) ?? null;
  }, [result, symbolView]);

  // Equity curve: per-symbol when one is selected, otherwise the first symbol's
  // curve as a stand-in for "combined" (backend gives per-symbol).
  const chartPoints = useMemo<BacktestEquityPoint[]>(() => {
    if (activePerSymbol) return activePerSymbol.equity_curve;
    return result.per_symbol[0]?.equity_curve ?? [];
  }, [result, activePerSymbol]);

  const displayMetrics = activePerSymbol ? activePerSymbol.metrics : result.combined;

  const allTrades = useMemo<BacktestTrade[]>(() => {
    if (activePerSymbol) return activePerSymbol.trades;
    return result.per_symbol.flatMap((ps) => ps.trades);
  }, [result, activePerSymbol]);

  return (
    <div className="flex flex-col gap-2 flex-1 min-h-0">
      {showHeader && (
        <div className="flex flex-wrap items-center gap-2 text-2xs text-muted">
          <span className="text-text-dim text-sm font-mono">{result.config_name}</span>
          <Badge tone="amber">{result.lookback}</Badge>
          <Badge tone="neutral">{result.timeframe}</Badge>
          <span className="font-mono">
            {dateShort(result.start)} → {dateShort(result.end)}
          </span>
        </div>
      )}

      {displayMetrics && <MetricsCards m={displayMetrics} />}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2 flex-1 min-h-0">
        <Panel
          title="Equity Curve"
          right={
            symbolOptions.length > 1 ? (
              <Toggle value={symbolView} onChange={setSymbolView} options={symbolOptions} />
            ) : undefined
          }
          className="min-h-[260px]"
          bodyClassName="min-h-0 p-1"
        >
          {chartPoints.length > 0 ? (
            <EquityChart points={chartPoints} />
          ) : (
            <Empty label="No equity curve for this selection" />
          )}
        </Panel>

        <Panel title="Trades" className="min-h-[260px]" bodyClassName="min-h-0">
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
