import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FlaskConical, Play, History } from 'lucide-react';
import { api, ApiError } from '@/api/client';
import type {
  Backtest as BacktestResult,
  BacktestLookback,
  Bot,
  Strategy,
} from '@/api/types';
import { Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { BacktestResults } from '@/components/BacktestResults';

// ---- selectable config (bot or strategy) --------------------------------

type SelOption = {
  key: string; // e.g. "bot:abc" / "strat:xyz"
  kind: 'bot' | 'strategy';
  id: string;
  name: string;
  mode: string;
  timeframe: string;
};

const LOOKBACKS: { value: BacktestLookback; label: string }[] = [
  { value: '1D', label: '1D' },
  { value: '2D', label: '2D' },
  { value: '1W', label: '1W' },
  { value: '1M', label: '1M' },
  { value: '3M', label: '3M' },
];

const TIMEFRAMES = ['', '1Min', '5Min', '15Min', '1Hour', '1Day'];

// ---- main view -----------------------------------------------------------

export function Backtest() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [bots, setBots] = useState<Bot[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);

  const [selKey, setSelKey] = useState<string>('');
  const [lookback, setLookback] = useState<BacktestLookback>('1W');
  const [timeframe, setTimeframe] = useState<string>(''); // '' = use config default

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engineDown, setEngineDown] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);

  // Build the unified option list (bots + strategies).
  const options = useMemo<SelOption[]>(() => {
    const botOpts: SelOption[] = bots.map((b) => ({
      key: `bot:${b.id}`,
      kind: 'bot',
      id: b.id,
      name: b.name || 'Untitled bot',
      mode: b.mode,
      timeframe: '',
    }));
    const stratOpts: SelOption[] = strategies.map((s) => ({
      key: `strat:${s.id}`,
      kind: 'strategy',
      id: s.id,
      name: s.name || 'Untitled strategy',
      mode: s.mode,
      timeframe: s.timeframe || '',
    }));
    return [...botOpts, ...stratOpts];
  }, [bots, strategies]);

  const selected = useMemo(() => options.find((o) => o.key === selKey), [options, selKey]);

  // Load both lists once.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [b, s] = await Promise.allSettled([api.bots(), api.strategies()]);
      if (!alive) return;
      if (b.status === 'fulfilled') setBots(b.value);
      if (s.status === 'fulfilled') setStrategies(s.value);
      setListsLoaded(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Deep-link: ?bot=<id> (or ?strategy=<id>) preselects + auto-runs once lists load.
  const autoRanRef = useRef(false);
  useEffect(() => {
    if (!listsLoaded || autoRanRef.current) return;
    const botId = searchParams.get('bot');
    const stratId = searchParams.get('strategy');
    const lb = searchParams.get('lookback') as BacktestLookback | null;
    if (lb && LOOKBACKS.some((l) => l.value === lb)) setLookback(lb);

    let key = '';
    if (botId && bots.some((b) => b.id === botId)) key = `bot:${botId}`;
    else if (stratId && strategies.some((s) => s.id === stratId)) key = `strat:${stratId}`;
    if (key) {
      setSelKey(key);
      autoRanRef.current = true;
      // Run on next tick once selKey state is committed.
      const opt = options.find((o) => o.key === key);
      const useLb = lb && LOOKBACKS.some((l) => l.value === lb) ? lb : lookback;
      if (opt) void run(opt, useLb, '');
    } else if (!selKey && options.length > 0) {
      setSelKey(options[0].key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listsLoaded]);

  async function run(opt?: SelOption, lb?: BacktestLookback, tf?: string) {
    const target = opt ?? selected;
    if (!target) {
      setError('Select a bot or strategy first');
      return;
    }
    const useLb = lb ?? lookback;
    const useTf = tf !== undefined ? tf : timeframe;
    setRunning(true);
    setError(null);
    setEngineDown(false);
    try {
      const body =
        target.kind === 'bot'
          ? { bot_id: target.id, lookback: useLb, timeframe: useTf || undefined }
          : { strategy_id: target.id, lookback: useLb, timeframe: useTf || undefined };
      const res = await api.backtest(body);
      setResult(res);
    } catch (e) {
      setResult(null);
      if (e instanceof ApiError && (e.status === 404 || e.status === 503)) {
        setEngineDown(true);
      } else {
        setError((e as Error).message || 'Backtest failed');
      }
    } finally {
      setRunning(false);
    }
  }

  // Sync the selection into the URL (no auto-run) so a refresh keeps context.
  function onSelect(key: string) {
    setSelKey(key);
    const opt = options.find((o) => o.key === key);
    const next = new URLSearchParams(searchParams);
    next.delete('bot');
    next.delete('strategy');
    if (opt) next.set(opt.kind === 'bot' ? 'bot' : 'strategy', opt.id);
    setSearchParams(next, { replace: true });
  }

  // ---- selector row -------------------------------------------------------

  const selectorRow = (
    <div className="panel p-2.5 flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2.5">
        <div className="flex flex-col gap-1 min-w-[220px]">
          <span className="micro-label">Bot / Strategy</span>
          <select
            className="input font-mono text-xs py-1.5"
            value={selKey}
            onChange={(e) => onSelect(e.target.value)}
          >
            {options.length === 0 && <option value="">No bots or strategies</option>}
            {bots.length > 0 && (
              <optgroup label="Bots">
                {bots.map((b) => (
                  <option key={`bot:${b.id}`} value={`bot:${b.id}`}>
                    {(b.name || 'Untitled')} · {b.mode}
                  </option>
                ))}
              </optgroup>
            )}
            {strategies.length > 0 && (
              <optgroup label="Strategies">
                {strategies.map((s) => (
                  <option key={`strat:${s.id}`} value={`strat:${s.id}`}>
                    {(s.name || 'Untitled')} · {s.mode}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <span className="micro-label">Lookback</span>
          <Toggle
            value={lookback}
            onChange={(v) => setLookback(v as BacktestLookback)}
            options={LOOKBACKS}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="micro-label">Timeframe</span>
          <select
            className="input font-mono text-xs py-1.5"
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
          >
            {TIMEFRAMES.map((tf) => (
              <option key={tf || 'default'} value={tf}>
                {tf || 'Config default'}
              </option>
            ))}
          </select>
        </div>

        <button
          className="btn-amber flex items-center gap-1.5"
          onClick={() => void run()}
          disabled={running || !selected}
        >
          <Play size={13} /> {running ? 'Simulating…' : 'Run Backtest'}
        </button>

        {selected && (
          <div className="flex items-center gap-1.5 text-2xs text-muted ml-auto">
            <Badge tone={selected.kind === 'bot' ? 'amber' : 'up'}>{selected.kind}</Badge>
            <span className="micro-label">{selected.mode}</span>
          </div>
        )}
      </div>
    </div>
  );

  // ---- results body -------------------------------------------------------

  let body: React.ReactNode;
  if (running) {
    body = (
      <div className="panel flex-1 min-h-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 py-10">
          <Spinner label="Simulating over real history…" />
          <span className="text-2xs text-muted micro-label">
            Replaying {lookback} of bars — this can take 10–30s.
          </span>
        </div>
      </div>
    );
  } else if (engineDown) {
    body = (
      <div className="panel flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4 py-10">
        <FlaskConical size={22} className="text-amber animate-pulse" />
        <span className="text-amber text-xs micro-label">Backtest engine starting…</span>
        <button className="btn mt-1" onClick={() => void run()}>
          Retry
        </button>
      </div>
    );
  } else if (error) {
    body = (
      <div className="panel flex-1 min-h-0">
        <ErrorState label={error} onRetry={() => void run()} />
      </div>
    );
  } else if (!result) {
    body = (
      <div className="panel flex-1 min-h-0">
        <Empty label="Pick a bot or strategy and a lookback, then Run Backtest." />
      </div>
    );
  } else {
    body = <BacktestResults result={result} />;
  }

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="flex items-center gap-2">
        <History size={16} className="text-amber" />
        <h1 className="text-sm micro-label text-text-dim">Backtest</h1>
      </div>
      {selectorRow}
      {body}
    </div>
  );
}
