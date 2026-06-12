import { createContext, useContext, useState, type ReactNode } from 'react';

interface SymbolCtx {
  symbol: string;
  setSymbol: (s: string) => void;
}

const Ctx = createContext<SymbolCtx | null>(null);

export function SymbolProvider({ children }: { children: ReactNode }) {
  const [symbol, setSymbolState] = useState('AAPL');
  const setSymbol = (s: string) => setSymbolState(s.toUpperCase());
  return <Ctx.Provider value={{ symbol, setSymbol }}>{children}</Ctx.Provider>;
}

export function useSymbol(): SymbolCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSymbol must be used within SymbolProvider');
  return ctx;
}
