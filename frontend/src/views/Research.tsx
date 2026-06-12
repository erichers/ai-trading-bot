import { useState } from 'react';
import {
  Activity,
  Brain,
  Search,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  ChevronDown,
  ChevronRight,
  History as HistoryIcon,
  Play,
  Square,
  Zap,
  Cpu,
  RefreshCw,
  X,
  Plus,
  FileText,
  Rss,
} from 'lucide-react';
import { api } from '@/api/client';
import type {
  Regime,
  ResearchHistoryItem,
  ResearchReport,
  ResearchWorker,
  ResearchProvider,
  ResearchDepth,
  ResearchFeedItem,
  ResearchDeepDoc,
} from '@/api/types';
import { money, colorBySign, timeAgo } from '@/lib/format';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { Markdown } from '@/components/Markdown';
import { TickerSearch } from '@/components/TickerSearch';
import { useSymbol } from '@/hooks/useSymbol';
import { usePolling } from '@/hooks/usePolling';

// ---- helpers -------------------------------------------------------------

function regimeTone(regime: string): { tone: 'up' | 'down' | 'amber' | 'neutral'; text: string; bar: string } {
  const r = (regime || '').toLowerCase();
  if (r.includes('risk-on') || r.includes('risk on') || r.includes('bull')) {
    return { tone: 'up', text: 'text-up', bar: 'bg-up' };
  }
  if (r.includes('risk-off') || r.includes('risk off') || r.includes('bear')) {
    return { tone: 'down', text: 'text-down', bar: 'bg-down' };
  }
  return { tone: 'amber', text: 'text-amber', bar: 'bg-amber' };
}

