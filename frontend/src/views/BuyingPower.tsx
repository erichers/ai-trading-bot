import { Link } from 'react-router-dom';
import { Banknote, ArrowRight, GraduationCap } from 'lucide-react';
import { api } from '@/api/client';
import type { Account, Order } from '@/api/types';
import { usePolling } from '@/hooks/usePolling';
import { Panel, Spinner, Empty, ErrorState, Badge, HelpTip } from '@/components/ui';
import { ContractLabel } from '@/components/ContractLabel';
import { money, num, timeOnly, timeAgo } from '@/lib/format';

function Stat({ label, value, sub, tone, help }: { label: string; value: string; sub?: string; tone?: string; help?: React.ReactNode }) {
  return (
    <div className="flex flex-col justify-center px-4 py-2.5 border-r border-border last:border-r-0 flex-1 min-w-[140px]">
      <span className="micro-label flex items-center gap-1">{label}{help && <HelpTip title={label}>{help}</HelpTip>}</span>
      <span className={`num text-2xl leading-tight ${tone ?? 'text-text'}`}>{value}</span>
      {sub && <span className="num text-2xs text-text-dim">{sub}</span>}
    </div>
  );
}

export function BuyingPower() {
  const acctQ = usePolling<Account>(() => api.account(), 8000);
  const ordersQ = usePolling<Order[]>(() => api.orders('open'), 8000);
  const acct = acctQ.data;
  const orders = ordersQ.data ?? [];

  // Margin multiplier ≈ buying power / equity (1× cash, ~2× reg-T, ~4× PDT intraday).
  const multiplier = acct && acct.equity > 0 ? acct.buying_power / acct.equity : 0;
  const reservedByOrders = orders
    .filter((o) => o.side === 'buy')
    .reduce((s, o) => s + (o.limit_price ?? 0) * (o.qty || 0), 0);

  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto max-w-6xl flex flex-col gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Banknote size={16} className="text-amber" />
          <h1 className="text-sm micro-label text-text-dim">Buying Power</h1>
          <span className="text-2xs text-muted">What you can deploy, where it comes from, and what’s reserved</span>
        </div>

        {!acct ? (
          acctQ.error ? <ErrorState label="Account unavailable" onRetry={acctQ.refetch} /> : <Spinner label="Loading account" />
        ) : (
          <>
            <div className="panel flex flex-wrap">
              <Stat label="Buying Power" value={money(acct.buying_power)} tone="text-amber" help="The total dollar amount you can use to open new positions right now. On a margin account this is larger than your cash because the broker lends against your equity." />
              <Stat label="Cash" value={money(acct.cash)} help="Actual settled + unsettled cash in the account. Buying power ≥ cash when margin is available." />
              <Stat label="Equity" value={money(acct.equity)} help="Cash + market value of positions — the collateral your buying power is calculated from." />
              <Stat label="Margin multiplier" value={`${num(multiplier, 1)}×`} help="Buying power ÷ equity. ~1× = cash account, ~2× = Reg-T margin, up to ~4× = pattern-day-trader intraday." />
              <Stat label="Reserved by open orders" value={money(reservedByOrders)} sub={`${orders.length} open`} help="Approximate buying power tied up in unfilled buy orders (limit price × qty)." />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              {/* Open orders reserving BP */}
              <Panel title="Open orders" right={<Link to="/positions" className="text-2xs uppercase tracking-wider text-amber hover:underline flex items-center gap-1">Manage <ArrowRight size={11} /></Link>} bodyClassName="overflow-auto">
                {orders.length === 0 ? (
                  <Empty label="No open orders" />
                ) : (
                  <table className="w-full text-xs">
                    <thead className="text-muted border-b border-border">
                      <tr>
                        <th className="text-left px-2 py-1 micro-label font-normal">Time</th>
                        <th className="text-left px-2 py-1 micro-label font-normal">Symbol</th>
                        <th className="text-left px-2 py-1 micro-label font-normal">Side</th>
                        <th className="text-right px-2 py-1 micro-label font-normal">Qty</th>
                        <th className="text-right px-2 py-1 micro-label font-normal">Limit</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums">
                      {orders.map((o) => (
                        <tr key={o.id} className="border-b border-border/50 hover:bg-panel-2">
                          <td className="px-2 py-1 font-mono text-text-dim" title={timeAgo(o.submitted_at)}>{timeOnly(o.submitted_at)}</td>
                          <td className="px-2 py-1"><ContractLabel symbol={o.symbol} /></td>
                          <td className={`px-2 py-1 uppercase ${o.side === 'buy' ? 'text-up' : 'text-down'}`}>{o.side}</td>
                          <td className="px-2 py-1 text-right num">{num(o.qty, 0)}</td>
                          <td className="px-2 py-1 text-right num">{o.limit_price != null ? money(o.limit_price) : 'mkt'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Panel>

              {/* Education */}
              <Panel title={<span className="flex items-center gap-1.5"><GraduationCap size={12} /> Understanding buying power</span>} bodyClassName="p-3">
                <div className="flex flex-col gap-2.5 text-2xs leading-relaxed text-text-dim">
                  <p><span className="text-text font-medium">What it is.</span> Buying power is the total you can spend opening new positions. With margin it’s a multiple of your cash because the broker lends against your equity as collateral.</p>
                  <p><span className="text-text font-medium">Cash vs margin.</span> A cash account can only use settled cash (1× — no leverage). A Reg-T margin account roughly doubles it (2×); flagged pattern day traders can get up to 4× <span className="text-muted">intraday only</span> (it drops to 2× overnight).</p>
                  <p><span className="text-text font-medium">Options.</span> Long options (buying calls/puts) are paid for in full from cash — no leverage, but the premium ties up buying power until you close. This app trades long options on paper.</p>
                  <p><span className="text-text font-medium">What reserves it.</span> Every open buy order earmarks buying power until it fills or cancels — so a stack of resting limit orders can leave you unable to enter elsewhere.</p>
                  <p><span className="text-text font-medium">PDT rule.</span> Under $25k equity, you’re capped at 3 day-trades per rolling 5 sessions. Your day-trade count is on the <Link to="/portfolio" className="text-amber hover:underline">Portfolio</Link> page.</p>
                  <p className="text-muted">This account is in <Badge tone="amber">paper</Badge> mode — leverage and PDT behave like the broker’s real rules but no real capital is at risk.</p>
                </div>
              </Panel>
            </div>
          </>
        )}

        <div className="flex flex-wrap gap-2">
          <Link to="/portfolio" className="btn flex items-center gap-1"><ArrowRight size={12} /> Portfolio</Link>
          <Link to="/risk" className="btn flex items-center gap-1"><ArrowRight size={12} /> Risk limits</Link>
        </div>
      </div>
    </div>
  );
}
