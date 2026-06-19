import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Wand2,
  BookOpen,
  Plus,
  Trash2,
  X,
  Save,
  Check,
  ChevronLeft,
  ChevronRight,
  Zap,
  Play,
  Sparkles,
  TrendingUp,
  TrendingDown,
  CandlestickChart,
  RefreshCw,
  FlaskConical,
  Lightbulb,
  AlertTriangle,
} from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type {
  Backtest as BacktestResult,
  BacktestLookback,
  Bot,
  BotAction,
  BotConfig,
  BotMode,
  BotRule,
  EvalResult,
  IndicatorCatalogItem,
  OptionExpiration,
  OptionsSelectResponse,
  SelectableContract,
  SnapshotMap,
} from '@/api/types';
import { blankAction } from '@/api/types';
import { money, num, pct } from '@/lib/format';
import { takeTemplatePrefill } from '@/lib/templatePrefill';
import { Badge, Empty, ErrorState, HelpTip, Panel, Spinner, Toggle } from '@/components/ui';
import { indicatorHint, ruleWarning } from '@/lib/builderHints';
import { formatContract, friendlyExpiry, daysToExpiry, dteLabel } from '@/lib/contracts';
import { BacktestResults } from '@/components/BacktestResults';
import { BotEvaluation } from '@/components/BotEvaluation';
import { Markdown } from '@/components/Markdown';
import { TickerSearch } from '@/components/TickerSearch';
import { usePolling } from '@/hooks/usePolling';

const TIMEFRAMES = ['1Min', '5Min', '15Min', '1Hour', '1Day'];

const OPERATORS: { value: string; label: string }[] = [
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '>=' },
  { value: '<=', label: '<=' },
  { value: '==', label: '==' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
];

const FALLBACK_INDICATORS: { value: string; label: string }[] = [
  { value: 'rsi14', label: 'RSI(14)' },
  { value: 'sma20', label: 'SMA(20)' },
  { value: 'sma50', label: 'SMA(50)' },
  { value: 'ema9', label: 'EMA(9)' },
  { value: 'ema21', label: 'EMA(21)' },
  { value: 'macd', label: 'MACD' },
  { value: 'price', label: 'Price' },
  { value: 'vwap', label: 'VWAP' },
  { value: 'atr14', label: 'ATR(14)' },
  { value: 'adx14', label: 'ADX(14)' },
  { value: 'volume', label: 'Volume' },
];

const MODE_OPTIONS: { value: BotMode; label: string }[] = [
  { value: 'signal', label: 'Signal-only' },
  { value: 'semi', label: 'Semi-auto' },
  { value: 'auto', label: 'Full-auto' },
];

const STEPS = ['Ticker', 'Entry trigger', 'Action', 'Sizing & risk', 'Review & Save'];

// One-line "what this step is about" education shown under the stepper.
const STEP_HELP = [
  'Pick the stock or ETF your bot watches and trades.',
  'Define the technical condition that fires a signal.',
  'Choose what to buy when the trigger fires — calls, puts, or shares.',
  'Size each trade, set your risk, and pick how hands-on the bot is.',
  'Review the whole strategy, backtest it, then save.',
];

const ONBOARDED_KEY = 'builder_onboarded';

const MICRO = 'micro-label block mb-1';

