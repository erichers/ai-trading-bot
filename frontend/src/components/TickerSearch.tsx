import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '@/api/client';
import type { Asset } from '@/api/types';

export function TickerSearch({
  onSelect,
  placeholder = 'Search ticker…',
  className = '',
}: {
  onSelect: (symbol: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Asset[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.assets(q.trim(), 8);
        if (!cancelled) {
          setResults(r);
          setActive(0);
          setOpen(true);
        }
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (sym: string) => {
    onSelect(sym.toUpperCase());
    setQ('');
    setResults([]);
    setOpen(false);
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <div className="flex items-center gap-2 bg-bg-2 border border-border rounded px-2 py-1.5 focus-within:border-amber/50">
        <Search size={13} className="text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              if (results[active]) choose(results[active].symbol);
              else if (q.trim()) choose(q.trim());
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
          placeholder={placeholder}
          className="bg-transparent outline-none text-sm w-full placeholder:text-muted uppercase tracking-wide"
        />
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full bg-panel border border-border-2 rounded shadow-xl max-h-72 overflow-auto">
          {results.map((a, i) => (
            <button
              key={a.symbol}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(a.symbol)}
              className={`flex items-center justify-between w-full px-3 py-1.5 text-left ${
                i === active ? 'bg-amber/10' : 'hover:bg-panel-2'
              }`}
            >
              <span className="font-mono text-sm text-text">{a.symbol}</span>
              <span className="text-2xs text-muted truncate ml-2 max-w-[60%]">{a.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
