import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Palette, ShieldAlert, SlidersHorizontal } from 'lucide-react';
import { api } from '@/api/client';
import type { Health } from '@/api/types';
import { Panel, Spinner, Badge, ErrorState } from '@/components/ui';
import { KillSwitch } from '@/components/KillSwitch';
import { useAppData } from '@/hooks/useAppData';

// ---- risk limits persistence --------------------------------------------

const RISK_KEY = 'terminal.riskLimits';

interface RiskLimits {
  maxDailyLoss: number;
  maxPositionSize: number;
  maxOpenPositions: number;
  riskPerTrade: number;
}

const DEFAULT_RISK: RiskLimits = {
  maxDailyLoss: 1000,
  maxPositionSize: 10000,
  maxOpenPositions: 5,
  riskPerTrade: 1,
};

function loadRisk(): RiskLimits {
  try {
    const raw = localStorage.getItem(RISK_KEY);
    if (!raw) return { ...DEFAULT_RISK };
    const parsed = JSON.parse(raw);
    return {
      maxDailyLoss: num(parsed.maxDailyLoss, DEFAULT_RISK.maxDailyLoss),
      maxPositionSize: num(parsed.maxPositionSize, DEFAULT_RISK.maxPositionSize),
      maxOpenPositions: num(parsed.maxOpenPositions, DEFAULT_RISK.maxOpenPositions),
      riskPerTrade: num(parsed.riskPerTrade, DEFAULT_RISK.riskPerTrade),
    };
  } catch {
    return { ...DEFAULT_RISK };
  }
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

// ---- health hook (prefer app-wide, fall back to local poll) --------------

function useHealth(): { health: Health | undefined; loading: boolean; error: boolean } {
  const app = useAppData();
  const [local, setLocal] = useState<Health | undefined>(undefined);
  const [error, setError] = useState(false);
  const [tried, setTried] = useState(false);

  const haveApp = app.health !== undefined;

  useEffect(() => {
    if (haveApp) return;
    let alive = true;
    const poll = async () => {
      try {
        const h = await api.health();
        if (alive) {
          setLocal(h);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      } finally {
        if (alive) setTried(true);
      }
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [haveApp]);

  if (haveApp) return { health: app.health, loading: false, error: false };
  return { health: local, loading: !tried && !error, error: error && !local };
}

// ---- small presentational bits -------------------------------------------

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${on ? 'bg-up' : 'bg-down'}`}
      aria-hidden
    />
  );
}

function StatusRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border last:border-b-0">
      <span className="text-xs text-text-dim">{label}</span>
      <span className="flex items-center gap-2">{children}</span>
    </div>
  );
}

function YesNo({ value }: { value: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <Dot on={value} />
      <Badge tone={value ? 'up' : 'down'}>{value ? 'Yes' : 'No'}</Badge>
    </span>
  );
}

// ---- main view -----------------------------------------------------------

export function SettingsView() {
  const { health, loading, error } = useHealth();

  const [risk, setRisk] = useState<RiskLimits>(() => loadRisk());
  const [saved, setSaved] = useState(false);

  // reload from storage on mount (in case it changed elsewhere)
  useEffect(() => {
    setRisk(loadRisk());
  }, []);

  const setField = (key: keyof RiskLimits, raw: string) => {
    setSaved(false);
    setRisk((r) => ({ ...r, [key]: raw === '' ? 0 : num(raw, r[key]) }));
  };

  const save = () => {
    try {
      localStorage.setItem(RISK_KEY, JSON.stringify(risk));
    } catch {
      /* ignore quota / private mode */
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const resetDefaults = () => {
    setRisk({ ...DEFAULT_RISK });
    setSaved(false);
  };

  const paper = health?.paper ?? true; // safe default when unknown
  const isLive = health !== undefined && !health.paper;

  const overallTone = useMemo<'up' | 'amber' | 'down'>(() => {
    if (!health) return 'amber';
    if (health.status?.toLowerCase() === 'ok' && health.alpaca_connected) return 'up';
    if (health.alpaca_connected) return 'amber';
    return 'down';
  }, [health]);

  return (
    <div className="h-full overflow-auto p-3">
      <div className="mx-auto max-w-5xl grid grid-cols-1 lg:grid-cols-2 gap-3 auto-rows-min">
        {/* PAPER / LIVE indicator -------------------------------------- */}
        <Panel title="Trading Mode" className="lg:col-span-2">
          <div className="p-4 flex flex-col sm:flex-row sm:items-center gap-4">
            <div
              className={`flex items-center gap-3 rounded border px-5 py-4 ${
                isLive
                  ? 'border-down/50 bg-down/10'
                  : 'border-amber/40 bg-amber/10'
              }`}
            >
              {isLive ? (
                <AlertTriangle size={28} className="text-down shrink-0" />
              ) : (
                <ShieldAlert size={28} className="text-amber shrink-0" />
              )}
              <div>
                <div
                  className={`text-3xl font-bold tracking-widest leading-none ${
                    isLive ? 'text-down' : 'text-amber'
                  }`}
                >
                  {paper ? 'PAPER' : 'LIVE'}
                </div>
                <div className="text-2xs uppercase tracking-widest text-muted mt-1">
                  (read-only)
                </div>
              </div>
            </div>
            <div className="text-xs text-text-dim leading-relaxed">
              {isLive ? (
                <>
                  <span className="text-down font-semibold">
                    Live trading is active.
                  </span>{' '}
                  Orders execute against real capital. The mode is controlled by the
                  backend account credentials and cannot be changed from this screen.
                </>
              ) : (
                <>
                  Paper trading is active — no real capital is at risk. The mode is
                  determined by the backend account credentials and cannot be changed
                  here.
                </>
              )}
              {!health && (
                <div className="mt-1 text-muted">
                  Status assumed PAPER until the backend reports otherwise.
                </div>
              )}
            </div>
          </div>
        </Panel>

        {/* SYSTEM STATUS --------------------------------------------- */}
        <Panel
          title="System Status"
          right={<Badge tone={overallTone}>{health?.status ?? 'unknown'}</Badge>}
        >
          {loading ? (
            <Spinner label="Loading status" />
          ) : error && !health ? (
            <div className="px-3 py-2">
              <ErrorState label="Backend unreachable — status unavailable" />
            </div>
          ) : (
            <div>
              <StatusRow label="Alpaca connected">
                <YesNo value={!!health?.alpaca_connected} />
              </StatusRow>
              <StatusRow label="Anthropic configured">
                <YesNo value={!!health?.anthropic_configured} />
              </StatusRow>
              <StatusRow label="Market">
                <Badge tone={health?.market_open ? 'up' : 'neutral'}>
                  {health?.market_open ? 'Open' : 'Closed'}
                </Badge>
              </StatusRow>
              <StatusRow label="Overall status">
                <Badge tone={overallTone}>{health?.status ?? 'unknown'}</Badge>
              </StatusRow>
            </div>
          )}
        </Panel>

        {/* THEME NOTE ------------------------------------------------ */}
        <Panel title="Appearance">
          <div className="p-4 flex items-start gap-3">
            <Palette size={20} className="text-amber shrink-0 mt-0.5" />
            <div className="text-xs text-text-dim leading-relaxed">
              The terminal uses a fixed dark Bloomberg-style theme with an amber accent.
              There is no light mode or theme toggle — the palette is tuned for
              low-glare, high-density market monitoring.
              <div className="mt-2 flex items-center gap-2">
                <span className="micro-label">Accent</span>
                <span className="inline-block w-4 h-4 rounded-sm bg-amber border border-border-2" />
                <Badge tone="amber">Amber</Badge>
              </div>
            </div>
          </div>
        </Panel>

        {/* RISK LIMITS ----------------------------------------------- */}
        <Panel
          title="Risk Limits"
          className="lg:col-span-2"
          right={
            <span className="flex items-center gap-1.5 text-muted">
              <SlidersHorizontal size={12} />
              <span className="micro-label">Local</span>
            </span>
          }
        >
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
            <Field
              label="Max daily loss ($)"
              value={risk.maxDailyLoss}
              step={50}
              onChange={(v) => setField('maxDailyLoss', v)}
            />
            <Field
              label="Max position size ($ or %)"
              value={risk.maxPositionSize}
              step={100}
              onChange={(v) => setField('maxPositionSize', v)}
            />
            <Field
              label="Max open positions"
              value={risk.maxOpenPositions}
              step={1}
              onChange={(v) => setField('maxOpenPositions', v)}
            />
            <Field
              label="Default risk per trade (%)"
              value={risk.riskPerTrade}
              step={0.25}
              onChange={(v) => setField('riskPerTrade', v)}
            />
          </div>
          <div className="px-4 pb-4 flex items-center gap-3">
            <button className="btn-amber" onClick={save}>
              Save
            </button>
            <button className="btn" onClick={resetDefaults}>
              Reset defaults
            </button>
            {saved && (
              <span className="flex items-center gap-1.5 text-up text-2xs uppercase tracking-wider">
                <Check size={14} />
                Saved
              </span>
            )}
            <span className="ml-auto text-2xs text-muted">
              Stored in this browser only ({RISK_KEY})
            </span>
          </div>
        </Panel>

        {/* DANGER ZONE ----------------------------------------------- */}
        <Panel
          title="Danger Zone"
          className="lg:col-span-2 border-down/50"
          right={<ShieldAlert size={14} className="text-down" />}
        >
          <div className="p-4 border border-down/40 bg-down/5 m-3 rounded flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="text-xs text-text-dim leading-relaxed flex-1">
              <span className="text-down font-semibold uppercase tracking-wider">
                Emergency stop.
              </span>{' '}
              The kill switch cancels <strong>all open orders</strong> immediately. It
              does not flatten existing positions. Use when you need to halt new
              fills fast.
            </div>
            <div className="shrink-0">
              <KillSwitch />
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  step,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="micro-label">{label}</span>
      <input
        className="input"
        type="number"
        inputMode="decimal"
        min={0}
        step={step}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
