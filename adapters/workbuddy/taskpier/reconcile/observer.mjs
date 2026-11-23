// TaskPier WorkBuddy adapter — reconcile observer (migrated from the foreman
// prototype D:\foreman-agent\src/observer.mjs, 2026-11-23 merge decision D1/D3).
//
// Read-only evidence collector + drift report between the WorkBuddy host
// (workbuddy.db sessions/automations + tasks/*/1.json) and the TaskPier store
// of THIS deployment. The board of truth is the TaskPier store; this script
// never writes either side — it reports, the owner (skill) decides.
//
// Status translation (ACL): WorkBuddy-side vocabulary → core's unified
// language. Only the mapping table below knows WorkBuddy words.
//
// CLI: node observer.mjs [--config <workbuddy.json>]
//   config: --config flag > TASKPIER_WORKBUDDY_CONFIG env > ../config/workbuddy.json
//   TaskPier store: core dbpath chain (--db flag here > TASKPIER_DB_PATH env >
//   ~/.agents/mcp.json taskpier env > fallbacks) — install.mjs pins the
//   deployment store via TASKPIER_DB_PATH, so hook/server/observer all agree.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDbPath } from '../../../../core/src/dbpath.mjs';
import { openStore } from '../../../../core/src/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** WorkBuddy-side status words → core statuses (unknown words pass through). */
const STATUS_MAP = new Map([
  ['queued', 'todo'],
  ['pending', 'running'],
  ['processing', 'running'],
  ['in_progress', 'running'],
  ['awaiting_user', 'waiting_decision'],
  ['done', 'done'],
  ['success', 'done'],
  ['completed', 'done'],
  ['error', 'failed'],
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
]);

export function translateStatus(workbuddyStatus) {
  if (typeof workbuddyStatus !== 'string') return null;
  return STATUS_MAP.get(workbuddyStatus.toLowerCase()) ?? workbuddyStatus.toLowerCase();
}

/** Read-only open of the WorkBuddy main db; throws to the caller (§15 degrade). */
export function openWorkBuddyDb(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`workbuddy.db not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return db;
}

export function readSessions(db) {
  try {
    return db.prepare('SELECT id,cwd,title,status,expert_id,updated_at FROM sessions ORDER BY updated_at DESC LIMIT 200').all();
  } catch { return []; }
}

export function readAutomations(db) {
  try {
    return db.prepare('SELECT id,name,expert_id,skills_json,model_id,status FROM automations').all();
  } catch {
    try { return db.prepare('SELECT expert_id,skills_json,model_id,status FROM automations').all(); }
    catch { return []; }
  }
}

/** Walk <tasksDir>/<id>/1.json read-only. Internal format — may break on host upgrades. */
export function readTaskFiles(tasksDir) {
  if (!existsSync(tasksDir)) return [];
  const out = [];
  for (const dir of readdirSync(tasksDir)) {
    const p = join(tasksDir, dir, '1.json');
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8'));
      out.push({
        id: dir,
        title: raw.title ?? raw.subject ?? raw.name ?? null,
        status: raw.status ?? null,
        cwd: raw.cwd ?? raw.workspace ?? null,
        updated_at: raw.updated_at ?? raw.updatedAt ?? null,
      });
    } catch { /* single broken file must not sink the report */ }
  }
  return out;
}

/** Cheap fingerprint of the evidence sources, to detect "evidence moved" between runs. */
export function evidenceVersion(dbPath, tasksDir) {
  const parts = [];
  try { parts.push(statSync(dbPath).mtimeMs.toFixed(0)); } catch { parts.push('na'); }
  try { parts.push(String(readdirSync(tasksDir).length)); } catch { parts.push('na'); }
  return parts.join(':');
}

function loadConfig() {
  const argv = process.argv.slice(2);
  const flagIdx = argv.indexOf('--config');
  const p = (flagIdx !== -1 && argv[flagIdx + 1])
    ? argv[flagIdx + 1]
    : process.env.TASKPIER_WORKBUDDY_CONFIG ?? join(HERE, '..', 'config', 'workbuddy.json');
  const abs = resolve(p);
  if (!existsSync(abs)) throw new Error(`config not found: ${abs}`);
  return JSON.parse(readFileSync(abs, 'utf8'));
}

/**
 * Reconcile this TaskPier deployment's store against WorkBuddy-side evidence.
 * Report-only: no auto-repair, no auto-`done` (skill: 工具回执 ≠ 业务事实).
 * @param {{workbuddy: {dbPath: string, tasksDir: string}}} cfg
 * @param {import('../../../../core/src/store.mjs').Store} store
 */
export function reconcile(cfg, store) {
  const report = { at: Date.now(), dbOk: false, sessions: 0, automations: 0, taskFiles: 0, drift: [], unregistered: [], unavailable: [] };

  let db;
  try { db = openWorkBuddyDb(cfg.workbuddy.dbPath); report.dbOk = true; }
  catch (e) { report.unavailable.push(`workbuddy.db: ${e.message}`); }

  let sessions = [];
  if (db) {
    try {
      sessions = readSessions(db);
      report.sessions = sessions.length;
      report.automations = readAutomations(db).length;
    } catch (e) { report.unavailable.push(`query: ${e.message}`); }
    finally { db.close(); }
  }

  const files = readTaskFiles(cfg.workbuddy.tasksDir);
  report.taskFiles = files.length;
  report.evidence_ver = evidenceVersion(cfg.workbuddy.dbPath, cfg.workbuddy.tasksDir);
  report.counts = store.counts();

  // Side A: TaskPier says active — is there any WorkBuddy-side evidence?
  const active = store.listByStatus(['todo', 'running', 'waiting_decision', 'blocked'], 200);
  for (const t of active) {
    const sessionHit = sessions.some(s => s.title && t.title && s.title.includes(t.title));
    const fileHit = files.some(f => f.title && t.title && (f.title.includes(t.title) || t.title.includes(f.title)));
    if (t.status === 'running' && !sessionHit && !fileHit) {
      report.drift.push({ displayId: t.displayId, title: t.title, status: t.status, reason: 'running but no matching WorkBuddy session/task evidence' });
    }
  }

  // Side B: WorkBuddy has activity TaskPier never registered.
  const knownTitles = new Set(active.map(t => t.title));
  for (const f of files) {
    if (!f.title) continue;
    const translated = translateStatus(f.status);
    const isActiveish = translated === 'running' || translated === 'waiting_decision';
    const known = [...knownTitles].some(k => k.includes(f.title) || f.title.includes(k));
    if (isActiveish && !known) {
      report.unregistered.push({ title: f.title, status: f.status, translated });
    }
  }

  return report;
}

export function main() {
  const cfg = loadConfig();
  const store = openStore(resolveDbPath(process.argv.slice(2)));
  try {
    process.stdout.write(`${JSON.stringify(reconcile(cfg, store), null, 2)}\n`);
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
