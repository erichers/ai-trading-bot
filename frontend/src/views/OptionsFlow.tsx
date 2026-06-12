import { useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import { api } from '@/api/client';
import type { OptionContract, OptionsFlow } from '@/api/types';
import { money, num, compact } from '@/lib/format';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { TickerSearch } from '@/components/TickerSearch';
import { useSymbol } from '@/hooks/useSymbol';
import { usePolling } from '@/hooks/usePolling';

const POLL_MS = 15000;

type Period = 'weekly' | 'daily';

interface ChainRow {
  strike: number;
  call?: OptionContract;
  put?: OptionContract;
}

// Join call/put contracts by strike into 3-zone rows.
function buildRows(chain: OptionContract[]): ChainRow[] {
  const map = new Map<number, ChainRow>();
  for (const c of chain) {
    const row = map.get(c.strike) ?? { strike: c.strike };
    if (c.type === 'call') row.call = c;
    else row.put = c;
    map.set(c.strike, row);
  }
  return [...map.values()].sort((a, b) => a.strike - b.strike);
}

/**
 * ATM heuristic: estimate the underlying as the strike where the call and put
 * `last` prices are closest (put-call parity implies they cross near spot).
 * Fall back to the median strike when last prices are unavailable. The ATM row
 * is then the strike nearest that estimate.
 */
function estimateAtmStrike(rows: ChainRow[]): number | null {
  if (rows.length === 0) return null;
  let best: { strike: number; diff: number } | null = null;
  for (const r of rows) {
    if (r.call && r.put && r.call.last > 0 && r.put.last > 0) {
      const diff = Math.abs(r.call.last - r.put.last);
      if (!best || diff < best.diff) best = { strike: r.strike, diff };
    }
  }
  if (best) return best.strike;
  // Fallback: median strike.
  return rows[Math.floor(rows.length / 2)].strike;
}

function GreekCells({ c }: { c?: OptionContract }) {
  if (!c) return <td colSpan={4} className="text-center text-muted">—</td>;
  return (
    <>
      <td className="px-1 text-right text-text-dim">{num(c.delta, 2)}</td>
      <td className="px-1 text-right text-text-dim">{num(c.gamma, 3)}</td>
      <td className="px-1 text-right text-text-dim">{num(c.theta, 2)}</td>
      <td className="px-1 text-right text-text-dim">{num(c.vega, 2)}</td>
    </>
  );
}

function SideCells({ c, side }: { c?: OptionContract; side: 'call' | 'put' }) {
  const tint = side === 'call' ? 'text-up' : 'text-down';
  if (!c) {
    return (
      <>
        <td colSpan={6} className="text-center text-muted px-1">—</td>
      </>
    );
  }
  return (
    <>
      <td className="px-1.5 text-right text-text">{money(c.bid)}</td>
      <td className="px-1.5 text-right text-text">{money(c.ask)}</td>
      <td className={`px-1.5 text-right font-medium ${tint}`}>{money(c.last)}</td>
      <td className="px-1.5 text-right text-text-dim">{compact(c.volume)}</td>
      <td className="px-1.5 text-right text-text-dim">{compact(c.open_interest)}</td>
      <td className="px-1.5 text-right text-text-dim">
        {num((c.implied_volatility ?? 0) * 100, 1)}%
      </td>
    </>
  );
}

function ChainTable({ chain }: { chain: OptionContract[] }) {
  const rows = useMemo(() => buildRows(chain), [chain]);
  const atm = useMemo(() => estimateAtmStrike(rows), [rows]);

  if (rows.length === 0) return <Empty label="No contracts for this expiration" />;

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-2xs font-mono tabular-nums border-collapse">
        <thead className="sticky top-0 z-10 bg-panel-2">
          <tr className="text-muted">
            <th colSpan={4} className="px-1 py-1 text-center border-b border-r border-border micro-label text-up/70">
              Call Greeks
            </th>
            <th colSpan={6} className="px-1 py-1 text-center border-b border-r border-border micro-label text-up">
              Calls
            </th>
            <th className="px-1 py-1 text-center border-b border-x border-border-2 micro-label">
              Strike
            </th>
            <th colSpan={6} className="px-1 py-1 text-center border-b border-l border-border micro-label text-down">
              Puts
            </th>
            <th colSpan={4} className="px-1 py-1 text-center border-b border-l border-border micro-label text-down/70">
              Put Greeks
            </th>
          </tr>
          <tr className="text-muted text-[9px]">
            <th className="px-1 text-right">Δ</th>
            <th className="px-1 text-right">Γ</th>
            <th className="px-1 text-right">Θ</th>
            <th className="px-1 text-right border-r border-border">V</th>
            <th className="px-1.5 text-right">Bid</th>
            <th className="px-1.5 text-right">Ask</th>
            <th className="px-1.5 text-right">Last</th>
            <th className="px-1.5 text-right">Vol</th>
            <th className="px-1.5 text-right">OI</th>
            <th className="px-1.5 text-right border-r border-border">IV</th>
            <th className="px-1 text-center border-x border-border-2"> </th>
            <th className="px-1.5 text-right">Bid</th>
            <th className="px-1.5 text-right">Ask</th>
            <th className="px-1.5 text-right">Last</th>
            <th className="px-1.5 text-right">Vol</th>
            <th className="px-1.5 text-right">OI</th>
            <th className="px-1.5 text-right border-r border-border">IV</th>
            <th className="px-1 text-right">Δ</th>
            <th className="px-1 text-right">Γ</th>
            <th className="px-1 text-right">Θ</th>
            <th className="px-1 text-right">V</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isAtm = atm !== null && r.strike === atm;
            return (
              <tr
                key={r.strike}
                className={`border-b border-border/40 ${
                  isAtm ? 'bg-amber/10 ring-1 ring-inset ring-amber/40' : 'hover:bg-panel-2/60'
                }`}
              >
                <GreekCells c={r.call} />
                <SideCells c={r.call} side="call" />
                <td
                  className={`px-2 text-center font-semibold border-x border-border-2 ${
                    isAtm ? 'text-amber' : 'text-text'
                  }`}
                >
                  {num(r.strike, r.strike % 1 === 0 ? 0 : 1)}
                </td>
                <SideCells c={r.put} side="put" />
                <GreekCells c={r.put} />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Bar({
  label,
  value,
  max,
  color,
  display,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  display: string;
}) {
  const w = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-2xs">
        <span className="micro-label">{label}</span>
        <span className="font-mono tabular-nums text-text">{display}</span>
      </div>
      <div className="h-2.5 bg-bg-2 rounded overflow-hidden border border-border">
        <div className={`h-full ${color} transition-all`} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

function FlowSummary({ flow }: { flow: OptionsFlow }) {
  const pcr = flow.put_call_ratio ?? 0;
  // PCR gauge: >1 means more puts (bearish, amber/down); <1 bullish (up).
  const bullish = pcr < 1;
  const gaugeFill = Math.min(100, (pcr / 2) * 100); // 0..2 maps to full bar
  const maxVol = Math.max(flow.total_call_volume, flow.total_put_volume, 1);

  return (
    <div className="flex flex-col gap-4 p-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="micro-label">Put / Call Ratio</span>
          <Badge tone={bullish ? 'up' : 'amber'}>{num(pcr, 2)}</Badge>
        </div>
        <div className="relative h-3 bg-bg-2 rounded overflow-hidden border border-border">
          <div
            className={`h-full ${bullish ? 'bg-up' : 'bg-amber'} transition-all`}
            style={{ width: `${gaugeFill}%` }}
          />
          {/* 1.0 neutral marker at 50% of a 0..2 scale */}
          <div className="absolute top-0 bottom-0 left-1/2 w-px bg-text/50" />
        </div>
        <div className="flex justify-between text-[9px] text-muted">
          <span>0 calls-heavy</span>
          <span>1.0</span>
          <span>2+ puts-heavy</span>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <Bar
          label="Call Volume"
          value={flow.total_call_volume}
          max={maxVol}
          color="bg-up"
          display={compact(flow.total_call_volume)}
        />
        <Bar
          label="Put Volume"
          value={flow.total_put_volume}
          max={maxVol}
          color="bg-down"
          display={compact(flow.total_put_volume)}
        />
      </div>
    </div>
  );
}

function UnusualTable({ flow }: { flow: OptionsFlow }) {
  const rows = flow.unusual ?? [];
  if (rows.length === 0) return <Empty label="No unusual activity" />;
  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-2xs font-mono tabular-nums border-collapse">
        <thead className="sticky top-0 bg-panel-2 text-muted">
          <tr className="text-[9px]">
            <th className="px-2 py-1.5 text-right">Strike</th>
            <th className="px-2 py-1.5 text-left">Type</th>
            <th className="px-2 py-1.5 text-right">Volume</th>
            <th className="px-2 py-1.5 text-right">OI</th>
            <th className="px-2 py-1.5 text-right">Vol/OI</th>
            <th className="px-2 py-1.5 text-right">Premium</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => {
            const hot = u.vol_oi_ratio > 2;
            return (
              <tr
                key={`${u.strike}-${u.type}-${i}`}
                className={`border-b border-border/40 ${
                  hot ? 'bg-amber/10 ring-1 ring-inset ring-amber/40' : 'hover:bg-panel-2/60'
                }`}
              >
                <td className="px-2 py-1 text-right text-text">{num(u.strike, u.strike % 1 === 0 ? 0 : 1)}</td>
                <td className="px-2 py-1">
                  <span className={u.type === 'call' ? 'text-up' : 'text-down'}>
                    {u.type.toUpperCase()}
                  </span>
                </td>
                <td className="px-2 py-1 text-right text-text-dim">{compact(u.volume)}</td>
                <td className="px-2 py-1 text-right text-text-dim">{compact(u.oi)}</td>
                <td className={`px-2 py-1 text-right font-medium ${hot ? 'text-amber' : 'text-text-dim'}`}>
                  {num(u.vol_oi_ratio, 2)}
                </td>
                <td className="px-2 py-1 text-right text-text">{money(u.premium)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OptionsFlowView() {
  const { symbol, setSymbol } = useSymbol();
  const [period, setPeriod] = useState<Period>('weekly');
  const [expiration, setExpiration] = useState<string>('');
  const [expirations, setExpirations] = useState<string[]>([]);
  const [expError, setExpError] = useState<string | null>(null);

  // Load expirations whenever the symbol changes; reset selected expiration.
  useEffect(() => {
    let cancelled = false;
    setExpError(null);
    setExpiration('');
    api
      .optionExpirations(symbol)
      .then((exps) => {
        if (cancelled) return;
        setExpirations(exps);
        setExpiration(exps[0] ?? '');
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setExpirations([]);
        setExpError(e.message || 'Failed to load expirations');
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const chain = usePolling<OptionContract[]>(
    () => api.optionChain(symbol, expiration || undefined, 'all'),
    POLL_MS,
    [symbol, expiration],
  );

  const flow = usePolling<OptionsFlow>(
    () => api.optionFlow(symbol, period),
    POLL_MS,
    [symbol, period],
  );

  return (
    <div className="flex flex-col h-full min-h-0 gap-2 p-2 bg-bg text-text">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 shrink-0">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-amber" />
          <span className="font-mono text-lg text-text">{symbol}</span>
          <Badge tone="neutral">Options Flow</Badge>
        </div>
        <TickerSearch onSelect={setSymbol} className="w-56" placeholder="Change ticker…" />
        <div className="flex items-center gap-2">
          <span className="micro-label">Period</span>
          <Toggle
            value={period}
            onChange={(v) => setPeriod(v as Period)}
            options={[
              { value: 'weekly', label: 'Weekly' },
              { value: 'daily', label: 'Daily' },
            ]}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="micro-label">Expiration</span>
          <select
            value={expiration}
            onChange={(e) => setExpiration(e.target.value)}
            disabled={expirations.length === 0}
            className="bg-bg-2 border border-border rounded px-2 py-1 text-xs font-mono text-text outline-none focus:border-amber/50 disabled:opacity-50"
          >
            {expirations.length === 0 && <option value="">{expError ? 'unavailable' : '—'}</option>}
            {expirations.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 min-h-0 gap-2">
        {/* Chain */}
        <Panel
          title="Options Chain"
          className="flex-1 min-w-0"
          bodyClassName="min-h-0"
          right={
            chain.error ? (
              <Badge tone="down">stale</Badge>
            ) : chain.data ? (
              <span className="text-2xs text-muted font-mono">{expiration || '—'}</span>
            ) : null
          }
        >
          {chain.loading && !chain.data ? (
            <Spinner label="Loading chain" />
          ) : chain.error && !chain.data ? (
            <ErrorState label={chain.error.message} onRetry={chain.refetch} />
          ) : !chain.data || chain.data.length === 0 ? (
            <Empty label="No chain data" />
          ) : (
            <ChainTable chain={chain.data} />
          )}
        </Panel>

        {/* Right column: flow summary + unusual */}
        <div className="flex flex-col gap-2 w-[360px] shrink-0 min-h-0">
          <Panel title="Flow Summary" className="shrink-0">
            {flow.loading && !flow.data ? (
              <Spinner label="Loading flow" />
            ) : flow.error && !flow.data ? (
              <ErrorState label={flow.error.message} onRetry={flow.refetch} />
            ) : !flow.data ? (
              <Empty label="No flow data" />
            ) : (
              <FlowSummary flow={flow.data} />
            )}
          </Panel>

          <Panel title="Unusual Activity" className="flex-1 min-h-0" bodyClassName="min-h-0">
            {flow.loading && !flow.data ? (
              <Spinner label="Loading" />
            ) : flow.error && !flow.data ? (
              <ErrorState label={flow.error.message} onRetry={flow.refetch} />
            ) : !flow.data ? (
              <Empty label="No data" />
            ) : (
              <UnusualTable flow={flow.data} />
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
