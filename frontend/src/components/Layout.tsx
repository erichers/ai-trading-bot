import { useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AlertOctagon, Ban } from 'lucide-react';
import { TopBar } from './TopBar';
import { LeftRail } from './LeftRail';
import { Toaster } from './Toaster';
import { DisconnectedBanner } from './ui';
import { useAppData } from '@/hooks/useAppData';

function RiskBanner() {
  const { riskStatus } = useAppData();
  if (!riskStatus) return null;
  const { circuit_breaker_tripped, kill_switch_engaged } = riskStatus;
  if (!circuit_breaker_tripped && !kill_switch_engaged) return null;
  return (
    <div className="bg-down/20 border-b border-down/60 text-down px-4 py-1.5 flex items-center justify-center gap-4 micro-label text-xs">
      {kill_switch_engaged && (
        <span className="flex items-center gap-1.5">
          <Ban size={14} /> KILL SWITCH ENGAGED
        </span>
      )}
      {circuit_breaker_tripped && (
        <span className="flex items-center gap-1.5">
          <AlertOctagon size={14} /> CIRCUIT BREAKER TRIPPED — new entries blocked
        </span>
      )}
    </div>
  );
}

export function Layout() {
  const { backendDown } = useAppData();
  const navigate = useNavigate();
  const location = useLocation();

  // First-run: send new users to the setup wizard once.
  useEffect(() => {
    let onboarded = false;
    try {
      onboarded = localStorage.getItem('tt_onboarded') === '1';
    } catch {
      onboarded = true;
    }
    if (!onboarded && location.pathname === '/') {
      navigate('/onboarding', { replace: true });
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar />
      <RiskBanner />
      {backendDown && <DisconnectedBanner />}
      <div className="flex flex-1 min-h-0">
        <LeftRail />
        <main className="flex-1 min-w-0 overflow-auto p-2.5">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
