import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp, ArrowRight } from 'lucide-react';
import { api } from '@/api/client';
import type { PortfolioHistory } from '@/api/types';
import { usePolling } from '@/hooks/usePolling';
import { Panel, Spinner, Empty, ErrorState, Toggle, HelpTip } from '@/components/ui';
import { PnlHistogram, EquityAreaChart } from '@/components/PortfolioChart';
import { money, signed, pct, num, colorBySign } from '@/lib/format';

const PERIODS = [
  { value: '1D', label: '1D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '1A', label: '1Y' },
  { value: 'all', label: 'All' },
];

function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function Stat({ label, value, sub, tone, help }: { label: string; value: string; sub?: string; tone?: string; help?: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-center px-4 py-2.5 border-r border-border last:border-r-0 flex-1 min-w-[130px]">
      <span className="micro-label flex items-center gap-1">{label}{help && <HelpTip title={label}>{help}</HelpTip>}</span>
      <span className={`num text-2xl leading-tight ${tone ?? 'text-text'}`}>{value}</span>
      {sub && <span className="num text-2xs text-text-dim">{sub}</span>}
    </div>
  );
}

export function Pnl() {
  const [period, setPeriod] = useState('1M');
  const histQ = usePolling<PortfolioHistory>(() => api.portfolioHistory(period), 30000, [period]);
  const hist = histQ.data;

  const stats = useMemo(() => {
    const pts = hist?.points ?? [];
    if (pts.length === 0) return null;
    let best = pts[0], worst = pts[0], wins = 0, losses = 0;
    for (const p of pts) {
      if (p.pnl > best.pnl) best = p;
      if (p.pnl < worst.pnl) worst = p;
      if (p.pnl > 0) wins++;
      else if (p.pnl < 0) losses++;
    }
    const periodsCounted = wins + losses;
    return { best, worst, wins, losses, winRate: periodsCounted ? (wins / periodsCounted) * 100 : 0 };
  }, [hist]);

  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto max-w-6xl flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <TrendingUp size={16} className="text-amber" />
          <h1 className="text-sm micro-label text-text-dim">Profit &amp; Loss</h1>
          <span className="text-2xs text-muted">Realized + unrealized P&L over time — pick a range</span>
          <div className="ml-auto"><Toggle value={period} onChange={setPeriod} options={PERIODS} /></div>
        </div>

        {!hist ? (
          histQ.error ? <ErrorState label="P&L history unavailable" onRetry={histQ.refetch} /> : <Spinner label="Loading P&L" />
        ) : (
          <>
            <div className="panel flex flex-wrap">
              <Stat label={`Total P&L (${period})`} value={signed(hist.total_pl)} sub={pct(hist.total_pl_pct)} tone={colorBySign(hist.total_pl)} help="Change in account equity across the selected range." />
              <Stat label="Start → End" value={money(hist.end_equity)} sub={`from ${money(hist.base_value)}`} />
              {stats && <Stat label="Best period" value={signed(stats.best.pnl)} sub={fmtDate(stats.best.t)} tone="text-up" />}
              {stats && <Stat label="Worst period" value={signed(stats.worst.pnl)} sub={fmtDate(stats.worst.t)} tone="text-down" />}
              {stats && <Stat label="Win rate" value={`${num(stats.winRate, 0)}%`} sub={`${stats.wins}↑ / ${stats.losses}↓ periods`} help="Share of time-periods in this range that ended green." />}
            </div>

            <Panel title="P&L per period" className="h-[260px]" bodyClassName="min-h-0 p-2">
              {hist.points.length ? <PnlHistogram points={hist.points} /> : <Empty label="No data" />}
            </Panel>

            <Panel title="Cumulative equity" className="h-[260px]" bodyClassName="min-h-0 p-2">
              {hist.points.length ? <EquityAreaChart points={hist.points} /> : <Empty label="No data" />}
            </Panel>

            <Panel title="Breakdown" bodyClassName="overflow-auto max-h-80">
              {hist.points.length === 0 ? (
                <Empty label="No data" />
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-muted border-b border-border sticky top-0 bg-panel">
                    <tr>
                      <th className="text-left px-2 py-1 micro-label font-normal">Date</th>
                      <th className="text-right px-2 py-1 micro-label font-normal">Equity</th>
                      <th className="text-right px-2 py-1 micro-label font-normal">P&L</th>
                      <th className="text-right px-2 py-1 micro-label font-normal">%</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {[...hist.points].reverse().map((p, i) => (
                      <tr key={i} className="border-b border-border/50 hover:bg-panel-2">
                        <td className="px-2 py-1 font-mono text-text-dim">{fmtDate(p.t)}</td>
                        <td className="px-2 py-1 text-right num">{money(p.equity)}</td>
                        <td className={`px-2 py-1 text-right num ${colorBySign(p.pnl)}`}>{signed(p.pnl)}</td>
                        <td className={`px-2 py-1 text-right num ${colorBySign(p.pnl_pct)}`}>{pct(p.pnl_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <Link to="/portfolio" className="btn flex items-center gap-1"><ArrowRight size={12} /> Portfolio</Link>
          <Link to="/trades" className="btn flex items-center gap-1"><ArrowRight size={12} /> Trade ledger</Link>
        </div>
      </div>
    </div>
  );
}
