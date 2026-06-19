import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

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
      <div className="w-3.5 h-3.5 border-2 border-border-2 border-t-amber rounded-full animate-spin" />
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
      className={`px-2 py-0.5 text-2xs uppercase tracking-wider rounded-full border ${tones[tone]}`}
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
    <div className="inline-flex rounded-full border border-border bg-panel-2 p-0.5 gap-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1 text-xs rounded-full transition-colors ${
            value === o.value
              ? 'bg-amber text-black font-medium'
              : 'text-text-dim hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Small "?" info icon with an accessible popover. Opens on hover and on
// click/focus (so it works on touch + keyboard too). Terminal-themed.
export function HelpTip({
  children,
  title,
  className = '',
}: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className={`relative inline-flex items-center align-middle ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={title ? `Help: ${title}` : 'Help'}
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="text-muted hover:text-amber focus:text-amber focus:outline-none transition-colors"
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-1/2 top-full z-50 mt-1.5 w-64 -translate-x-1/2 rounded-xl border border-amber/40 bg-panel-2 px-3 py-2.5 text-left text-2xs leading-relaxed text-text-dim shadow-lg shadow-black/60 normal-case tracking-normal"
        >
          {title && <span className="micro-label text-amber block mb-1">{title}</span>}
          {children}
        </span>
      )}
    </span>
  );
}

export function DisconnectedBanner() {
  return (
    <div className="bg-down/15 border-b border-down/40 text-down text-xs px-4 py-1.5 text-center micro-label">
      Backend disconnected — showing last known data. Retrying…
    </div>
  );
}
