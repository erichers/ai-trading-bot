import { useEffect, useState } from 'react';
import {
  AlertOctagon,
  Ban,
  Calculator,
  Check,
  ShieldAlert,
  SlidersHorizontal,
} from 'lucide-react';
import { api } from '@/api/client';
import type {
  RiskDecision,
  RiskEvent,
  RiskLimits,
  RiskSizeResult,
  RiskStatus,
} from '@/api/types';
import { usePolling } from '@/hooks/usePolling';
import { useAppData } from '@/hooks/useAppData';
import { Panel, Spinner, Empty, ErrorState, Badge } from '@/components/ui';
import { money, moneyCompact, num, pct, signed, colorBySign, timeOnly, timeAgo } from '@/lib/format';

// ---- helpers -------------------------------------------------------------

function utilTone(p: number): { bar: string; text: string } {
  if (p >= 90) return { bar: 'bg-down', text: 'text-down' };
  if (p >= 70) return { bar: 'bg-amber', text: 'text-amber' };
  return { bar: 'bg-up', text: 'text-up' };
}

function UtilBar({ label, value }: { label: string; value: number }) {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  const tone = utilTone(v);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="micro-label">{label}</span>
        <span className={`num text-xs ${tone.text}`}>{pct(v, 0)}</span>
      </div>
      <div className="h-2 bg-bg-2 rounded overflow-hidden">
        <div className={`h-full ${tone.bar} transition-all`} style={{ width: `${Math.min(v, 100)}%` }} />
      </div>
    </div>
  );
}

function BigStat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div className="flex flex-col justify-center px-4 py-2 border-r border-border last:border-r-0 flex-1 min-w-[140px]">
      <span className="micro-label">{label}</span>
      <span className={`num text-2xl leading-tight ${tone ?? 'text-text'}`}>{value}</span>
      {sub && <span className="num text-2xs text-text-dim">{sub}</span>}
    </div>
  );
}

// ---- status header strip -------------------------------------------------

function StatusStrip() {
  const { riskStatus } = useAppData();
  // Local poll as a fallback if the global hook has no data yet.
  const localQ = usePolling<RiskStatus>(() => api.riskStatus(), 5000);
  const status = riskStatus ?? localQ.data;

  if (!status) {
    return (
      <Panel title="Risk Status">
        {localQ.error ? (
          <ErrorState label="Risk status unavailable" onRetry={localQ.refetch} />
        ) : (
          <Spinner label="Loading risk status" />
        )}
      </Panel>
    );
  }

  const u = status.utilization;
  const tripped = status.circuit_breaker_tripped || status.kill_switch_engaged;

  return (
    <div className="flex flex-col gap-3">
      {tripped && (
        <div className="panel border-down/60 bg-down/15 px-4 py-3 flex flex-wrap items-center gap-4 text-down">
          {status.kill_switch_engaged && (
            <span className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
              <Ban size={18} /> Kill Switch Engaged
            </span>
          )}
          {status.circuit_breaker_tripped && (
            <span className="flex items-center gap-2 font-bold uppercase tracking-wider text-sm">
              <AlertOctagon size={18} /> Circuit Breaker Tripped — new entries blocked
            </span>
          )}
        </div>
      )}

      <div className="panel flex flex-wrap">
        <BigStat
          label="Open Risk"
          value={moneyCompact(status.open_risk)}
          sub={`${pct(status.open_risk_pct)} of equity`}
          tone="text-amber"
        />
        <BigStat
          label="Day P&L"
          value={signed(status.day_pl)}
          sub={`${pct(status.day_pl_pct)} · CB at ${pct(-status.limits.max_daily_loss_pct, 1)}`}
          tone={colorBySign(status.day_pl)}
        />
        <BigStat
          label="Open Positions"
          value={`${num(status.open_positions, 0)} / ${num(status.max_open_positions, 0)}`}
        />
        <BigStat label="Equity" value={money(status.equity)} />
        <BigStat label="Buying Power" value={money(status.buying_power)} />
      </div>

      <Panel title="Utilization">
        <div className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-5">
          <UtilBar label="Position Slots" value={u.position_slots_used_pct} />
          <UtilBar label="Buying Power" value={u.buying_power_used_pct} />
          <UtilBar label="Daily Loss" value={u.daily_loss_used_pct} />
        </div>
      </Panel>
    </div>
  );
}

