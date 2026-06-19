import { Link, useNavigate } from 'react-router-dom';
import { useAppData } from '@/hooks/useAppData';
import { useSymbol } from '@/hooks/useSymbol';
import { TickerSearch } from './TickerSearch';
import { KillSwitch } from './KillSwitch';
import { money, signed, pct, colorBySign } from '@/lib/format';
import { Badge } from './ui';

function ConnDot({ ok }: { ok: boolean }) {
  return (
    <span
      title={ok ? 'Connected' : 'Disconnected'}
      className={`inline-block w-2 h-2 rounded-full ${
        ok ? 'bg-up shadow-[0_0_6px_#00C805]' : 'bg-down'
      }`}
    />
  );
}

export function TopBar() {
  const { account, clock, health, wsStatus } = useAppData();
  const { setSymbol } = useSymbol();
  const navigate = useNavigate();

  const marketOpen = clock?.is_open ?? health?.market_open ?? false;
  const dayPl = account?.day_pl ?? 0;

  return (
    <header className="flex items-center gap-4 px-4 h-12 bg-black border-b border-border shrink-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 shrink-0">
        <div className="w-2.5 h-2.5 bg-amber rounded-full" />
        <span className="font-semibold tracking-tight text-text text-base">Terminal</span>
      </div>

      {/* Search */}
      <TickerSearch
        className="w-64"
        onSelect={(s) => {
          setSymbol(s);
          navigate('/');
        }}
        placeholder="Ticker / command…"
      />

      {/* Center: clock + status */}
      <div className="flex items-center gap-3 mx-auto">
        <span className="num text-xs text-text-dim">
          {clock ? new Date(clock.timestamp).toLocaleTimeString('en-US', { hour12: false }) : '--:--:--'}
        </span>
        <Badge tone={marketOpen ? 'up' : 'down'}>{marketOpen ? 'Open' : 'Closed'}</Badge>
        {health?.paper && <Badge tone="amber">Paper</Badge>}
      </div>

      {/* Right: equity, P&L, conn, kill */}
      <div className="flex items-center gap-4 shrink-0">
        <Link to="/portfolio" className="text-right rounded px-1.5 py-0.5 hover:bg-panel-2 transition-colors" title="Open Portfolio">
          <div className="micro-label">Equity</div>
          <div className="num text-sm text-text">{money(account?.equity ?? null)}</div>
        </Link>
        <Link to="/pnl" className="text-right rounded px-1.5 py-0.5 hover:bg-panel-2 transition-colors" title="Open P&L">
          <div className="micro-label">Day P&amp;L</div>
          <div className={`num text-sm ${colorBySign(dayPl)}`}>
            {signed(dayPl)} <span className="text-2xs">{pct(account?.day_pl_pct)}</span>
          </div>
        </Link>
        <div className="flex items-center gap-1.5">
          <ConnDot ok={wsStatus === 'open' && !!health?.alpaca_connected} />
          <span className="micro-label">{wsStatus === 'open' ? 'Live' : 'Off'}</span>
        </div>
        <KillSwitch />
      </div>
    </header>
  );
}
