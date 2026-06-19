import { useCallback, useMemo, useState } from 'react';
import { X, ChevronDown, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { NewOrder, Order, OrderSide, OrderType, Position, TimeInForce } from '@/api/types';
import { useAppData } from '@/hooks/useAppData';
import { usePolling } from '@/hooks/usePolling';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { ContractLabel } from '@/components/ContractLabel';
import { money, num, pct, signed, colorBySign, timeOnly, timeAgo } from '@/lib/format';

// --- Heuristic for the distance-to-stop/target bar -----------------------
// We don't have real bracket levels on a bare Position, so we approximate a
// protective stop 2% below entry and a profit target 4% above entry. The bar
// shows where current_price sits within that [stop, target] band (clamped).
const STOP_MULT = 0.98;
const TARGET_MULT = 1.04;

function StopTargetBar({ p }: { p: Position }) {
  const stop = p.avg_entry_price * STOP_MULT;
  const target = p.avg_entry_price * TARGET_MULT;
  const span = target - stop;
  const ratio = span > 0 ? (p.current_price - stop) / span : 0;
  const clamped = Math.max(0, Math.min(1, ratio));
  const pctPos = clamped * 100;
  // Fill color leans red near the stop, green near the target.
  const fillColor = clamped < 0.4 ? 'bg-down' : clamped > 0.6 ? 'bg-up' : 'bg-amber';
  return (
    <div className="flex flex-col gap-0.5 w-28" title={`stop ${money(stop)} → target ${money(target)}`}>
      <div className="relative h-1.5 bg-bg-2 rounded-full border border-border overflow-hidden">
        <div className={`absolute inset-y-0 left-0 ${fillColor}`} style={{ width: `${pctPos}%` }} />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-0.5 h-2.5 bg-text"
          style={{ left: `${pctPos}%` }}
        />
      </div>
      <div className="flex justify-between text-2xs text-muted tabular-nums">
        <span>{num(stop)}</span>
        <span>{num(target)}</span>
      </div>
    </div>
  );
}

function SideBadge({ side }: { side: string }) {
  const isBuy = side.toLowerCase() === 'buy' || side.toLowerCase() === 'long';
  return <Badge tone={isBuy ? 'up' : 'down'}>{side}</Badge>;
}

function statusTone(status: string): 'neutral' | 'amber' | 'up' | 'down' {
  const s = status.toLowerCase();
  if (s.includes('fill')) return 'up';
  if (s.includes('cancel') || s.includes('reject') || s.includes('expired')) return 'down';
  if (s.includes('new') || s.includes('accept') || s.includes('pending') || s.includes('held'))
    return 'amber';
  return 'neutral';
}

// --- Positions table ----------------------------------------------------
function PositionsTable({
  positions,
  refetchPositions,
  refetchOrders,
}: {
  positions: Position[];
  refetchPositions: () => void;
  refetchOrders: () => void;
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const closePosition = useCallback(
    async (p: Position) => {
      setBusy((b) => ({ ...b, [p.symbol]: true }));
      try {
        const side: OrderSide = p.side.toLowerCase() === 'long' || p.side.toLowerCase() === 'buy' ? 'sell' : 'buy';
        await api.createOrder({
          symbol: p.symbol,
          qty: Math.abs(p.qty),
          side,
          type: 'market',
          time_in_force: 'day',
        });
        setNotes((n) => ({ ...n, [p.symbol]: 'close order submitted' }));
        refetchPositions();
        refetchOrders();
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'close failed';
        setNotes((n) => ({ ...n, [p.symbol]: `error: ${msg}` }));
      } finally {
        setBusy((b) => ({ ...b, [p.symbol]: false }));
      }
    },
    [refetchPositions, refetchOrders],
  );

  const moveBreakeven = useCallback((p: Position) => {
    // Stub only — does NOT place an order. Real impl would amend/replace the
    // protective stop leg to entry price.
    setNotes((n) => ({ ...n, [p.symbol]: 'stop moved to breakeven (stub)' }));
  }, []);

  if (positions.length === 0) return <Empty label="No open positions" />;

  return (
    <div className="overflow-auto h-full">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 bg-panel z-10">
          <tr className="text-left text-muted border-b border-border">
            <th className="px-2 py-1.5 micro-label font-normal">Symbol</th>
            <th className="px-2 py-1.5 micro-label font-normal">Side</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Qty</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Entry</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Current</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Mkt Val</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Unrl P&L</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Chg Today</th>
            <th className="px-2 py-1.5 micro-label font-normal">Stop / Target</th>
            <th className="px-2 py-1.5 micro-label font-normal text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {positions.map((p) => (
            <tr key={p.symbol} className="border-b border-border/50 hover:bg-panel-2 group">
              <td className="px-2 py-1.5">
              <ContractLabel symbol={p.symbol} />
            </td>
              <td className="px-2 py-1.5">
                <SideBadge side={p.side} />
              </td>
              <td className="px-2 py-1.5 text-right font-mono">{num(p.qty, 0)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{money(p.avg_entry_price)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{money(p.current_price)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{money(p.market_value)}</td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorBySign(p.unrealized_pl)}`}>
                <div>{signed(p.unrealized_pl)}</div>
                <div className="text-2xs">{pct(p.unrealized_plpc * 100)}</div>
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorBySign(p.change_today)}`}>
                {pct(p.change_today * 100)}
              </td>
              <td className="px-2 py-1.5">
                <StopTargetBar p={p} />
              </td>
              <td className="px-2 py-1.5">
                <div className="flex items-center justify-end gap-1">
                  <button
                    className="btn text-2xs px-1.5 py-0.5"
                    disabled={busy[p.symbol]}
                    onClick={() => closePosition(p)}
                    title="Submit market order to close"
                  >
                    {busy[p.symbol] ? '…' : 'Close'}
                  </button>
                  <button
                    className="btn text-2xs px-1.5 py-0.5"
                    onClick={() => moveBreakeven(p)}
                    title="Move stop to breakeven (stub)"
                  >
                    BE
                  </button>
                </div>
                {notes[p.symbol] && (
                  <div
                    className={`text-2xs mt-0.5 text-right ${
                      notes[p.symbol].startsWith('error') ? 'text-down' : 'text-amber'
                    }`}
                  >
                    {notes[p.symbol]}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- Orders table -------------------------------------------------------
function OrdersTable() {
  const [status, setStatus] = useState<'open' | 'closed' | 'all'>('open');
  const { data, error, loading, refetch } = usePolling<Order[]>(
    () => api.orders(status),
    5000,
    [status],
  );
  const [cancelling, setCancelling] = useState<Record<string, boolean>>({});

  const orders = data ?? [];

  const cancel = useCallback(
    async (id: string) => {
      setCancelling((c) => ({ ...c, [id]: true }));
      try {
        await api.cancelOrder(id);
        refetch();
      } catch {
        /* surfaced by next poll */
      } finally {
        setCancelling((c) => ({ ...c, [id]: false }));
      }
    },
    [refetch],
  );

  const isOpenStatus = (s: string) => {
    const l = s.toLowerCase();
    return !(
      l.includes('fill') ||
      l.includes('cancel') ||
      l.includes('reject') ||
      l.includes('expired') ||
      l.includes('done')
    );
  };

  const toggle = (
    <Toggle
      value={status}
      onChange={(v) => setStatus(v as 'open' | 'closed' | 'all')}
      options={[
        { value: 'open', label: 'Open' },
        { value: 'closed', label: 'Filled' },
        { value: 'all', label: 'All' },
      ]}
    />
  );

  let body: React.ReactNode;
  if (loading && orders.length === 0) body = <Spinner label="Loading orders" />;
  else if (error && orders.length === 0)
    body = <ErrorState label="Failed to load orders" onRetry={refetch} />;
  else if (orders.length === 0) body = <Empty label="No orders" />;
  else
    body = (
      <div className="overflow-auto h-full">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-panel z-10">
            <tr className="text-left text-muted border-b border-border">
              <th className="px-2 py-1.5 micro-label font-normal">Time</th>
              <th className="px-2 py-1.5 micro-label font-normal">Symbol</th>
              <th className="px-2 py-1.5 micro-label font-normal">Side</th>
              <th className="px-2 py-1.5 micro-label font-normal">Type</th>
              <th className="px-2 py-1.5 micro-label font-normal text-right">Qty / Filled</th>
              <th className="px-2 py-1.5 micro-label font-normal text-right">Limit</th>
              <th className="px-2 py-1.5 micro-label font-normal text-right">Stop</th>
              <th className="px-2 py-1.5 micro-label font-normal text-right">Fill Px</th>
              <th className="px-2 py-1.5 micro-label font-normal">Status</th>
              <th className="px-2 py-1.5 micro-label font-normal" />
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {orders.map((o) => (
              <tr key={o.id} className="border-b border-border/50 hover:bg-panel-2">
                <td className="px-2 py-1.5 font-mono whitespace-nowrap" title={timeAgo(o.submitted_at)}>
                  {timeOnly(o.submitted_at)}
                  <span className="text-muted ml-1 text-2xs">{timeAgo(o.submitted_at)}</span>
                </td>
                <td className="px-2 py-1.5">
                  <ContractLabel symbol={o.symbol} />
                </td>
                <td className="px-2 py-1.5">
                  <SideBadge side={o.side} />
                </td>
                <td className="px-2 py-1.5 font-mono text-text-dim">{o.type}</td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {num(o.qty, 0)}
                  <span className="text-muted"> / {num(o.filled_qty, 0)}</span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {o.limit_price != null ? money(o.limit_price) : '—'}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {o.stop_price != null ? money(o.stop_price) : '—'}
                </td>
                <td className="px-2 py-1.5 text-right font-mono">
                  {o.filled_avg_price != null ? money(o.filled_avg_price) : '—'}
                </td>
                <td className="px-2 py-1.5">
                  <Badge tone={statusTone(o.status)}>{o.status}</Badge>
                </td>
                <td className="px-2 py-1.5 text-right">
                  {isOpenStatus(o.status) && (
                    <button
                      className="text-muted hover:text-down disabled:opacity-40 p-0.5"
                      disabled={cancelling[o.id]}
                      onClick={() => cancel(o.id)}
                      title="Cancel order"
                    >
                      <X size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <Panel title="Orders" right={toggle} className="flex-1 min-h-0" bodyClassName="min-h-0">
      {body}
    </Panel>
  );
}

// --- Order ticket -------------------------------------------------------
function OrderTicket({ onSubmitted }: { onSubmitted: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<OrderSide>('buy');
  const [qty, setQty] = useState('');
  const [type, setType] = useState<OrderType>('market');
  const [tif, setTif] = useState<TimeInForce>('day');
  const [limitPrice, setLimitPrice] = useState('');
  const [stopPrice, setStopPrice] = useState('');
  const [bracketOpen, setBracketOpen] = useState(false);
  const [takeProfit, setTakeProfit] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const needsLimit = type === 'limit' || type === 'stop_limit';
  const needsStop = type === 'stop' || type === 'stop_limit';

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setErr(null);
      setOk(null);
      const q = Number(qty);
      if (!symbol.trim()) return setErr('Symbol required');
      if (!Number.isFinite(q) || q <= 0) return setErr('Qty must be a positive number');
      if (needsLimit && !(Number(limitPrice) > 0)) return setErr('Limit price required');
      if (needsStop && !(Number(stopPrice) > 0)) return setErr('Stop price required');

      const order: NewOrder = {
        symbol: symbol.trim().toUpperCase(),
        qty: q,
        side,
        type,
        time_in_force: tif,
      };
      if (needsLimit) order.limit_price = Number(limitPrice);
      if (needsStop) order.stop_price = Number(stopPrice);
      if (bracketOpen && Number(takeProfit) > 0) order.take_profit = Number(takeProfit);
      if (bracketOpen && Number(stopLoss) > 0) order.stop_loss = Number(stopLoss);

      setBusy(true);
      try {
        const created = await api.createOrder(order);
        setOk(`Submitted ${created.side} ${created.qty} ${created.symbol} · ${created.status}`);
        setQty('');
        setLimitPrice('');
        setStopPrice('');
        setTakeProfit('');
        setStopLoss('');
        onSubmitted();
      } catch (e2) {
        setErr(e2 instanceof ApiError ? e2.message : 'Order failed');
      } finally {
        setBusy(false);
      }
    },
    [symbol, qty, side, type, tif, limitPrice, stopPrice, bracketOpen, takeProfit, stopLoss, needsLimit, needsStop, onSubmitted],
  );

  return (
    <Panel title="Order Ticket">
      <form onSubmit={submit} className="flex flex-col gap-2.5 p-3 text-xs">
        <div className="flex flex-col gap-1">
          <label className="micro-label">Symbol</label>
          <input
            className="input font-mono uppercase"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="AAPL"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="micro-label">Side</label>
          <div className="inline-flex rounded border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setSide('buy')}
              className={`flex-1 px-2 py-1.5 transition-colors ${
                side === 'buy' ? 'bg-up/15 text-up' : 'bg-panel text-text-dim hover:bg-panel-2'
              }`}
            >
              Buy
            </button>
            <button
              type="button"
              onClick={() => setSide('sell')}
              className={`flex-1 px-2 py-1.5 transition-colors ${
                side === 'sell' ? 'bg-down/15 text-down' : 'bg-panel text-text-dim hover:bg-panel-2'
              }`}
            >
              Sell
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1">
            <label className="micro-label">Qty</label>
            <input
              className="input font-mono tabular-nums"
              type="number"
              min="0"
              step="any"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              placeholder="0"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="micro-label">TIF</label>
            <select
              className="input"
              value={tif}
              onChange={(e) => setTif(e.target.value as TimeInForce)}
            >
              <option value="day">day</option>
              <option value="gtc">gtc</option>
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <label className="micro-label">Type</label>
          <select
            className="input"
            value={type}
            onChange={(e) => setType(e.target.value as OrderType)}
          >
            <option value="market">market</option>
            <option value="limit">limit</option>
            <option value="stop">stop</option>
            <option value="stop_limit">stop_limit</option>
          </select>
        </div>

        {(needsLimit || needsStop) && (
          <div className="grid grid-cols-2 gap-2">
            {needsLimit && (
              <div className="flex flex-col gap-1">
                <label className="micro-label">Limit Price</label>
                <input
                  className="input font-mono tabular-nums"
                  type="number"
                  min="0"
                  step="any"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            )}
            {needsStop && (
              <div className="flex flex-col gap-1">
                <label className="micro-label">Stop Price</label>
                <input
                  className="input font-mono tabular-nums"
                  type="number"
                  min="0"
                  step="any"
                  value={stopPrice}
                  onChange={(e) => setStopPrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 border-t border-border pt-2">
          <button
            type="button"
            className="flex items-center gap-1 micro-label hover:text-text-dim"
            onClick={() => setBracketOpen((v) => !v)}
          >
            {bracketOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Bracket (optional)
          </button>
          {bracketOpen && (
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1">
                <label className="micro-label">Take Profit</label>
                <input
                  className="input font-mono tabular-nums"
                  type="number"
                  min="0"
                  step="any"
                  value={takeProfit}
                  onChange={(e) => setTakeProfit(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="micro-label">Stop Loss</label>
                <input
                  className="input font-mono tabular-nums"
                  type="number"
                  min="0"
                  step="any"
                  value={stopLoss}
                  onChange={(e) => setStopLoss(e.target.value)}
                  placeholder="0.00"
                />
              </div>
            </div>
          )}
        </div>

        {err && <div className="text-down text-2xs">{err}</div>}
        {ok && <div className="text-up text-2xs">{ok}</div>}

        <button
          type="submit"
          disabled={busy}
          className={`${side === 'sell' ? 'btn' : 'btn-amber'} mt-1 disabled:opacity-50`}
        >
          {busy ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol || ''}`.trim()}
        </button>
      </form>
    </Panel>
  );
}

// --- Main view ----------------------------------------------------------
export function PositionsOrders() {
  const { positions, refetchPositions } = useAppData();
  // Bump key to trigger a re-mount/refetch of the orders table after actions.
  const [ordersNonce, setOrdersNonce] = useState(0);
  const refetchOrders = useCallback(() => setOrdersNonce((n) => n + 1), []);

  const totalUnrl = useMemo(
    () => positions.reduce((a, p) => a + (p.unrealized_pl || 0), 0),
    [positions],
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-3 p-3 h-full min-h-0">
      <div className="flex flex-col gap-3 min-h-0">
        <Panel
          title="Positions"
          right={
            <span className={`text-xs font-mono tabular-nums ${colorBySign(totalUnrl)}`}>
              {signed(totalUnrl)}
            </span>
          }
          className="min-h-[180px] max-h-[45%]"
          bodyClassName="min-h-0"
        >
          <PositionsTable
            positions={positions}
            refetchPositions={refetchPositions}
            refetchOrders={refetchOrders}
          />
        </Panel>
        <OrdersTable key={ordersNonce} />
      </div>
      <OrderTicket
        onSubmitted={() => {
          refetchOrders();
          refetchPositions();
        }}
      />
    </div>
  );
}
