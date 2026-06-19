// Cross-route prefill for the Builder. The Strategy Library "Customize" action
// stashes a partial Bot draft here, then navigates to /builder?from=template.
// The Builder view reads + clears it once on mount and opens the form prefilled.

import type { Bot } from '@/api/types';

const KEY = 'builder.templatePrefill';

export function setTemplatePrefill(draft: Partial<Bot>): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    /* storage may be unavailable — degrade silently */
  }
}

export function takeTemplatePrefill(): Partial<Bot> | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    sessionStorage.removeItem(KEY);
    return JSON.parse(raw) as Partial<Bot>;
  } catch {
    return null;
  }
}
