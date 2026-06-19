import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  Play,
  Pencil,
  Check,
  X,
  TrendingUp,
  CandlestickChart,
  Info,
} from 'lucide-react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type AreaData,
  type UTCTimestamp,
  ColorType,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import { api, ApiError } from '@/api/client';
import type { Backtest as BacktestResult, BacktestLookback, Bot, StrategyRule } from '@/api/types';
import { Panel, Badge, Spinner, Empty, Toggle } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { TickerSearch } from '@/components/TickerSearch';
import { pct, num } from '@/lib/format';
import { setTemplatePrefill } from '@/lib/templatePrefill';
import {
  STRATEGY_TEMPLATES,
  STYLE_ORDER,
  STYLE_LABEL,
  STYLE_BLURB,
  TRIGGER_EXPLAINERS,
  type StrategyTemplate,
  type StrategyStyle,
  type StrategyCategory,
} from '@/data/strategyTemplates';
import { GOAL_BOTS, goalToBot, type GoalBot } from '@/data/goalBots';
import { Target, AlertTriangle } from 'lucide-react';

// ---- human-readable indicators / rules -----------------------------------

const IND_LABEL: Record<string, string> = {
  rsi14: 'RSI(14)',
  sma20: 'SMA(20)',
  sma50: 'SMA(50)',
  sma200: 'SMA(200)',
  ema9: 'EMA(9)',
  ema21: 'EMA(21)',
  'macd.hist': 'MACD histogram',
  'macd.macd': 'MACD line',
  'macd.signal': 'MACD signal',
  'bbands.upper': 'upper Bollinger band',
  'bbands.mid': 'middle Bollinger band',
  'bbands.lower': 'lower Bollinger band',
  atr14: 'ATR(14)',
  vwap: 'VWAP',
  adx14: 'ADX(14)',
  'stoch.k': 'Stochastic %K',
  'stoch.d': 'Stochastic %D',
  obv: 'OBV',
  volume: 'volume',
  avg_volume20: '20-day avg volume',
  price: 'price',
  close: 'price',
};

const OP_PHRASE: Record<string, string> = {
  crosses_above: 'crosses above',
  crosses_below: 'crosses below',
  '>': 'is above',
  '<': 'is below',
  '>=': 'is at or above',
  '<=': 'is at or below',
  '==': 'equals',
};

const indLabel = (k: string): string => IND_LABEL[k] ?? k;

function valueLabel(v: string | number): string {
  if (typeof v === 'number') return String(v);
  // a string that is another indicator key → label it; otherwise it's a literal
  return IND_LABEL[v] ?? v;
}

function ruleSentence(rules: StrategyRule[]): string {
  const parts = rules.map((r, i) => {
    const join = i > 0 ? ` ${r.join === 'OR' ? 'or' : 'and'} ` : '';
    return `${join}${indLabel(r.indicator)} ${OP_PHRASE[r.operator] ?? r.operator} ${valueLabel(r.value)}`;
  });
  return `Buy when ${parts.join('')}.`;
}

function exitSentence(t: StrategyTemplate): string {
  const stop =
    t.exits.stop_type === 'atr'
      ? `${t.exits.stop_value}× ATR stop`
      : `${t.exits.stop_value}% stop`;
  const target =
    t.exits.target_type === 'rr'
      ? `${t.exits.target_value}R target`
      : `${t.exits.target_value}% target`;
  const trail = t.exits.trailing ? ', trailing' : '';
  return `${stop} · ${target}${trail}`;
}

// ---- template → Bot payload (shared by Add-as-Bot and Customize) ----------

function templateToBot(t: StrategyTemplate, symbols: string[]): Partial<Bot> {
  return {
    name: t.name,
    symbols,
    kind: 'options_weekly',
    rules: t.rules,
    ai_gate: t.ai_gate,
    action: t.action,
    risk: { risk_per_trade_pct: t.sizing.risk_per_trade_pct },
    mode: 'signal',
    enabled: false,
    config: {
      direction: 'research',
      side: t.action.right === 'put' ? 'put' : t.action.right === 'call' ? 'call' : 'auto',
      expiry: 'nearest_weekly',
      strike: 'ATM',
      target_delta: 0.4,
      contracts: 1,
      max_premium: 500,
    },
  };
}

