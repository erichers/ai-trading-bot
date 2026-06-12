import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Send,
  Database,
  ChevronRight,
  ChevronDown,
  Copy,
  Check,
  Sparkles,
  Code2,
  AlertTriangle,
  Table2,
} from 'lucide-react';
import { api } from '@/api/client';
import type {
  ChatMessageTurn,
  ChatResponse,
  ChatSchemaTable,
} from '@/api/types';
import { usePolling } from '@/hooks/usePolling';
import { Panel, Spinner, Empty, ErrorState, Badge } from '@/components/ui';
import { Markdown } from '@/components/Markdown';

// ---- conversation model --------------------------------------------------

interface UserTurn {
  id: number;
  role: 'user';
  content: string;
}

interface AssistantTurn {
  id: number;
  role: 'assistant';
  pending?: boolean;
  // populated once the response arrives
  response?: ChatResponse;
  // a transport-level failure (network / 500) distinct from a query error
  failure?: string;
}

type Turn = UserTurn | AssistantTurn;

const SUGGESTIONS = [
  'How many trades have I made?',
  'Show my highest-conviction research',
  'Which bots do I have and their modes?',
  'Latest research for TSLA, META, NVDA',
  'Count research analyses per symbol',
  'Recent risk vetoes',
];

// Cap how many prior turns we send back to the model.
const HISTORY_LIMIT = 8;

// ---- cell rendering ------------------------------------------------------

const NUMERIC_RE = /^-?\d[\d,]*\.?\d*$/;

function formatCell(v: unknown): { text: string; numeric: boolean } {
  if (v === null || v === undefined) return { text: '—', numeric: false };
  if (typeof v === 'number') return { text: String(v), numeric: true };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', numeric: false };
  if (typeof v === 'object') return { text: JSON.stringify(v), numeric: false };
  const s = String(v);
  return { text: s, numeric: NUMERIC_RE.test(s.trim()) };
}

// ---- SQL block (collapsible + copy) --------------------------------------

