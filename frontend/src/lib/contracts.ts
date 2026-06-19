// Human-readable option contract formatting, shared across the app.
//
// Turns raw OCC symbols (e.g. "NVDA260622C00210000") and contract fields into
// plain English like "June 22 · $210 Call · 3 DTE" so traders never have to
// decode an OCC string by hand.

const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export interface ParsedOcc {
  root: string;
  year: number;
  month: number; // 1-12
  day: number;
  right: 'call' | 'put';
  strike: number;
}

// Parse an OCC option symbol → its parts. Root is variable length (1-6).
export function parseOcc(occ: string | null | undefined): ParsedOcc | null {
  if (!occ) return null;
  const m = occ.match(/^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    root: m[1],
    year: 2000 + parseInt(m[2], 10),
    month: parseInt(m[3], 10),
    day: parseInt(m[4], 10),
    right: m[5] === 'C' ? 'call' : 'put',
    strike: parseInt(m[6], 10) / 1000,
  };
}

// Is this string an OCC option symbol (vs a plain equity ticker)?
export function isOccSymbol(s: string | null | undefined): boolean {
  return parseOcc(s) !== null;
}

// Days-to-expiration from a YYYY-MM-DD (or ISO) string, local-date based.
export function daysToExpiry(expiration: string | null | undefined): number | null {
  if (!expiration) return null;
  const m = expiration.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const exp = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((exp.getTime() - today.getTime()) / 86_400_000);
}

export function dteLabel(dte: number | null): string {
  if (dte === null) return '';
  if (dte < 0) return 'expired';
  if (dte === 0) return 'expires today';
  return `${dte} DTE`;
}

const strikeStr = (strike: number): string =>
  `$${strike % 1 === 0 ? strike.toFixed(0) : strike}`;

// Format a friendly expiry like "June 22" (long) or "Jun 22" (short).
export function friendlyExpiry(
  expiration: string | null | undefined,
  style: 'long' | 'short' = 'long',
): string {
  if (!expiration) return '';
  const m = expiration.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return expiration;
  const month = +m[2];
  const day = +m[3];
  const months = style === 'long' ? MONTHS_LONG : MONTHS_SHORT;
  return `${months[month - 1]} ${day}`;
}

export interface ContractParts {
  occ?: string | null;
  strike?: number | null;
  expiration?: string | null;
  right?: 'call' | 'put' | null;
}

export interface FormattedContract {
  human: string; // "June 22 · $210 Call · 3 DTE"
  dte: number | null;
  right: 'call' | 'put' | null;
  strike: number | null;
  expiry: string; // "June 22"
}

// Build a plain-English contract description. Prefers explicit fields, falls
// back to parsing the OCC symbol. `style` controls month length.
export function formatContract(
  parts: ContractParts,
  style: 'long' | 'short' = 'long',
): FormattedContract | null {
  const parsed = parseOcc(parts.occ);
  const right = parts.right ?? parsed?.right ?? null;
  const strike = parts.strike ?? parsed?.strike ?? null;

  // Resolve expiry date from explicit field or the parsed OCC date.
  let year = parsed?.year;
  let month = parsed?.month;
  let day = parsed?.day;
  const em = parts.expiration?.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (em) {
    year = +em[1];
    month = +em[2];
    day = +em[3];
  }
  if (!month || !day) return null;

  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dte = daysToExpiry(isoDate);
  const expiry = friendlyExpiry(isoDate, style);

  const rightStr = right ? right.charAt(0).toUpperCase() + right.slice(1) : 'Option';
  const segs = [expiry];
  if (strike !== null) segs.push(`${strikeStr(strike)} ${rightStr}`);
  else segs.push(rightStr);
  const d = dteLabel(dte);
  if (d) segs.push(d);

  return { human: segs.join(' · '), dte, right, strike, expiry };
}

// Convenience: format directly from an OCC symbol. Returns the human string, or
// the original symbol if it isn't a parseable OCC (e.g. a plain equity ticker).
export function formatOcc(occ: string | null | undefined, style: 'long' | 'short' = 'short'): string {
  const f = formatContract({ occ }, style);
  return f ? f.human : (occ ?? '');
}

// Underlying ticker from an OCC symbol, or the string itself if not an option.
export function underlyingOf(symbol: string | null | undefined): string {
  return parseOcc(symbol)?.root ?? symbol ?? '';
}