// ---- equity curve (compact) ----------------------------------------------

const toTime = (iso: string): UTCTimestamp =>
  Math.floor(new Date(iso).getTime() / 1000) as UTCTimestamp;

function MiniEquity({ points }: { points: { t: string; equity: number }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#A8A8A8',
        fontFamily: 'monospace',
        fontSize: 9,
      },
      grid: { vertLines: { color: 'rgba(255,255,255,0.06)' }, horzLines: { color: 'rgba(255,255,255,0.06)' } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: false, secondsVisible: false },
      width: el.clientWidth || 360,
      height: 120,
      autoSize: false,
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;
    areaRef.current = chart.addAreaSeries({
      lineColor: '#CCFF00',
      topColor: 'rgba(204,255,0,0.25)',
      bottomColor: 'rgba(204,255,0,0.02)',
      lineWidth: 2,
      priceLineVisible: false,
    });
    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const w = containerRef.current.clientWidth;
      if (w > 0) {
        chart.applyOptions({ width: w });
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

  return <div ref={containerRef} className="h-[120px] w-full" />;
}

// ---- inline backtest panel for a template ---------------------------------

const LOOKBACKS: { value: BacktestLookback; label: string }[] = [
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
];

function TemplateBacktest({ template, symbols }: { template: StrategyTemplate; symbols: string[] }) {
  const [lookback, setLookback] = useState<BacktestLookback>(template.suggestedLookback);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const res = await api.backtest({
        symbols,
        timeframe: template.timeframe,
        lookback,
        rules: template.rules,
        action: template.action,
      });
      setResult(res);
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setError('Backtest engine starting…');
      else setError((e as Error).message || 'Backtest failed');
    } finally {
      setRunning(false);
    }
  }

  const m = result?.combined;
  const curve = result?.per_symbol?.[0]?.equity_curve ?? [];

  return (
    <div className="rounded border border-border bg-bg-2 p-2.5 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="micro-label">Backtest</span>
        <Toggle value={lookback} onChange={(v) => setLookback(v as BacktestLookback)} options={LOOKBACKS} />
        <button
          className="btn-amber flex items-center gap-1 !py-1"
          onClick={() => void run()}
          disabled={running || symbols.length === 0}
        >
          <Play size={11} /> {running ? 'Simulating…' : 'Run'}
        </button>
        <span className="text-2xs text-muted ml-auto">{template.timeframe} · {symbols.join(', ') || 'pick a ticker'}</span>
      </div>

      {running ? (
        <Spinner label="replaying real bars…" />
      ) : error ? (
        <div className="text-down text-xs micro-label">{error}</div>
      ) : result && m ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Metric label="Return" value={pct(m.total_return_pct)} tone={m.total_return_pct >= 0 ? 'text-up' : 'text-down'} />
            <Metric label="Win rate" value={`${num(m.win_rate, 1)}%`} sub={`${num(m.wins, 0)}W/${num(m.losses, 0)}L`} />
            <Metric label="# Trades" value={num(m.num_trades, 0)} />
            <Metric
              label="Profit factor"
              value={Number.isFinite(m.profit_factor) ? num(m.profit_factor, 2) : '∞'}
              tone={m.profit_factor >= 1 ? 'text-up' : 'text-down'}
            />
          </div>
          {curve.length > 0 ? (
            <MiniEquity points={curve} />
          ) : (
            <Empty label="No trades fired over this window — try a longer lookback" />
          )}
        </>
      ) : (
        <span className="text-2xs text-muted micro-label">
          Run a quick simulation over real history before adding this as a bot.
        </span>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'text-text', sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="panel flex flex-col gap-0.5 px-2 py-1.5 min-w-0">
      <span className="micro-label">{label}</span>
      <span className={`num text-base tabular-nums leading-none ${tone}`}>{value}</span>
      {sub && <span className="text-2xs text-muted tabular-nums">{sub}</span>}
    </div>
  );
}

// ---- toast ---------------------------------------------------------------

