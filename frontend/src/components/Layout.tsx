import { Outlet } from 'react-router-dom';
import { TopBar } from './TopBar';
import { LeftRail } from './LeftRail';
import { DisconnectedBanner } from './ui';
import { useAppData } from '@/hooks/useAppData';

export function Layout() {
  const { backendDown } = useAppData();
  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <TopBar />
      {backendDown && <DisconnectedBanner />}
      <div className="flex flex-1 min-h-0">
        <LeftRail />
        <main className="flex-1 min-w-0 overflow-auto p-3">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
