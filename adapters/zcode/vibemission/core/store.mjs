// TaskPier core — persistence layer (node:sqlite, WAL).
// Raw CRUD + append-only events. No status logic here (that lives in
// state-machine.mjs); no MCP concepts here (that lives in tools.mjs).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TaskPierError, Codes } from './errors.mjs';
import { formatDisplayId } from './format.mjs';

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

  /** Idempotent: safe to call multiple times (e.g. tests + teardown hooks). */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/**
 * Open (and migrate) the task store.
 * @param {string} dbPath
 */
export function openStore(dbPath) {
  if (typeof DatabaseSync !== 'function') {
    throw new TaskPierError(
      Codes.STORE_ERROR,
      'node:sqlite unavailable — TaskPier core requires Node >= 23.4.0 (unflagged node:sqlite)',
    );
  }
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(DDL);
    return new Store(db);
  } catch (err) {
    if (err instanceof TaskPierError) throw err;
    throw new TaskPierError(Codes.STORE_ERROR, `failed to open store at ${dbPath}: ${err.message}`);
  }
}
