// VibeMission core — ledger-level queue view (③ 队列必须可见).
//
// The entry session dispatches everything; tasks pile up in `todo` while the
// concurrency gate is full. This module turns that pile into something the user
// can actually see: position, enqueued time, and a rough ETA — the ledger-level
// half of "队列必须可见" (the host's own message queue is out of our reach; see
// docs/entry-execution-split.md).
//
// Pure functions: caller supplies the rows and the clock.

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_TURN_MS = 90_000;

/**
 * Order queued (todo) tasks FIFO — oldest first, id as a stable tie-break.
 * @param {Array<{id:number, created_at:number}>} tasks
 */
export function orderQueue(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return Number(a.id) - Number(b.id);
  });
}

/**
 * Compute queue positions and ETAs.
 *
 * ETA model: `limit` slots drain one turn every `turnMs`, so a task at position
 * `p` starts after roughly ceil(p / limit) turns. Deliberately coarse — the
 * user needs "roughly when", not a scheduler.
 *
 * @param {Array} tasks rows with id/displayId/title/created_at
 * @param {{limit?: number, turnMs?: number, now?: number}} [opts]
 * @returns {Array<{taskId:number, displayId:string, title:string, position:number,
 *                  enqueuedAt:number, waitedMs:number, etaMs:number}>}
 */
export function computeQueue(tasks, opts = {}) {
  const limit = Math.max(1, opts.limit ?? DEFAULT_CONCURRENCY);
  const turnMs = Math.max(1, opts.turnMs ?? DEFAULT_TURN_MS);
  const now = opts.now ?? Date.now();

  return orderQueue(tasks).map((task, i) => {
    const position = i + 1;
    return {
      taskId: Number(task.id),
      displayId: task.displayId ?? `#${task.id}`,
      title: task.title ?? '',
      position,
      enqueuedAt: Number(task.created_at),
      waitedMs: Math.max(0, now - Number(task.created_at)),
      etaMs: Math.ceil(position / limit) * turnMs,
    };
  });
}

/** Human-readable one-liner: `第 2 位 · #41 支付对账 · 已等 3 分钟 · 预计 6 分钟内`. */
export function formatQueueEntry(entry) {
  const waited = Math.round(entry.waitedMs / 60_000);
  const eta = Math.max(1, Math.round(entry.etaMs / 60_000));
  return `第 ${entry.position} 位 · ${entry.displayId} ${entry.title} · 已等 ${waited} 分钟 · 预计 ${eta} 分钟内`;
}

/**
 * Should the user be told about the queue right now?
 * Only when something has waited past the threshold — otherwise it is noise.
 * @param {Array} entries result of computeQueue
 * @param {{thresholdMs?: number}} [opts]
 */
export function staleEntries(entries, opts = {}) {
  const threshold = opts.thresholdMs ?? 60_000;
  return entries.filter((e) => e.waitedMs >= threshold);
}
