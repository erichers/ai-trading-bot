import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsItem, WSMessage } from '@/api/types';

export interface LiveQuote {
  symbol: string;
  price: number;
  change?: number;
  change_pct?: number;
  ts: number;
}

export type WSStatus = 'connecting' | 'open' | 'closed';

interface WSHook {
  status: WSStatus;
  quotes: Record<string, LiveQuote>;
  lastNews: NewsItem | null;
  lastSignal: WSMessage | null;
}

/**
 * Native WebSocket with exponential backoff reconnect. Exposes latest quote
 * per symbol plus the most recent news/signal push.
 */
export function useWebSocket(): WSHook {
  const [status, setStatus] = useState<WSStatus>('connecting');
  const [quotes, setQuotes] = useState<Record<string, LiveQuote>>({});
  const [lastNews, setLastNews] = useState<NewsItem | null>(null);
  const [lastSignal, setLastSignal] = useState<WSMessage | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const closedByUs = useRef(false);

  const connect = useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Honor Vite's base path so the WS resolves under /sandbox/ws behind Apache.
    const base = import.meta.env.BASE_URL.endsWith('/')
      ? import.meta.env.BASE_URL
      : `${import.meta.env.BASE_URL}/`;
    const url = `${proto}://${window.location.host}${base}ws`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      attemptRef.current = 0;
      setStatus('open');
    };

    ws.onmessage = (ev) => {
      let msg: WSMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'quote' && typeof msg.symbol === 'string') {
        const sym = msg.symbol as string;
        setQuotes((prev) => ({
          ...prev,
          [sym]: {
            symbol: sym,
            price: Number(msg.price),
            change: msg.change as number | undefined,
            change_pct: msg.change_pct as number | undefined,
            ts: Date.now(),
          },
        }));
      } else if (msg.type === 'news') {
        setLastNews(msg as unknown as NewsItem);
      } else if (msg.type === 'signal') {
        setLastSignal(msg);
      }
    };

    ws.onclose = () => {
      setStatus('closed');
      if (!closedByUs.current) scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (closedByUs.current) return;
    const attempt = attemptRef.current++;
    const delay = Math.min(1000 * 2 ** attempt, 15000);
    timerRef.current = window.setTimeout(connect, delay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  useEffect(() => {
    closedByUs.current = false;
    connect();
    return () => {
      closedByUs.current = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { status, quotes, lastNews, lastSignal };
}
