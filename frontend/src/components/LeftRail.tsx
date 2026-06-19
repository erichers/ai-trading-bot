import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  LineChart,
  Activity,
  Cpu,
  BookOpen,
  Wand2,
  Brain,
  MessagesSquare,
  Newspaper,
  Briefcase,
  Receipt,
  History,
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
  { to: '/library', icon: BookOpen, label: 'Library' },
  { to: '/builder', icon: Wand2, label: 'Builder' },
  { to: '/research', icon: Brain, label: 'Research' },
  { to: '/chat', icon: MessagesSquare, label: 'Chat' },
  { to: '/news', icon: Newspaper, label: 'News' },
  { to: '/positions', icon: Briefcase, label: 'Positions' },
  { to: '/trades', icon: Receipt, label: 'Trades' },
  { to: '/backtest', icon: History, label: 'Backtest' },
  { to: '/risk', icon: ShieldAlert, label: 'Risk' },
  { to: '/onboarding', icon: Rocket, label: 'Setup' },
  { to: '/settings', icon: Settings, label: 'Settings' },
  { to: '/help', icon: HelpCircle, label: 'Help' },
];

export function LeftRail() {
  return (
    <nav className="flex flex-col w-14 bg-black border-r border-border shrink-0 py-2 gap-1">
      {items.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          aria-label={label}
          className={({ isActive }) =>
            `group relative flex items-center justify-center py-2.5 mx-2 rounded-xl transition-colors ${
              isActive ? 'bg-amber/15' : 'hover:bg-amber/10'
            }`
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-amber rounded-full" />
              )}
              <Icon
                size={20}
                strokeWidth={isActive ? 2.25 : 1.9}
                className={`transition-colors ${isActive ? 'text-amber' : 'text-amber/65 group-hover:text-amber'}`}
              />
              {/* Hover tooltip — label slides in to the right of the icon. */}
              <span className="pointer-events-none absolute left-full ml-2 z-50 whitespace-nowrap rounded-md border border-amber/30 bg-panel-2 px-2 py-1 text-2xs font-medium text-text opacity-0 shadow-lg shadow-black/60 transition-opacity duration-100 group-hover:opacity-100">
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
