import type { ReactNode } from 'react';

export function Panel({
  title,
  right,
  children,
  className = '',
  bodyClassName = '',
}: {
  title?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <div className={`panel flex flex-col min-h-0 ${className}`}>
      {title !== undefined && (
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <span className="micro-label">{title}</span>
          {right}
        </div>
      )}
      <div className={`flex-1 min-h-0 ${bodyClassName}`}>{children}</div>
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse bg-panel-2 rounded ${className}`} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-text-dim text-xs py-6 justify-center">
      <div className="w-3 h-3 border-2 border-border-2 border-t-amber rounded-full animate-spin" />
      {label && <span className="micro-label">{label}</span>}
    </div>
  );
}

export function Empty({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-muted text-xs py-8 micro-label">
      {label}
    </div>
  );
}

export function ErrorState({ label, onRetry }: { label: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center gap-2 py-8 px-4">
      <div className="text-down text-xs micro-label">{label}</div>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'amber' | 'up' | 'down';
}) {
  const tones: Record<string, string> = {
    neutral: 'border-border-2 text-text-dim',
    amber: 'border-amber/40 text-amber bg-amber/10',
    up: 'border-up/40 text-up bg-up/10',
    down: 'border-down/40 text-down bg-down/10',
  };
  return (
    <span
      className={`px-1.5 py-0.5 text-2xs uppercase tracking-wider rounded border ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Toggle({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="inline-flex rounded border border-border overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs transition-colors ${
            value === o.value
              ? 'bg-amber/15 text-amber'
              : 'bg-panel text-text-dim hover:bg-panel-2'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DisconnectedBanner() {
  return (
    <div className="bg-down/15 border-b border-down/40 text-down text-xs px-4 py-1.5 text-center micro-label">
      Backend disconnected — showing last known data. Retrying…
    </div>
  );
}
