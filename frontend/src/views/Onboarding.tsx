import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CheckCircle2,
  Circle,
  AlertTriangle,
  Loader2,
  RefreshCw,
  KeyRound,
  Database,
  Cpu,
  Server,
  ShieldCheck,
  ShieldAlert,
  LineChart,
  Rocket,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import { api } from '@/api/client';
import type { Health } from '@/api/types';
import { Panel } from '@/components/ui';

type StepStatus = 'ok' | 'warn' | 'pending' | 'checking';

const ONBOARDED_KEY = 'tt_onboarded';

function Dot({ status }: { status: StepStatus }) {
  if (status === 'checking') return <Loader2 size={18} className="text-muted animate-spin" />;
  if (status === 'ok') return <CheckCircle2 size={18} className="text-up" />;
  if (status === 'warn') return <AlertTriangle size={18} className="text-amber" />;
  return <Circle size={18} className="text-muted" />;
}

function Cmd({ children }: { children: string }) {
  return (
    <code className="block bg-bg-2 border border-border rounded px-2 py-1 text-2xs font-mono text-text-dim overflow-x-auto whitespace-pre">
      {children}
    </code>
  );
}

interface Step {
  icon: LucideIcon;
  title: string;
  status: StepStatus;
  statusLabel: string;
  body: React.ReactNode;
}

