import { useState } from 'react';
import { Check, X, ChevronDown, ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { EvalItem, EvalResult } from '@/api/types';
import { Badge, Empty } from '@/components/ui';
import { money, num } from '@/lib/format';

// ==========================================================================
//  Shared rich evaluation renderer.
//  Makes it OBVIOUS which symbols are firing and WHY (or why not):
//  triggers table (target vs actual + ✓/✗), AI gate (conviction vs min),
//  direction (CALL/PUT/skip), selected contract, and risk (vetoes/warnings).
//  Handles both the new structured shape and the older simpler proposal shape.
// ==========================================================================

// Normalize a single item from either the new or legacy shape.
interface NormItem {
  symbol: string;
  firing: boolean;
  reason: string;
  triggers: { indicator: string; operator: string; value: string | number; actual: string; passed: boolean }[];
  triggerResult: boolean | null;
  aiGate: { enabled: boolean; conviction: number; min: number; sentiment?: number; passed: boolean } | null;
  direction: { right: 'call' | 'put' | 'skip'; rationale: string } | null;
  contract: { occ: string; strike: number; expiration: string; mid: number; delta?: number } | null;
  risk: { approved: boolean; decision: string; vetoes: { rule: string; message: string }[]; warnings: { rule: string; message: string }[] } | null;
}

function fmtActual(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'number' ? num(v) : String(v);
}

function normalize(p: EvalItem): NormItem {
  // ---- triggers ----
  const triggers = (p.triggers ?? []).map((t) => ({
    indicator: t.indicator,
    operator: t.operator,
    value: t.value,
    actual: fmtActual(t.actual),
    passed: !!t.passed,
  }));

  // ---- ai gate (new) or derive from legacy conviction/sentiment ----
  let aiGate: NormItem['aiGate'] = null;
  if (p.ai_gate) {
    aiGate = {
      enabled: !!p.ai_gate.enabled,
      conviction: p.ai_gate.conviction ?? p.conviction ?? 0,
      min: p.ai_gate.min_conviction ?? 0,
      sentiment: p.ai_gate.sentiment ?? p.sentiment,
      passed: !!p.ai_gate.passed,
    };
  } else if (p.conviction !== undefined) {
    aiGate = {
      enabled: true,
      conviction: p.conviction,
      min: 0,
      sentiment: p.sentiment,
      passed: true,
    };
  }

  // ---- direction (new) or legacy right ----
  let direction: NormItem['direction'] = null;
  if (p.direction) {
    direction = { right: p.direction.right, rationale: p.direction.rationale };
  } else if (p.right) {
    direction = { right: p.right, rationale: p.rationale ?? '' };
  }

  // ---- contract (new) or legacy occ_symbol ----
  let contract: NormItem['contract'] = null;
  if (p.contract) {
    contract = {
      occ: p.contract.occ_symbol,
      strike: p.contract.strike,
      expiration: p.contract.expiration,
      mid: p.contract.mid,
      delta: p.contract.delta,
    };
  } else if (p.occ_symbol) {
    contract = {
      occ: p.occ_symbol,
      strike: p.strike ?? 0,
      expiration: p.expiration ?? '',
      mid: p.mid_price ?? 0,
    };
  }

  // ---- risk (new) or legacy risk_decision ----
  const rawRisk = p.risk ?? p.risk_decision;
  const risk: NormItem['risk'] = rawRisk
    ? {
        approved: !!rawRisk.approved,
        decision: rawRisk.decision || (rawRisk.approved ? 'approved' : 'vetoed'),
        vetoes: rawRisk.vetoes ?? [],
        warnings: ('warnings' in rawRisk ? rawRisk.warnings : []) ?? [],
      }
    : null;

  // ---- firing + reason ----
  const triggerResult = p.trigger_result ?? (triggers.length ? triggers.every((t) => t.passed) : null);
  let firing = p.firing;
  if (firing === undefined) {
    // Derive: legacy proposals existing usually means it fired & passed risk.
    firing = !!(triggerResult !== false && (aiGate ? aiGate.passed : true) && (risk ? risk.approved : true));
  }
  let reason = p.reason ?? '';
  if (!reason) {
    const bits: string[] = [];
    if (triggerResult === false) bits.push('triggers not met');
    if (aiGate && aiGate.enabled && !aiGate.passed)
      bits.push(`AI conviction ${num(aiGate.conviction, 0)} < ${num(aiGate.min, 0)}`);
    if (direction && direction.right === 'skip') bits.push('direction = skip');
    if (risk && !risk.approved)
      bits.push(`risk vetoed${risk.vetoes[0] ? ` (${risk.vetoes[0].message})` : ''}`);
    reason = bits.length ? bits.join(' · ') : firing ? 'All conditions met' : 'No qualifying setup';
  }

  return {
    symbol: p.symbol,
    firing: !!firing,
    reason,
    triggers,
    triggerResult,
    aiGate,
    direction,
    contract,
    risk,
  };
}

function PassFail({ ok }: { ok: boolean }) {
  return ok ? (
    <Check size={12} className="text-up shrink-0" />
  ) : (
    <X size={12} className="text-down shrink-0" />
  );
}

function EvalRow({ item }: { item: NormItem }) {
  const [open, setOpen] = useState(false);
  const hasDetail =
    item.triggers.length > 0 || item.aiGate || item.direction || item.contract || item.risk;
  return (
    <div className={`rounded border bg-bg-2 ${item.firing ? 'border-up/40' : 'border-border'}`}>
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        className="w-full text-left px-2.5 py-2 flex items-center gap-2"
      >
        {hasDetail ? (
          open ? (
            <ChevronDown size={12} className="text-muted shrink-0" />
          ) : (
            <ChevronRight size={12} className="text-muted shrink-0" />
          )
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="font-mono text-sm text-text w-14 shrink-0">{item.symbol}</span>
        <Badge tone={item.firing ? 'up' : 'neutral'}>
          {item.firing ? 'FIRING' : 'NOT FIRING'}
        </Badge>
        <span className={`text-2xs flex-1 truncate ${item.firing ? 'text-up' : 'text-muted'}`}>
          {item.reason}
        </span>
        {item.direction && item.direction.right !== 'skip' && (
          <Badge tone={item.direction.right === 'call' ? 'up' : 'down'}>
            {item.direction.right}
          </Badge>
        )}
      </button>

      {open && hasDetail && (
        <div className="px-2.5 pb-2.5 pt-0.5 flex flex-col gap-2.5 border-t border-border/60">
          {/* Triggers */}
          {item.triggers.length > 0 && (
            <div>
              <div className="micro-label mb-1 flex items-center gap-1.5">
                Triggers
                <Badge tone={item.triggerResult ? 'up' : 'down'}>
                  {item.triggerResult ? 'met' : 'not met'}
                </Badge>
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-2xs uppercase tracking-wider text-muted">
                    <th className="text-left font-normal py-0.5">Indicator</th>
                    <th className="text-left font-normal py-0.5">Cond.</th>
                    <th className="text-right font-normal py-0.5">Target</th>
                    <th className="text-right font-normal py-0.5">Actual</th>
                    <th className="text-center font-normal py-0.5 w-6"> </th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {item.triggers.map((t, i) => (
                    <tr key={i} className="border-t border-border/40">
                      <td className="py-0.5 font-mono text-text-dim">{t.indicator}</td>
                      <td className="py-0.5 font-mono text-muted">{t.operator}</td>
                      <td className="py-0.5 text-right font-mono text-text-dim">
                        {String(t.value)}
                      </td>
                      <td
                        className={`py-0.5 text-right font-mono ${t.passed ? 'text-up' : 'text-down'}`}
                      >
                        {t.actual}
                      </td>
                      <td className="py-0.5 text-center">
                        <span className="inline-flex justify-center">
                          <PassFail ok={t.passed} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* AI gate */}
          {item.aiGate && (
            <div>
              <div className="micro-label mb-1">AI gate</div>
              {item.aiGate.enabled ? (
                <div className="flex items-center gap-2">
                  <PassFail ok={item.aiGate.passed} />
                  <div className="flex-1 h-1.5 bg-bg rounded overflow-hidden relative">
                    <div
                      className={`h-full ${item.aiGate.passed ? 'bg-up' : 'bg-down'}`}
                      style={{
                        width: `${Math.max(0, Math.min(100, item.aiGate.conviction))}%`,
                      }}
                    />
                  </div>
                  <span className="text-2xs text-muted whitespace-nowrap">
                    conviction{' '}
                    <span className="text-text-dim tabular-nums">
                      {num(item.aiGate.conviction, 0)}
                    </span>{' '}
                    vs min{' '}
                    <span className="text-text-dim tabular-nums">{num(item.aiGate.min, 0)}</span>
                    {item.aiGate.sentiment !== undefined && (
                      <>
                        {' '}
                        · sent{' '}
                        <span className="text-text-dim tabular-nums">
                          {num(item.aiGate.sentiment, 0)}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              ) : (
                <span className="text-2xs text-muted">disabled — no AI confirmation required</span>
              )}
            </div>
          )}

          {/* Direction */}
          {item.direction && (
            <div>
              <div className="micro-label mb-1">Direction</div>
              <div className="flex items-center gap-2">
                <Badge
                  tone={
                    item.direction.right === 'call'
                      ? 'up'
                      : item.direction.right === 'put'
                        ? 'down'
                        : 'neutral'
                  }
                >
                  {item.direction.right === 'skip' ? 'SKIP' : item.direction.right.toUpperCase()}
                </Badge>
                {item.direction.rationale && (
                  <span className="text-2xs text-text-dim leading-relaxed">
                    {item.direction.rationale}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Contract */}
          {item.contract && (
            <div>
              <div className="micro-label mb-1">Selected contract</div>
              <div className="text-xs font-mono text-text-dim flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-amber">{item.contract.occ}</span>
                <span>
                  {money(item.contract.strike)} · {item.contract.expiration}
                </span>
                <span>mid {money(item.contract.mid)}</span>
                {item.contract.delta !== undefined && <span>Δ {num(item.contract.delta)}</span>}
              </div>
            </div>
          )}

          {/* Risk */}
          {item.risk && (
            <div>
              <div className="micro-label mb-1 flex items-center gap-1.5">
                Risk
                <Badge tone={item.risk.approved ? 'up' : 'down'}>{item.risk.decision}</Badge>
              </div>
              <div className="flex items-start gap-1.5">
                {item.risk.approved ? (
                  <ShieldCheck size={13} className="text-up shrink-0 mt-0.5" />
                ) : (
                  <ShieldAlert size={13} className="text-down shrink-0 mt-0.5" />
                )}
                <div className="flex flex-col gap-0.5 flex-1">
                  {item.risk.vetoes.length === 0 && item.risk.warnings.length === 0 ? (
                    <span className="text-2xs text-text-dim">
                      {item.risk.approved ? 'Approved — no vetoes.' : 'Vetoed.'}
                    </span>
                  ) : (
                    <>
                      {item.risk.vetoes.map((v, i) => (
                        <span key={`v${i}`} className="text-2xs text-down">
                          ✕ {v.rule}: {v.message}
                        </span>
                      ))}
                      {item.risk.warnings.map((w, i) => (
                        <span key={`w${i}`} className="text-2xs text-amber">
                          ⚠ {w.rule}: {w.message}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Bot-level banner explaining the aggregate state + mode consequences.
function summaryBanner(result: EvalResult, items: NormItem[]): string {
  const total = items.length;
  const firing = items.filter((i) => i.firing).length;
  const reasons: string[] = [];
  if (firing === 0 && total > 0) {
    // collect the distinct reasons across non-firing symbols
    const seen = new Set<string>();
    for (const it of items) {
      if (!it.firing && it.reason && !seen.has(it.reason)) {
        seen.add(it.reason);
        reasons.push(`${it.symbol}: ${it.reason}`);
      }
    }
  }
  const head = total === 0 ? 'No symbols evaluated' : `${firing}/${total} firing`;
  const modeNote =
    result.mode === 'signal'
      ? ' · Mode = Signal-only → no orders are placed'
      : result.mode === 'semi'
        ? ' · Mode = Semi-auto → orders need your confirmation'
        : result.mode === 'auto'
          ? ' · Mode = Full-auto → firing setups place orders'
          : '';
  const base = `${head}${modeNote}`;
  if (firing === 0 && reasons.length) return `${base} — ${reasons.slice(0, 3).join(' / ')}`;
  return base;
}

export function BotEvaluation({ result }: { result: EvalResult }) {
  const items = (result.proposals ?? []).map(normalize);
  const firing = items.filter((i) => i.firing).length;

  return (
    <div className="flex flex-col gap-2">
      {/* banner */}
      <div
        className={`rounded border px-2.5 py-2 text-2xs leading-relaxed ${
          firing > 0
            ? 'border-up/40 bg-up/10 text-up'
            : 'border-border bg-bg-2 text-text-dim'
        }`}
      >
        {summaryBanner(result, items)}
        {result.note && <div className="text-muted mt-1">{result.note}</div>}
        {result.recorded_signals !== undefined && result.recorded_signals > 0 && (
          <div className="text-muted mt-1">
            {result.recorded_signals} signal(s) recorded
          </div>
        )}
        {result.placed && result.placed.length > 0 && (
          <div className="text-amber mt-1">{result.placed.length} order(s) placed</div>
        )}
      </div>

      {items.length === 0 ? (
        <Empty label="No symbols evaluated" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item, i) => (
            <EvalRow key={`${item.symbol}-${i}`} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}
