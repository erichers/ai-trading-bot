import React from 'react';
import ReactDOM from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { AppDataProvider } from './hooks/useAppData';
import { SymbolProvider } from './hooks/useSymbol';
import { Dashboard } from './views/Dashboard';
import { Tickers } from './views/Tickers';
import { OptionsFlowView } from './views/OptionsFlow';
import { Strategies } from './views/Strategies';
import { Library } from './views/Library';
import { Builder } from './views/Builder';
import { Research } from './views/Research';
import { Chat } from './views/Chat';
import { News } from './views/News';
import { PositionsOrders } from './views/PositionsOrders';
import { Trades } from './views/Trades';
import { Backtest } from './views/Backtest';
import { Risk } from './views/Risk';
import { Onboarding } from './views/Onboarding';
import { SettingsView } from './views/Settings';
import { Help } from './views/Help';

// Match the served base path (e.g. '/sandbox' under Apache) so router links resolve.
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

const router = createBrowserRouter(
  [
    {
      path: '/',
      element: <Layout />,
      children: [
        { index: true, element: <Dashboard /> },
        { path: 'tickers', element: <Tickers /> },
        { path: 'options', element: <OptionsFlowView /> },
        { path: 'strategies', element: <Strategies /> },
        { path: 'library', element: <Library /> },
        { path: 'builder', element: <Builder /> },
        { path: 'research', element: <Research /> },
        { path: 'chat', element: <Chat /> },
        { path: 'news', element: <News /> },
        { path: 'positions', element: <PositionsOrders /> },
        { path: 'trades', element: <Trades /> },
        { path: 'backtest', element: <Backtest /> },
        { path: 'risk', element: <Risk /> },
        { path: 'onboarding', element: <Onboarding /> },
        { path: 'settings', element: <SettingsView /> },
        { path: 'help', element: <Help /> },
      ],
    },
  ],
  { basename },
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppDataProvider>
      <SymbolProvider>
        <RouterProvider router={router} />
      </SymbolProvider>
    </AppDataProvider>
  </React.StrictMode>,
);
