// VibeMission — queue visibility CLI (③ 账本层排队可见).
//
// Read-only by construction: opens the store with `openStoreReadOnly` (SQLite
// readOnly), runs no DDL and no migration. If the schema is older than the code
// expects, it refuses and tells you to re-run with `--migrate` — a query tool
// must never quietly upgrade a live database (that contradiction was flagged in
// review on 2026-11-29).
//
// Usage:
//   node scripts/queue-view.mjs [--db <path>] [--limit 3] [--turn-min 1.5]
//                              [--format text|json] [--stale-min 1] [--migrate]
//
// Exit codes: 0 = nothing stale; 1 = at least one entry waited past the
// threshold (a caller — owner or watchdog — knows a heads-up is due);
// 2 = schema is behind and `--migrate` was not given.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolveDbPath } from '../core/src/dbpath.mjs';
import { openStore, openStoreReadOnly } from '../core/src/store.mjs';
import { currentVersion, LATEST_VERSION } from '../core/src/migrate.mjs';
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
    migrate: argv.includes('--migrate'),
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

/** @param {import('../core/src/store.mjs').Store} store */
export function schemaBehind(store) {
  try {
    return currentVersion(store.db) < LATEST_VERSION;
  } catch {
    return true; // schema_meta missing → unknown/older schema
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db ?? resolveDbPath();

  if (!existsSync(dbPath)) {
    console.error(`找不到账本：${dbPath}\n（只读模式不会创建新库；请确认路径，或先由主程序初始化）`);
    process.exitCode = 2;
    return;
  }

  // Explicit upgrade path only.
  if (args.migrate) {
    const rw = openStore(dbPath);
    try {
      rw.close();
    } catch {
      /* ignore */
    }
  }

  const store = openStoreReadOnly(dbPath);
  try {
    if (schemaBehind(store)) {
      const shown = (() => {
        try {
          return currentVersion(store.db);
        } catch {
          return '未知';
        }
      })();
      console.error(
        `schema 落后：当前 ${shown}，代码期望 ${LATEST_VERSION}。\n` +
          `本命令只读，不会自动升级。确认要升级请显式加 --migrate：\n` +
          `  node scripts/queue-view.mjs --migrate ${args.db ? `--db ${args.db}` : ''}`,
      );
      process.exitCode = 2;
      return;
    }

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

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
