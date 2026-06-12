import { useEffect, useMemo, useState } from 'react';
import { Plus, Bot as BotIcon, GripVertical, ChevronLeft } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type { Bot } from '@/api/types';
import { Badge, ErrorState, Panel, Spinner } from '@/components/ui';
import { BuilderForm } from '@/views/Builder';

/* ---------- main tile ---------- */
export function BotSetup() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [engineDown, setEngineDown] = useState(false);

  // editing === null + creating === false → list view.
  const [editing, setEditing] = useState<Bot | null>(null);
  const [creating, setCreating] = useState(false);

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
          {bots.map((b) => {
            const right = b.action?.right;
            return (
              <button
                key={b.id}
                onClick={() => openEdit(b)}
                className="text-left px-3 py-2.5 border-b border-border hover:bg-panel-2 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-text truncate">{b.name || 'Untitled'}</span>
                  <Badge tone={b.enabled ? 'up' : 'neutral'}>{b.enabled ? 'ON' : 'OFF'}</Badge>
                </div>
                <div className="flex items-center gap-1 mt-1 flex-wrap">
                  <Badge tone={b.mode === 'auto' ? 'up' : b.mode === 'semi' ? 'amber' : 'neutral'}>
                    {b.mode}
                  </Badge>
                  {right && right !== 'auto' && (
                    <Badge tone={right === 'call' ? 'up' : 'down'}>{right}</Badge>
                  )}
                  {(b.symbols || []).slice(0, 5).map((sym) => (
                    <span
                      key={sym}
                      className="text-2xs px-1 py-0.5 rounded bg-panel-2 text-text-dim border border-border-2"
                    >
                      {sym}
                    </span>
                  ))}
                  {(b.symbols?.length ?? 0) > 5 && (
                    <span className="text-2xs text-muted">+{b.symbols.length - 5}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </Panel>
  );
}
