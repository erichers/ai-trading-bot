import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { useAppData } from '@/hooks/useAppData';
import type { LiveNotification } from '@/hooks/useWebSocket';

const TONES = {
  success: { icon: CheckCircle2, cls: 'border-up/50 bg-up/10', accent: 'text-up' },
  warning: { icon: AlertTriangle, cls: 'border-amber/50 bg-amber/10', accent: 'text-amber' },
  error: { icon: XCircle, cls: 'border-down/50 bg-down/10', accent: 'text-down' },
  info: { icon: Info, cls: 'border-border-2 bg-panel-2', accent: 'text-text-dim' },
} as const;

// Live toast stack fed by the WebSocket notification bus (order fills, bot
// actions, risk vetoes). Auto-dismisses; newest on top; capped.
export function Toaster() {
  const { lastNotification } = useAppData();
  const [toasts, setToasts] = useState<LiveNotification[]>([]);

  useEffect(() => {
    if (!lastNotification) return;
    setToasts((prev) => [lastNotification, ...prev].slice(0, 5));
    const id = lastNotification.id;
    const t = setTimeout(() => {
      setToasts((prev) => prev.filter((n) => n.id !== id));
    }, 7000);
    return () => clearTimeout(t);
  }, [lastNotification]);

  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {toasts.map((n) => {
        const tone = TONES[n.level] ?? TONES.info;
        const Icon = tone.icon;
        return (
          <div
            key={n.id}
            className={`panel border ${tone.cls} px-3 py-2.5 flex items-start gap-2.5 shadow-lg shadow-black/40 animate-[flashUp_0.3s_ease-out]`}
          >
            <Icon size={15} className={`shrink-0 mt-0.5 ${tone.accent}`} />
            <div className="flex-1 min-w-0">
              <div className={`text-xs font-semibold ${tone.accent}`}>{n.title}</div>
              <div className="text-2xs text-text-dim leading-relaxed break-words">{n.message}</div>
            </div>
            <button
              className="text-muted hover:text-text shrink-0"
              onClick={() => setToasts((prev) => prev.filter((t) => t.id !== n.id))}
              aria-label="Dismiss"
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
