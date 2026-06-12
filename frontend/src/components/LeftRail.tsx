import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  LineChart,
  Activity,
  Cpu,
  Wand2,
  Brain,
  MessagesSquare,
  Newspaper,
  Briefcase,
  Receipt,
  ShieldAlert,
  Rocket,
  Settings,
  HelpCircle,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
}

const items: NavItem[] = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/tickers', icon: LineChart, label: 'Tickers' },
  { to: '/options', icon: Activity, label: 'Options Flow' },
  { to: '/strategies', icon: Cpu, label: 'Strategies' },
  { to: '/builder', icon: Wand2, label: 'Builder' },
  { to: '/research', icon: Brain, label: 'Research' },
  { to: '/chat', icon: MessagesSquare, label: 'Chat' },
  { to: '/news', icon: Newspaper, label: 'News' },
  { to: '/positions', icon: Briefcase, label: 'Positions' },
  { to: '/trades', icon: Receipt, label: 'Trades' },
  { to: '/risk', icon: ShieldAlert, label: 'Risk' },
  { to: '/onboarding', icon: Rocket, label: 'Setup' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/help', icon: HelpCircle, label: 'Help' },
];

export function LeftRail() {
  return (
    <nav className="flex flex-col w-14 bg-panel border-r border-border shrink-0 py-2">
      {items.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          title={label}
          className={({ isActive }) =>
            `group relative flex flex-col items-center gap-0.5 py-2.5 mx-1 rounded transition-colors ${
              isActive
                ? 'text-amber bg-amber/10'
                : 'text-muted hover:text-text hover:bg-panel-2'
            }`
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 bg-amber rounded-full" />
              )}
              <Icon size={18} />
              <span className="text-[8px] uppercase tracking-wide leading-none">{label.split(' ')[0]}</span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
