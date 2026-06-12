import type { ReactNode } from 'react';
import { Panel, Badge } from '@/components/ui';
import {
  BookOpen,
  Cpu,
  ShieldAlert,
  LayoutDashboard,
  Search,
  Activity,
  Workflow,
  Newspaper,
  Wallet,
  Settings as SettingsIcon,
  Power,
  Lightbulb,
  Palette,
  TerminalSquare,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';

function Section({
  icon,
  title,
  children,
  right,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <Panel
      title={title}
      right={right}
      className="bg-panel"
      bodyClassName="p-3 text-sm text-text-dim leading-relaxed"
    >
      <div className="flex gap-3">
        <div className="shrink-0 mt-0.5 text-amber">{icon}</div>
        <div className="min-w-0 flex-1 space-y-2">{children}</div>
      </div>
    </Panel>
  );
}

const VIEWS: {
  icon: ReactNode;
  name: string;
  desc: string;
}[] = [
  {
    icon: <LayoutDashboard size={15} />,
    name: 'Dashboard',
    desc: 'Equity strip incl. OPEN RISK, watchlist, the main chart, the AI research feed, and the live activity log — your command center.',
  },
  {
    icon: <Search size={15} />,
    name: 'Tickers',
    desc: 'Search any symbol for a snapshot, mini-chart, and one-click add to your watchlist.',
  },
  {
    icon: <Activity size={15} />,
    name: 'Options Flow',
    desc: 'Full chain, flow summary, unusual activity scanner, with weekly/daily views.',
  },
  {
    icon: <Workflow size={15} />,
    name: 'Strategies',
    desc: '"Indicators to fire" rule builder + an AI gate + a test-signal runner before anything goes live.',
  },
  {
    icon: <BookOpen size={15} />,
    name: 'Research',
    desc: 'Morning briefing, deep-dive analyze on demand, and a market regime monitor.',
  },
  {
    icon: <Newspaper size={15} />,
    name: 'News',
    desc: 'Live feed with watchlist filtering, pushed in real time over WebSocket.',
  },
  {
    icon: <Wallet size={15} />,
    name: 'Positions & Orders',
    desc: 'Positions table, order ticket, and bracket (entry / stop / target) management.',
  },
  {
    icon: <SettingsIcon size={15} />,
    name: 'Settings',
    desc: 'System health, paper/live mode, hard risk limits, and the kill switch.',
  },
];

const LEGEND: { tone: 'up' | 'down' | 'amber'; label: string; meaning: string }[] = [
  { tone: 'up', label: 'Green', meaning: 'Up / P&L positive' },
  { tone: 'down', label: 'Red', meaning: 'Down / negative' },
  { tone: 'amber', label: 'Amber', meaning: 'Warnings / armed signals / accent' },
];

export function Help() {
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="max-w-4xl mx-auto p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="micro-label">Onboarding</div>
            <h1 className="text-text text-lg font-semibold flex items-center gap-2">
              <BookOpen size={18} className="text-amber" />
              Help &amp; Field Guide
            </h1>
          </div>
          <Badge tone="amber">Paper-First Terminal</Badge>
        </div>

        {/* Welcome */}
        <Section icon={<BookOpen size={16} />} title="Welcome">
          <p className="text-text">
            This is a <span className="text-amber">paper-first AI trading terminal</span>.
            It pairs a research assistant with deterministic execution plumbing so you can
            design, test, and run strategies against simulated capital — and watch every
            decision it makes.
          </p>
          <p>
            New here? Skim the principle below, then jump into the view guide. Everything is
            keyboard- and search-driven from the top bar.
          </p>
        </Section>

        {/* The Principle */}
        <Section
          icon={<Cpu size={16} />}
          title="The Principle"
          right={<Badge tone="neutral">Core Model</Badge>}
        >
          <p className="text-text font-medium tracking-wide">
            &ldquo;LLM proposes, code disposes.&rdquo;
          </p>
          <p>
            The AI generates <span className="text-text">theses, signals, and conviction</span>{' '}
            — but it never pulls the trigger. Every proposed action is gated by{' '}
            <span className="text-text">deterministic rules</span> and{' '}
            <span className="text-text">hard risk limits</span> before it can touch an order.
          </p>
          <ul className="space-y-1.5">
            {[
              'The model surfaces ideas; rules decide if they qualify.',
              'Nothing auto-executes without passing both the rule gate and the risk gate.',
              'Paper mode is the default — live mode is an explicit, deliberate switch.',
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <CheckCircle2 size={14} className="text-up shrink-0 mt-0.5" />
                <span>{t}</span>
              </li>
            ))}
          </ul>
        </Section>

        {/* Paper-First Disclaimer */}
        <div className="rounded border border-amber/40 bg-amber/10 p-3">
          <div className="flex gap-3">
            <AlertTriangle size={18} className="text-amber shrink-0 mt-0.5" />
            <div className="space-y-1.5 text-sm">
              <div className="micro-label text-amber">Paper-First Disclaimer</div>
              <p className="text-text leading-relaxed">
                Unless you explicitly enable live mode in Settings, this terminal runs against
                a <span className="text-amber font-medium">PAPER account</span> with simulated
                funds. Fills, slippage, and P&amp;L are approximations.
              </p>
              <p className="text-text-dim leading-relaxed">
                Nothing here is financial advice. The AI can be wrong, stale, or confidently
                mistaken. <span className="text-amber">Verify everything</span> before acting on
                real capital.
              </p>
            </div>
          </div>
        </div>

        {/* View Guide */}
        <div className="space-y-2">
          <div className="micro-label px-0.5">View Guide</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {VIEWS.map((v) => (
              <div
                key={v.name}
                className="panel bg-panel border border-border rounded p-3 flex gap-3"
              >
                <div className="shrink-0 text-amber mt-0.5">{v.icon}</div>
                <div className="min-w-0">
                  <div className="text-text text-sm font-medium">{v.name}</div>
                  <div className="text-text-dim text-xs leading-relaxed mt-0.5">{v.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Kill Switch */}
        <Section
          icon={<Power size={16} />}
          title="The Kill Switch"
          right={<Badge tone="down">Emergency</Badge>}
        >
          <p>
            The red{' '}
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-down/50 bg-down/15 text-down text-xs uppercase tracking-wider font-medium align-middle">
              <ShieldAlert size={11} /> Kill
            </span>{' '}
            button in Settings is your panic stop. It cancels{' '}
            <span className="text-down font-medium">ALL open orders</span> at once.
          </p>
          <p className="text-xs text-muted">
            Mechanically it fires{' '}
            <code className="text-text-dim bg-panel-2 px-1 rounded">DELETE /api/orders</code> and
            requires a confirmation before executing. Positions are not closed — only working
            orders are pulled.
          </p>
        </Section>

        {/* Tips */}
        <Section icon={<Lightbulb size={16} />} title="Tips">
          <ul className="space-y-2">
            <li className="flex items-start gap-2">
              <TerminalSquare size={14} className="text-amber shrink-0 mt-0.5" />
              <span>
                Use the <span className="text-text">command / ticker search box</span> in the top
                bar — type a symbol and press <span className="text-text">Enter</span> to load it
                into the main chart.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ArrowRight size={14} className="text-amber shrink-0 mt-0.5" />
              <span>
                Prices <span className="text-up">flash green</span> /{' '}
                <span className="text-down">flash red</span> on each incoming quote tick so you
                can read the tape at a glance.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ArrowRight size={14} className="text-amber shrink-0 mt-0.5" />
              <span>
                All numbers are rendered <span className="font-mono tabular-nums">mono / tabular</span>{' '}
                so columns align and digits don&apos;t jitter.
              </span>
            </li>
          </ul>
        </Section>

        {/* Color Legend */}
        <Section icon={<Palette size={16} />} title="Color Legend">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {LEGEND.map((l) => (
              <div
                key={l.label}
                className="flex items-center gap-2 border border-border rounded px-2.5 py-2 bg-panel-2"
              >
                <Badge tone={l.tone}>{l.label}</Badge>
                <span className="text-text-dim text-xs">{l.meaning}</span>
              </div>
            ))}
          </div>
        </Section>

        <div className="text-center text-2xs text-muted uppercase tracking-widest py-2">
          Paper proposes · code disposes · you decide
        </div>
      </div>
    </div>
  );
}