// ---- limits editor + kill switch -----------------------------------------

const LIMIT_FIELDS: { key: keyof RiskLimits; label: string; step: number }[] = [
  { key: 'max_position_pct', label: 'Max position (% equity)', step: 0.5 },
  { key: 'max_open_positions', label: 'Max open positions', step: 1 },
  { key: 'max_daily_loss_pct', label: 'Max daily loss (%)', step: 0.5 },
  { key: 'max_per_trade_risk_pct', label: 'Max per-trade risk (%)', step: 0.25 },
  { key: 'max_concentration_pct', label: 'Max concentration (%)', step: 1 },
  { key: 'min_price', label: 'Min price ($)', step: 0.5 },
  { key: 'default_risk_per_trade_pct', label: 'Default risk/trade (%)', step: 0.25 },
  { key: 'skip_first_minutes', label: 'Skip first minutes', step: 1 },
];

function toNum(v: string, fallback: number): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function LimitsEditor() {
  const { refetchRiskStatus } = useAppData();
  const limitsQ = usePolling<RiskLimits>(() => api.riskLimits(), 0);
  const [draft, setDraft] = useState<RiskLimits | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Kill switch controls.
  const [confirming, setConfirming] = useState(false);
  const [flatten, setFlatten] = useState(false);
  const [killBusy, setKillBusy] = useState(false);
  const [killMsg, setKillMsg] = useState<string | null>(null);

  useEffect(() => {
    if (limitsQ.data && !draft) setDraft(limitsQ.data);
  }, [limitsQ.data, draft]);

  if (!draft) {
    return (
      <Panel title="Risk Limits">
        {limitsQ.error ? (
          <ErrorState label="Failed to load limits" onRetry={limitsQ.refetch} />
        ) : (
          <Spinner label="Loading limits" />
        )}
      </Panel>
    );
  }

  const setField = (key: keyof RiskLimits, raw: string) => {
    setSaved(false);
    setDraft((d) => (d ? { ...d, [key]: raw === '' ? 0 : toNum(raw, d[key] as number) } : d));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setErr(null);
    try {
      const payload: Partial<RiskLimits> = {};
      for (const { key } of LIMIT_FIELDS) {
        payload[key] = draft[key] as never;
      }
      const updated = await api.updateRiskLimits(payload);
      setDraft(updated);
      setSaved(true);
      refetchRiskStatus();
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const fireKill = async () => {
    setKillBusy(true);
    setKillMsg(null);
    try {
      const res = await api.riskKillSwitch(true, flatten);
      setKillMsg(
        `KILL SWITCH ENGAGED${res.cancelled != null ? ` — ${res.cancelled} order(s) cancelled` : ''}`,
      );
      setDraft((d) => (d ? { ...d, kill_switch_engaged: res.kill_switch_engaged } : d));
      refetchRiskStatus();
    } catch (e) {
      setKillMsg(`FAILED: ${(e as Error).message}`);
    } finally {
      setKillBusy(false);
      setConfirming(false);
      setTimeout(() => setKillMsg(null), 5000);
    }
  };

  const releaseKill = async () => {
    setKillBusy(true);
    setKillMsg(null);
    try {
      const res = await api.riskKillSwitch(false);
      setKillMsg('KILL SWITCH RELEASED');
      setDraft((d) => (d ? { ...d, kill_switch_engaged: res.kill_switch_engaged } : d));
      refetchRiskStatus();
    } catch (e) {
      setKillMsg(`FAILED: ${(e as Error).message}`);
    } finally {
      setKillBusy(false);
      setTimeout(() => setKillMsg(null), 5000);
    }
  };

  return (
    <Panel
      title="Risk Limits"
      right={
        <span className="flex items-center gap-1.5 text-muted">
          <SlidersHorizontal size={12} />
          <span className="micro-label">Backend</span>
        </span>
      }
    >
      <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
        {LIMIT_FIELDS.map(({ key, label, step }) => (
          <label key={key} className="flex flex-col gap-1.5">
            <span className="micro-label">{label}</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              step={step}
              value={Number.isFinite(draft[key] as number) ? (draft[key] as number) : ''}
              onChange={(e) => setField(key, e.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="px-4 pb-4 flex items-center gap-3 flex-wrap">
        <button className="btn-amber" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && (
          <span className="flex items-center gap-1.5 text-up text-2xs uppercase tracking-wider">
            <Check size={14} /> Saved
          </span>
        )}
        {err && <span className="text-2xs text-down uppercase tracking-wider">{err}</span>}
      </div>

      {/* Kill switch */}
      <div className="m-3 p-4 border border-down/40 bg-down/5 rounded flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <ShieldAlert size={16} className="text-down" />
          <span className="micro-label text-down">Kill Switch</span>
          <Badge tone={draft.kill_switch_engaged ? 'down' : 'neutral'}>
            {draft.kill_switch_engaged ? 'Engaged' : 'Disengaged'}
          </Badge>
        </div>
        <p className="text-xs text-text-dim leading-relaxed">
          Engaging the kill switch blocks all new entries. Optionally flatten open positions
          immediately.
        </p>
        {killMsg && (
          <span className="text-2xs uppercase tracking-wider text-amber">{killMsg}</span>
        )}
        {draft.kill_switch_engaged ? (
          <button
            className="btn self-start"
            onClick={releaseKill}
            disabled={killBusy}
          >
            {killBusy ? '…' : 'Release Kill Switch'}
          </button>
        ) : confirming ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-2xs text-down uppercase tracking-wider">Engage kill switch?</span>
            <button
              onClick={fireKill}
              disabled={killBusy}
              className="px-3 py-1.5 text-2xs uppercase rounded bg-down text-black font-bold hover:bg-down/80"
            >
              {killBusy ? '…' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 text-2xs uppercase rounded border border-border-2 text-text-dim"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={() => setConfirming(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-down/50 bg-down/15 text-down hover:bg-down/25 font-bold uppercase tracking-wider"
            >
              <Ban size={14} /> Engage Kill Switch
            </button>
            <label className="flex items-center gap-1.5 text-xs text-text-dim cursor-pointer">
              <input
                type="checkbox"
                checked={flatten}
                onChange={(e) => setFlatten(e.target.checked)}
              />
              Flatten positions
            </label>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---- position sizer ------------------------------------------------------

function PositionSizer() {
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [riskPct, setRiskPct] = useState('');
  const [result, setResult] = useState<RiskSizeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const entryN = parseFloat(entry);
  const stopN = parseFloat(stop);
  const valid = Number.isFinite(entryN) && Number.isFinite(stopN) && entryN > 0 && stopN > 0;

  const calc = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.riskSize(
        entryN,
        stopN,
        riskPct === '' ? undefined : parseFloat(riskPct),
      );
      setResult(r);
    } catch (e) {
      setErr((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      title="Position Sizer"
      right={<Calculator size={12} className="text-muted" />}
    >
      <div className="p-4 flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="micro-label">Entry ($)</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.01}
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="micro-label">Stop ($)</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.01}
              value={stop}
              onChange={(e) => setStop(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="micro-label">Risk % (opt)</span>
            <input
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              step={0.25}
              placeholder="default"
              value={riskPct}
              onChange={(e) => setRiskPct(e.target.value)}
            />
          </label>
        </div>
        <button className="btn-amber self-start" onClick={calc} disabled={!valid || busy}>
          {busy ? 'Sizing…' : 'Calculate'}
        </button>
        {err && <span className="text-2xs text-down uppercase tracking-wider">{err}</span>}
        {result && (
          <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
            <div className="flex flex-col">
              <span className="micro-label">Suggested Qty</span>
              <span className="num text-xl text-amber">{num(result.qty, 0)}</span>
            </div>
            <div className="flex flex-col">
              <span className="micro-label">Risk Amount</span>
              <span className="num text-xl text-text">{money(result.risk_amount)}</span>
            </div>
            <div className="flex flex-col">
              <span className="micro-label">Position Value</span>
              <span className="num text-xl text-text">{money(result.position_value)}</span>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---- events log ----------------------------------------------------------

function decisionTone(d: RiskDecision): 'up' | 'amber' | 'down' {
  if (d === 'vetoed') return 'down';
  if (d === 'warned') return 'amber';
  return 'up';
}

function EventsLog() {
  const eventsQ = usePolling<RiskEvent[]>(() => api.riskEvents(50), 6000);
  const events = eventsQ.data ?? [];

  let body: React.ReactNode;
  if (eventsQ.loading && events.length === 0) body = <Spinner label="Loading events" />;
  else if (eventsQ.error && events.length === 0)
    body = <ErrorState label="Failed to load risk events" onRetry={eventsQ.refetch} />;
  else if (events.length === 0) body = <Empty label="No risk events yet" />;
  else
    body = (
      <div className="overflow-auto h-full">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-panel z-10">
            <tr className="text-left text-muted border-b border-border">
              <th className="px-2 py-1.5 micro-label font-normal">Time</th>
              <th className="px-2 py-1.5 micro-label font-normal">Symbol</th>
              <th className="px-2 py-1.5 micro-label font-normal">Side / Qty</th>
              <th className="px-2 py-1.5 micro-label font-normal">Decision</th>
              <th className="px-2 py-1.5 micro-label font-normal">Rules</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {events.map((e) => (
              <tr key={e.id} className="border-b border-border/50 hover:bg-panel-2 align-top">
                <td className="px-2 py-1.5 font-mono whitespace-nowrap" title={timeAgo(e.created_at)}>
                  {timeOnly(e.created_at)}
                  <span className="text-muted ml-1 text-2xs">{timeAgo(e.created_at)}</span>
                </td>
                <td className="px-2 py-1.5 font-mono font-semibold text-text">{e.symbol}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <span className={e.side === 'buy' ? 'text-up' : 'text-down'}>
                    {(e.side || '').toUpperCase()}
                  </span>
                  <span className="text-muted ml-1">{num(e.qty, 0)}</span>
                  <span className="text-muted ml-1 text-2xs uppercase">{e.order_type}</span>
                </td>
                <td className="px-2 py-1.5">
                  <Badge tone={decisionTone(e.decision)}>{e.decision}</Badge>
                </td>
                <td className="px-2 py-1.5">
                  {e.rules.length === 0 ? (
                    <span className="text-muted">—</span>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {e.rules.map((r, i) => (
                        <span
                          key={`${r.rule}-${i}`}
                          className={
                            r.kind === 'veto'
                              ? 'text-down'
                              : r.kind === 'warning'
                                ? 'text-amber'
                                : 'text-text-dim'
                          }
                        >
                          <span className="font-mono text-2xs uppercase opacity-70 mr-1">
                            {r.rule}
                          </span>
                          {r.message}
                        </span>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <Panel
      title="Risk Events"
      className="flex-1 min-h-0"
      bodyClassName="min-h-0"
      right={<span className="micro-label">{events.length}</span>}
    >
      {body}
    </Panel>
  );
}

// ---- main view -----------------------------------------------------------

export function Risk() {
  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto max-w-6xl flex flex-col gap-3">
        <StatusStrip />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 auto-rows-min">
          <LimitsEditor />
          <PositionSizer />
        </div>
        <div className="h-96">
          <EventsLog />
        </div>
      </div>
    </div>
  );
}
