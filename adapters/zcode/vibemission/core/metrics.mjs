// VibeMission core — entry turn metrics (度量埋点).
//
// Acceptance criterion 1 (入口 P95 ≤ 3 秒) can only be *measured*, not
// guaranteed, from inside VibeMission — the host owns the response path. So we
// record every entry turn in `entry_turns` and summarise it; the number is then
// checkable by anyone, and a regression shows up as data instead of an opinion.
//
// Storage: `entry_turns(entry_session_id, started_at, first_reply_at,
// latency_ms, dispatched_task_id, outcome)` — created by migration v1.

import { ENTRY_BUDGET } from './budget.mjs';

/** @param {number[]} values @param {number} p 0..1 */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * @param {Array<{latency_ms:number|null, outcome:string, dispatched_task_id:number|null}>} rows
 * @param {{budgetMs?: number}} [opts]
 */
export function summarizeTurns(rows, opts = {}) {
  const budgetMs = opts.budgetMs ?? ENTRY_BUDGET.maxDurationMs;
  const latencies = rows
    .map((r) => r.latency_ms)
    .filter((v) => v != null)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  const within = latencies.filter((n) => n <= budgetMs).length;

  return {
    count: rows.length,
    measured: latencies.length,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    max: latencies.length ? Math.max(...latencies) : null,
    budgetMs,
    withinBudget: latencies.length ? within / latencies.length : null,
    dispatched: rows.filter((r) => r.dispatched_task_id != null).length,
  };
}

/**
 * Record one entry turn. Latency is derived from the two timestamps so callers
 * cannot accidentally record a made-up number.
 * @param {import('./store.mjs').Store} store
 * @param {{entrySessionId?: string|null, startedAt: number, firstReplyAt?: number|null,
 *          dispatchedTaskId?: number|null, outcome?: string}} turn
 */
export function recordTurn(store, turn) {
  const firstReplyAt = turn.firstReplyAt ?? null;
  const latency = firstReplyAt == null ? null : Math.max(0, firstReplyAt - turn.startedAt);
  return store.recordEntryTurn({
    entrySessionId: turn.entrySessionId ?? null,
    startedAt: turn.startedAt,
    firstReplyAt,
    latencyMs: latency,
    dispatchedTaskId: turn.dispatchedTaskId ?? null,
    outcome: turn.outcome ?? 'reply',
  });
}
