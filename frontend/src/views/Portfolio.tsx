import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Wallet, ArrowRight } from 'lucide-react';
import { api } from '@/api/client';
import type { Account, PortfolioHistory, Position } from '@/api/types';
import { usePolling } from '@/hooks/usePolling';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle, HelpTip } from '@/components/ui';
import { ContractLabel } from '@/components/ContractLabel';
import { EquityAreaChart } from '@/components/PortfolioChart';
import { money, moneyCompact, num, pct, signed, colorBySign } from '@/lib/format';

const PERIODS = [
  { value: '1D', label: '1D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
  { value: '1A', label: '1Y' },
  { value: 'all', label: 'All' },
];

function Stat({ label, value, sub, tone, help }: { label: string; value: string; sub?: string; tone?: string; help?: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-center px-4 py-2.5 border-r border-border last:border-r-0 flex-1 min-w-[130px]">
      <span className="micro-label flex items-center gap-1">
        {label}
        {help && <HelpTip title={label}>{help}</HelpTip>}
      </span>
      <span className={`num text-2xl leading-tight ${tone ?? 'text-text'}`}>{value}</span>
      {sub && <span className="num text-2xs text-text-dim">{sub}</span>}
    </div>
  );
}

export function Portfolio() {
  const [period, setPeriod] = useState('1M');
  const acctQ = usePolling<Account>(() => api.account(), 8000);
  const posQ = usePolling<Position[]>(() => api.positions(), 8000);
  const histQ = usePolling<PortfolioHistory>(() => api.portfolioHistory(period), 30000, [period]);

  const acct = acctQ.data;
  const positions = posQ.data ?? [];
  const hist = histQ.data;

  // Allocation: each position's market value as a share of (positions + cash).
  const alloc = useMemo(() => {
    const investedAbs = positions.reduce((s, p) => s + Math.abs(p.market_value), 0);
    const cash = Math.max(0, acct?.cash ?? 0);
    const total = investedAbs + cash || 1;
    const rows = positions
      .map((p) => ({ ...p, weight: (Math.abs(p.market_value) / total) * 100 }))
      .sort((a, b) => b.weight - a.weight);
    return { rows, cashWeight: (cash / total) * 100, cash };
  }, [positions, acct]);

  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto max-w-6xl flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Wallet size={16} className="text-amber" />
          <h1 className="text-sm micro-label text-text-dim">Portfolio</h1>
          <span className="text-2xs text-muted">Your account equity, allocation & holdings — live from Alpaca (paper)</span>
        </div>

        {/* hero stats */}
        {!acct ? (
          acctQ.error ? <ErrorState label="Account unavailable" onRetry={acctQ.refetch} /> : <Spinner label="Loading account" />
        ) : (
          <div className="panel flex flex-wrap">
            <Stat label="Equity" value={money(acct.equity)} tone="text-amber" help="Total account value: cash + the market value of all open positions." />
            <Stat
              label={`P&L (${period})`}
              value={hist ? signed(hist.total_pl) : '—'}
              sub={hist ? pct(hist.total_pl_pct) : undefined}
              tone={hist ? colorBySign(hist.total_pl) : undefined}
              help="Profit/loss over the selected time range, from Alpaca's portfolio history."
            />
            <Stat label="Day P&L" value={signed(acct.day_pl)} sub={pct(acct.day_pl_pct)} tone={colorBySign(acct.day_pl)} help="Change in equity since the previous close." />
            <Stat label="Cash" value={money(acct.cash)} help="Settled + unsettled cash not currently invested." />
            <Stat label="Buying Power" value={money(acct.buying_power)} help="What you can deploy into new positions right now." />
            <Stat label="Positions" value={num(positions.length, 0)} sub={`${acct.daytrade_count} day trades`} />
          </div>
        )}

        {/* equity curve */}
        <Panel
          title="Equity Curve"
          right={<Toggle value={period} onChange={setPeriod} options={PERIODS} />}
          className="h-[340px]"
          bodyClassName="min-h-0 p-2"
        >
          {histQ.loading && !hist ? (
            <Spinner label="Loading history" />
          ) : histQ.error && !hist ? (
            <ErrorState label="Portfolio history unavailable" onRetry={histQ.refetch} />
          ) : hist && hist.points.length > 0 ? (
            <EquityAreaChart points={hist.points} />
          ) : (
            <Empty label="No history for this range" />
          )}
        </Panel>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* allocation */}
          <Panel title="Allocation" bodyClassName="p-3">
            {positions.length === 0 && alloc.cash === 0 ? (
              <Empty label="No holdings" />
            ) : (
              <div className="flex flex-col gap-2">
                {alloc.rows.map((p) => (
                  <div key={p.symbol} className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-xs">
                      <ContractLabel symbol={p.symbol} className="text-xs" />
                      <span className="num text-text-dim">{pct(p.weight, 1)} · {moneyCompact(p.market_value)}</span>
                    </div>
                    <div className="h-2 bg-bg-2 rounded overflow-hidden">
                      <div className="h-full bg-amber" style={{ width: `${Math.min(100, p.weight)}%` }} />
                    </div>
                  </div>
                ))}
                {alloc.cash > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-text-dim">Cash</span>
                      <span className="num text-text-dim">{pct(alloc.cashWeight, 1)} · {moneyCompact(alloc.cash)}</span>
                    </div>
                    <div className="h-2 bg-bg-2 rounded overflow-hidden">
                      <div className="h-full bg-up/60" style={{ width: `${Math.min(100, alloc.cashWeight)}%` }} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </Panel>

          {/* holdings */}
          <Panel
            title="Holdings"
            right={
              <Link to="/positions" className="text-2xs uppercase tracking-wider text-amber hover:underline flex items-center gap-1">
                Manage <ArrowRight size={11} />
              </Link>
            }
            bodyClassName="overflow-auto"
          >
            {positions.length === 0 ? (
              <Empty label="No open positions" />
            ) : (
              <table className="w-full text-xs">
                <thead className="text-muted border-b border-border">
                  <tr>
                    <th className="text-left px-2 py-1 micro-label font-normal">Symbol</th>
                    <th className="text-right px-2 py-1 micro-label font-normal">Qty</th>
                    <th className="text-right px-2 py-1 micro-label font-normal">Value</th>
                    <th className="text-right px-2 py-1 micro-label font-normal">Unreal. P&L</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {positions.map((p) => (
                    <tr key={p.symbol} className="border-b border-border/50 hover:bg-panel-2">
                      <td className="px-2 py-1"><ContractLabel symbol={p.symbol} /></td>
                      <td className="px-2 py-1 text-right num">{num(p.qty, 0)}</td>
                      <td className="px-2 py-1 text-right num">{money(p.market_value)}</td>
                      <td className={`px-2 py-1 text-right num ${colorBySign(p.unrealized_pl)}`}>
                        {signed(p.unrealized_pl)} <span className="text-muted">({pct(p.unrealized_plpc * 100)})</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link to="/pnl" className="btn flex items-center gap-1"><ArrowRight size={12} /> P&L history</Link>
          <Link to="/buying-power" className="btn flex items-center gap-1"><ArrowRight size={12} /> Buying power</Link>
          <Link to="/risk" className="btn flex items-center gap-1"><ArrowRight size={12} /> Risk</Link>
          {acct && <Badge tone="amber">paper</Badge>}
        </div>
      </div>
    </div>
  );
}
