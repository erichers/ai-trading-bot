import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Check,
  Plus,
  Trash2,
  X,
  Zap,
  Save,
  FlaskConical,
  Wand2,
  GraduationCap,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/api/client';
import type {
  IndicatorCatalogItem,
  SignalEvalResult,
  Strategy,
  StrategyMode,
  StrategyRule,
} from '@/api/types';
import { num } from '@/lib/format';
import { Badge, Empty, ErrorState, HelpTip, Panel, Spinner, Toggle } from '@/components/ui';
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

const MODE_OPTIONS: { value: StrategyMode; label: string }[] = [
  { value: 'signal', label: 'Signal-only' },
  { value: 'semi', label: 'Semi-auto' },
  { value: 'auto', label: 'Full-auto' },
];

// A locally-editable draft. id is empty string for an unsaved draft.
interface Draft {
  id: string;
  name: string;
  symbols: string[];
  timeframe: string;
  rules: StrategyRule[];
  ai_gate: { enabled: boolean; min_conviction: number };
  exits: {
    stop_type: string;
    stop_value: number;
    target_type: string;
    target_value: number;
    trailing: boolean;
  };
  sizing: { risk_per_trade_pct: number; max_position_pct: number; max_positions: number };
  mode: StrategyMode;
  enabled: boolean;
}

function blankDraft(firstIndicator: string): Draft {
  return {
    id: '',
    name: 'New Strategy',
    symbols: [],
    timeframe: '15Min',
    rules: [{ indicator: firstIndicator, operator: '>', value: '', join: 'AND' }],
    ai_gate: { enabled: false, min_conviction: 60 },
    exits: {
      stop_type: 'percent',
      stop_value: 2,
      target_type: 'R',
      target_value: 2,
      trailing: false,
    },
    sizing: { risk_per_trade_pct: 1, max_position_pct: 20, max_positions: 5 },
    mode: 'signal',
    enabled: false,
  };
}

function strategyToDraft(s: Strategy): Draft {
  return {
    id: s.id,
    name: s.name,
    symbols: [...(s.symbols || [])],
    timeframe: s.timeframe || '15Min',
    rules:
      s.rules && s.rules.length
        ? s.rules.map((r) => ({ ...r }))
        : [{ indicator: 'rsi14', operator: '>', value: '', join: 'AND' }],
    ai_gate: { enabled: !!s.ai_gate?.enabled, min_conviction: s.ai_gate?.min_conviction ?? 60 },
    exits: {
      stop_type: s.exits?.stop_type ?? 'percent',
      stop_value: s.exits?.stop_value ?? 2,
      target_type: s.exits?.target_type ?? 'R',
      target_value: s.exits?.target_value ?? 2,
      trailing: !!s.exits?.trailing,
    },
    sizing: {
      risk_per_trade_pct: s.sizing?.risk_per_trade_pct ?? 1,
      max_position_pct: s.sizing?.max_position_pct ?? 20,
      max_positions: s.sizing?.max_positions ?? 5,
    },
    mode: s.mode ?? 'signal',
    enabled: !!s.enabled,
  };
}

// A section label with a step number and an inline "?" explainer.
function SectionLabel({
  step,
  children,
  title,
  help,
}: {
  step?: number;
  children: React.ReactNode;
  title: string;
  help: React.ReactNode;
}) {
  return (
    <label className="micro-label mb-1 flex items-center gap-1.5">
      {step !== undefined && (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber/15 text-amber text-[9px] font-bold not-italic">
          {step}
        </span>
      )}
      {children}
      <HelpTip title={title}>{help}</HelpTip>
    </label>
  );
}

// Tiny muted hint shown beneath a field label.
function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-2xs text-muted leading-relaxed mb-1">{children}</p>;
}

