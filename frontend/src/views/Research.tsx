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
} from 'lucide-react';
import { api } from '@/api/client';
import type { Regime, ResearchHistoryItem, ResearchReport } from '@/api/types';
import { money, colorBySign, timeAgo } from '@/lib/format';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
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

// ---- deep dive report ----------------------------------------------------

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

function DeepDive() {
  const { symbol, setSymbol } = useSymbol();
  const [report, setReport] = useState<ResearchReport | undefined>(undefined);
  const [analyzing, setAnalyzing] = useState(false);
  const [err, setErr] = useState<string | undefined>(undefined);

  const analyze = async (sym: string) => {
    const s = (sym || '').trim().toUpperCase();
    if (!s) return;
    setSymbol(s);
    setAnalyzing(true);
    setErr(undefined);
    try {
      const r = await api.analyze(s);
      setReport(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <Panel
      title="Deep Dive"
      right={
        <div className="flex items-center gap-2">
          <TickerSearch onSelect={analyze} placeholder="Analyze ticker…" className="w-44" />
          <button
            className="btn-amber flex items-center gap-1.5"
            onClick={() => analyze(symbol)}
            disabled={analyzing}
          >
            <Brain size={12} />
            Analyze {symbol}
          </button>
        </div>
      }
      bodyClassName="overflow-auto"
    >
      {analyzing ? (
        <Spinner label={`Analyzing ${symbol}…`} />
      ) : err ? (
        <ErrorState label={`Analysis failed — ${err}`} onRetry={() => analyze(symbol)} />
      ) : !report ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 py-10 text-center">
          <Search size={20} className="text-muted" />
          <span className="micro-label">Search a ticker or click Analyze to generate a report</span>
        </div>
      ) : (
        <ReportCard report={report} />
      )}
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

export function Research() {
  const [tab, setTab] = useState<'live' | 'history'>('live');

  return (
    <div className="flex flex-col gap-3 p-3 h-full overflow-hidden">
      <div className="flex items-center gap-2 shrink-0">
        <Toggle
          value={tab}
          onChange={(v) => setTab(v as 'live' | 'history')}
          options={[
            { value: 'live', label: 'Live' },
            { value: 'history', label: 'History' },
          ]}
        />
        {tab === 'history' && (
          <span className="flex items-center gap-1.5 text-muted">
            <HistoryIcon size={12} />
            <span className="micro-label">Past analyses</span>
          </span>
        )}
      </div>

      {tab === 'live' ? (
        <div className="flex flex-col gap-3 flex-1 min-h-0 overflow-auto">
          <RegimeBanner />
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 flex-1 min-h-0">
            <MorningBriefing />
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
