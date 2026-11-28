// TaskPier core — persistence layer (node:sqlite, WAL).
// Raw CRUD + append-only events. No status logic here (that lives in
// state-machine.mjs); no MCP concepts here (that lives in tools.mjs).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TaskPierError, Codes } from './errors.mjs';
import { formatDisplayId } from './format.mjs';
import { migrate } from './migrate.mjs';

const DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings (intent routing aliases)
  status TEXT NOT NULL DEFAULT 'todo',
  host TEXT,
  project TEXT,
  workspace TEXT,
  session_id TEXT,                          -- host session link (reference only, never copied)
  parent_id INTEGER,
  blocked_reason TEXT,
  decision_question TEXT,
  decision_options TEXT DEFAULT '[]',       -- JSON array of strings
  artifacts TEXT NOT NULL DEFAULT '[]',     -- JSON array of strings
  evidence TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- create | status_change | field_update
  actor TEXT NOT NULL DEFAULT 'mcp',
  payload TEXT NOT NULL DEFAULT '{}'        -- JSON: {from,to,alert,fields,answer,...}
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
`;

const JSON_FIELDS = ['keywords', 'decision_options', 'artifacts', 'evidence'];
const UPDATABLE_FIELDS = [
  'title', 'keywords', 'status', 'host', 'project', 'workspace',
  'session_id', 'parent_id', 'blocked_reason', 'decision_question',
  'decision_options', 'artifacts', 'evidence',
];

/** @param {any} row */
function rowToTask(row) {
  if (!row) return null;
  const task = { ...row, id: Number(row.id), parentId: row.parent_id == null ? null : Number(row.parent_id) };
  task.displayId = formatDisplayId(task.id);
  delete task.parent_id;
  for (const f of JSON_FIELDS) task[f] = JSON.parse(task[f] ?? '[]');
  return task;
}

export class Store {
  /** @param {InstanceType<typeof DatabaseSync>} db */
  constructor(db) {
    this.db = db;
    this.closed = false;
  }

  /**
   * @param {{
   *  title: string, keywords?: string[], status?: string,
   *  host?: string|null, project?: string|null, workspace?: string|null,
   *  session_id?: string|null, parent_id?: number|null
   * }} fields
   * @param {number} now
   */
  insertTask(fields, now = Date.now()) {
    const row = this.db
      .prepare(
        `INSERT INTO tasks (title, keywords, status, host, project, workspace, session_id, parent_id,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fields.title,
        JSON.stringify(fields.keywords ?? []),
        fields.status ?? 'todo',
        fields.host ?? null,
        fields.project ?? null,
        fields.workspace ?? null,
        fields.session_id ?? null,
        fields.parent_id ?? null,
        now,
        now,
      );
    return this.getTask(Number(row.lastInsertRowid));
  }

  /** @param {number} id */
  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return rowToTask(row);
  }

  /**
   * @param {{status?: string|string[], host?: string, project?: string, limit?: number}} filter
   */
  listTasks(filter = {}) {
    const where = [];
    const params = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (filter.host) { where.push('host = ?'); params.push(filter.host); }
    if (filter.project) { where.push('project = ?'); params.push(filter.project); }
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY updated_at DESC, id DESC LIMIT ${limit}`;
    return this.db.prepare(sql).all(...params).map(rowToTask);
  }

  /**
   * Only sets provided fields; caller is responsible for FSM legality.
   * @param {number} id @param {Record<string, unknown>} fields @param {number} now
   */
  updateTask(id, fields, now = Date.now()) {
    const keys = Object.keys(fields).filter((k) => UPDATABLE_FIELDS.includes(k));
    if (keys.length === 0) return this.getTask(id);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const params = keys.map((k) => {
      const v = fields[k];
      return JSON_FIELDS.includes(k) ? JSON.stringify(v ?? []) : v;
    });
    this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...params, now, id);
    return this.getTask(id);
  }

  /**
   * Append-only audit trail (Transactional-Outbox-ish: facts first, notify later).
   * @param {number} taskId @param {string} kind @param {string} actor @param {Record<string, unknown>} payload
   */
  appendEvent(taskId, kind, actor = 'mcp', payload = {}) {
    this.db
      .prepare('INSERT INTO events (task_id, ts, kind, actor, payload) VALUES (?, ?, ?, ?, ?)')
      .run(taskId, Date.now(), kind, actor, JSON.stringify(payload ?? {}));
  }

  /** @param {number} taskId @param {number} limit */
  listEvents(taskId, limit = 10) {
    return this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
      .all(taskId, limit)
      .map((e) => ({ ...e, payload: JSON.parse(e.payload ?? '{}') }));
  }

  /** Status histogram over all tasks. */
  counts() {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all();
    /** @type {Record<string, number>} */
    const counts = {};
    for (const s of ['inbox', 'todo', 'running', 'waiting_decision', 'blocked', 'review', 'done', 'failed', 'cancelled']) {
      counts[s] = 0;
    }
    for (const r of rows) counts[r.status] = Number(r.n);
    return counts;
  }

  /** @param {string[]} statuses */
  listByStatus(statuses, limit = 50) {
    return this.listTasks({ status: statuses, limit });
  }

  // ── ④ 回程绑定：入口会话 ↔ 任务 ────────────────────────────────────────────

  /**
   * Bind a task to the entry session that received it. Re-binding the same pair
   * only bumps `last_seen_at`, so this is safe to call on every message.
   * @param {{entrySessionId: string, taskId: number, now?: number}} binding
   */
  bindEntrySession({ entrySessionId, taskId, now = Date.now() }) {
    this.db
      .prepare(
        `INSERT INTO entry_session_tasks (entry_session_id, task_id, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entry_session_id, task_id)
         DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(entrySessionId, Number(taskId), now, now);
    return { entrySessionId, taskId: Number(taskId), lastSeenAt: now };
  }

  /**
   * Tasks bound to an entry session, newest touch first. This is the "回原会话"
   * lookup: a queued message carries its entry session, the reply goes back there.
   * @param {string} entrySessionId
   * @param {{limit?: number}} [opts]
   */
  listEntryBindings(entrySessionId, opts = {}) {
    const limit = opts.limit ?? 20;
    const rows = this.db
      .prepare(
        `SELECT t.* FROM entry_session_tasks b
         JOIN tasks t ON t.id = b.task_id
         WHERE b.entry_session_id = ?
         ORDER BY b.last_seen_at DESC, t.id DESC
         LIMIT ?`,
      )
      .all(entrySessionId, limit);
    return rows.map(rowToTask);
  }

  // ── 度量埋点：入口回合 ─────────────────────────────────────────────────────

  /** @param {{entrySessionId?: string|null, startedAt: number, firstReplyAt?: number|null,
   *           latencyMs?: number|null, dispatchedTaskId?: number|null, outcome?: string}} turn */
  recordEntryTurn(turn) {
    const info = this.db
      .prepare(
        `INSERT INTO entry_turns (entry_session_id, started_at, first_reply_at, latency_ms, dispatched_task_id, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        turn.entrySessionId ?? null,
        Number(turn.startedAt),
        turn.firstReplyAt ?? null,
        turn.latencyMs ?? null,
        turn.dispatchedTaskId ?? null,
        turn.outcome ?? 'reply',
      );
    return Number(info.lastInsertRowid);
  }

  /** @param {{since?: number|null, limit?: number}} [opts] */
  listEntryTurns(opts = {}) {
    const limit = opts.limit ?? 500;
    if (opts.since != null) {
      return this.db
        .prepare('SELECT * FROM entry_turns WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?')
        .all(Number(opts.since), limit);
    }
    return this.db.prepare('SELECT * FROM entry_turns ORDER BY started_at DESC LIMIT ?').all(limit);
  }

  /** Queue candidates: tasks waiting for a slot. */
  listQueued(limit = 200) {
    return this.db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC, id ASC LIMIT ?')
      .all('todo', limit)
      .map(rowToTask);
  }

  /** Idempotent: safe to call multiple times (e.g. tests + teardown hooks). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Open the task store (read/write), applying pending migrations.
 *
 * Migration is a write. Any caller that promises "read-only" must use
 * `openStoreReadOnly` instead — writing through a read-only CLI is exactly the
 * contradiction that got this flagged in review (2026-11-29).
 *
 * @param {string} dbPath
 * @param {{migrate?: boolean}} [options] migrate:false skips DDL + migrations
 *   (still read/write at the SQLite level — prefer openStoreReadOnly for reads)
 */
export function openStore(dbPath, options = {}) {
  if (typeof DatabaseSync !== 'function') {
    throw new TaskPierError(
      Codes.STORE_ERROR,
      'node:sqlite unavailable — TaskPier core requires Node >= 23.4.0 (unflagged node:sqlite)',
    );
  }
  const runMigrations = options.migrate !== false;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON;');
    if (runMigrations) {
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec(DDL);
      // Base tables exist; now bring schema forward (④ 绑定表 + 度量埋点表).
      migrate(db);
    }
    return new Store(db);
  } catch (err) {
    if (err instanceof TaskPierError) throw err;
    throw new TaskPierError(Codes.STORE_ERROR, `failed to open store at ${dbPath}: ${err.message}`);
  }
}

/**
 * Open the store without the ability to write anything — no DDL, no migrations.
 * @param {string} dbPath
 */
export function openStoreReadOnly(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return new Store(db);
  } catch (err) {
    throw new TaskPierError(Codes.STORE_ERROR, `failed to open store read-only at ${dbPath}: ${err.message}`);
  }
}
