// VibeMission core — schema migrations.
//
// The base DDL in store.mjs is all `CREATE TABLE IF NOT EXISTS`, so adding a
// column or table to a *live* database would silently do nothing (the table
// already exists, the statement is skipped). This module gives us a real,
// idempotent upgrade path: `schema_meta.version` records what has been applied,
// and each migration runs exactly once, inside a transaction.
//
// Rules:
//   - migrations are append-only; never edit one that has shipped
//   - each `up(db)` must be safe to re-run (CREATE ... IF NOT EXISTS / guards)
//   - backup the database before running against a live store

/** @typedef {{version: number, name: string, up: (db: any) => void}} Migration */

/** @type {Migration[]} */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'entry-binding-and-turns',
    up(db) {
      // ④ 回程绑定：入口会话 ↔ 任务。One entry session carries many tasks.
      db.exec(`
        CREATE TABLE IF NOT EXISTS entry_session_tasks (
          entry_session_id TEXT NOT NULL,
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          PRIMARY KEY (entry_session_id, task_id)
        );
        CREATE INDEX IF NOT EXISTS idx_entry_tasks_task ON entry_session_tasks(task_id);
      `);

      // 度量埋点：入口回合延迟。Separate from `events` on purpose — events
      // require a task_id, and an entry turn may not produce a task at all.
      db.exec(`
        CREATE TABLE IF NOT EXISTS entry_turns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entry_session_id TEXT,
          started_at INTEGER NOT NULL,
          first_reply_at INTEGER,
          latency_ms INTEGER,
          dispatched_task_id INTEGER,
          outcome TEXT NOT NULL DEFAULT 'reply'
        );
        CREATE INDEX IF NOT EXISTS idx_entry_turns_started ON entry_turns(started_at);
      `);
    },
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

function ensureMeta(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      version INTEGER NOT NULL
    );
  `);
  const row = db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get();
  if (Number(row.n) === 0) db.prepare('INSERT INTO schema_meta (version) VALUES (0)').run();
}

/** @param {any} db @returns {number} */
export function currentVersion(db) {
  const row = db.prepare('SELECT version FROM schema_meta LIMIT 1').get();
  return row ? Number(row.version) : 0;
}

/**
 * Apply all pending migrations. Idempotent: running twice is a no-op.
 * @param {any} db
 * @returns {{from: number, to: number, applied: string[]}}
 */
export function migrate(db, { migrations = MIGRATIONS } = {}) {
  ensureMeta(db);
  const from = currentVersion(db);
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const applied = [];

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('UPDATE schema_meta SET version = ?').run(m.version);
      db.exec('COMMIT');
      applied.push(`${m.version}:${m.name}`);
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${err.message}`);
    }
  }

  return { from, to: currentVersion(db), applied };
}
