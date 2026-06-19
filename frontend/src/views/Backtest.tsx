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
import { Spinner, Empty, ErrorState, Badge, Toggle, HelpTip } from '@/components/ui';
import { BacktestResults } from '@/components/BacktestResults';
import { money } from '@/lib/format';

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
  const [accountSize, setAccountSize] = useState<number>(10_000); // starting cash
  const [cashPerTrade, setCashPerTrade] = useState<number>(1_000); // max bet per trade
  const [slippageBps, setSlippageBps] = useState<number>(25); // per-side slippage (bps)
  const [commission, setCommission] = useState<number>(1.3); // round-trip commission ($)

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
      const cash = {
        account_size: accountSize > 0 ? accountSize : 10_000,
        cash_per_trade: cashPerTrade > 0 ? cashPerTrade : undefined,
        slippage_bps: slippageBps >= 0 ? slippageBps : undefined,
        commission: commission >= 0 ? commission : undefined,
      };
      const body =
        target.kind === 'bot'
          ? { bot_id: target.id, lookback: useLb, timeframe: useTf || undefined, ...cash }
          : { strategy_id: target.id, lookback: useLb, timeframe: useTf || undefined, ...cash };
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

      {/* Money setup — turn % results into real dollars */}
      <div className="border-t border-border pt-2 flex flex-wrap items-end gap-2.5">
        <div className="flex flex-col gap-1">
          <span className="micro-label flex items-center gap-1">
            Starting cash
            <HelpTip title="Starting cash">
              The hypothetical account balance the simulation begins with. All dollar results (net P&L,
              ending balance, drawdown) are measured against this. It doesn’t touch your real account.
            </HelpTip>
          </span>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-xs">$</span>
            <input
              type="number"
              min={100}
              step={1000}
              className="input w-32 pl-5 py-1.5"
              value={accountSize}
              onChange={(e) => setAccountSize(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="micro-label flex items-center gap-1">
            Cash per trade (max bet)
            <HelpTip title="Cash per trade">
              The amount put into each individual trade — the most you’re willing to risk per setup. The
              simulation deploys this on every entry and tracks the running cash. Smaller = safer and more
              diversified; larger = more concentrated swings. A common rule is 1–10% of the account.
            </HelpTip>
          </span>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-xs">$</span>
            <input
              type="number"
              min={1}
              step={100}
              className="input w-32 pl-5 py-1.5"
              value={cashPerTrade}
              onChange={(e) => setCashPerTrade(Number(e.target.value))}
            />
          </div>
        </div>

        {/* quick presets */}
        <div className="flex flex-col gap-1">
          <span className="micro-label">Quick bet size</span>
          <div className="flex gap-1">
            {[
              { label: '1%', frac: 0.01 },
              { label: '5%', frac: 0.05 },
              { label: '10%', frac: 0.1 },
              { label: '25%', frac: 0.25 },
            ].map((p) => (
              <button
                key={p.label}
                className="btn px-2 py-1"
                onClick={() => setCashPerTrade(Math.max(1, Math.round(accountSize * p.frac)))}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* realistic costs */}
        <div className="flex flex-col gap-1">
          <span className="micro-label flex items-center gap-1">
            Slippage (bps/side)
            <HelpTip title="Slippage">
              Execution cost from the bid/ask spread, in basis points per side (100 bps = 1%). Options have
              wide spreads — 25+ bps/side is realistic. Applied round-trip to every trade.
            </HelpTip>
          </span>
          <input
            type="number"
            min={0}
            step={5}
            className="input w-24 py-1.5"
            value={slippageBps}
            onChange={(e) => setSlippageBps(Number(e.target.value))}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="micro-label flex items-center gap-1">
            Commission ($/trade)
            <HelpTip title="Commission">
              Flat fee per round-trip trade. Equity is commission-free on Alpaca; options are ~$0.65/contract
              each way (~$1.30 round trip).
            </HelpTip>
          </span>
          <div className="relative">
            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-muted text-xs">$</span>
            <input
              type="number"
              min={0}
              step={0.1}
              className="input w-24 pl-5 py-1.5"
              value={commission}
              onChange={(e) => setCommission(Number(e.target.value))}
            />
          </div>
        </div>

        <span className="text-2xs text-muted ml-auto max-w-[240px] leading-relaxed">
          Betting <span className="text-text-dim num">{money(cashPerTrade)}</span> per trade —{' '}
          {accountSize > 0 ? `${((cashPerTrade / accountSize) * 100).toFixed(1)}% of ` : ''}
          <span className="text-text-dim num">{money(accountSize)}</span>. Results are{' '}
          <span className="text-text-dim">net of fees &amp; slippage</span>.
        </span>
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