function Toast({ msg, onClose }: { msg: { text: string; botId: string }; onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded border border-up/40 bg-panel shadow-xl px-3 py-2.5 flex flex-col gap-2 max-w-sm">
      <div className="flex items-center gap-2 text-up text-sm">
        <Check size={15} /> {msg.text}
        <button className="ml-auto text-muted hover:text-text" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="btn flex items-center gap-1"
          onClick={() => navigate(`/builder?bot=${encodeURIComponent(msg.botId)}`)}
        >
          <Pencil size={11} /> Edit in Builder
        </button>
        <button
          className="btn flex items-center gap-1"
          onClick={() => navigate(`/backtest?bot=${encodeURIComponent(msg.botId)}`)}
        >
          <Play size={11} /> Backtest
        </button>
      </div>
    </div>
  );
}

// ---- ticker selector -----------------------------------------------------

function TickerSelector({
  symbols,
  onChange,
}: {
  symbols: string[];
  onChange: (next: string[]) => void;
}) {
  function add(sym: string) {
    const s = sym.trim().toUpperCase();
    if (!s || symbols.includes(s)) return;
    onChange([...symbols, s]);
  }
  function remove(sym: string) {
    onChange(symbols.filter((x) => x !== sym));
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="micro-label">Tickers</span>
      <div className="max-w-xs">
        <TickerSearch onSelect={add} placeholder="Add ticker…" />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {symbols.map((sym) => (
          <span
            key={sym}
            className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border-2 bg-panel-2 text-text"
          >
            {sym}
            <X
              size={11}
              className="cursor-pointer text-muted hover:text-down"
              onClick={() => remove(sym)}
            />
          </span>
        ))}
        {symbols.length === 0 && <span className="text-2xs text-muted">Add at least one ticker</span>}
      </div>
    </div>
  );
}

// ---- category badge tone --------------------------------------------------

function catTone(c: StrategyCategory): 'amber' | 'up' | 'down' | 'neutral' {
  switch (c) {
    case 'Momentum':
      return 'up';
    case 'Breakout':
      return 'amber';
    case 'Mean Reversion':
      return 'down';
    default:
      return 'neutral';
  }
}

// ---- a single template card ----------------------------------------------