function SqlBlock({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="rounded border border-border bg-bg-2 overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border">
        <button
          className="flex items-center gap-1.5 text-amber hover:text-text"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Code2 size={12} />
          <span className="micro-label">SQL</span>
        </button>
        <button
          className="flex items-center gap-1 text-muted hover:text-text text-2xs uppercase tracking-wider"
          onClick={copy}
          title="Copy SQL"
        >
          {copied ? <Check size={11} className="text-up" /> : <Copy size={11} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {open && (
        <pre className="p-2.5 overflow-auto">
          <code className="font-mono text-xs text-text-dim whitespace-pre">{sql}</code>
        </pre>
      )}
    </div>
  );
}

// ---- results table -------------------------------------------------------

function ResultsTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
}) {
  // Derive columns from the rows if the backend omitted them.
  const cols = useMemo(() => {
    if (columns && columns.length) return columns;
    const set = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) set.add(k);
    return Array.from(set);
  }, [columns, rows]);

  return (
    <div className="rounded border border-border overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-panel">
        <Table2 size={12} className="text-amber" />
        <span className="micro-label">Results</span>
        <Badge tone="neutral">{rows.length} {rows.length === 1 ? 'row' : 'rows'}</Badge>
      </div>
      <div className="overflow-auto max-h-80">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-panel z-10">
            <tr className="text-left text-muted border-b border-border">
              {cols.map((c) => (
                <th key={c} className="px-2 py-1.5 micro-label font-normal whitespace-nowrap">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/50 hover:bg-panel-2">
                {cols.map((c) => {
                  const { text, numeric } = formatCell(row[c]);
                  return (
                    <td
                      key={c}
                      className={`px-2 py-1.5 font-mono whitespace-nowrap ${
                        numeric ? 'text-right text-text' : 'text-text-dim'
                      }`}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- assistant answer ----------------------------------------------------

function AssistantAnswer({ turn }: { turn: AssistantTurn }) {
  if (turn.pending) {
    return (
      <div className="flex items-center gap-2 text-text-dim text-xs">
        <div className="w-3 h-3 border-2 border-border-2 border-t-amber rounded-full animate-spin" />
        <span className="micro-label">Gemma is querying…</span>
      </div>
    );
  }

  if (turn.failure) {
    return (
      <div className="flex items-start gap-2 text-down text-xs">
        <AlertTriangle size={14} className="mt-0.5 shrink-0" />
        <span>{turn.failure}</span>
      </div>
    );
  }

  const r = turn.response;
  if (!r) return null;

  const hasRows = Array.isArray(r.rows) && r.rows.length > 0;

  return (
    <div className="flex flex-col gap-2.5 min-w-0">
      {r.answer ? (
        <Markdown source={r.answer} />
      ) : (
        <span className="text-muted text-xs italic">No answer returned.</span>
      )}

      {r.error && (
        <div className="flex items-start gap-2 rounded border border-down/40 bg-down/10 text-down text-xs px-2.5 py-1.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="font-mono break-words">{r.error}</span>
        </div>
      )}

      {r.mode === 'sql' && r.sql && <SqlBlock sql={r.sql} />}

      {hasRows && <ResultsTable columns={r.columns ?? []} rows={r.rows!} />}
    </div>
  );
}

// ---- chat bubble ---------------------------------------------------------

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm border border-amber/40 bg-amber/10 text-text px-3 py-2 text-sm whitespace-pre-wrap break-words">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%] min-w-0 rounded-lg rounded-bl-sm border border-border bg-panel px-3 py-2.5">
        <AssistantAnswer turn={turn} />
      </div>
    </div>
  );
}

// ---- schema panel --------------------------------------------------------

function SchemaTableItem({ t }: { t: ChatSchemaTable }) {
  const [open, setOpen] = useState(false);
  const cols = t.columns ?? [];
  return (
    <div className="border-b border-border/60">
      <button
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-panel-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? (
          <ChevronDown size={12} className="text-muted shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-muted shrink-0" />
        )}
        <Table2 size={12} className="text-amber shrink-0" />
        <span className="font-mono text-xs text-text truncate">{t.table}</span>
        <span className="ml-auto text-2xs text-muted">{cols.length}</span>
      </button>
      {open && cols.length > 0 && (
        <div className="pb-1.5 pl-7 pr-2 flex flex-col gap-0.5">
          {cols.map((c) => (
            <div key={c.name} className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-2xs text-text-dim truncate">{c.name}</span>
              <span className="font-mono text-2xs text-muted truncate shrink-0">{c.type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaPanel() {
  const { data, error, loading, refetch } = usePolling<ChatSchemaTable[]>(
    () => api.chatSchema(),
    0, // fetch once; schema is static
    [],
  );
  const tables = data ?? [];

  let body: React.ReactNode;
  if (loading && tables.length === 0) body = <Spinner label="Loading schema" />;
  else if (error && tables.length === 0)
    body = <ErrorState label={`Schema unavailable — ${error.message}`} onRetry={refetch} />;
  else if (tables.length === 0) body = <Empty label="No tables" />;
  else
    body = (
      <div className="overflow-auto h-full">
        {tables.map((t) => (
          <SchemaTableItem key={t.table} t={t} />
        ))}
      </div>
    );

  return (
    <Panel
      title={
        <span className="flex items-center gap-1.5">
          <Database size={12} /> Schema
        </span>
      }
      right={tables.length ? <Badge tone="neutral">{tables.length}</Badge> : undefined}
      className="w-60 shrink-0 hidden lg:flex"
      bodyClassName="min-h-0"
    >
      {body}
    </Panel>
  );
}

// ---- main view -----------------------------------------------------------

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const nextId = () => ++idRef.current;

  // Auto-scroll to the newest turn.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;

    const userTurn: UserTurn = { id: nextId(), role: 'user', content: message };
    const assistantId = nextId();
    const assistantTurn: AssistantTurn = { id: assistantId, role: 'assistant', pending: true };

    // Build history from prior completed turns (before this one).
    const history: ChatMessageTurn[] = [];
    for (const t of turns) {
      if (t.role === 'user') history.push({ role: 'user', content: t.content });
      else if (t.response?.answer)
        history.push({ role: 'assistant', content: t.response.answer });
    }
    const recent = history.slice(-HISTORY_LIMIT);

    setTurns((prev) => [...prev, userTurn, assistantTurn]);
    setInput('');
    setBusy(true);

    try {
      const res = await api.chat(message, recent);
      setTurns((prev) =>
        prev.map((t) =>
          t.id === assistantId && t.role === 'assistant'
            ? { ...t, pending: false, response: res }
            : t,
        ),
      );
    } catch (e) {
      const msg = (e as Error).message || 'Request failed';
      setTurns((prev) =>
        prev.map((t) =>
          t.id === assistantId && t.role === 'assistant'
            ? { ...t, pending: false, failure: `Chat failed — ${msg}` }
            : t,
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  };

  const empty = turns.length === 0;

  return (
    <div className="flex gap-3 h-full min-h-0">
      <SchemaPanel />

      <Panel
        title={
          <span className="flex items-center gap-1.5">
            <Sparkles size={12} className="text-amber" /> DB Chat
          </span>
        }
        right={<span className="text-2xs text-muted">natural language → SQL</span>}
        className="flex-1 min-w-0"
        bodyClassName="flex flex-col min-h-0"
      >
        {/* conversation thread */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto px-3 py-3 flex flex-col gap-3">
          {empty ? (
            <div className="flex flex-col items-center justify-center h-full text-center gap-3 px-4">
              <Database size={28} className="text-amber/60" />
              <div className="text-text-dim text-sm max-w-md">
                Ask anything about your trading database — trades, research, bots, risk events.
                Gemma writes a read-only SQL query, runs it, and explains the result.
              </div>
              <div className="micro-label">Try one of these</div>
            </div>
          ) : (
            turns.map((t) => <Bubble key={t.id} turn={t} />)
          )}
        </div>

        {/* suggested questions */}
        <div className="px-3 pt-2 pb-1 border-t border-border shrink-0 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((q) => (
            <button
              key={q}
              disabled={busy}
              onClick={() => send(q)}
              className="px-2 py-1 text-2xs rounded border border-border-2 text-text-dim hover:border-amber/40 hover:text-amber bg-panel-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {q}
            </button>
          ))}
        </div>

        {/* input box */}
        <div className="px-3 py-2.5 border-t border-border shrink-0 flex items-end gap-2">
          <textarea
            className="input flex-1 resize-none font-mono text-sm leading-relaxed h-[42px] max-h-32"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask about your database…  (Enter to send, Shift+Enter for newline)"
            disabled={busy}
          />
          <button
            className="btn-amber flex items-center gap-1.5 h-[42px] px-3 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={() => send(input)}
            disabled={busy || input.trim() === ''}
          >
            {busy ? (
              <>
                <div className="w-3 h-3 border-2 border-amber/40 border-t-amber rounded-full animate-spin" />
                <span className="hidden sm:inline">Querying</span>
              </>
            ) : (
              <>
                <Send size={14} />
                <span className="hidden sm:inline">Send</span>
              </>
            )}
          </button>
        </div>
      </Panel>
    </div>
  );
}