const GUIDE_STEPS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: GraduationCap, title: 'Name it', body: 'Give the bot a label you’ll recognize, like “QQQ RSI dip”.' },
  { icon: GraduationCap, title: 'Pick the universe', body: 'Add the ticker(s) it watches. Each is evaluated on its own.' },
  { icon: GraduationCap, title: 'Choose a timeframe', body: 'The candle size. 1–5 Min = day trading; 1Hour–1Day = swing.' },
  { icon: GraduationCap, title: 'Set entry rules', body: 'The indicator conditions that must be true to enter, e.g. RSI(14) crosses above 32.' },
  { icon: GraduationCap, title: 'Add exits & risk', body: 'Where you take profit (target) and bail (stop), plus how much to risk.' },
  { icon: GraduationCap, title: 'Pick a mode & save', body: 'Signal-only alerts you; Full-auto places paper orders when rules fire. Test, then Save.' },
];

function HowToGuide() {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border border-amber/30 bg-amber/[0.06]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? (
          <ChevronDown size={13} className="text-amber shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-amber shrink-0" />
        )}
        <GraduationCap size={14} className="text-amber shrink-0" />
        <span className="micro-label text-amber">How to set up a bot</span>
        <span className="text-2xs text-muted ml-auto">{open ? 'hide' : '6 steps'}</span>
      </button>
      {open && (
        <ol className="px-3 pb-3 pt-0.5 grid sm:grid-cols-2 gap-x-4 gap-y-2">
          {GUIDE_STEPS.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber/15 text-amber text-[9px] font-bold shrink-0 mt-0.5">
                {i + 1}
              </span>
              <span className="text-2xs leading-relaxed">
                <span className="text-text font-medium">{s.title}.</span>{' '}
                <span className="text-text-dim">{s.body}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function Strategies() {
  const list = usePolling<Strategy[]>(() => api.strategies(), 20000, []);
  const [catalog, setCatalog] = useState<IndicatorCatalogItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const [tickerInput, setTickerInput] = useState('');
  const [testResult, setTestResult] = useState<SignalEvalResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load indicator catalog once.
  useEffect(() => {
    let alive = true;
    api
      .indicatorCatalog()
      .then((c) => {
        if (alive) setCatalog(c || []);
      })
      .catch(() => {
        if (alive) setCatalog([]);
      });
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
  const defaultIndicator = indicatorOptions[0]?.value ?? 'rsi14';

  const strategies = list.data ?? [];

  // When the selected strategy resolves (or changes), seed the builder.
  useEffect(() => {
    if (selectedId === null) return;
    const found = strategies.find((s) => s.id === selectedId);
    if (found) {
      setDraft(strategyToDraft(found));
      resetActionState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, list.data]);

  function resetActionState() {
    setTestResult(null);
    setTestError(null);
    setSaveError(null);
    setTickerInput('');
  }

  function selectStrategy(s: Strategy) {
    setSelectedId(s.id);
    setDraft(strategyToDraft(s));
    resetActionState();
  }

  function newDraft() {
    setSelectedId(null);
    setDraft(blankDraft(defaultIndicator));
    resetActionState();
  }

  function patch(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  // ---- ticker chips ----
  function addTicker() {
    const sym = tickerInput.trim().toUpperCase();
    if (!sym || !draft) return;
    if (!draft.symbols.includes(sym)) patch({ symbols: [...draft.symbols, sym] });
    setTickerInput('');
  }
  function removeTicker(sym: string) {
    if (!draft) return;
    patch({ symbols: draft.symbols.filter((s) => s !== sym) });
  }

  // ---- rules ----
  function updateRule(i: number, p: Partial<StrategyRule>) {
    if (!draft) return;
    patch({ rules: draft.rules.map((r, idx) => (idx === i ? { ...r, ...p } : r)) });
  }
  function addRule() {
    if (!draft) return;
    patch({
      rules: [
        ...draft.rules,
        { indicator: defaultIndicator, operator: '>', value: '', join: 'AND' },
      ],
    });
  }
  function removeRule(i: number) {
    if (!draft) return;
    const next = draft.rules.filter((_, idx) => idx !== i);
    patch({
      rules: next.length
        ? next
        : [{ indicator: defaultIndicator, operator: '>', value: '', join: 'AND' }],
    });
  }

  // ---- actions ----
  async function testSignal() {
    if (!draft) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const symbol = draft.symbols[0];
      if (!symbol) throw new Error('Add at least one ticker to the universe');
      const res = await api.evaluateSignal(symbol, draft.timeframe, draft.rules);
      setTestResult(res);
    } catch (e) {
      setTestError((e as Error).message || 'Evaluation failed');
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const payload: Partial<Strategy> = {
        name: draft.name,
        symbols: draft.symbols,
        timeframe: draft.timeframe,
        rules: draft.rules,
        ai_gate: draft.ai_gate,
        exits: draft.exits,
        sizing: draft.sizing,
        mode: draft.mode,
        enabled: draft.enabled,
      };
      const saved = draft.id
        ? await api.updateStrategy(draft.id, payload)
        : await api.createStrategy(payload);
      setSelectedId(saved.id);
      setDraft(strategyToDraft(saved));
      list.refetch();
    } catch (e) {
      setSaveError((e as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft?.id) return;
    setDeleting(true);
    setSaveError(null);
    try {
      await api.deleteStrategy(draft.id);
      setSelectedId(null);
      setDraft(null);
      list.refetch();
    } catch (e) {
      setSaveError((e as Error).message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  }

  async function toggleEnabled(s: Strategy, next: boolean) {
    try {
      await api.updateStrategy(s.id, { enabled: next });
      list.refetch();
      if (draft && draft.id === s.id) patch({ enabled: next });
    } catch {
      /* poll will resync */
    }
  }

  function modeTone(mode: StrategyMode): 'neutral' | 'amber' | 'up' {
    if (mode === 'auto') return 'up';
    if (mode === 'semi') return 'amber';
    return 'neutral';
  }

  return (
    <div className="grid grid-cols-[300px_1fr] gap-2 h-full min-h-0 p-2">
      {/* LEFT: strategy list */}
      <Panel
        title="Strategies"
        right={
          <div className="flex items-center gap-1">
            <Link to="/builder" className="btn flex items-center gap-1" title="Guided bot builder">
              <Wand2 size={12} /> Builder
            </Link>
            <button className="btn-amber flex items-center gap-1" onClick={newDraft}>
              <Plus size={12} /> New
            </button>
          </div>
        }
        bodyClassName="overflow-y-auto"
      >
        {list.loading && !list.data ? (
          <Spinner label="Loading strategies" />
        ) : list.error && !list.data ? (
          <ErrorState label="Could not load strategies" onRetry={list.refetch} />
        ) : strategies.length === 0 ? (
          <Empty label="No strategies — hit + New" />
        ) : (
          <div className="flex flex-col">
            {strategies.map((s) => {
              const active = s.id === selectedId;
              return (
                <button
                  key={s.id}
                  onClick={() => selectStrategy(s)}
                  className={`text-left px-3 py-2 border-b border-border transition-colors ${
                    active ? 'bg-amber/10' : 'hover:bg-panel-2'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm truncate ${active ? 'text-amber' : 'text-text'}`}
                    >
                      {s.name || 'Untitled'}
                    </span>
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleEnabled(s, !s.enabled);
                      }}
                    >
                      <Badge tone={s.enabled ? 'up' : 'neutral'}>
                        {s.enabled ? 'ON' : 'OFF'}
                      </Badge>
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-1 flex-wrap">
                    <Badge tone={modeTone(s.mode)}>{s.mode}</Badge>
                    {(s.symbols || []).slice(0, 4).map((sym) => (
                      <span
                        key={sym}
                        className="text-2xs px-1 py-0.5 rounded bg-panel-2 text-text-dim border border-border-2"
                      >
                        {sym}
                      </span>
                    ))}
                    {(s.symbols?.length ?? 0) > 4 && (
                      <span className="text-2xs text-muted">+{s.symbols.length - 4}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {/* RIGHT: builder */}
      <Panel
        title={draft ? (draft.id ? 'Edit Strategy' : 'New Strategy') : 'Strategy Builder'}
        right={
          draft && (
            <div className="flex items-center gap-1">
              <button
                className="btn flex items-center gap-1"
                onClick={testSignal}
                disabled={testing}
              >
                <FlaskConical size={12} /> {testing ? 'Testing…' : 'Test signal now'}
              </button>
              {draft.id && (
                <button
                  className="btn flex items-center gap-1 text-down"
                  onClick={remove}
                  disabled={deleting}
                >
                  <Trash2 size={12} /> {deleting ? 'Deleting…' : 'Delete'}
                </button>
              )}
              <button
                className="btn-amber flex items-center gap-1"
                onClick={save}
                disabled={saving}
              >
                <Save size={12} /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )
        }
        bodyClassName="overflow-y-auto"
      >
        {!draft ? (
          <Empty label="Select a strategy or create a new one" />
        ) : (
          <div className="p-3 flex flex-col gap-4 max-w-3xl">
            {/* How-to guide */}
            <HowToGuide />

            {/* Name */}
            <div>
              <SectionLabel
                step={1}
                title="Name"
                help="A label so you can recognize this bot later in the list — e.g. “QQQ RSI dip” or “NVDA momentum”. It has no effect on trading."
              >
                Name
              </SectionLabel>
              <input
                className="input w-full"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. QQQ RSI dip"
              />
            </div>

            {/* Universe */}
            <div>
              <SectionLabel
                step={2}
                title="Universe"
                help="The ticker(s) this bot watches. Add one or more — each symbol is evaluated independently against your rules. Type a symbol and press Enter to add it; click the ✕ to remove."
              >
                Universe
              </SectionLabel>
              <Hint>Type a symbol (e.g. QQQ, NVDA) and press Enter.</Hint>
              <div className="flex flex-wrap items-center gap-1 p-2 rounded border border-border bg-bg-2">
                {draft.symbols.map((sym) => (
                  <span
                    key={sym}
                    className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-panel-2 border border-border-2 text-text"
                  >
                    {sym}
                    <X
                      size={11}
                      className="cursor-pointer text-muted hover:text-down"
                      onClick={() => removeTicker(sym)}
                    />
                  </span>
                ))}
                <input
                  className="bg-transparent outline-none text-xs px-1 py-0.5 flex-1 min-w-[80px] text-text placeholder:text-muted"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTicker();
                    }
                  }}
                  placeholder="Add ticker + Enter"
                />
              </div>
            </div>

            {/* Timeframe */}
            <div>
              <SectionLabel
                step={3}
                title="Timeframe"
                help="The candle size your indicators are calculated on. Shorter (1–5 Min) gives more, faster signals — good for day trading but noisier. Longer (1Hour–1Day) gives fewer, steadier signals — good for swing trades."
              >
                Timeframe
              </SectionLabel>
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

            {/* Rule builder */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <SectionLabel
                  step={4}
                  title="Entry rules"
                  help={
                    <>
                      The technical conditions that must be true to trigger an entry. Each rule is{' '}
                      <b>indicator → comparison → value</b> (e.g. RSI(14) <i>crosses above</i> 32).
                      Chain several with <b>AND</b> (all must be true) or <b>OR</b> (any can be true).{' '}
                      <i>crosses above/below</i> fires only on the bar it crosses — cleaner entries than a plain &gt;/&lt;.
                    </>
                  }
                >
                  Rules — indicators to fire
                </SectionLabel>
                <button className="btn flex items-center gap-1" onClick={addRule}>
                  <Plus size={12} /> Rule
                </button>
              </div>
              <Hint>
                Example: <span className="text-text-dim font-mono">RSI(14) crosses above 32</span> — buy
                when momentum turns up from oversold.
              </Hint>
              <div className="flex flex-col gap-1">
                {draft.rules.map((rule, i) => (
                  <div key={i}>
                    {i > 0 && (
                      <div className="flex items-center gap-2 py-1">
                        <Toggle
                          value={draft.rules[i].join}
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
                        className="input w-32"
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
                        className="input w-28"
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
                  </div>
                ))}
              </div>
            </div>

            {/* AI Gate */}
            <div>
              <SectionLabel
                title="AI gate"
                help="An optional second opinion. When ON, after your rules pass the bot only enters if the AI research model’s conviction meets your minimum. Raise it to be more selective; turn it OFF to trade purely on the technical rules above."
              >
                AI Gate
              </SectionLabel>
              <Hint>Optional. Leave Off to trade on the rules alone.</Hint>
              <div className="flex items-center gap-3">
                <Toggle
                  value={draft.ai_gate.enabled ? 'on' : 'off'}
                  onChange={(v) =>
                    patch({ ai_gate: { ...draft.ai_gate, enabled: v === 'on' } })
                  }
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
                          ai_gate: {
                            ...draft.ai_gate,
                            min_conviction: Number(e.target.value),
                          },
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

            {/* Exits & Risk */}
            <div>
              <SectionLabel
                step={5}
                title="Exits & risk"
                help={
                  <>
                    Every trade needs a way out. <b>Stop</b> is where you bail if it goes against you;{' '}
                    <b>Target</b> is where you take profit. Type <b>percent</b> = a % move,{' '}
                    <b>atr</b> = multiples of recent volatility (adapts to the stock), <b>R</b> = multiples
                    of what you’re risking (a 2R target makes twice what the stop risks).
                  </>
                }
              >
                Exits &amp; Risk
              </SectionLabel>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-2xs text-muted flex items-center gap-1">
                    Stop type
                    <HelpTip title="Stop type">
                      How the protective stop is measured. <b>percent</b> = a fixed % below entry.{' '}
                      <b>atr</b> = a multiple of Average True Range, so the stop widens for volatile names
                      and tightens for calm ones.
                    </HelpTip>
                  </span>
                  <select
                    className="input w-full mt-0.5"
                    value={draft.exits.stop_type}
                    onChange={(e) =>
                      patch({ exits: { ...draft.exits, stop_type: e.target.value } })
                    }
                  >
                    <option value="percent">percent</option>
                    <option value="atr">atr</option>
                  </select>
                </div>
                <div>
                  <span className="text-2xs text-muted">
                    Stop value{' '}
                    <span className="text-muted/70">
                      ({draft.exits.stop_type === 'atr' ? '× ATR' : '%'})
                    </span>
                  </span>
                  <input
                    type="number"
                    className="input w-full mt-0.5"
                    value={draft.exits.stop_value}
                    onChange={(e) =>
                      patch({
                        exits: { ...draft.exits, stop_value: Number(e.target.value) },
                      })
                    }
                  />
                </div>
                <div>
                  <span className="text-2xs text-muted flex items-center gap-1">
                    Target type
                    <HelpTip title="Target type">
                      How the profit target is measured. <b>R</b> = multiples of your risk (2R = take twice
                      what the stop risks — a 2:1 reward:risk). <b>percent</b> = a fixed % above entry.
                    </HelpTip>
                  </span>
                  <select
                    className="input w-full mt-0.5"
                    value={draft.exits.target_type}
                    onChange={(e) =>
                      patch({ exits: { ...draft.exits, target_type: e.target.value } })
                    }
                  >
                    <option value="R">R</option>
                    <option value="percent">percent</option>
                  </select>
                </div>
                <div>
                  <span className="text-2xs text-muted">
                    Target value{' '}
                    <span className="text-muted/70">
                      ({draft.exits.target_type === 'R' ? '× R' : '%'})
                    </span>
                  </span>
                  <input
                    type="number"
                    className="input w-full mt-0.5"
                    value={draft.exits.target_value}
                    onChange={(e) =>
                      patch({
                        exits: { ...draft.exits, target_value: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-2 text-xs text-text-dim cursor-pointer">
                <input
                  type="checkbox"
                  className="accent-amber"
                  checked={draft.exits.trailing}
                  onChange={(e) =>
                    patch({ exits: { ...draft.exits, trailing: e.target.checked } })
                  }
                />
                Trailing stop
                <HelpTip title="Trailing stop">
                  When on, the stop follows the price up as the trade moves in your favor — locking in
                  gains and letting winners run. It never moves backward.
                </HelpTip>
              </label>
            </div>

            {/* Sizing */}
            <div>
              <SectionLabel
                title="Position sizing"
                help={
                  <>
                    How big each trade is and how many you’ll hold. These caps are your safety rails —
                    the deterministic risk engine vetoes any order that would breach them.
                  </>
                }
              >
                Sizing
              </SectionLabel>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <span className="text-2xs text-muted flex items-center gap-1">
                    Risk / trade %
                    <HelpTip title="Risk per trade %">
                      The most of your account you’re willing to lose if the stop hits on one trade. This
                      drives position size: tighter stop → bigger position for the same risk. 1% is a common
                      conservative default.
                    </HelpTip>
                  </span>
                  <input
                    type="number"
                    className="input w-full mt-0.5"
                    value={draft.sizing.risk_per_trade_pct}
                    onChange={(e) =>
                      patch({
                        sizing: {
                          ...draft.sizing,
                          risk_per_trade_pct: Number(e.target.value),
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <span className="text-2xs text-muted flex items-center gap-1">
                    Max position %
                    <HelpTip title="Max position %">
                      A hard cap on how much of your account any single position can occupy, regardless of
                      the risk calc. Prevents one trade from dominating the book.
                    </HelpTip>
                  </span>
                  <input
                    type="number"
                    className="input w-full mt-0.5"
                    value={draft.sizing.max_position_pct}
                    onChange={(e) =>
                      patch({
                        sizing: {
                          ...draft.sizing,
                          max_position_pct: Number(e.target.value),
                        },
                      })
                    }
                  />
                </div>
                <div>
                  <span className="text-2xs text-muted flex items-center gap-1">
                    Max positions
                    <HelpTip title="Max positions">
                      How many open trades this bot can hold at once across its universe. When you’re at the
                      limit, new setups are vetoed until one closes.
                    </HelpTip>
                  </span>
                  <input
                    type="number"
                    className="input w-full mt-0.5"
                    value={draft.sizing.max_positions}
                    onChange={(e) =>
                      patch({
                        sizing: { ...draft.sizing, max_positions: Number(e.target.value) },
                      })
                    }
                  />
                </div>
              </div>
            </div>

            {/* Mode */}
            <div>
              <SectionLabel
                step={6}
                title="Mode"
                help={
                  <>
                    What happens when rules fire. <b>Signal-only</b> just records an alert (no orders).{' '}
                    <b>Semi-auto</b> stages the order for your one-click confirmation. <b>Full-auto</b>{' '}
                    places the paper order automatically. Start on Signal-only to watch how it behaves.
                  </>
                }
              >
                Mode
              </SectionLabel>
              <Toggle
                value={draft.mode}
                onChange={(v) => patch({ mode: v as StrategyMode })}
                options={MODE_OPTIONS}
              />
              <Hint>
                {draft.mode === 'signal'
                  ? 'Signal-only: alerts you, never places orders.'
                  : draft.mode === 'semi'
                    ? 'Semi-auto: stages orders for your confirmation.'
                    : 'Full-auto: places paper orders automatically when rules fire.'}
              </Hint>
            </div>

            {/* Save / test errors */}
            {saveError && <div className="text-down text-xs micro-label">{saveError}</div>}
            {testError && <div className="text-down text-xs micro-label">{testError}</div>}

            {/* Test result */}
            {testResult && (
              <div className="rounded border border-border bg-bg-2 p-3">
                <div className="flex items-center gap-2 mb-2">
                  <Zap size={13} className={testResult.fired ? 'text-up' : 'text-down'} />
                  <Badge tone={testResult.fired ? 'up' : 'down'}>
                    {testResult.fired ? 'FIRED' : 'NOT FIRED'}
                  </Badge>
                  <span className="text-2xs text-muted">
                    {draft.symbols[0]} · {draft.timeframe}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {testResult.matched.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {m.result ? (
                        <Check size={13} className="text-up shrink-0" />
                      ) : (
                        <X size={13} className="text-down shrink-0" />
                      )}
                      <span className="text-text-dim font-mono">
                        {m.indicator} {m.operator} {String(m.value)}
                      </span>
                    </div>
                  ))}
                </div>
                {testResult.snapshot && Object.keys(testResult.snapshot).length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border-2 flex flex-wrap gap-x-3 gap-y-1">
                    {Object.entries(testResult.snapshot).map(([k, v]) => (
                      <span key={k} className="text-2xs text-muted font-mono">
                        {k}=<span className="text-text-dim">{num(v)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