function TemplateCard({
  template,
  onAdd,
}: {
  template: StrategyTemplate;
  onAdd: (botId: string, name: string) => void;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [symbols, setSymbols] = useState<string[]>(template.defaultSymbols);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function addAsBot() {
    if (symbols.length === 0) {
      setAddError('Pick at least one ticker first.');
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const bot = await api.createBot(templateToBot(template, symbols));
      onAdd(bot.id, bot.name);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setAddError('Bot engine starting…');
      else setAddError((e as Error).message || 'Could not add bot');
    } finally {
      setAdding(false);
    }
  }

  function customize() {
    setTemplatePrefill(templateToBot(template, symbols));
    navigate('/builder?from=template');
  }

  const isEquity = template.action.asset === 'equity';

  return (
    <div className="panel flex flex-col">
      <button onClick={() => setOpen((o) => !o)} className="text-left px-3 py-2.5 hover:bg-panel-2 transition-colors">
        <div className="flex items-start gap-2">
          {open ? (
            <ChevronDown size={14} className="text-muted shrink-0 mt-0.5" />
          ) : (
            <ChevronRight size={14} className="text-muted shrink-0 mt-0.5" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-text font-semibold">{template.name}</span>
              <Badge tone={catTone(template.category)}>{template.category}</Badge>
              <Badge tone="neutral">{template.timeframe}</Badge>
              <Badge tone={isEquity ? 'amber' : 'up'}>
                {isEquity ? (
                  <span className="inline-flex items-center gap-0.5">
                    <CandlestickChart size={9} /> shares
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-0.5">
                    <TrendingUp size={9} /> calls
                  </span>
                )}
              </Badge>
            </div>
            <p className="text-xs text-text-dim mt-1 leading-relaxed">{template.summary}</p>
            <div className="flex flex-wrap items-center gap-1 mt-1.5">
              {template.indicatorsUsed.map((ind) => (
                <span
                  key={ind}
                  className="text-2xs px-1 py-0.5 rounded bg-bg-2 text-amber border border-amber/20 font-mono"
                >
                  {indLabel(ind)}
                </span>
              ))}
              <span className="text-2xs text-muted ml-1">· {template.defaultSymbols.join(' ')}</span>
            </div>
          </div>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3 pl-9 flex flex-col gap-3 bg-bg-2/40 border-t border-border">
          {/* education */}
          <div className="pt-2">
            <Markdown source={template.education} />
          </div>

          {/* rules + exits */}
          <div className="rounded border border-amber/30 bg-amber/5 px-3 py-2 flex flex-col gap-1">
            <span className="micro-label text-amber">Entry</span>
            <span className="text-sm text-text">{ruleSentence(template.rules)}</span>
            <span className="micro-label text-amber mt-1">Exit / target</span>
            <span className="text-sm text-text-dim">{exitSentence(template)}</span>
            <span className="text-2xs text-muted mt-1">
              AI gate: {template.ai_gate.enabled ? `on · min conviction ${template.ai_gate.min_conviction}` : 'off'} ·
              risk {template.sizing.risk_per_trade_pct}%/trade · max {template.sizing.max_positions} positions
            </span>
          </div>

          {/* ticker selector */}
          <TickerSelector symbols={symbols} onChange={setSymbols} />

          {/* inline backtest */}
          <TemplateBacktest template={template} symbols={symbols} />

          {/* actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              className="btn-amber flex items-center gap-1.5 py-1.5 px-3"
              onClick={() => void addAsBot()}
              disabled={adding}
            >
              <Plus size={13} /> {adding ? 'Adding…' : 'Add as Bot'}
            </button>
            <button className="btn flex items-center gap-1.5 py-1.5 px-3" onClick={customize}>
              <Pencil size={12} /> Customize in Builder
            </button>
          </div>
          {addError && <div className="text-down text-xs micro-label">{addError}</div>}
        </div>
      )}
    </div>
  );
}

// ---- triggers reference ---------------------------------------------------

function TriggersReference() {
  const [open, setOpen] = useState(false);
  return (
    <Panel
      title={
        <span className="flex items-center gap-1.5">
          <Info size={12} /> Triggers explained
        </span>
      }
      right={
        <button className="btn !py-0.5" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {open ? (
        <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {TRIGGER_EXPLAINERS.map((t) => (
            <div key={t.key} className="rounded border border-border bg-bg-2 px-3 py-2">
              <div className="text-sm text-amber font-semibold mb-0.5">{t.name}</div>
              <div className="text-xs text-text-dim leading-relaxed">{t.text}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-2 text-2xs text-muted micro-label">
          A plain-English reference for every indicator used by these strategies.
        </div>
      )}
    </Panel>
  );
}

// ---- goal-based prebuilt bots ---------------------------------------------

function GoalBotCard({
  goal,
  onAdd,
}: {
  goal: GoalBot;
  onAdd: (botId: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  async function add() {
    setAdding(true);
    setAddError(null);
    try {
      const bot = await api.createBot(goalToBot(goal));
      onAdd(bot.id, bot.name);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setAddError('Bot engine starting…');
      else setAddError((e as Error).message || 'Could not add bot');
    } finally {
      setAdding(false);
    }
  }

  const ring =
    goal.tone === 'up'
      ? 'border-up/40'
      : goal.tone === 'amber'
        ? 'border-amber/40'
        : 'border-down/40';

  return (
    <div className={`panel flex flex-col border ${ring}`}>
      <div className="px-3 py-2.5 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-base">{goal.emoji}</span>
          <span className="text-sm text-text font-semibold">{goal.name}</span>
          <Badge tone={goal.tone}>{goal.riskLabel} risk</Badge>
        </div>
        <p className="text-xs text-text-dim leading-relaxed">{goal.tagline}</p>
        <div className="flex items-center gap-1.5 text-2xs">
          <Target size={11} className="text-amber shrink-0" />
          <span className="text-muted">Target</span>
          <span className="text-text font-mono">{goal.target}</span>
        </div>
      </div>

      {/* config chips */}
      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {goal.params.map((p) => (
          <span
            key={p}
            className="text-2xs px-1.5 py-0.5 rounded bg-bg-2 text-text-dim border border-border-2"
          >
            {p}
          </span>
        ))}
      </div>

      {goal.warning && (
        <div className="mx-3 mb-2 rounded border border-down/40 bg-down/10 px-2.5 py-1.5 flex items-start gap-1.5">
          <AlertTriangle size={12} className="text-down shrink-0 mt-0.5" />
          <span className="text-2xs text-down leading-relaxed">{goal.warning}</span>
        </div>
      )}

      {open && (
        <div className="px-3 pb-2 text-2xs text-text-dim leading-relaxed border-t border-border pt-2">
          {goal.definition}
        </div>
      )}

      <div className="px-3 pb-3 pt-1 flex items-center gap-2 flex-wrap mt-auto">
        <button
          className="btn-amber flex items-center gap-1.5 py-1.5 px-3"
          onClick={() => void add()}
          disabled={adding}
        >
          <Plus size={13} /> {adding ? 'Adding…' : 'Add as Bot'}
        </button>
        <button className="btn py-1.5 px-3" onClick={() => setOpen((o) => !o)}>
          {open ? 'Less' : 'How it works'}
        </button>
        {addError && <span className="text-down text-2xs micro-label">{addError}</span>}
      </div>
    </div>
  );
}

function GoalBots({ onAdd }: { onAdd: (botId: string, name: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 px-1">
        <span className="text-sm text-text font-semibold uppercase tracking-wide">Start with a goal</span>
        <span className="text-2xs text-muted">
          Prebuilt bots tuned to an outcome — added disabled &amp; Signal-only so nothing trades until you turn it on
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
        {GOAL_BOTS.map((g) => (
          <GoalBotCard key={g.id} goal={g} onAdd={onAdd} />
        ))}
      </div>
    </div>
  );
}

// ---- main view ------------------------------------------------------------

export function Library() {
  const [toast, setToast] = useState<{ text: string; botId: string } | null>(null);
  const [styleFilter, setStyleFilter] = useState<StrategyStyle | 'all'>('all');

  const grouped = useMemo(() => {
    const map: Record<StrategyStyle, StrategyTemplate[]> = { day: [], swing: [], position: [] };
    for (const t of STRATEGY_TEMPLATES) map[t.style].push(t);
    return map;
  }, []);

  const styles = styleFilter === 'all' ? STYLE_ORDER : [styleFilter];

  return (
    <div className="flex flex-col gap-3 h-full min-h-0 overflow-y-auto pb-6">
      <div className="flex items-center gap-2 flex-wrap">
        <BookOpen size={16} className="text-amber" />
        <h1 className="text-sm micro-label text-text-dim">Strategy Library</h1>
        <span className="text-2xs text-muted">
          {STRATEGY_TEMPLATES.length} research-backed templates — read the edge, backtest, then add as a bot
        </span>
        <div className="ml-auto">
          <Toggle
            value={styleFilter}
            onChange={(v) => setStyleFilter(v as StrategyStyle | 'all')}
            options={[
              { value: 'all', label: 'All' },
              { value: 'day', label: 'Day' },
              { value: 'swing', label: 'Swing' },
              { value: 'position', label: 'Position' },
            ]}
          />
        </div>
      </div>

      {/* Goal-based prebuilt bots */}
      <GoalBots onAdd={(botId, name) => setToast({ text: `Added “${name}” (off)`, botId })} />

      <div className="flex items-baseline gap-2 px-1 pt-1">
        <span className="text-sm text-text font-semibold uppercase tracking-wide">Or build from a strategy</span>
        <span className="text-2xs text-muted">Individual research-backed templates — read the edge, backtest, then add</span>
      </div>

      {styles.map((style) => (
        <div key={style} className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2 px-1">
            <span className="text-sm text-text font-semibold uppercase tracking-wide">{STYLE_LABEL[style]}</span>
            <span className="text-2xs text-muted">{STYLE_BLURB[style]}</span>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
            {grouped[style].map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                onAdd={(botId, name) => setToast({ text: `Added “${name}” (off)`, botId })}
              />
            ))}
          </div>
        </div>
      ))}

      <TriggersReference />

      {toast && <Toast msg={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
