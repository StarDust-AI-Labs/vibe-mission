// WorkBuddy adapter reconcile tests — fixture-based, no real ~/.workbuddy
// touched. Builds a fake workbuddy.db (sessions/automations), fake tasks/*/1.json
// and a TaskPier store, then asserts the drift report (merge decision D3:
// report-only, never writes either side).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../../../core/src/store.mjs';
import {
  reconcile, translateStatus, readTaskFiles, evidenceVersion,
} from '../reconcile/observer.mjs';

let dir;
let store;

function buildWorkBuddyDb(dbPath, sessions) {
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (id INTEGER PRIMARY KEY, cwd TEXT, title TEXT, status TEXT, expert_id TEXT, updated_at INTEGER)');
  db.exec('CREATE TABLE automations (id INTEGER PRIMARY KEY, name TEXT, expert_id TEXT, skills_json TEXT, model_id TEXT, status TEXT)');
  for (const [i, s] of sessions.entries()) {
    db.prepare('INSERT INTO sessions (id,cwd,title,status,expert_id,updated_at) VALUES (?,?,?,?,?,?)')
      .run(i + 1, s.cwd ?? null, s.title, s.status ?? 'active', s.expert_id ?? null, 1795400000000);
  }
  db.prepare("INSERT INTO automations (id,name,expert_id,skills_json,model_id,status) VALUES (1,'daily','ex_a','[]','m1','on')").run();
  db.close();
}

function writeTaskFile(tasksDir, id, obj) {
  mkdirSync(join(tasksDir, id), { recursive: true });
  writeFileSync(join(tasksDir, id, '1.json'), JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-wb-reconcile-'));
  store = openStore(join(dir, 'tasks.sqlite'));
});

afterEach(async () => {
  store.close();
  // Windows: let sqlite release file handles before removing the temp dir.
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); }
  catch { /* never fail the test on temp cleanup */ }
});

test('translateStatus maps WorkBuddy vocabulary to core statuses', () => {
  assert.equal(translateStatus('queued'), 'todo');
  assert.equal(translateStatus('awaiting_user'), 'waiting_decision');
  assert.equal(translateStatus('Processing'), 'running');
  assert.equal(translateStatus('completed'), 'done');
  assert.equal(translateStatus('weird-new-status'), 'weird-new-status'); // unknown passes through
  assert.equal(translateStatus(null), null);
});

test('running task with no host-side evidence shows up as drift', () => {
  const dbPath = join(dir, 'workbuddy.db');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir);
  buildWorkBuddyDb(dbPath, [{ title: '完全无关的会话', cwd: 'D:/x' }]);

  store.insertTask({ title: '给老张写周报', keywords: ['周报'], status: 'running' });
  store.insertTask({ title: '收拾桌面', keywords: [], status: 'todo' }); // todo 不参与 drift

  const report = reconcile({ workbuddy: { dbPath, tasksDir } }, store);
  assert.equal(report.dbOk, true);
  assert.equal(report.sessions, 1);
  assert.equal(report.automations, 1);
  assert.equal(report.drift.length, 1);
  assert.equal(report.drift[0].title, '给老张写周报');
  assert.match(report.drift[0].reason, /no matching/i);
  assert.equal(report.counts.running, 1);
});

test('unregistered host activity is reported, registered ones are not', () => {
  const dbPath = join(dir, 'workbuddy.db');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir);
  buildWorkBuddyDb(dbPath, []);
  writeTaskFile(tasksDir, 'T001', { title: '剪辑婚礼视频', status: 'processing' }); // → running, 未登记
  writeTaskFile(tasksDir, 'T002', { title: '整理素材库', status: 'done' });        // 非活跃，不报
  store.insertTask({ title: '剪辑婚礼视频', keywords: ['婚礼'], status: 'running' }); // 已登记

  const report = reconcile({ workbuddy: { dbPath, tasksDir } }, store);
  assert.equal(report.taskFiles, 2);
  assert.equal(report.unregistered.length, 0); // T001 已在库中登记
  assert.equal(report.drift.length, 0);        // running 有文件证据
});

test('unregistered detection fires for host-only activity', () => {
  const dbPath = join(dir, 'workbuddy.db');
  const tasksDir = join(dir, 'tasks');
  mkdirSync(tasksDir);
  buildWorkBuddyDb(dbPath, []);
  writeTaskFile(tasksDir, 'T003', { title: '处理报销单', status: 'awaiting_user' }); // 库里没有

  const report = reconcile({ workbuddy: { dbPath, tasksDir } }, store);
  assert.equal(report.unregistered.length, 1);
  assert.equal(report.unregistered[0].title, '处理报销单');
  assert.equal(report.unregistered[0].translated, 'waiting_decision');
});

test('missing workbuddy.db degrades to unavailable, never throws', () => {
  const report = reconcile(
    { workbuddy: { dbPath: join(dir, 'nope.db'), tasksDir: join(dir, 'nope-tasks') } },
    store,
  );
  assert.equal(report.dbOk, false);
  assert.equal(report.unavailable.length, 1);
  assert.match(report.unavailable[0], /workbuddy\.db/);
  assert.equal(report.taskFiles, 0);
  assert.equal(report.evidence_ver, 'na:na');
});

test('readTaskFiles skips broken json and missing dirs', () => {
  assert.deepEqual(readTaskFiles(join(dir, 'nope')), []);
  const tasksDir = join(dir, 't2');
  mkdirSync(join(tasksDir, 'ok'), { recursive: true });
  writeFileSync(join(tasksDir, 'ok', '1.json'), '{broken json');
  assert.equal(readTaskFiles(tasksDir).length, 0);
});

test('evidenceVersion fingerprints both sources', () => {
  const dbPath = join(dir, 'wb.db');
  const tasksDir = join(dir, 'tt');
  mkdirSync(tasksDir);
  mkdirSync(join(tasksDir, 'a'));
  const v1 = evidenceVersion(dbPath, tasksDir);
  assert.match(v1, /^na:1$/);
});
