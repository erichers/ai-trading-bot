import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Plus,
  Bot as BotIcon,
  BookOpen,
  GripVertical,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Pencil,
  Trash2,
  Zap,
  Play,
  Square,
  History,
} from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { Bot, BotMode, EvalResult } from '@/api/types';
import { Badge, ErrorState, Panel, Spinner, Toggle } from '@/components/ui';
import { BotEvaluation } from '@/components/BotEvaluation';
import { timeAgo } from '@/lib/format';
import { BuilderForm } from '@/views/Builder';

const MODE_OPTIONS: { value: BotMode; label: string }[] = [
  { value: 'signal', label: 'Signal' },
  { value: 'semi', label: 'Semi' },
  { value: 'auto', label: 'Auto' },
];

function modeTone(mode: BotMode): 'neutral' | 'amber' | 'up' {
  if (mode === 'auto') return 'up';
  if (mode === 'semi') return 'amber';
  return 'neutral';
}

/* ---------- per-bot row with inline controls + expandable evaluation ------ */

function BotRow({
  bot,
  onEdit,
  onChanged,
}: {
  bot: Bot;
  onEdit: (b: Bot) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false); // enable/mode/delete in flight
  const [evaluating, setEvaluating] = useState(false);
  const [running, setRunning] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [result, setResult] = useState<EvalResult | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);
  // Inline confirmation (window.confirm() does not work in the native webview).
  const [confirming, setConfirming] = useState<null | 'run' | 'delete'>(null);
  const navigate = useNavigate();

  const right = bot.action?.right;

  async function toggleEnabled(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await api.updateBot(bot.id, { enabled: !bot.enabled });
      onChanged();
    } catch {
      /* poll/reload will resync */
    } finally {
      setBusy(false);
    }
  }

  async function setMode(mode: BotMode) {
    if (mode === bot.mode) return;
    setBusy(true);
    try {
      await api.updateBot(bot.id, { mode });
      onChanged();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setConfirming(null);
    setBusy(true);
    try {
      await api.deleteBot(bot.id);
      onChanged();
    } catch {
      setBusy(false);
    }
  }

  // Load last status when first expanded (degrade gracefully on 404/503).
  async function loadStatus() {
    try {
      const s = await api.botStatus(bot.id);
      if (s?.last_result) setResult(s.last_result);
      if (s?.last_evaluated_at) setLastAt(s.last_evaluated_at);
    } catch {
      /* status endpoint may not exist yet — that's fine */
    }
  }

  function expand() {
    const next = !open;
    setOpen(next);
    if (next && !result) void loadStatus();
  }

  async function evaluate() {
    setEvaluating(true);
    setEvalError(null);
    try {
      const res = await api.evaluateBot(bot.id);
      setResult(res);
      setLastAt(new Date().toISOString());
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setEvalError('Bot engine starting…');
      else setEvalError((e as Error).message || 'Evaluation failed');
    } finally {
      setEvaluating(false);
    }
  }

  async function run() {
    setConfirming(null);
    setRunning(true);
    setEvalError(null);
    try {
      const res = await api.runBot(bot.id, true);
      setResult(res);
      setLastAt(new Date().toISOString());
      // Make the outcome explicit even when nothing was placed.
      if (bot.mode === 'signal') {
        setEvalError(null);
      } else if ((res.placed?.length ?? 0) === 0) {
        setEvalError(
          'Ran — but no orders were placed (no setup passed triggers + AI gate + risk right now). See per-symbol reasons below.',
        );
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 503))
        setEvalError('Bot engine starting…');
      else setEvalError((e as Error).message || 'Run failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className={`border-b border-border ${bot.enabled ? '' : 'opacity-70'}`}>
      {/* header line */}
      <div className="px-3 py-2.5 hover:bg-panel-2 transition-colors">
        <button onClick={expand} className="w-full text-left flex items-center gap-2">
          {open ? (
            <ChevronDown size={13} className="text-muted shrink-0" />
          ) : (
            <ChevronRight size={13} className="text-muted shrink-0" />
          )}
          <span className="text-sm text-text truncate flex-1">{bot.name || 'Untitled'}</span>
          {bot.enabled && (
            <span className="flex items-center gap-1 text-2xs text-up">
              <span className="w-1.5 h-1.5 rounded-full bg-up animate-pulse" /> running
            </span>
          )}
          <Badge tone={bot.enabled ? 'up' : 'neutral'}>{bot.enabled ? 'ON' : 'OFF'}</Badge>
        </button>

        <div className="flex items-center gap-1 mt-1.5 flex-wrap pl-5">
          <Badge tone={modeTone(bot.mode)}>{bot.mode}</Badge>
          {right && right !== 'auto' && (
            <Badge tone={right === 'call' ? 'up' : 'down'}>{right}</Badge>
          )}
          {(bot.symbols || []).slice(0, 5).map((sym) => (
            <span
              key={sym}
              className="text-2xs px-1 py-0.5 rounded bg-panel-2 text-text-dim border border-border-2"
            >
              {sym}
            </span>
          ))}
          {(bot.symbols?.length ?? 0) > 5 && (
            <span className="text-2xs text-muted">+{bot.symbols.length - 5}</span>
          )}
        </div>
      </div>

      {/* expandable detail */}
      {open && (
        <div className="px-3 pb-3 pl-8 flex flex-col gap-2.5 bg-bg-2/40">
          {/* inline controls */}
          <div className="flex items-center gap-2 flex-wrap pt-2">
            <Toggle value={bot.mode} onChange={(v) => void setMode(v as BotMode)} options={MODE_OPTIONS} />
            {/* Start / Stop — the bot's running state. */}
            <button
              className={`btn flex items-center gap-1 ${bot.enabled ? 'text-down' : 'text-up'}`}
              onClick={(e) => void toggleEnabled(e)}
              disabled={busy}
              title={bot.enabled ? 'Stop this bot (pause evaluation)' : 'Start this bot (resume evaluation)'}
            >
              {bot.enabled ? <Square size={11} /> : <Play size={11} />}
              {bot.enabled ? 'Stop' : 'Start'}
            </button>
            <button
              className="btn flex items-center gap-1"
              onClick={() => onEdit(bot)}
              disabled={busy}
            >
              <Pencil size={11} /> Edit
            </button>
            <button
              className="btn flex items-center gap-1"
              onClick={(e) => {
                e.stopPropagation();
                navigate(`/backtest?bot=${encodeURIComponent(bot.id)}`);
              }}
              disabled={busy}
              title="Backtest this bot over real history"
            >
              <History size={11} /> Backtest
            </button>
            <button
              className="btn flex items-center gap-1 text-down"
              onClick={(e) => {
                e.stopPropagation();
                setConfirming('delete');
              }}
              disabled={busy}
            >
              <Trash2 size={11} /> Delete
            </button>
          </div>

          {/* evaluate / run */}
          <div className="grid grid-cols-2 gap-2">
            <button
              className="btn flex items-center justify-center gap-1.5 py-1.5"
              onClick={() => void evaluate()}
              disabled={evaluating || running}
              title="Check which symbols are firing right now (no orders)"
            >
              <Zap size={12} /> {evaluating ? 'Evaluating…' : 'Evaluate now'}
            </button>
            <button
              className="btn flex items-center justify-center gap-1.5 py-1.5 text-amber"
              onClick={() => setConfirming('run')}
              disabled={evaluating || running}
              title={
                bot.mode === 'signal'
                  ? 'Signal-only mode records signals; it will NOT place orders'
                  : 'Run now and place paper orders for firing setups'
              }
            >
              <Play size={12} /> {running ? 'Running…' : 'Run (paper)'}
            </button>
          </div>

          {/* inline confirmation bar (works in the native webview) */}
          {confirming && (
            <div className="rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 flex items-center gap-2 flex-wrap">
              <span className="text-2xs text-text-dim flex-1 leading-relaxed">
                {confirming === 'delete' ? (
                  <>Delete “{bot.name || 'Untitled'}”? This can’t be undone.</>
                ) : bot.mode === 'signal' ? (
                  <>
                    This bot is in <b>Signal-only</b> mode — running records signals but{' '}
                    <b>won’t place any orders</b>. Switch to Semi/Auto to place paper orders. Run anyway?
                  </>
                ) : (
                  <>Run now and place <b>paper</b> orders for any firing setups?</>
                )}
              </span>
              <button
                className={confirming === 'delete' ? 'btn-danger' : 'btn-amber'}
                onClick={() => (confirming === 'delete' ? void remove() : void run())}
              >
                {confirming === 'delete' ? 'Delete' : 'Run'}
              </button>
              <button className="btn" onClick={() => setConfirming(null)}>
                Cancel
              </button>
            </div>
          )}

          {lastAt && (
            <div className="text-2xs text-muted">Last evaluated {timeAgo(lastAt)}</div>
          )}
          {evalError && <div className="text-down text-xs micro-label">{evalError}</div>}

          {evaluating || running ? (
            <Spinner label={running ? 'running' : 'evaluating'} />
          ) : result ? (
            <BotEvaluation result={result} onEditBot={() => onEdit(bot)} />
          ) : (
            <div className="text-2xs text-muted micro-label py-1">
              Hit “Evaluate now” to see which symbols are firing and why.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- main tile ---------- */
export function BotSetup() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [engineDown, setEngineDown] = useState(false);

  // editing === null + creating === false → list view.
  const [editing, setEditing] = useState<Bot | null>(null);
  const [creating, setCreating] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  async function load() {
    setLoading(true);
    setLoadError(null);
    setEngineDown(false);
    try {
      const list = await api.bots();
      setBots(list);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setEngineDown(true);
      else setLoadError((e as Error).message || 'Could not load bots');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  // Deep-link from the Trades page: ?editBot=<id> opens that bot's editor once loaded.
  useEffect(() => {
    const id = searchParams.get('editBot');
    if (!id || bots.length === 0) return;
    const bot = bots.find((b) => b.id === id);
    if (bot) {
      setCreating(false);
      setEditing(bot);
    }
    const next = new URLSearchParams(searchParams);
    next.delete('editBot');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots]);

  const enabledCount = useMemo(() => bots.filter((b) => b.enabled).length, [bots]);
  const inBuilder = creating || editing !== null;

  function openNew() {
    setEditing(null);
    setCreating(true);
  }
  function openEdit(b: Bot) {
    setCreating(false);
    setEditing(b);
  }
  function backToList() {
    setCreating(false);
    setEditing(null);
    void load();
  }

  return (
    <Panel
      title="Bot Setup"
      right={
        <div className="flex items-center gap-2">
          {!inBuilder && bots.length > 0 && (
            <span className="micro-label">
              {enabledCount}/{bots.length} on
            </span>
          )}
          {!inBuilder && (
            <Link
              to="/library"
              className="btn flex items-center gap-1"
              title="Browse research-backed strategy templates"
            >
              <BookOpen size={12} /> Library
            </Link>
          )}
          {!inBuilder && (
            <button className="btn-amber flex items-center gap-1" onClick={openNew}>
              <Plus size={12} /> New
            </button>
          )}
          <span className="drag-handle inline-flex" title="Drag to move">
            <GripVertical size={13} />
          </span>
        </div>
      }
      bodyClassName="overflow-y-auto"
    >
      {inBuilder ? (
        <div className="flex flex-col">
          <div className="px-3 pt-3">
            <button className="btn flex items-center gap-1" onClick={backToList}>
              <ChevronLeft size={12} /> Bots
            </button>
          </div>
          <BuilderForm
            key={editing?.id ?? 'new'}
            initial={editing}
            onSaved={() => void load()}
            onCancel={backToList}
          />
        </div>
      ) : loading ? (
        <Spinner label="loading bots" />
      ) : engineDown ? (
        <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4 py-8">
          <BotIcon size={20} className="text-amber animate-pulse" />
          <span className="text-amber text-xs micro-label">Bot engine starting…</span>
          <button className="btn mt-1" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : loadError ? (
        <ErrorState label={loadError} onRetry={() => void load()} />
      ) : bots.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-5 py-8">
          <BotIcon size={22} className="text-amber" />
          <p className="text-sm text-text-dim leading-relaxed max-w-xs">
            Buy weekly calls/puts on a megacap basket based on researched indicators + market
            research.
          </p>
          <button className="btn-amber flex items-center gap-1" onClick={openNew}>
            <Plus size={12} /> Create a bot
          </button>
        </div>
      ) : (
        <div className="flex flex-col">
          {bots.map((b) => (
            <BotRow key={b.id} bot={b} onEdit={openEdit} onChanged={() => void load()} />
          ))}
        </div>
      )}
    </Panel>
  );
}