function actionTone(action: string): 'up' | 'down' | 'amber' | 'neutral' {
  const a = (action || '').toLowerCase();
  if (a.includes('buy') || a.includes('long') || a.includes('accumulate')) return 'up';
  if (a.includes('sell') || a.includes('short') || a.includes('avoid') || a.includes('reduce')) return 'down';
  if (a.includes('hold') || a.includes('watch') || a.includes('neutral')) return 'amber';
  return 'neutral';
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Provider badge — kimi spends credits (amber), gemma is free/local (green).
function isKimi(provider?: string): boolean {
  return (provider || '').toLowerCase().includes('kimi');
}
function ProviderBadge({ provider }: { provider?: string }) {
  if (!provider) return null;
  const kimi = isKimi(provider);
  return <Badge tone={kimi ? 'amber' : 'up'}>{provider}{kimi ? ' · credits' : ' · free'}</Badge>;
}

function sourceTone(source: string): 'up' | 'down' | 'amber' | 'neutral' {
  switch ((source || '').toLowerCase()) {
    case 'deep':
      return 'amber';
    case 'earnings':
      return 'up';
    case 'market':
      return 'neutral';
    case 'briefing':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// ---- regime banner -------------------------------------------------------

function RegimeBanner() {
  const { data, error, loading, refetch } = usePolling<Regime>(() => api.regime(), 60000);

  if (loading && !data) {
    return (
      <div className="panel px-3 py-3">
        <Spinner label="Loading regime" />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="panel">
        <ErrorState label={`Regime unavailable — ${error.message}`} onRetry={refetch} />
      </div>
    );
  }
  if (!data) return null;

  const t = regimeTone(data.regime);
  const breadthPct = clamp(data.breadth <= 1 ? data.breadth * 100 : data.breadth, 0, 100);

  return (
    <div className="panel px-3 py-2.5 flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
      <div className="flex items-center gap-2 shrink-0">
        <Activity size={14} className={t.text} />
        <span className="micro-label">Regime</span>
        <span className={`text-sm font-semibold uppercase tracking-wide ${t.text}`}>
          {data.regime || '—'}
        </span>
      </div>

      <div className="flex items-center gap-6 shrink-0">
        <div className="flex items-baseline gap-1.5">
          <span className="micro-label">VIX</span>
          <span className="font-mono text-sm text-text">{Number(data.vix_proxy ?? 0).toFixed(2)}</span>
        </div>

        <div className="flex items-center gap-2">
          <span className="micro-label">Breadth</span>
          <div className="w-24 h-2 rounded bg-bg-2 border border-border overflow-hidden">
            <div className={`h-full ${t.bar}`} style={{ width: `${breadthPct}%` }} />
          </div>
          <span className="font-mono text-xs text-text-dim">{breadthPct.toFixed(0)}%</span>
        </div>
      </div>

      {data.note && (
        <div className="text-xs text-text-dim min-w-0 lg:border-l lg:border-border lg:pl-6 lg:flex-1">
          {data.note}
        </div>
      )}
    </div>
  );
}

// ---- morning briefing ----------------------------------------------------

function MorningBriefing() {
  const { data, error, loading, refetch } = usePolling(() => api.briefing(), 60000);

  return (
    <Panel
      title="Morning Briefing"
      right={data ? <span className="text-2xs text-muted">{timeAgo(data.generated_at)}</span> : undefined}
      bodyClassName="overflow-auto"
    >
      {loading && !data ? (
        <Spinner label="Loading briefing" />
      ) : error && !data ? (
        <ErrorState label={`Briefing unavailable — ${error.message}`} onRetry={refetch} />
      ) : !data ? (
        <Empty label="No briefing" />
      ) : (
        <div className="p-3 flex flex-col gap-3">
          {data.summary && <p className="text-sm text-text-dim leading-relaxed">{data.summary}</p>}

          {data.items.length === 0 ? (
            <Empty label="No items" />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {data.items.map((it, i) => (
                <li key={`${it.symbol}-${i}`} className="flex items-start gap-3 py-2">
                  <span
                    className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${
                      it.sentiment > 0 ? 'bg-up' : it.sentiment < 0 ? 'bg-down' : 'bg-muted'
                    }`}
                    title={`sentiment ${it.sentiment}`}
                  />
                  <span className="font-mono text-xs text-amber bg-amber/10 border border-amber/30 rounded px-1.5 py-0.5 shrink-0">
                    {it.symbol}
                  </span>
                  <span className="text-xs text-text-dim leading-relaxed flex-1 min-w-0">{it.note}</span>
                  <span className={`font-mono text-2xs shrink-0 ${colorBySign(it.sentiment)}`}>
                    {it.sentiment > 0 ? '+' : ''}
                    {it.sentiment}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

// ---- deep dive report card -----------------------------------------------

function ReportCard({ report }: { report: ResearchReport }) {
  const conviction = clamp(Number(report.conviction ?? 0), 0, 100);

  return (
    <div className="flex flex-col gap-4 p-3">
      {/* header */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg text-text">{report.symbol}</span>
        <Badge tone={actionTone(report.suggested_action)}>{report.suggested_action || 'N/A'}</Badge>
        {report.regime && <Badge tone="neutral">{report.regime}</Badge>}
        <div className="flex-1" />
        {report.model && <span className="text-2xs text-muted font-mono">{report.model}</span>}
        {report.generated_at && (
          <span className="text-2xs text-muted">{timeAgo(report.generated_at)}</span>
        )}
      </div>

      {/* conviction + sentiment */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="sm:col-span-2 flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="micro-label">Conviction</span>
            <span className="font-mono text-sm text-amber">{conviction.toFixed(0)}</span>
          </div>
          <div className="w-full h-3 rounded bg-bg-2 border border-border overflow-hidden">
            <div className="h-full bg-amber" style={{ width: `${conviction}%` }} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="micro-label">Sentiment</span>
          <span className={`font-mono text-lg ${colorBySign(report.sentiment_score)}`}>
            {report.sentiment_score > 0 ? '+' : ''}
            {report.sentiment_score}
          </span>
        </div>
      </div>

      {/* thesis */}
      <div className="flex flex-col gap-1">
        <span className="micro-label">Thesis</span>
        <p className="text-sm text-text-dim leading-relaxed">{report.thesis || '—'}</p>
      </div>

      {/* key risks */}
      <div className="flex flex-col gap-1">
        <span className="micro-label">Key Risks</span>
        {report.key_risks && report.key_risks.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {report.key_risks.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-text-dim leading-relaxed">
                <AlertTriangle size={12} className="text-amber mt-0.5 shrink-0" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-muted">None noted</span>
        )}
      </div>

      {/* bull vs bear */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="border border-up/30 bg-up/5 rounded p-2.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <TrendingUp size={13} className="text-up" />
            <span className="text-2xs uppercase tracking-widest text-up">Bull</span>
          </div>
          <p className="text-xs text-text-dim leading-relaxed">{report.thesis || '—'}</p>
        </div>
        <div className="border border-down/30 bg-down/5 rounded p-2.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <TrendingDown size={13} className="text-down" />
            <span className="text-2xs uppercase tracking-widest text-down">Bear Case</span>
          </div>
          <p className="text-xs text-text-dim leading-relaxed">{report.bear_case || '—'}</p>
        </div>
      </div>

      {/* stop / target */}
      <div className="grid grid-cols-2 gap-3">
        <div className="border border-border rounded p-2.5 flex flex-col gap-0.5">
          <span className="micro-label">Suggested Stop</span>
          <span className="font-mono text-sm text-down">{money(report.suggested_stop)}</span>
        </div>
        <div className="border border-border rounded p-2.5 flex flex-col gap-0.5">
          <span className="micro-label">Suggested Target</span>
          <span className="font-mono text-sm text-up">{money(report.suggested_target)}</span>
        </div>
      </div>
    </div>
  );
}

// ==========================================================================
// 1. ENGINE — continuous background research worker controls
// ==========================================================================

const PROVIDERS: { value: ResearchProvider; label: string; note: string; tone: 'up' | 'amber' }[] = [
  { value: 'gemma', label: 'Gemma', note: 'free · 24/7', tone: 'up' },
  { value: 'kimi', label: 'Kimi', note: 'uses credits', tone: 'amber' },
];
const DEPTHS: ResearchDepth[] = ['quick', 'standard', 'deep'];

function UniverseChips({ universe, onChange }: { universe: string[]; onChange: (u: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const s = draft.trim().toUpperCase();
    if (!s) return;
    if (!universe.includes(s)) onChange([...universe, s]);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1.5">
      <span className="micro-label">Universe</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {universe.map((sym) => (
          <span
            key={sym}
            className="flex items-center gap-1 font-mono text-xs text-amber bg-amber/10 border border-amber/30 rounded px-1.5 py-0.5"
          >
            {sym}
            <button
              className="text-muted hover:text-down"
              onClick={() => onChange(universe.filter((s) => s !== sym))}
              title={`Remove ${sym}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        {universe.length === 0 && <span className="text-xs text-muted">No symbols</span>}
        <div className="flex items-center gap-1">
          <input
            className="input font-mono uppercase py-0.5 w-20 text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            placeholder="ADD…"
            autoComplete="off"
          />
          <button className="btn px-1.5 py-1" onClick={add} title="Add symbol">
            <Plus size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

function EngineStatus({ w }: { w: ResearchWorker }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-3">
      <div className="flex items-center gap-2">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            w.running ? 'bg-up animate-pulse' : 'bg-muted'
          }`}
          title={w.running ? 'running' : 'idle'}
        />
        <span className="micro-label">{w.running ? 'Running' : 'Idle'}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="micro-label">Last run</span>
        <span className="font-mono text-xs text-text-dim">
          {w.last_run ? timeAgo(w.last_run) : '—'}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="micro-label">Analyses today</span>
        <span className="font-mono text-xs text-text tabular-nums">{w.count_today}</span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="micro-label">Cycles</span>
        <span className="font-mono text-xs text-text tabular-nums">{w.cycles}</span>
      </div>
    </div>
  );
}

function Engine() {
  const { data, error, loading, refetch } = usePolling<ResearchWorker>(
    () => api.researchWorker(),
    15000,
  );

  // local editable draft
  const [draft, setDraft] = useState<ResearchWorker | null>(null);
  const [saving, setSaving] = useState(false);
  const [running1, setRunning1] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [actionErr, setActionErr] = useState<string | undefined>(undefined);
  const [runResult, setRunResult] = useState<string | undefined>(undefined);

  // sync draft from server once data arrives / when not actively editing
  const w = draft ?? data ?? null;

  const ensureDraft = (): ResearchWorker | null => {
    if (draft) return draft;
    if (data) {
      const d = { ...data, universe: [...data.universe] };
      setDraft(d);
      return d;
    }
    return null;
  };

  const patch = (p: Partial<ResearchWorker>) => {
    const base = ensureDraft();
    if (!base) return;
    setDraft({ ...base, ...p });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setActionErr(undefined);
    try {
      const updated = await api.updateResearchWorker({
        provider: draft.provider,
        depth: draft.depth,
        interval_sec: draft.interval_sec,
        universe: draft.universe,
      });
      setDraft({ ...updated, universe: [...updated.universe] });
      refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!w) return;
    setToggling(true);
    setActionErr(undefined);
    try {
      const updated = await api.updateResearchWorker({ enabled: !w.enabled });
      setDraft({ ...updated, universe: [...updated.universe] });
      refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setToggling(false);
    }
  };

  const runOnce = async () => {
    setRunning1(true);
    setActionErr(undefined);
    setRunResult(undefined);
    try {
      const r = await api.researchRunOnce();
      setRunResult(r.ran ? `Ran — ${r.count} analyses generated` : 'Worker reported nothing to run');
      refetch();
    } catch (e) {
      setActionErr((e as Error).message);
    } finally {
      setRunning1(false);
    }
  };

  if (loading && !w) return <Panel title="Research Engine"><Spinner label="Loading engine config" /></Panel>;
  if (error && !w)
    return (
      <Panel title="Research Engine">
        <ErrorState label={`Engine unavailable — ${error.message}`} onRetry={refetch} />
      </Panel>
    );
  if (!w) return <Panel title="Research Engine"><Empty label="No engine config" /></Panel>;

  const kimiContinuous = w.provider === 'kimi';

  return (
    <Panel
      title="Research Engine"
      right={
        <button
          className={`flex items-center gap-1.5 ${w.enabled ? 'btn' : 'btn-amber'}`}
          onClick={toggleEnabled}
          disabled={toggling}
        >
          {toggling ? (
            <RefreshCw size={12} className="animate-spin" />
          ) : w.enabled ? (
            <Square size={12} />
          ) : (
            <Play size={12} />
          )}
          {w.enabled ? 'Stop' : 'Start'}
        </button>
      }
      bodyClassName="overflow-auto"
    >
      <div className="p-3 flex flex-col gap-4">
        {/* prominent helper */}
        <div className="flex items-start gap-2 rounded border border-up/30 bg-up/5 px-3 py-2.5">
          <Zap size={14} className="text-up mt-0.5 shrink-0" />
          <p className="text-xs text-text-dim leading-relaxed">
            Continuous background research uses <span className="text-up font-semibold">Gemma</span>{' '}
            (free, local). <span className="text-amber font-semibold">Kimi</span> (credits) only runs
            when you click <span className="text-text">Analyze</span> or{' '}
            <span className="text-text">Deep Dive</span>.
          </p>
        </div>

        {/* provider */}
        <div className="flex flex-col gap-1.5">
          <span className="micro-label">Provider (continuous worker)</span>
          <div className="flex flex-wrap gap-2">
            {PROVIDERS.map((p) => {
              const active = w.provider === p.value;
              return (
                <button
                  key={p.value}
                  onClick={() => patch({ provider: p.value })}
                  className={`flex items-center gap-2 rounded border px-3 py-2 text-left transition-colors ${
                    active
                      ? p.tone === 'up'
                        ? 'border-up/60 bg-up/10'
                        : 'border-amber/60 bg-amber/10'
                      : 'border-border bg-panel hover:bg-panel-2'
                  }`}
                >
                  {p.value === 'gemma' ? (
                    <Cpu size={14} className={active ? 'text-up' : 'text-muted'} />
                  ) : (
                    <Brain size={14} className={active ? 'text-amber' : 'text-muted'} />
                  )}
                  <span className="flex flex-col">
                    <span className={`text-sm font-semibold ${active ? 'text-text' : 'text-text-dim'}`}>
                      {p.label}
                    </span>
                    <span className={`text-2xs uppercase tracking-wider ${p.tone === 'up' ? 'text-up' : 'text-amber'}`}>
                      {p.note}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {kimiContinuous && (
            <div className="flex items-start gap-2 rounded border border-amber/40 bg-amber/10 px-3 py-2 mt-1">
              <AlertTriangle size={13} className="text-amber mt-0.5 shrink-0" />
              <p className="text-xs text-amber leading-relaxed">
                Caution: with Kimi selected the background worker will consume credits on{' '}
                <span className="font-semibold">every cycle</span>. Use Gemma to run free 24/7.
              </p>
            </div>
          )}
        </div>

        {/* depth */}
        <div className="flex flex-col gap-1.5">
          <span className="micro-label">Depth</span>
          <Toggle
            value={w.depth}
            onChange={(v) => patch({ depth: v as ResearchDepth })}
            options={DEPTHS.map((d) => ({ value: d, label: d[0].toUpperCase() + d.slice(1) }))}
          />
        </div>

        {/* interval */}
        <div className="flex flex-col gap-1.5">
          <span className="micro-label">Interval (minutes)</span>
          <input
            type="number"
            min={1}
            className="input font-mono py-1 w-28 text-sm tabular-nums"
            value={Math.max(1, Math.round(w.interval_sec / 60))}
            onChange={(e) => {
              const mins = Math.max(1, Number(e.target.value) || 1);
              patch({ interval_sec: mins * 60 });
            }}
          />
        </div>

        {/* universe */}
        <UniverseChips universe={w.universe} onChange={(u) => patch({ universe: u })} />

        {/* actions */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <button
            className="btn-amber flex items-center gap-1.5"
            onClick={save}
            disabled={saving || !draft}
          >
            {saving ? <RefreshCw size={12} className="animate-spin" /> : null}
            Save
          </button>
          <button className="btn flex items-center gap-1.5" onClick={runOnce} disabled={running1}>
            {running1 ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
            Run once now
          </button>
          {draft && <span className="text-2xs text-amber">Unsaved changes</span>}
          {runResult && <span className="text-2xs text-up">{runResult}</span>}
          {actionErr && <span className="text-2xs text-down">{actionErr}</span>}
        </div>

        <EngineStatus w={w} />
      </div>
    </Panel>
  );
}

// ==========================================================================
// 2. FEED — research feed browser
// ==========================================================================

function ConvictionMeter({ value }: { value: number }) {
  const c = clamp(Number(value ?? 0), 0, 100);
  return (
    <div className="flex items-center gap-1.5 min-w-[110px]">
      <span className="micro-label">Conv</span>
      <div className="w-14 h-2 rounded bg-bg-2 border border-border overflow-hidden">
        <div className="h-full bg-amber" style={{ width: `${c}%` }} />
      </div>
      <span className="font-mono text-2xs text-amber tabular-nums">{c.toFixed(0)}</span>
    </div>
  );
}

function FeedCard({ item }: { item: ResearchFeedItem }) {
  const [expanded, setExpanded] = useState(false);
  const [doc, setDoc] = useState<ResearchDeepDoc | undefined>(undefined);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [docErr, setDocErr] = useState<string | undefined>(undefined);

  const isDoc = item.source === 'deep' || item.source === 'earnings';

  const toggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && isDoc && !doc && !loadingDoc) {
      setLoadingDoc(true);
      setDocErr(undefined);
      try {
        const d = await api.researchDeepDoc(item.id);
        setDoc(d);
      } catch (e) {
        setDocErr((e as Error).message);
      } finally {
        setLoadingDoc(false);
      }
    }
  };

  return (
    <div className="border border-border rounded bg-panel-2/40">
      <button
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-panel-2"
        onClick={toggle}
      >
        {expanded ? (
          <ChevronDown size={13} className="text-muted shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-muted shrink-0" />
        )}
        <span className="font-mono text-sm text-text">{item.symbol || '—'}</span>
        <Badge tone={sourceTone(item.source)}>{item.source}</Badge>
        <ProviderBadge provider={item.provider} />
        <span className="text-xs text-text-dim flex-1 min-w-[140px] truncate">{item.title}</span>

        {item.conviction !== undefined && item.conviction !== null && (
          <ConvictionMeter value={item.conviction} />
        )}
        {item.sentiment_score !== undefined && item.sentiment_score !== null && (
          <span className={`font-mono text-xs tabular-nums ${colorBySign(item.sentiment_score)}`}>
            {item.sentiment_score > 0 ? '+' : ''}
            {item.sentiment_score}
          </span>
        )}
        {item.regime && <Badge tone="neutral">{item.regime}</Badge>}
        {item.created_at && <span className="text-2xs text-muted">{timeAgo(item.created_at)}</span>}
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-2 border-t border-border flex flex-col gap-2">
          {item.summary && <p className="text-sm text-text-dim leading-relaxed">{item.summary}</p>}
          {isDoc && (
            <div className="mt-1">
              {loadingDoc ? (
                <Spinner label="Loading document" />
              ) : docErr ? (
                <span className="text-2xs text-down">Failed to load — {docErr}</span>
              ) : doc ? (
                <div className="rounded border border-border bg-bg-2/40 p-3">
                  <Markdown source={doc.body} />
                </div>
              ) : null}
            </div>
          )}
          {item.model && (
            <span className="text-2xs text-muted font-mono self-end">{item.model}</span>
          )}
        </div>
      )}
    </div>
  );
}

function Feed() {
  const [symbolFilter, setSymbolFilter] = useState('');
  const { data, error, loading, refetch } = usePolling<ResearchFeedItem[]>(
    () => api.researchFeed(50),
    15000,
  );

  const items = data ?? [];
  const q = symbolFilter.trim().toUpperCase();
  const filtered = items.filter((it) => !q || (it.symbol || '').toUpperCase().includes(q));
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
  );

  const right = (
    <div className="relative">
      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
      <input
        className="input font-mono uppercase pl-7 py-1 w-32 text-xs"
        value={symbolFilter}
        onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
        placeholder="Symbol…"
        autoComplete="off"
      />
    </div>
  );

  let body: React.ReactNode;
  if (loading && items.length === 0) body = <Spinner label="Loading feed" />;
  else if (error && items.length === 0)
    body = <ErrorState label={`Feed unavailable — ${error.message}`} onRetry={refetch} />;
  else if (sorted.length === 0) body = <Empty label="No research yet" />;
  else
    body = (
      <div className="p-3 flex flex-col gap-2">
        {sorted.map((it) => (
          <FeedCard key={String(it.id)} item={it} />
        ))}
      </div>
    );

  return (
    <Panel title="Research Feed" right={right} className="flex-1 min-h-0" bodyClassName="overflow-auto">
      {body}
    </Panel>
  );
}

// ==========================================================================
// 3. DEEP DIVE — on-demand Kimi analyze + deep-dive (spends credits)
// ==========================================================================

function DeepDive() {
  const { symbol, setSymbol } = useSymbol();
  const [report, setReport] = useState<ResearchReport | undefined>(undefined);
  const [doc, setDoc] = useState<ResearchDeepDoc | undefined>(undefined);
  const [busy, setBusy] = useState<'analyze' | 'deep' | null>(null);
  const [err, setErr] = useState<string | undefined>(undefined);

  const analyze = async (sym: string) => {
    const s = (sym || '').trim().toUpperCase();
    if (!s) return;
    setSymbol(s);
    setBusy('analyze');
    setErr(undefined);
    setDoc(undefined);
    try {
      // On-demand defaults to Kimi.
      const r = await api.analyze(s, 'kimi');
      setReport(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const deepDive = async (sym: string) => {
    const s = (sym || '').trim().toUpperCase();
    if (!s) return;
    setSymbol(s);
    setBusy('deep');
    setErr(undefined);
    try {
      const d = await api.researchDeepGenerate(s, 'deep');
      setDoc(d);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Panel
      title="Deep Dive"
      right={
        <div className="flex items-center gap-2">
          <TickerSearch onSelect={(s) => setSymbol(s)} placeholder="Set ticker…" className="w-40" />
          <button
            className="btn-amber flex items-center gap-1.5"
            onClick={() => analyze(symbol)}
            disabled={busy !== null}
          >
            {busy === 'analyze' ? <RefreshCw size={12} className="animate-spin" /> : <Brain size={12} />}
            Analyze (Kimi)
          </button>
          <button
            className="btn-amber flex items-center gap-1.5"
            onClick={() => deepDive(symbol)}
            disabled={busy !== null}
          >
            {busy === 'deep' ? <RefreshCw size={12} className="animate-spin" /> : <FileText size={12} />}
            Deep Dive (Kimi)
          </button>
        </div>
      }
      bodyClassName="overflow-auto"
    >
      <div className="flex flex-col gap-3 p-3">
        <div className="flex items-center gap-2 rounded border border-amber/40 bg-amber/10 px-3 py-2">
          <AlertTriangle size={13} className="text-amber shrink-0" />
          <p className="text-xs text-amber leading-relaxed">
            On-demand <span className="font-semibold">Analyze</span> and{' '}
            <span className="font-semibold">Deep Dive</span> use Kimi and{' '}
            <span className="font-semibold">spend credits</span> each run. Target:{' '}
            <span className="font-mono text-text">{symbol}</span>
          </p>
        </div>

        {busy ? (
          <Spinner label={`${busy === 'deep' ? 'Generating deep dive' : 'Analyzing'} ${symbol}…`} />
        ) : err ? (
          <ErrorState label={`Failed — ${err}`} onRetry={() => analyze(symbol)} />
        ) : doc ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-lg text-text">{doc.symbol}</span>
              <Badge tone="amber">{doc.kind}</Badge>
              <ProviderBadge provider={doc.provider} />
              <div className="flex-1" />
              {doc.model && <span className="text-2xs text-muted font-mono">{doc.model}</span>}
              {doc.created_at && <span className="text-2xs text-muted">{timeAgo(doc.created_at)}</span>}
            </div>
            {doc.title && <div className="text-sm font-semibold text-text">{doc.title}</div>}
            <div className="rounded border border-border bg-bg-2/40 p-3">
              <Markdown source={doc.body} />
            </div>
          </div>
        ) : report ? (
          <ReportCard report={report} />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <Search size={20} className="text-muted" />
            <span className="micro-label">
              Set a ticker, then Analyze or Deep Dive (Kimi · spends credits)
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---- history -------------------------------------------------------------

function HistoryCard({ item }: { item: ResearchHistoryItem }) {
  const [expanded, setExpanded] = useState(false);
  const conviction = clamp(Number(item.conviction ?? 0), 0, 100);

  return (
    <div className="border border-border rounded bg-panel-2/40">
      <button
        className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left hover:bg-panel-2"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown size={13} className="text-muted shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-muted shrink-0" />
        )}
        <span className="font-mono text-sm text-text">{item.symbol}</span>
        <Badge tone={actionTone(item.suggested_action)}>{item.suggested_action || 'N/A'}</Badge>
        {item.regime && <Badge tone="neutral">{item.regime}</Badge>}

        {/* conviction meter */}
        <div className="flex items-center gap-1.5 min-w-[120px]">
          <span className="micro-label">Conv</span>
          <div className="w-16 h-2 rounded bg-bg-2 border border-border overflow-hidden">
            <div className="h-full bg-amber" style={{ width: `${conviction}%` }} />
          </div>
          <span className="font-mono text-2xs text-amber">{conviction.toFixed(0)}</span>
        </div>

        <span className={`font-mono text-xs ${colorBySign(item.sentiment_score)}`}>
          {item.sentiment_score > 0 ? '+' : ''}
          {item.sentiment_score}
        </span>

        <div className="flex-1" />
        {(item.provider || item.model) && (
          <span className="text-2xs text-muted font-mono">
            {[item.provider, item.model].filter(Boolean).join(' · ')}
          </span>
        )}
        {item.generated_at && (
          <span className="text-2xs text-muted">{timeAgo(item.generated_at)}</span>
        )}
      </button>

      {expanded && (
        <div className="px-3 pb-3 pt-1 flex flex-col gap-3 border-t border-border">
          <div className="flex flex-col gap-1">
            <span className="micro-label">Thesis</span>
            <p className="text-sm text-text-dim leading-relaxed">{item.thesis || '—'}</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border border-down/30 bg-down/5 rounded p-2.5 flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <TrendingDown size={13} className="text-down" />
                <span className="text-2xs uppercase tracking-widest text-down">Bear Case</span>
              </div>
              <p className="text-xs text-text-dim leading-relaxed">{item.bear_case || '—'}</p>
            </div>
            <div className="flex flex-col gap-1">
              <span className="micro-label">Key Risks</span>
              {item.key_risks && item.key_risks.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {item.key_risks.map((r, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs text-text-dim leading-relaxed">
                      <AlertTriangle size={12} className="text-amber mt-0.5 shrink-0" />
                      <span>{r}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-xs text-muted">None noted</span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-border rounded p-2.5 flex flex-col gap-0.5">
              <span className="micro-label">Suggested Stop</span>
              <span className="font-mono text-sm text-down">{money(item.suggested_stop)}</span>
            </div>
            <div className="border border-border rounded p-2.5 flex flex-col gap-0.5">
              <span className="micro-label">Suggested Target</span>
              <span className="font-mono text-sm text-up">{money(item.suggested_target)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ResearchHistory() {
  const [symbolFilter, setSymbolFilter] = useState('');
  const { data, error, loading, refetch } = usePolling<ResearchHistoryItem[]>(
    () => api.researchHistory(undefined, 50),
    60000,
  );

  const items = data ?? [];
  const filtered = items.filter((it) => {
    const q = symbolFilter.trim().toUpperCase();
    return !q || it.symbol.toUpperCase().includes(q);
  });
  // reverse-chron
  const sorted = [...filtered].sort(
    (a, b) => new Date(b.generated_at || 0).getTime() - new Date(a.generated_at || 0).getTime(),
  );

  const right = (
    <div className="relative">
      <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
      <input
        className="input font-mono uppercase pl-7 py-1 w-32 text-xs"
        value={symbolFilter}
        onChange={(e) => setSymbolFilter(e.target.value.toUpperCase())}
        placeholder="Symbol…"
        autoComplete="off"
      />
    </div>
  );

  let body: React.ReactNode;
  if (loading && items.length === 0) body = <Spinner label="Loading history" />;
  else if (error && items.length === 0)
    body = <ErrorState label={`History unavailable — ${error.message}`} onRetry={refetch} />;
  else if (sorted.length === 0) body = <Empty label="No past analyses" />;
  else
    body = (
      <div className="p-3 flex flex-col gap-2">
        {sorted.map((it) => (
          <HistoryCard key={it.id} item={it} />
        ))}
      </div>
    );

  return (
    <Panel title="Analysis History" right={right} className="flex-1 min-h-0" bodyClassName="overflow-auto">
      {body}
    </Panel>
  );
}

// ---- view ----------------------------------------------------------------

type Tab = 'engine' | 'feed' | 'deep' | 'history';

export function Research() {
  const [tab, setTab] = useState<Tab>('engine');

  return (
    <div className="flex flex-col gap-3 p-3 h-full overflow-hidden">
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <Toggle
          value={tab}
          onChange={(v) => setTab(v as Tab)}
          options={[
            { value: 'engine', label: 'Engine' },
            { value: 'feed', label: 'Feed' },
            { value: 'deep', label: 'Deep Dive' },
            { value: 'history', label: 'History' },
          ]}
        />
        {tab === 'engine' && (
          <span className="flex items-center gap-1.5 text-muted">
            <Cpu size={12} />
            <span className="micro-label">Continuous research worker</span>
          </span>
        )}
        {tab === 'feed' && (
          <span className="flex items-center gap-1.5 text-muted">
            <Rss size={12} />
            <span className="micro-label">Auto-refresh 15s</span>
          </span>
        )}
        {tab === 'history' && (
          <span className="flex items-center gap-1.5 text-muted">
            <HistoryIcon size={12} />
            <span className="micro-label">Past analyses</span>
          </span>
        )}
      </div>

      {tab === 'engine' ? (
        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-auto">
          <RegimeBanner />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 flex-1 min-h-0">
            <Engine />
            <MorningBriefing />
          </div>
        </div>
      ) : tab === 'feed' ? (
        <div className="flex flex-col flex-1 min-h-0">
          <Feed />
        </div>
      ) : tab === 'deep' ? (
        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-auto">
          <RegimeBanner />
          <div className="flex flex-col flex-1 min-h-0">
            <DeepDive />
          </div>
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0">
          <ResearchHistory />
        </div>
      )}
    </div>
  );
}
