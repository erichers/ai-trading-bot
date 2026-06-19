import { useState } from 'react';
import { Ban } from 'lucide-react';
import { api } from '@/api/client';

export function KillSwitch({ compact = false }: { compact?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const fire = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.cancelAllOrders();
      setResult('ALL ORDERS CANCELLED');
    } catch (e) {
      setResult(`FAILED: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      setConfirming(false);
      setTimeout(() => setResult(null), 4000);
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="text-2xs text-down uppercase tracking-wider">Cancel ALL?</span>
        <button
          onClick={fire}
          disabled={busy}
          className="px-3 py-1 text-2xs uppercase rounded-full bg-down text-white font-semibold hover:opacity-90"
        >
          {busy ? '…' : 'Yes'}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-3 py-1 text-2xs uppercase rounded-full border border-border-2 text-text-dim"
        >
          No
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {result && (
        <span className="text-2xs uppercase tracking-wider text-amber">{result}</span>
      )}
      <button
        onClick={() => setConfirming(true)}
        title="Cancel all open orders"
        className={`flex items-center gap-1.5 rounded-full border border-down/50 bg-down/15 text-down hover:bg-down/25 transition-colors font-semibold uppercase tracking-wider ${
          compact ? 'px-3 py-1 text-2xs' : 'px-4 py-1.5 text-xs'
        }`}
      >
        <Ban size={compact ? 12 : 14} />
        Kill
      </button>
    </div>
  );
}
