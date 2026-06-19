// Renders a trade symbol in plain English. For equities it's just the ticker;
// for options it shows the underlying + a friendly contract line
// ("NVDA · June 22 · $210 Call · 3 DTE"), with the raw OCC available on hover.

import { parseOcc, formatContract } from '@/lib/contracts';

export function ContractLabel({
  symbol,
  expiration,
  strike,
  right,
  className = '',
  variant = 'inline',
}: {
  symbol: string;
  expiration?: string | null;
  strike?: number | null;
  right?: 'call' | 'put' | null;
  className?: string;
  /** 'inline' = compact one-liner for tables; 'full' = the complete sentence. */
  variant?: 'inline' | 'full';
}) {
  const parsed = parseOcc(symbol);
  const isOption = parsed !== null || (!!expiration && (right || strike));

  if (!isOption) {
    return <span className={`font-mono ${className}`}>{symbol}</span>;
  }

  const f = formatContract(
    { occ: symbol, expiration, strike, right },
    variant === 'full' ? 'long' : 'short',
  );
  const root = parsed?.root ?? symbol.replace(/[0-9].*$/, '');
  const tone = f?.right === 'call' ? 'text-up' : f?.right === 'put' ? 'text-down' : 'text-text';

  if (!f) {
    return <span className={`font-mono ${className}`}>{symbol}</span>;
  }

  return (
    <span className={`whitespace-nowrap ${className}`} title={`${root} · ${f.human} (${symbol})`}>
      <span className="font-mono font-semibold text-text">{root}</span>{' '}
      <span className={`${tone}`}>{f.human}</span>
    </span>
  );
}