export function Onboarding() {
  const navigate = useNavigate();
  const [health, setHealth] = useState<Health | null>(null);
  const [dbOk, setDbOk] = useState<StepStatus>('checking');
  const [backendUp, setBackendUp] = useState<StepStatus>('checking');
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    setBackendUp('checking');
    setDbOk('checking');
    try {
      const h = await api.health();
      setHealth(h);
      setBackendUp('ok');
    } catch {
      setHealth(null);
      setBackendUp('warn');
    }
    try {
      await api.trades(undefined, undefined, 1);
      setDbOk('ok');
    } catch {
      setDbOk('warn');
    }
    setChecking(false);
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const alpaca: StepStatus = !health ? 'checking' : health.alpaca_connected ? 'ok' : 'warn';
  const ollama: StepStatus = !health ? 'checking' : health.ollama_connected ? 'ok' : 'warn';
  const paper: StepStatus = !health ? 'checking' : health.paper ? 'ok' : 'warn';

  const steps: Step[] = [
    {
      icon: KeyRound,
      title: '1 · Connect your Alpaca paper account',
      status: alpaca,
      statusLabel: alpaca === 'ok' ? 'Connected' : 'Add keys',
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-text-dim text-xs">
            Create a free paper account, generate API keys, and put them in the repo-root{' '}
            <code className="text-amber">.env</code>. The secret shows only once.
          </p>
          <Cmd>{`ALPACA_API_KEY=...\nALPACA_SECRET_KEY=...\nALPACA_API_BASE_URL=https://paper-api.alpaca.markets/v2`}</Cmd>
          <a
            href="https://app.alpaca.markets/paper/dashboard/overview"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-amber hover:underline text-xs w-fit"
          >
            Open Alpaca paper dashboard <ExternalLink size={12} />
          </a>
        </div>
      ),
    },
    {
      icon: Database,
      title: '2 · Start the database (MySQL via MAMP)',
      status: dbOk,
      statusLabel: dbOk === 'ok' ? 'Connected' : 'Start MAMP',
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-text-dim text-xs">
            Trades, research, signals and risk events are persisted to MySQL{' '}
            <code className="text-amber">trading_terminal</code> on port 8889. Start MAMP (or its
            MySQL script).
          </p>
          <Cmd>{`/Applications/MAMP/bin/startMysql.sh`}</Cmd>
        </div>
      ),
    },
    {
      icon: Cpu,
      title: '3 · Start the local AI (Ollama + Gemma)',
      status: ollama,
      statusLabel: ollama === 'ok' ? `${health?.research_model ?? 'gemma4:e2b'} ready` : 'Start Ollama',
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-text-dim text-xs">
            Research runs on a <strong className="text-text">local</strong> model — no cloud key,
            fully private. Pull it once, then keep the server running.
          </p>
          <Cmd>{`ollama serve\nollama pull gemma4:e2b`}</Cmd>
        </div>
      ),
    },
    {
      icon: Server,
      title: '4 · Backend API',
      status: backendUp,
      statusLabel: backendUp === 'ok' ? 'Online :8000' : 'Not reachable',
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-text-dim text-xs">
            The FastAPI backend brokers every order, computes indicators, and serves data. Launch
            everything with one script:
          </p>
          <Cmd>{`./serve.sh   # builds the UI, starts Ollama/MySQL checks + backend`}</Cmd>
        </div>
      ),
    },
    {
      icon: paper === 'ok' ? ShieldCheck : ShieldAlert,
      title: '5 · Confirm paper mode',
      status: paper,
      statusLabel: paper === 'ok' ? 'PAPER (safe)' : 'CHECK MODE',
      body: (
        <p className="text-text-dim text-xs">
          You are trading simulated money. The platform ships paper-first — go live only after ≥30
          paper days with positive expectancy. The header always shows a{' '}
          <span className="text-amber">PAPER</span> badge; live mode requires re-auth and a red
          banner.
        </p>
      ),
    },
    {
      icon: ShieldAlert,
      title: '6 · Set your risk limits',
      status: 'pending',
      statusLabel: 'Configure',
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-text-dim text-xs">
            The deterministic risk engine vetoes any order that breaks your rules — max position
            size, daily-loss circuit breaker, per-trade risk, concentration. Set them before
            automating.
          </p>
          <button
            onClick={() => navigate('/risk')}
            className="btn-amber w-fit text-xs px-3 py-1.5"
          >
            Open Risk settings →
          </button>
        </div>
      ),
    },
    {
      icon: LineChart,
      title: '7 · Build your first strategy',
      status: 'pending',
      statusLabel: 'Start',
      body: (
        <div className="flex flex-col gap-2">
          <p className="text-text-dim text-xs">
            Start with one simple vertical slice — e.g. RSI mean-reversion on a few liquid ETFs
            (SPY, QQQ). Run it in <strong className="text-text">Signal-only</strong> mode first,
            then Semi-auto, then Full-auto.
          </p>
          <button
            onClick={() => navigate('/strategies')}
            className="btn w-fit text-xs px-3 py-1.5"
          >
            Open Strategy builder →
          </button>
        </div>
      ),
    },
  ];

  const readyCount = steps.filter((s) => s.status === 'ok').length;
  const coreReady = alpaca === 'ok' && ollama === 'ok' && dbOk === 'ok' && backendUp === 'ok';

  const finish = () => {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1');
    } catch {
      /* ignore */
    }
    navigate('/');
  };

  return (
    <div className="max-w-3xl mx-auto flex flex-col gap-3 pb-8">
      {/* Hero */}
      <div className="rounded-lg border border-border bg-panel p-5 flex items-start gap-4">
        <div className="rounded bg-amber/15 p-2.5">
          <Rocket size={22} className="text-amber" />
        </div>
        <div className="flex-1">
          <h1 className="text-lg font-semibold text-text">Set up your trading terminal</h1>
          <p className="text-text-dim text-xs mt-1">
            Seven steps to a fully wired, paper-first AI trading bot. The first four auto-detect as
            you go.{' '}
            <span className="text-up font-mono">{coreReady ? 'All systems go.' : `${readyCount}/7 ready.`}</span>
          </p>
        </div>
        <button
          onClick={check}
          disabled={checking}
          className="btn text-xs px-3 py-1.5 flex items-center gap-1.5 shrink-0"
        >
          <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> Re-check
        </button>
      </div>

      {steps.map((s) => {
        const Icon = s.icon;
        const tone =
          s.status === 'ok'
            ? 'text-up'
            : s.status === 'warn'
              ? 'text-amber'
              : 'text-muted';
        return (
          <Panel key={s.title} title="" className="">
            <div className="flex gap-3 p-3">
              <div className="pt-0.5">
                <Dot status={s.status} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon size={15} className="text-muted" />
                    <span className="text-sm text-text font-medium">{s.title}</span>
                  </div>
                  <span className={`text-2xs font-mono uppercase tracking-wide ${tone}`}>
                    {s.statusLabel}
                  </span>
                </div>
                <div className="mt-2">{s.body}</div>
              </div>
            </div>
          </Panel>
        );
      })}

      <div className="flex items-center justify-between rounded-lg border border-border bg-panel p-4 mt-1">
        <p className="text-text-dim text-xs">
          You can reopen this anytime from <span className="text-text">Help → Setup</span>.
        </p>
        <button onClick={finish} className="btn-amber text-sm px-4 py-2 flex items-center gap-2">
          <CheckCircle2 size={15} /> Go to dashboard
        </button>
      </div>
    </div>
  );
}