const BACKTEST_LOOKBACKS: { value: BacktestLookback; label: string }[] = [
  { value: '1D', label: '1D' },
  { value: '2D', label: '2D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
];

// ---- Builder draft -------------------------------------------------------

interface Draft {
  id: string;
  name: string;
  symbols: string[];
  primary: string; // the underlying the contract picker uses
  timeframe: string;
  rules: BotRule[];
  ai_gate: { enabled: boolean; min_conviction: number };
  config: BotConfig;
  action: BotAction;
  risk: { risk_per_trade_pct: number };
  mode: BotMode;
  enabled: boolean;
}

function blankDraft(firstIndicator: string): Draft {
  return {
    id: '',
    name: 'New Bot',
    symbols: [],
    primary: '',
    timeframe: '5Min',
    rules: [{ indicator: firstIndicator, operator: 'crosses_above', value: '', join: 'AND' }],
    ai_gate: { enabled: true, min_conviction: 60 },
    config: {
      direction: 'research',
      side: 'auto',
      expiry: 'nearest_weekly',
      strike: 'ATM',
      target_delta: 0.4,
      contracts: 1,
      max_premium: 500,
    },
    action: blankAction(),
    risk: { risk_per_trade_pct: 1 },
    mode: 'signal',
    enabled: false,
  };
}

function botToDraft(b: Partial<Bot>): Draft {
  const symbols = [...(b.symbols || [])];
  const action: BotAction = b.action
    ? { ...blankAction(), ...b.action }
    : {
        ...blankAction(),
        // Migrate from legacy config.side if no action saved yet.
        right: b.config?.side ?? 'auto',
      };
  return {
    id: b.id ?? '',
    name: b.name ?? 'New Bot',
    symbols,
    primary: symbols[0] ?? '',
    timeframe: '5Min',
    rules:
      b.rules && b.rules.length
        ? b.rules.map((r) => ({ ...r }))
        : [{ indicator: 'rsi14', operator: 'crosses_above', value: '', join: 'AND' }],
    ai_gate: { enabled: !!b.ai_gate?.enabled, min_conviction: b.ai_gate?.min_conviction ?? 60 },
    config: {
      direction: b.config?.direction ?? 'research',
      side: b.config?.side ?? 'auto',
      expiry: 'nearest_weekly',
      strike: b.config?.strike ?? 'ATM',
      target_delta: b.config?.target_delta ?? 0.4,
      contracts: b.config?.contracts ?? 1,
      max_premium: b.config?.max_premium ?? 500,
    },
    action,
    risk: { risk_per_trade_pct: b.risk?.risk_per_trade_pct ?? 1 },
    mode: b.mode ?? 'signal',
    enabled: !!b.enabled,
  };
}

function draftToPayload(d: Draft): Partial<Bot> {
  // Keep legacy config.side in sync with action.right so older readers work.
  const side = d.action.right === 'auto' ? 'auto' : d.action.right;
  return {
    name: d.name,
    symbols: d.symbols,
    kind: 'options_weekly',
    rules: d.rules,
    ai_gate: d.ai_gate,
    config: { ...d.config, side },
    action: d.action,
    risk: d.risk,
    mode: d.mode,
    enabled: d.enabled,
  };
}

// ---- plain-english preview ----------------------------------------------

function indicatorLabel(id: string, opts: { value: string; label: string }[]): string {
  return opts.find((o) => o.value === id)?.label ?? id;
}

function operatorPhrase(op: string): string {
  const found = OPERATORS.find((o) => o.value === op);
  return found ? found.label : op;
}

function entrySentence(d: Draft, indicatorOpts: { value: string; label: string }[]): string {
  const sym = d.primary || d.symbols[0] || 'the ticker';
  const parts = d.rules.map((r, i) => {
    const join = i > 0 ? ` ${r.join} ` : '';
    const val = r.value === '' || r.value === undefined ? '?' : String(r.value);
    return `${join}${indicatorLabel(r.indicator, indicatorOpts)} ${operatorPhrase(r.operator)} ${val}`;
  });
  return `Buy ${sym} when ${parts.join('')} on ${d.timeframe}.`;
}

// ---- stepper -------------------------------------------------------------

function Stepper({ step, onJump }: { step: number; onJump: (i: number) => void }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {STEPS.map((label, i) => {
        const active = i === step;
        const done = i < step;
        return (
          <button
            key={label}
            onClick={() => onJump(i)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-2xs uppercase tracking-wider transition-colors ${
              active
                ? 'border-transparent bg-amber text-black font-semibold'
                : done
                  ? 'border-up/40 text-up hover:bg-panel-2'
                  : 'border-border-2 text-text-dim hover:bg-panel-2'
            }`}
          >
            <span
              className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] ${
                active ? 'bg-black/20 text-black' : done ? 'bg-up/20 text-up' : 'bg-panel-2 text-muted'
              }`}
            >
              {done ? <Check size={10} /> : i + 1}
            </span>
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ---- contract picker (live) ----------------------------------------------

function ContractPicker({
  symbol,
  right,
  expiry,
  moneyness,
  selected,
  onSelect,
}: {
  symbol: string;
  right: 'call' | 'put';
  expiry: string;
  moneyness: 'ATM' | 'OTM' | 'ITM';
  selected: string | null;
  onSelect: (c: SelectableContract) => void;
}) {
  const [data, setData] = useState<OptionsSelectResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.optionsSelect(symbol, { right, expiry, moneyness, count: 9 });
      setData(res);
    } catch (e) {
      setData(null);
      if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
        setError(`Live options chain unavailable for ${symbol}`);
      } else {
        setError((e as Error).message || `Could not load options for ${symbol}`);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, right, expiry, moneyness]);

  if (loading) return <Spinner label={`loading ${right} chain for ${symbol}`} />;
  if (error) return <ErrorState label={error} onRetry={() => void load()} />;
  if (!data || data.contracts.length === 0) {
    return <Empty label={`No live contracts for ${symbol}`} />;
  }

  return (
    <div className="rounded border border-border bg-bg-2 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
        <span className="text-2xs text-muted">
          {data.symbol} @ <span className="num text-text-dim">{money(data.underlying_price)}</span>{' '}
          · exp <span className="text-text-dim">{friendlyExpiry(data.expiration)} · {dteLabel(daysToExpiry(data.expiration))}</span>
        </span>
        <button className="btn flex items-center gap-1 !py-0.5" onClick={() => void load()}>
          <RefreshCw size={11} /> Refresh
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-2xs uppercase tracking-wider text-muted border-b border-border">
              <th className="text-left px-2 py-1">Strike</th>
              <th className="text-left px-2 py-1">M</th>
              <th className="text-right px-2 py-1">Bid</th>
              <th className="text-right px-2 py-1">Ask</th>
              <th className="text-right px-2 py-1">Mid</th>
              <th className="text-right px-2 py-1">IV</th>
              <th className="text-right px-2 py-1">Δ</th>
              <th className="text-right px-2 py-1">OI</th>
              <th className="text-right px-2 py-1">Vol</th>
            </tr>
          </thead>
          <tbody>
            {data.contracts.map((c) => {
              const isSel = c.occ_symbol === selected;
              const tone =
                c.moneyness === 'ATM' ? 'amber' : c.moneyness === 'ITM' ? 'up' : 'neutral';
              return (
                <tr
                  key={c.occ_symbol}
                  onClick={() => onSelect(c)}
                  className={`cursor-pointer border-b border-border/60 transition-colors ${
                    isSel ? 'bg-amber/15' : 'hover:bg-panel-2'
                  }`}
                >
                  <td className="px-2 py-1 num text-text">
                    {isSel && <Check size={11} className="inline text-amber mr-1" />}
                    {money(c.strike)}
                  </td>
                  <td className="px-2 py-1">
                    <Badge tone={tone}>{c.moneyness}</Badge>
                  </td>
                  <td className="px-2 py-1 text-right num text-text-dim">{num(c.bid)}</td>
                  <td className="px-2 py-1 text-right num text-text-dim">{num(c.ask)}</td>
                  <td className="px-2 py-1 text-right num text-amber">{num(c.mid)}</td>
                  <td className="px-2 py-1 text-right num text-text-dim">
                    {pct((c.implied_volatility ?? 0) * 100, 0)}
                  </td>
                  <td className="px-2 py-1 text-right num text-text-dim">{num(c.delta)}</td>
                  <td className="px-2 py-1 text-right num text-muted">{num(c.open_interest, 0)}</td>
                  <td className="px-2 py-1 text-right num text-muted">{num(c.volume, 0)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==========================================================================
//  AI builder ("Build with AI" — Kimi) entry
// ==========================================================================

function AiBuilder({
  onDraft,
  defaultOpen = false,
}: {
  onDraft: (b: Partial<Bot>, explanation: string) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function build() {
    const text = prompt.trim();
    if (!text) {
      setError('Describe the strategy first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.botFromPrompt(text);
      onDraft(res.draft || {}, res.explanation || '');
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
        setError('AI builder unavailable right now — build manually below.');
      } else {
        setError((e as Error).message || 'Kimi could not design the strategy.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="btn-amber flex items-center justify-center gap-1.5 py-2"
        onClick={() => setOpen(true)}
      >
        <Sparkles size={14} /> Describe your strategy (build with AI)
      </button>
    );
  }

  return (
    <div className="rounded border border-amber/40 bg-amber/5 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="micro-label flex items-center gap-1.5 text-amber">
          <Sparkles size={13} /> Describe your strategy
        </span>
        <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
          <X size={12} />
        </button>
      </div>
      <textarea
        className="input w-full min-h-[80px] resize-y"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        placeholder="Day-trade QQQ: buy weekly ATM calls when RSI(14) crosses above 32 on 5m, AI conviction > 60, 1 contract, semi-auto"
      />
      <button
        className="btn-amber flex items-center justify-center gap-1.5 py-2"
        onClick={build}
        disabled={busy}
      >
        <Sparkles size={14} /> {busy ? 'Building…' : 'Build with AI'}
      </button>
      {busy && <Spinner label="Kimi is designing your strategy… (can take ~60s)" />}
      {error && <div className="text-down text-xs micro-label">{error}</div>}
    </div>
  );
}

// ==========================================================================
//  Inline backtest of the in-progress draft (no save)
// ==========================================================================

interface DraftBacktestState {
  lookback: BacktestLookback;
  running: boolean;
  error: string | null;
  engineDown: boolean;
  result: BacktestResult | null;
  ranSignature: string | null;
}

function useDraftBacktest(draft: Draft, defaultLookback: BacktestLookback) {
  const [state, setState] = useState<DraftBacktestState>({
    lookback: defaultLookback,
    running: false,
    error: null,
    engineDown: false,
    result: null,
    ranSignature: null,
  });

  // Build the /api/backtest request body from the IN-PROGRESS draft (no bot_id).
  const symbols = draft.symbols.length ? draft.symbols : draft.primary ? [draft.primary] : [];
  const rulesReady = draft.rules.some(
    (r) => r.value !== '' && r.value !== undefined && r.value !== null,
  );

  // Stable signature of everything that affects the backtest result.
  const signature = useMemo(
    () =>
      JSON.stringify({
        symbols,
        timeframe: draft.timeframe,
        rules: draft.rules,
        action: draft.action,
        ai_gate: draft.ai_gate,
        lookback: state.lookback,
      }),
    [symbols, draft.timeframe, draft.rules, draft.action, draft.ai_gate, state.lookback],
  );

  const setLookback = (lookback: BacktestLookback) =>
    setState((s) => ({ ...s, lookback }));

  async function run() {
    if (symbols.length === 0) {
      setState((s) => ({ ...s, error: 'Add at least one ticker to backtest.' }));
      return;
    }
    if (!rulesReady) {
      setState((s) => ({ ...s, error: 'Add at least one entry trigger to backtest.' }));
      return;
    }
    setState((s) => ({ ...s, running: true, error: null, engineDown: false }));
    try {
      const res = await api.backtest({
        symbols,
        timeframe: draft.timeframe,
        rules: draft.rules,
        action: draft.action,
        ai_gate: draft.ai_gate,
        lookback: state.lookback,
      });
      setState((s) => ({ ...s, result: res, ranSignature: signature, running: false }));
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
        setState((s) => ({ ...s, result: null, engineDown: true, running: false }));
      } else {
        setState((s) => ({
          ...s,
          result: null,
          error: (e as Error).message || 'Backtest failed',
          running: false,
        }));
      }
    }
  }

  const stale =
    state.result !== null && state.ranSignature !== null && signature !== state.ranSignature;

  return { state, setLookback, run, stale, symbols };
}

function DraftBacktest({
  bt,
  draft,
  collapsible = false,
}: {
  bt: ReturnType<typeof useDraftBacktest>;
  draft: Draft;
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);
  const { state, setLookback, run, stale, symbols } = bt;
  const { lookback, running, error, engineDown, result } = state;

  if (collapsible && !open) {
    return (
      <button
        className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-text-dim hover:text-amber transition-colors self-start"
        onClick={() => setOpen(true)}
      >
        <FlaskConical size={12} /> ▸ Backtest current draft
      </button>
    );
  }

  return (
    <div className="rounded border border-border bg-bg-2 p-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="micro-label flex items-center gap-1.5 text-amber">
          <FlaskConical size={13} /> Backtest current draft
        </span>
        {collapsible && (
          <button className="btn !py-0.5" onClick={() => setOpen(false)}>
            <X size={12} />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="micro-label">Lookback</span>
          <Toggle
            value={lookback}
            onChange={(v) => setLookback(v as BacktestLookback)}
            options={BACKTEST_LOOKBACKS}
          />
        </div>
        <button
          className="btn-amber flex items-center gap-1.5 py-1.5 px-4"
          onClick={() => void run()}
          disabled={running}
        >
          <Play size={13} /> {running ? 'Simulating…' : 'Backtest current draft'}
        </button>
        <span className="text-2xs text-muted">
          {symbols.length ? symbols.join(', ') : 'no ticker'} · {draft.timeframe}
        </span>
      </div>

      {stale && !running && (
        <div className="text-2xs text-amber/90 micro-label flex items-center gap-1.5">
          <RefreshCw size={11} /> Draft changed since last run — re-run to see updated results.
        </div>
      )}

      {running ? (
        <div className="flex flex-col items-center gap-2 py-6">
          <Spinner label="Simulating over real history…" />
          <span className="text-2xs text-muted micro-label">
            Replaying {lookback} of bars — this can take 10–30s.
          </span>
        </div>
      ) : engineDown ? (
        <div className="flex flex-col items-center justify-center gap-2 text-center py-6">
          <FlaskConical size={20} className="text-amber animate-pulse" />
          <span className="text-amber text-xs micro-label">Backtest engine starting…</span>
          <button className="btn mt-1" onClick={() => void run()}>
            Retry
          </button>
        </div>
      ) : error ? (
        <ErrorState label={error} onRetry={() => void run()} />
      ) : result ? (
        <BacktestResults result={result} />
      ) : (
        <Empty label="Set your lookback, then Backtest current draft." />
      )}
    </div>
  );
}

// ==========================================================================
//  Multi-step Builder form (reusable; embedded by BotSetup too)
// ==========================================================================

export function BuilderForm({
  initial,
  onSaved,
  onCancel,
  aiOpen = false,
}: {
  initial?: Partial<Bot> | null;
  onSaved?: (b: Bot) => void;
  onCancel?: () => void;
  aiOpen?: boolean;
}) {
  const [catalog, setCatalog] = useState<IndicatorCatalogItem[]>([]);
  const [draft, setDraft] = useState<Draft>(() =>
    initial ? botToDraft(initial) : blankDraft('rsi14'),
  );
  const [step, setStep] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Bot | null>(null);

  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<EvalResult | null>(null);
  const [running, setRunning] = useState(false);

  const [aiExplanation, setAiExplanation] = useState<string | null>(null);

  const [expirations, setExpirations] = useState<OptionExpiration[]>([]);

  // Inline backtest of the in-progress draft — state lifted here so results
  // persist as the user moves between steps (mid-build alter-then-retest loop).
  const bt = useDraftBacktest(draft, '1M');

  // indicator catalog
  useEffect(() => {
    let alive = true;
    api
      .indicatorCatalog()
      .then((c) => alive && setCatalog(c || []))
      .catch(() => alive && setCatalog([]));
    return () => {
      alive = false;
    };
  }, []);

  const indicatorOptions = useMemo(
    () =>
      catalog && catalog.length
        ? catalog.map((c) => ({ value: c.id, label: c.name }))
        : FALLBACK_INDICATORS,
    [catalog],
  );

  // primary ticker live snapshot
  const snap = usePolling<SnapshotMap>(
    () => (draft.primary ? api.snapshot(draft.primary) : Promise.resolve({} as SnapshotMap)),
    15000,
    [draft.primary],
  );
  const primaryPrice = draft.primary ? snap.data?.[draft.primary]?.price : undefined;

  // expirations for the action step
  useEffect(() => {
    if (!draft.primary) {
      setExpirations([]);
      return;
    }
    let alive = true;
    api
      .optionExpirations(draft.primary)
      .then((e) => alive && setExpirations(e || []))
      .catch(() => alive && setExpirations([]));
    return () => {
      alive = false;
    };
  }, [draft.primary]);

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const patchAction = (p: Partial<BotAction>) =>
    setDraft((d) => ({ ...d, action: { ...d.action, ...p } }));

  // ---- ticker basket ----
  function addTicker(symRaw: string) {
    const sym = symRaw.trim().toUpperCase();
    if (!sym) return;
    setDraft((d) => {
      const symbols = d.symbols.includes(sym) ? d.symbols : [...d.symbols, sym];
      return { ...d, symbols, primary: d.primary || sym };
    });
  }
  function removeTicker(sym: string) {
    setDraft((d) => {
      const symbols = d.symbols.filter((s) => s !== sym);
      const primary = d.primary === sym ? (symbols[0] ?? '') : d.primary;
      // changing primary invalidates a manually-picked contract
      const action =
        d.primary === sym ? { ...d.action, contract_symbol: null } : d.action;
      return { ...d, symbols, primary, action };
    });
  }
  function setPrimary(sym: string) {
    setDraft((d) =>
      d.primary === sym
        ? d
        : { ...d, primary: sym, action: { ...d.action, contract_symbol: null } },
    );
  }

  // ---- rules ----
  function updateRule(i: number, p: Partial<BotRule>) {
    setDraft((d) => ({ ...d, rules: d.rules.map((r, idx) => (idx === i ? { ...r, ...p } : r)) }));
  }
  function addRule() {
    setDraft((d) => ({
      ...d,
      rules: [
        ...d.rules,
        { indicator: indicatorOptions[0]?.value ?? 'rsi14', operator: '>', value: '', join: 'AND' },
      ],
    }));
  }
  function removeRule(i: number) {
    setDraft((d) => {
      const next = d.rules.filter((_, idx) => idx !== i);
      return {
        ...d,
        rules: next.length
          ? next
          : [{ indicator: 'rsi14', operator: '>', value: '', join: 'AND' }],
      };
    });
  }

  // Apply a "suggested trigger" chip to a rule row, preserving its join.
  function applySuggestion(i: number, s: { indicator: string; operator: string; value: string | number }) {
    updateRule(i, { indicator: s.indicator, operator: s.operator, value: s.value });
  }

  // ---- validation per step ----
  function validate(s: number): string | null {
    if (s === 0) {
      if (draft.symbols.length === 0) return 'Pick at least one ticker.';
      if (!draft.primary) return 'Choose a primary ticker for the contract picker.';
    }
    if (s === 1) {
      if (draft.rules.length === 0) return 'Add at least one entry rule.';
      for (const r of draft.rules) {
        if (r.value === '' || r.value === undefined || r.value === null) {
          return 'Every rule needs a value.';
        }
      }
    }
    if (s === 2) {
      if (draft.action.asset === 'option') {
        // either an explicit contract OR auto (ATM, contract_symbol null) is fine
        if (draft.action.right === 'auto') {
          return 'Choose Buy Calls or Buy Puts.';
        }
      }
    }
    if (s === 3) {
      if (draft.action.asset === 'option' && draft.config.contracts < 1) {
        return 'Contracts must be at least 1.';
      }
    }
    return null;
  }

  function next() {
    const err = validate(step);
    if (err) {
      setStepError(err);
      return;
    }
    setStepError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStepError(null);
    setStep((s) => Math.max(s - 1, 0));
  }
  function jump(target: number) {
    if (target <= step) {
      setStepError(null);
      setStep(target);
      return;
    }
    // validate every step up to target
    for (let i = step; i < target; i++) {
      const err = validate(i);
      if (err) {
        setStep(i);
        setStepError(err);
        return;
      }
    }
    setStepError(null);
    setStep(target);
  }

  // ---- save ----
  async function save() {
    // run all validations
    for (let i = 0; i < STEPS.length - 1; i++) {
      const err = validate(i);
      if (err) {
        setStep(i);
        setStepError(err);
        return;
      }
    }
    setSaving(true);
    setSaveError(null);
    try {
      const payload = draftToPayload(draft);
      const result = draft.id
        ? await api.updateBot(draft.id, payload)
        : await api.createBot(payload);
      setDraft(botToDraft(result));
      setSaved(result);
      onSaved?.(result);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setSaveError('Bot engine starting…');
      else setSaveError((e as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function evaluate() {
    const id = saved?.id || draft.id;
    if (!id) {
      setEvalError('Save the bot before evaluating.');
      return;
    }
    setEvaluating(true);
    setEvalError(null);
    try {
      const res = await api.evaluateBot(id);
      setEvalResult(res);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setEvalError('Bot engine starting…');
      else setEvalError((e as Error).message || 'Evaluation failed');
    } finally {
      setEvaluating(false);
    }
  }

  async function run() {
    const id = saved?.id || draft.id;
    if (!id) {
      setEvalError('Save the bot before running.');
      return;
    }
    if (!window.confirm('Run this bot now and place paper orders for any firing setups?')) return;
    setRunning(true);
    setEvalError(null);
    try {
      const res = await api.runBot(id, true);
      setEvalResult(res);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setEvalError('Bot engine starting…');
      else setEvalError((e as Error).message || 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  // Fill the form from an AI-generated draft (Kimi). Resets evaluation state.
  function applyAiDraft(b: Partial<Bot>, explanation: string) {
    setDraft(botToDraft(b));
    setAiExplanation(explanation || null);
    setSaved(null);
    setEvalResult(null);
    setStep(0);
  }

  // The selected contract details (for the prominent "Selected:" line).
  const [selectedContract, setSelectedContract] = useState<SelectableContract | null>(null);

  const optionRight: 'call' | 'put' = draft.action.right === 'put' ? 'put' : 'call';

  // ---- render each step ----
  return (
    <div className="p-2.5 flex flex-col gap-3 max-w-3xl">
      {/* header: stepper + cancel */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Stepper step={step} onJump={jump} />
          {onCancel && (
            <button className="btn flex items-center gap-1.5" onClick={onCancel}>
              <X size={12} /> Cancel
            </button>
          )}
        </div>
        {/* Per-step education line */}
        <div className="flex items-center gap-2 text-xs text-text-dim">
          <Lightbulb size={13} className="text-amber shrink-0" />
          <span>
            <span className="text-text font-medium">Step {step + 1} · {STEPS[step]}</span>
            {' — '}
            {STEP_HELP[step]}
          </span>
        </div>
      </div>

      {/* Build with AI (Kimi) — prominent on the first step */}
      {step === 0 && <AiBuilder onDraft={applyAiDraft} defaultOpen={aiOpen} />}
      {aiExplanation && (
        <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2">
          <div className="micro-label text-amber mb-1 flex items-center gap-1.5">
            <Sparkles size={12} /> AI strategy — tweak any step, then Save
          </div>
          <Markdown source={aiExplanation} />
        </div>
      )}

      {/* name (always visible) */}
      <div>
        <label className={MICRO}>Bot name</label>
        <input
          className="input w-full"
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="e.g. QQQ RSI dip-buyer"
        />
      </div>

      {/* ---------------- STEP 0: Ticker ---------------- */}
      {step === 0 && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={MICRO}>
              Pick the underlying
              <HelpTip title="Underlying" className="ml-1">
                The stock or ETF the bot watches and trades. Add one or more — the bot scans
                each for your trigger. The primary (★) is the one the live contract picker uses.
              </HelpTip>
            </label>
            <TickerSearch onSelect={addTicker} placeholder="Search & add ticker (e.g. QQQ)…" />
          </div>
          {draft.symbols.length > 0 && (
            <div>
              <label className={MICRO}>Basket — click to set the primary (★)</label>
              <div className="flex flex-wrap items-center gap-1.5">
                {draft.symbols.map((sym) => {
                  const isPrimary = sym === draft.primary;
                  return (
                    <span
                      key={sym}
                      onClick={() => setPrimary(sym)}
                      className={`flex items-center gap-1 text-xs px-2 py-1 rounded border cursor-pointer transition-colors ${
                        isPrimary
                          ? 'border-amber/50 bg-amber/15 text-amber'
                          : 'border-border-2 bg-panel-2 text-text hover:bg-border'
                      }`}
                    >
                      {isPrimary && '★ '}
                      {sym}
                      <X
                        size={11}
                        className="cursor-pointer text-muted hover:text-down"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTicker(sym);
                        }}
                      />
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {draft.primary && (
            <div className="rounded border border-border bg-bg-2 p-3 flex items-center gap-3">
              <span className="font-mono text-lg text-text">{draft.primary}</span>
              <span className="num text-xl text-amber">
                {primaryPrice !== undefined ? money(primaryPrice) : snap.loading ? '…' : '—'}
              </span>
              <span className="text-2xs text-muted ml-auto">live underlying price</span>
            </div>
          )}
        </div>
      )}

      {/* ---------------- STEP 1: Entry trigger ---------------- */}
      {step === 1 && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={MICRO}>
              Timeframe
              <HelpTip title="Timeframe" className="ml-1">
                The bar size the rules are evaluated on. Smaller bars (1–5 min) give more
                signals but more noise — day-trading. Larger bars (1Hour / 1Day) give fewer,
                cleaner signals — swing / position trading.
              </HelpTip>
            </label>
            <select
              className="input"
              value={draft.timeframe}
              onChange={(e) => patch({ timeframe: e.target.value })}
            >
              {TIMEFRAMES.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="micro-label flex items-center gap-1">
                Entry rules — when to buy
                <HelpTip title="Entry rules">
                  When ALL (AND) / ANY (OR) of these conditions are true on a closed bar, the
                  bot signals an entry. Each row is <span className="text-text">[indicator]
                  [operator] [value]</span>; the value can be a number or another indicator key
                  (e.g. <span className="text-amber">ema21</span>, <span className="text-amber">vwap</span>).
                </HelpTip>
              </label>
              <button className="btn flex items-center gap-1" onClick={addRule}>
                <Plus size={12} /> Rule
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {draft.rules.map((rule, i) => {
                const info = indicatorHint(rule.indicator);
                const warn = ruleWarning(rule);
                return (
                <div key={i}>
                  {i > 0 && (
                    <div className="flex items-center gap-2 py-1">
                      <Toggle
                        value={rule.join}
                        onChange={(v) => updateRule(i, { join: v as 'AND' | 'OR' })}
                        options={[
                          { value: 'AND', label: 'AND' },
                          { value: 'OR', label: 'OR' },
                        ]}
                      />
                      <div className="flex-1 border-t border-border-2" />
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <select
                      className="input flex-1"
                      value={rule.indicator}
                      onChange={(e) => updateRule(i, { indicator: e.target.value })}
                    >
                      {indicatorOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                      {!indicatorOptions.some((o) => o.value === rule.indicator) && (
                        <option value={rule.indicator}>{rule.indicator}</option>
                      )}
                    </select>
                    <select
                      className="input w-36"
                      value={rule.operator}
                      onChange={(e) => updateRule(i, { operator: e.target.value })}
                    >
                      {OPERATORS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input w-24"
                      value={String(rule.value ?? '')}
                      onChange={(e) => updateRule(i, { value: e.target.value })}
                      placeholder="value"
                    />
                    <button
                      className="btn px-2 text-down"
                      onClick={() => removeRule(i)}
                      title="Remove rule"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>

                  {/* Hint for the picked indicator */}
                  <div className="flex items-start gap-1.5 mt-1 px-0.5 text-2xs text-text-dim leading-relaxed">
                    <Lightbulb size={11} className="text-amber shrink-0 mt-0.5" />
                    <span>{info.hint}</span>
                  </div>

                  {/* Suggested triggers — click to fill this row */}
                  {info.suggestions.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 mt-1 px-0.5">
                      <span className="text-2xs uppercase tracking-wider text-muted mr-0.5">
                        Suggested
                      </span>
                      {info.suggestions.map((s) => (
                        <button
                          key={s.label}
                          onClick={() => applySuggestion(i, s.rule)}
                          className="text-2xs px-1.5 py-0.5 rounded border border-amber/30 bg-amber/5 text-amber hover:bg-amber/15 transition-colors"
                          title="Click to apply this trigger"
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Non-blocking sanity warning */}
                  {warn && (
                    <div className="flex items-start gap-1.5 mt-1 px-0.5 text-2xs text-amber leading-relaxed">
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      <span>{warn}</span>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
          <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2">
            <span className="text-2xs text-muted block mb-0.5">Plain English</span>
            <span className="text-sm text-text">{entrySentence(draft, indicatorOptions)}</span>
          </div>
        </div>
      )}

      {/* ---------------- STEP 2: Action ---------------- */}
      {step === 2 && (
        <div className="flex flex-col gap-3">
          <div>
            <label className={MICRO}>
              What to trade
              <HelpTip title="Right (call / put / shares)" className="ml-1">
                Calls profit when the underlying moves up; puts profit when it moves down.
                Buy shares to trade the stock directly. If your trigger doesn't imply a
                direction, the AI / trigger logic can decide it for you.
              </HelpTip>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <ActionButton
                active={draft.action.asset === 'option' && draft.action.right === 'call'}
                tone="up"
                icon={<TrendingUp size={16} />}
                label="Buy Calls"
                onClick={() =>
                  patchAction({ asset: 'option', right: 'call', contract_symbol: null })
                }
              />
              <ActionButton
                active={draft.action.asset === 'option' && draft.action.right === 'put'}
                tone="down"
                icon={<TrendingDown size={16} />}
                label="Buy Puts"
                onClick={() =>
                  patchAction({ asset: 'option', right: 'put', contract_symbol: null })
                }
              />
              <ActionButton
                active={draft.action.asset === 'equity'}
                tone="amber"
                icon={<CandlestickChart size={16} />}
                label="Buy Shares"
                onClick={() =>
                  patchAction({ asset: 'equity', right: 'auto', contract_symbol: null })
                }
              />
            </div>
          </div>

          {draft.action.asset === 'option' && draft.action.right !== 'auto' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={MICRO}>
                    Expiry
                    <HelpTip title="Expiry" className="ml-1">
                      Which option expiration to trade. "Nearest weekly" always rolls to the
                      next weekly contract — cheaper and more reactive, but decays fast. Pick a
                      dated expiry for more time / less theta burn.
                    </HelpTip>
                  </label>
                  <select
                    className="input w-full"
                    value={draft.action.expiry}
                    onChange={(e) =>
                      patchAction({ expiry: e.target.value, contract_symbol: null })
                    }
                  >
                    <option value="nearest_weekly">Nearest weekly</option>
                    {expirations.map((ex) => (
                      <option key={ex.date} value={ex.date}>
                        {ex.date} {ex.type === 'weekly' ? '(weekly)' : '(monthly)'}
                      </option>
                    ))}
                  </select>
                  {draft.action.expiry === 'nearest_weekly' && (
                    <span className="mt-1 inline-block">
                      <Badge tone="amber">weekly</Badge>
                    </span>
                  )}
                </div>
                <div>
                  <label className={MICRO}>
                    Moneyness
                    <HelpTip title="Moneyness (ATM / OTM / ITM)" className="ml-1">
                      Strike relative to the current price. <span className="text-amber">ATM</span> ≈ 50
                      delta (balanced). <span className="text-amber">OTM</span> is cheaper but
                      lower-probability — needs a bigger move to pay off. <span className="text-amber">ITM</span> is
                      pricier but higher-probability and moves more like the stock.
                    </HelpTip>
                  </label>
                  <Toggle
                    value={draft.action.moneyness}
                    onChange={(v) =>
                      patchAction({ moneyness: v as 'ATM' | 'OTM' | 'ITM', contract_symbol: null })
                    }
                    options={[
                      { value: 'ATM', label: 'ATM' },
                      { value: 'OTM', label: 'OTM' },
                      { value: 'ITM', label: 'ITM' },
                    ]}
                  />
                  {draft.action.moneyness === 'OTM' && (
                    <div className="flex items-center gap-2 mt-2">
                      <span className="text-2xs text-muted flex items-center gap-1">
                        OTM strikes
                        <HelpTip title="OTM strikes">
                          How many strikes out-of-the-money from ATM to step. 1 is just past
                          the money; higher = cheaper, further reach, lower probability.
                        </HelpTip>
                      </span>
                      <input
                        type="number"
                        min={0}
                        className="input w-16"
                        value={draft.action.otm_strikes}
                        onChange={(e) =>
                          patchAction({ otm_strikes: Math.max(0, Number(e.target.value)) })
                        }
                      />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="micro-label">Pick the exact contract from the live chain</label>
                <label className="flex items-center gap-1.5 text-xs text-text-dim cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-amber"
                    checked={draft.action.contract_symbol === null}
                    onChange={(e) =>
                      patchAction({ contract_symbol: e.target.checked ? null : draft.action.contract_symbol })
                    }
                  />
                  Use auto ({draft.action.moneyness})
                </label>
              </div>

              {selectedContract && draft.action.contract_symbol && (
                <div className="rounded border border-amber/40 bg-amber/10 px-3 py-2 text-sm text-amber">
                  Selected: <span className="font-semibold">{draft.primary}</span>{' '}
                  {formatContract({
                    occ: selectedContract.occ_symbol,
                    strike: selectedContract.strike,
                    expiration: selectedContract.expiration,
                    right: optionRight === 'put' ? 'put' : 'call',
                  })?.human ?? `${selectedContract.expiration} ${money(selectedContract.strike)}`}{' '}
                  · {money(selectedContract.mid)} mid · ≈ {money(selectedContract.mid * 100)}/contract · Δ{' '}
                  {num(selectedContract.delta)}
                </div>
              )}

              {draft.primary ? (
                <ContractPicker
                  symbol={draft.primary}
                  right={optionRight}
                  expiry={draft.action.expiry}
                  moneyness={draft.action.moneyness}
                  selected={draft.action.contract_symbol}
                  onSelect={(c) => {
                    setSelectedContract(c);
                    patchAction({ contract_symbol: c.occ_symbol, moneyness: c.moneyness });
                  }}
                />
              ) : (
                <Empty label="Pick a primary ticker first (step 1)" />
              )}
            </>
          )}

          {draft.action.asset === 'equity' && (
            <div className="rounded border border-border bg-bg-2 px-3 py-2 text-xs text-text-dim">
              Bot will buy shares of {draft.primary || 'the ticker'} on entry — no contract to pick.
            </div>
          )}

          <DraftBacktest bt={bt} draft={draft} collapsible />
        </div>
      )}

      {/* ---------------- STEP 3: Sizing & risk + mode ---------------- */}
      {step === 3 && (
        <div className="flex flex-col gap-3">
          {/* Sizing & risk basics — how the three numbers relate */}
          <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2 text-2xs text-text-dim leading-relaxed">
            <span className="micro-label text-amber flex items-center gap-1.5 mb-1">
              <Lightbulb size={12} /> Sizing &amp; risk basics
            </span>
            <span className="num text-text">Risk / trade %</span> sets the most you'd lose if
            the stop hits — e.g. 1% of a $30k account = $300 at risk. The position size is
            derived from that and your stop distance, so a tighter stop buys more contracts for
            the same risk. <span className="num text-text">Contracts</span> is the cap on size,
            and <span className="num text-text">max premium</span> skips trades that cost more
            than you want per contract.
          </div>
          <div>
            <label className={MICRO}>Sizing</label>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <span className="text-2xs text-muted flex items-center gap-1">
                  {draft.action.asset === 'equity' ? 'Qty (shares)' : 'Contracts'}
                  <HelpTip title={draft.action.asset === 'equity' ? 'Quantity' : 'Contracts'}>
                    {draft.action.asset === 'equity'
                      ? 'Number of shares to buy per entry.'
                      : 'Number of option contracts per entry. Each contract controls 100 shares of exposure.'}
                  </HelpTip>
                </span>
                <input
                  type="number"
                  min="1"
                  className="input w-full mt-0.5"
                  value={draft.config.contracts}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      config: { ...d.config, contracts: Number(e.target.value) },
                    }))
                  }
                />
              </div>
              <div>
                <span className="text-2xs text-muted flex items-center gap-1">
                  Risk / trade %
                  <HelpTip title="Risk per trade %">
                    The max % of account equity you'd lose if the stop is hit. Position size is
                    derived from this and the stop distance. 0.5–1% is conservative; higher
                    risks more per trade.
                  </HelpTip>
                </span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  className="input w-full mt-0.5"
                  value={draft.risk.risk_per_trade_pct}
                  onChange={(e) => patch({ risk: { risk_per_trade_pct: Number(e.target.value) } })}
                />
              </div>
              <div>
                <span className="text-2xs text-muted flex items-center gap-1">
                  Max premium ($)
                  <HelpTip title="Max premium ($)">
                    Skip a trade if the option costs more than this per contract (price × 100).
                    Caps how much you'll pay for a single contract.
                  </HelpTip>
                </span>
                <input
                  type="number"
                  min="0"
                  className="input w-full mt-0.5"
                  value={draft.config.max_premium}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      config: { ...d.config, max_premium: Number(e.target.value) },
                    }))
                  }
                />
              </div>
            </div>
          </div>

          <div>
            <label className={MICRO}>
              AI Gate — market research
              <HelpTip title="AI gate / Min conviction" className="ml-1">
                Require the AI research conviction (0–100) to clear this bar before the bot
                trades. Higher = pickier, fewer trades but stronger setups. Turn off to trade
                purely on the technical trigger.
              </HelpTip>
            </label>
            <div className="flex items-center gap-3">
              <Toggle
                value={draft.ai_gate.enabled ? 'on' : 'off'}
                onChange={(v) => patch({ ai_gate: { ...draft.ai_gate, enabled: v === 'on' } })}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'on', label: 'On' },
                ]}
              />
              {draft.ai_gate.enabled && (
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-2xs text-muted whitespace-nowrap">Min conviction</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={draft.ai_gate.min_conviction}
                    onChange={(e) =>
                      patch({
                        ai_gate: { ...draft.ai_gate, min_conviction: Number(e.target.value) },
                      })
                    }
                    className="flex-1 accent-amber"
                  />
                  <span className="text-amber text-xs w-8 text-right tabular-nums">
                    {draft.ai_gate.min_conviction}
                  </span>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className={MICRO}>
              Mode
              <HelpTip title="Mode" className="ml-1">
                <span className="text-amber">Signal-only</span> alerts you, places no orders.
                {' '}<span className="text-amber">Semi-auto</span> queues a proposal you approve
                each time. <span className="text-amber">Full-auto</span> places orders
                automatically — the risk engine can still veto.
              </HelpTip>
            </label>
            <Toggle
              value={draft.mode}
              onChange={(v) => patch({ mode: v as BotMode })}
              options={MODE_OPTIONS}
            />
          </div>

          <DraftBacktest bt={bt} draft={draft} collapsible />
        </div>
      )}

      {/* ---------------- STEP 4: Review & Save ---------------- */}
      {step === 4 && (
        <div className="flex flex-col gap-3">
          <div className="rounded border border-border bg-bg-2 p-3 flex flex-col gap-2 text-sm">
            <Row label="Name" value={draft.name} />
            <Row label="Primary" value={draft.primary || '—'} />
            <Row label="Basket" value={draft.symbols.join(', ') || '—'} />
            <Row label="Trigger" value={entrySentence(draft, indicatorOptions)} />
            <Row
              label="Action"
              value={
                draft.action.asset === 'equity'
                  ? 'Buy shares'
                  : `Buy ${draft.action.right === 'put' ? 'PUTS' : 'CALLS'} · ${draft.action.moneyness} · ${draft.action.expiry}`
              }
            />
            <Row
              label="Contract"
              value={
                draft.action.contract_symbol
                  ? draft.action.contract_symbol
                  : `auto (${draft.action.moneyness})`
              }
            />
            <Row
              label="Sizing"
              value={`${draft.config.contracts} × · risk ${draft.risk.risk_per_trade_pct}% · max prem ${money(draft.config.max_premium)}`}
            />
            <Row
              label="AI gate"
              value={
                draft.ai_gate.enabled
                  ? `on · min conviction ${draft.ai_gate.min_conviction}`
                  : 'off'
              }
            />
            <Row label="Mode" value={draft.mode} />
          </div>

          {/* Backtest the draft over real history BEFORE saving. */}
          <DraftBacktest bt={bt} draft={draft} />

          <button
            className="btn-amber flex items-center justify-center gap-1.5 py-2.5 text-sm"
            onClick={save}
            disabled={saving}
          >
            <Save size={14} /> {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Save bot'}
          </button>

          {saveError && <div className="text-down text-xs micro-label">{saveError}</div>}

          {saved && (
            <div className="rounded border border-up/40 bg-up/10 p-3 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-up text-sm">
                <Check size={15} /> Saved “{saved.name}”
                <Badge tone={saved.enabled ? 'up' : 'neutral'}>
                  {saved.enabled ? 'ON' : 'OFF'}
                </Badge>
                <Badge tone={saved.mode === 'auto' ? 'up' : saved.mode === 'semi' ? 'amber' : 'neutral'}>
                  {saved.mode}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  className="btn flex items-center justify-center gap-1.5 py-2"
                  onClick={evaluate}
                  disabled={evaluating || running}
                >
                  <Zap size={13} /> {evaluating ? 'Evaluating…' : 'Evaluate now'}
                </button>
                <button
                  className="btn flex items-center justify-center gap-1.5 py-2 text-amber"
                  onClick={run}
                  disabled={evaluating || running}
                  title="Run the bot and place paper orders for firing setups"
                >
                  <Play size={13} /> {running ? 'Running…' : 'Run (paper)'}
                </button>
              </div>
              {evalError && <div className="text-down text-xs micro-label">{evalError}</div>}
              {evaluating || running ? (
                <Spinner label={running ? 'running' : 'evaluating'} />
              ) : evalResult ? (
                <BotEvaluation result={evalResult} />
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* step error + nav */}
      {stepError && <div className="text-down text-xs micro-label">{stepError}</div>}

      {step < STEPS.length - 1 && (
        <div className="flex items-center justify-between pt-1 border-t border-border">
          <button
            className="btn flex items-center gap-1 disabled:opacity-40"
            onClick={back}
            disabled={step === 0}
          >
            <ChevronLeft size={12} /> Back
          </button>
          <span className="text-2xs text-muted">
            Step {step + 1} of {STEPS.length}
          </span>
          <button className="btn-amber flex items-center gap-1" onClick={next}>
            Next <ChevronRight size={12} />
          </button>
        </div>
      )}
      {step === STEPS.length - 1 && (
        <div className="flex items-center justify-between pt-1 border-t border-border">
          <button className="btn flex items-center gap-1" onClick={back}>
            <ChevronLeft size={12} /> Back
          </button>
          <span className="text-2xs text-muted">Final step</span>
        </div>
      )}
    </div>
  );
}

function ActionButton({
  active,
  tone,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  tone: 'up' | 'down' | 'amber';
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  const toneCls =
    tone === 'up'
      ? 'border-up/50 bg-up/15 text-up'
      : tone === 'down'
        ? 'border-down/50 bg-down/15 text-down'
        : 'border-amber/50 bg-amber/15 text-amber';
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center justify-center gap-1.5 py-4 rounded border transition-colors ${
        active ? toneCls : 'border-border-2 bg-panel-2 text-text-dim hover:bg-border'
      }`}
    >
      {icon}
      <span className="text-sm">{label}</span>
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-2xs uppercase tracking-wider text-muted w-20 shrink-0 pt-0.5">
        {label}
      </span>
      <span className="text-text-dim flex-1 break-words">{value}</span>
    </div>
  );
}

// ==========================================================================
//  Guided onboarding — friendly first-run welcome + "how to start" choices
// ==========================================================================

function ChoiceCard({
  icon,
  title,
  desc,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-start gap-2 text-left rounded-2xl border border-border bg-panel-2 p-5 hover:border-amber/60 hover:bg-amber/5 transition-colors"
    >
      <span className="text-3xl leading-none">{icon}</span>
      <span className="text-base font-semibold text-text group-hover:text-amber transition-colors">
        {title}
      </span>
      <span className="text-xs text-text-dim leading-relaxed">{desc}</span>
    </button>
  );
}

function BuilderOnboarding({
  onChoice,
  onSkip,
}: {
  onChoice: (c: 'template' | 'ai' | 'scratch') => void;
  onSkip: (dontShowAgain: boolean) => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center min-h-full px-6 py-10">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        {/* Welcome */}
        <div className="rounded-2xl border border-border bg-panel-2 p-6 flex flex-col gap-3">
          <div className="flex items-center gap-2.5">
            <span className="w-9 h-9 rounded-full bg-amber/15 flex items-center justify-center">
              <Wand2 size={18} className="text-amber" />
            </span>
            <h1 className="text-xl font-semibold text-text tracking-tight">Build a trading bot</h1>
          </div>
          <p className="text-sm text-text-dim leading-relaxed">
            A bot watches a ticker for an <span className="text-text">entry trigger</span>. When it
            fires, the signal passes through an <span className="text-text">AI gate</span> and the{' '}
            <span className="text-text">risk engine</span> before any order is placed. You stay in
            control — choose signal-only, semi-auto, or full-auto.
          </p>
        </div>

        {/* How to start */}
        <div className="flex flex-col gap-3">
          <span className="micro-label">How do you want to start?</span>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <ChoiceCard
              icon="📚"
              title="Use a template"
              desc="Start from a research-backed strategy in the Library and customize it."
              onClick={() => onChoice('template')}
            />
            <ChoiceCard
              icon="✨"
              title="Describe with AI"
              desc="Tell the AI your idea in plain English and it drafts the bot for you."
              onClick={() => onChoice('ai')}
            />
            <ChoiceCard
              icon="🛠️"
              title="Build from scratch"
              desc="Go straight to the guided steps and configure every detail yourself."
              onClick={() => onChoice('scratch')}
            />
          </div>
        </div>

        {/* Skip */}
        <div className="flex items-center justify-center gap-4 pt-1">
          <button className="text-xs text-text-dim hover:text-text transition-colors" onClick={() => onSkip(false)}>
            Skip for now
          </button>
          <span className="text-muted">·</span>
          <button
            className="text-xs text-text-dim hover:text-text transition-colors"
            onClick={() => onSkip(true)}
          >
            Don't show this again
          </button>
        </div>
      </div>
    </div>
  );
}

// ==========================================================================
//  Full-page Builder view (list + builder)
// ==========================================================================

export function Builder() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const list = usePolling<Bot[]>(() => api.bots(), 20000, []);
  const [mode, setMode] = useState<'list' | 'onboard' | 'edit'>('list');
  const [editing, setEditing] = useState<Partial<Bot> | null>(null);
  const [aiOpen, setAiOpen] = useState(false);

  const bots = list.data ?? [];

  function hasOnboarded(): boolean {
    try {
      return localStorage.getItem(ONBOARDED_KEY) === '1';
    } catch {
      return true;
    }
  }

  // Prefill from the Strategy Library "Customize" action (?from=template).
  useEffect(() => {
    if (searchParams.get('from') !== 'template') return;
    const draft = takeTemplatePrefill();
    if (draft) {
      setEditing(draft);
      setAiOpen(false);
      setMode('edit');
    }
    // clear the query param so a refresh doesn't re-trigger
    const next = new URLSearchParams(searchParams);
    next.delete('from');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-run: show the friendly onboarding automatically (once).
  useEffect(() => {
    if (searchParams.get('from') === 'template') return;
    if (!hasOnboarded()) {
      setEditing(null);
      setMode('onboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function newBot() {
    setEditing(null);
    setAiOpen(false);
    // New bots get the guided onboarding unless they've dismissed it.
    setMode(hasOnboarded() ? 'edit' : 'onboard');
  }
  function editBot(b: Bot) {
    setEditing(b);
    setAiOpen(false);
    setMode('edit'); // editing an existing bot skips straight to the form
  }
  function backToList() {
    setMode('list');
    setEditing(null);
    setAiOpen(false);
    list.refetch();
  }

  function markOnboarded() {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  function handleChoice(c: 'template' | 'ai' | 'scratch') {
    markOnboarded();
    if (c === 'template') {
      navigate('/library');
      return;
    }
    setEditing(null);
    setAiOpen(c === 'ai');
    setMode('edit');
  }

  function handleSkip(dontShowAgain: boolean) {
    if (dontShowAgain) markOnboarded();
    setEditing(null);
    setAiOpen(false);
    setMode('edit');
  }

  return (
    <div className="grid grid-cols-[300px_1fr] gap-2 h-full min-h-0 p-2">
      {/* LEFT: bot list */}
      <Panel
        title="Bots"
        right={
          <div className="flex items-center gap-1.5">
            <button
              className="btn flex items-center gap-1"
              onClick={() => navigate('/library')}
              title="Start from a research-backed template"
            >
              <BookOpen size={12} /> Templates
            </button>
            <button className="btn-amber flex items-center gap-1" onClick={newBot}>
              <Plus size={12} /> New
            </button>
          </div>
        }
        bodyClassName="overflow-y-auto"
      >
        {list.loading && !list.data ? (
          <Spinner label="loading bots" />
        ) : list.error && !list.data ? (
          <ErrorState label="Could not load bots" onRetry={list.refetch} />
        ) : bots.length === 0 ? (
          <Empty label="No bots — hit + New" />
        ) : (
          <div className="flex flex-col">
            {bots.map((b) => {
              const active = editing?.id === b.id && mode === 'edit';
              const right = b.action?.right;
              return (
                <button
                  key={b.id}
                  onClick={() => editBot(b)}
                  className={`text-left px-3 py-2.5 border-b border-border transition-colors ${
                    active ? 'bg-amber/10' : 'hover:bg-panel-2'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate ${active ? 'text-amber' : 'text-text'}`}>
                      {b.name || 'Untitled'}
                    </span>
                    <Badge tone={b.enabled ? 'up' : 'neutral'}>{b.enabled ? 'ON' : 'OFF'}</Badge>
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <Badge tone={b.mode === 'auto' ? 'up' : b.mode === 'semi' ? 'amber' : 'neutral'}>
                      {b.mode}
                    </Badge>
                    {right && right !== 'auto' && (
                      <Badge tone={right === 'call' ? 'up' : 'down'}>{right}</Badge>
                    )}
                    {(b.symbols || []).slice(0, 4).map((sym) => (
                      <span
                        key={sym}
                        className="text-2xs px-1 py-0.5 rounded bg-panel-2 text-text-dim border border-border-2"
                      >
                        {sym}
                      </span>
                    ))}
                    {(b.symbols?.length ?? 0) > 4 && (
                      <span className="text-2xs text-muted">+{b.symbols.length - 4}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {/* RIGHT: guided builder */}
      <Panel
        title={
          <span className="flex items-center gap-1.5">
            <Wand2 size={13} />{' '}
            {mode === 'edit'
              ? editing
                ? 'Edit Bot'
                : 'New Bot'
              : mode === 'onboard'
                ? 'Get started'
                : 'Builder'}
          </span>
        }
        bodyClassName="overflow-y-auto"
      >
        {mode === 'onboard' ? (
          <BuilderOnboarding onChoice={handleChoice} onSkip={handleSkip} />
        ) : mode === 'edit' ? (
          <BuilderForm
            key={editing?.id ?? 'new'}
            initial={editing}
            aiOpen={aiOpen}
            onSaved={() => list.refetch()}
            onCancel={backToList}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6 py-10">
            <Wand2 size={24} className="text-amber" />
            <p className="text-sm text-text-dim leading-relaxed max-w-sm">
              Build a trading bot end-to-end: pick a ticker, define an entry trigger, choose calls or
              puts, pick the exact contract from the live chain, set sizing, and save.
            </p>
            <div className="flex items-center gap-2">
              <button className="btn-amber flex items-center gap-1" onClick={newBot}>
                <Plus size={12} /> New bot
              </button>
              <button className="btn flex items-center gap-1" onClick={() => navigate('/library')}>
                <BookOpen size={12} /> Start from a template
              </button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
