// VibeMission — queue visibility CLI (③ 账本层排队可见).
//
// Prints the todo queue as the user should see it: position, how long it has
// waited, and a rough ETA. Read-only; never mutates the store.
//
// Usage:
//   node scripts/queue-view.mjs [--db <path>] [--limit 3] [--turn-min 1.5]
//                              [--format text|json] [--stale-min 1]
//
// Exit codes: 0 = nothing stale; 1 = at least one entry waited past the
// threshold (so a caller — owner or watchdog — knows a heads-up is due).

import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDbPath } from '../core/src/dbpath.mjs';
import { openStore } from '../core/src/store.mjs';
import { computeQueue, formatQueueEntry, staleEntries } from '../core/src/queue.mjs';

export function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    db: get('--db'),
    limit: Number(get('--limit') ?? 3),
    turnMs: Number(get('--turn-min') ?? 1.5) * 60_000,
    format: get('--format') ?? 'text',
    staleMin: Number(get('--stale-min') ?? 1),
  };
}

/**
 * Build the view from an open store.
 * @param {import('../core/src/store.mjs').Store} store
 * @param {{limit?: number, turnMs?: number, now?: number, staleMs?: number}} [opts]
 */
export function buildView(store, opts = {}) {
  const queued = store.listQueued();
  const entries = computeQueue(queued, {
    limit: opts.limit ?? 3,
    turnMs: opts.turnMs ?? 90_000,
    now: opts.now,
  });
  const stale = staleEntries(entries, { thresholdMs: opts.staleMs ?? 60_000 });
  return { entries, stale, queuedCount: queued.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const store = openStore(args.db ?? resolveDbPath());
  try {
    const view = buildView(store, {
      limit: args.limit,
      turnMs: args.turnMs,
      staleMs: args.staleMin * 60_000,
    });

    if (args.format === 'json') {
      console.log(JSON.stringify(view, null, 2));
    } else if (view.entries.length === 0) {
      console.log('队列为空：没有排队中的任务。');
    } else {
      console.log(`排队 ${view.queuedCount} 条（并发上限 ${args.limit}）：`);
      for (const e of view.entries) console.log(`- ${formatQueueEntry(e)}`);
      if (view.stale.length) {
        console.log('');
        console.log(`有 ${view.stale.length} 条已等待超过 ${args.staleMin} 分钟，建议主动说明排第几。`);
      }
    }
    process.exitCode = view.stale.length ? 1 : 0;
  } finally {
    store.close();
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
