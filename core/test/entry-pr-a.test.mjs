// PR-A：入口闸门 + 账本层排队可见 + 回程绑定 + 心跳 + 度量埋点。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '../src/store.mjs';
import { migrate, currentVersion, LATEST_VERSION } from '../src/migrate.mjs';
import { computeQueue, formatQueueEntry, staleEntries, orderQueue } from '../src/queue.mjs';
import { classifyHeartbeat, STATES, HEARTBEAT } from '../src/heartbeat.mjs';
import { percentile, summarizeTurns, recordTurn } from '../src/metrics.mjs';
import { checkEntryBudget, mustDispatch, ENTRY_BUDGET } from '../../channels/ingress/gate.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vibemission-pr-a-'));
  store = openStore(join(dir, 'tasks.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

// ── 迁移 ────────────────────────────────────────────────────────────────────

test('迁移：新库直接升到最新版本，且表都在', () => {
  assert.equal(currentVersion(store.db), LATEST_VERSION);
  const names = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);
  assert.ok(names.includes('schema_meta'));
  assert.ok(names.includes('entry_session_tasks'));
  assert.ok(names.includes('entry_turns'));
});

test('迁移：同一库重复打开幂等，不会再跑一遍', () => {
  const dbPath = join(dir, 'tasks.sqlite');
  store.close();
  const first = openStore(dbPath);
  const before = currentVersion(first.db);
  first.close();
  const second = openStore(dbPath);
  assert.equal(currentVersion(second.db), before);
  second.close();
  store = openStore(dbPath); // 让 afterEach 能关
});

test('迁移：老库（只有 base 表）升级后可写绑定表，任务数据无损', () => {
  const dbPath = join(dir, 'legacy.sqlite');
  // 手工造一个"旧版"库：只有 tasks 表，没有 schema_meta
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'todo',
    host TEXT, project TEXT, workspace TEXT, session_id TEXT, parent_id INTEGER,
    blocked_reason TEXT, decision_question TEXT, decision_options TEXT DEFAULT '[]',
    artifacts TEXT NOT NULL DEFAULT '[]', evidence TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  raw.prepare('INSERT INTO tasks (title, created_at, updated_at) VALUES (?, ?, ?)').run('老任务', 1, 1);
  raw.close();

  const upgraded = openStore(dbPath);
  try {
    assert.equal(currentVersion(upgraded.db), LATEST_VERSION);
    const task = upgraded.getTask(1);
    assert.equal(task.title, '老任务', '老数据必须原样保留');
    upgraded.bindEntrySession({ entrySessionId: 'sess_old', taskId: 1, now: 10 });
    assert.equal(upgraded.listEntryBindings('sess_old').length, 1);
  } finally {
    upgraded.close();
  }
});

test('迁移：失败时回滚，版本号不前进', () => {
  const dbPath = join(dir, 'fail.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT)');
  assert.throws(
    () =>
      migrate(raw, {
        migrations: [{ version: 1, name: 'boom', up: () => { throw new Error('boom'); } }],
      }),
    /migration 1 \(boom\) failed/,
  );
  assert.equal(currentVersion(raw), 0, '失败后版本必须仍是 0');
  raw.close();
});

// ── ④ 回程绑定 ──────────────────────────────────────────────────────────────

test('回程绑定：同一会话多次绑定只更新时间，不重复插入', () => {
  const a = store.insertTask({ title: '任务 A' });
  store.bindEntrySession({ entrySessionId: 'sess_entry', taskId: a.id, now: 100 });
  store.bindEntrySession({ entrySessionId: 'sess_entry', taskId: a.id, now: 200 });

  const rows = store.listEntryBindings('sess_entry');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, a.id);
});

test('回程绑定：一个入口会话可绑多条任务，按最近触达排序', () => {
  const a = store.insertTask({ title: '任务 A' });
  const b = store.insertTask({ title: '任务 B' });
  store.bindEntrySession({ entrySessionId: 'sess_1', taskId: a.id, now: 100 });
  store.bindEntrySession({ entrySessionId: 'sess_1', taskId: b.id, now: 300 });

  const rows = store.listEntryBindings('sess_1');
  assert.deepEqual(rows.map((t) => t.id), [b.id, a.id]);
});

test('回程绑定：不同群（入口会话）之间互不可见 —— 不串台', () => {
  const a = store.insertTask({ title: 'A 群的任务' });
  const b = store.insertTask({ title: 'B 群的任务' });
  store.bindEntrySession({ entrySessionId: 'oc_groupA', taskId: a.id, now: 100 });
  store.bindEntrySession({ entrySessionId: 'oc_groupB', taskId: b.id, now: 100 });

  assert.deepEqual(store.listEntryBindings('oc_groupA').map((t) => t.id), [a.id]);
  assert.deepEqual(store.listEntryBindings('oc_groupB').map((t) => t.id), [b.id]);
});

test('回程绑定：不存在的任务被外键拒绝（不会产出幽灵绑定）', () => {
  assert.throws(() => store.bindEntrySession({ entrySessionId: 'sess_x', taskId: 9999, now: 1 }));
});

// ── ③ 账本层排队可见 ────────────────────────────────────────────────────────

test('排队：FIFO 按创建时间，同时间按 id', () => {
  const t1 = { id: 3, created_at: 100 };
  const t2 = { id: 1, created_at: 100 };
  const t3 = { id: 2, created_at: 50 };
  assert.deepEqual(orderQueue([t1, t2, t3]).map((t) => t.id), [2, 1, 3]);
});

test('排队：位置、已等时长、ETA 递增', () => {
  const now = 10 * 60_000;
  const entries = computeQueue(
    [
      { id: 1, displayId: 'tp-0001', title: '一', created_at: now - 5 * 60_000 },
      { id: 2, displayId: 'tp-0002', title: '二', created_at: now - 4 * 60_000 },
      { id: 3, displayId: 'tp-0003', title: '三', created_at: now - 3 * 60_000 },
      { id: 4, displayId: 'tp-0004', title: '四', created_at: now - 2 * 60_000 },
    ],
    { limit: 3, turnMs: 90_000, now },
  );

  assert.deepEqual(entries.map((e) => e.position), [1, 2, 3, 4]);
  assert.equal(entries[0].waitedMs, 5 * 60_000);
  assert.equal(entries[0].etaMs, 90_000, '第 1 位只需一轮');
  assert.equal(entries[2].etaMs, 90_000, '前 3 位同一批');
  assert.equal(entries[3].etaMs, 180_000, '第 4 位要等两轮');
});

test('排队：空队列与单条', () => {
  assert.deepEqual(computeQueue([], { now: 0 }), []);
  const one = computeQueue([{ id: 7, displayId: 'tp-0007', title: '单', created_at: 0 }], { now: 1000 });
  assert.equal(one[0].position, 1);
  assert.equal(one[0].etaMs, 90_000);
});

test('排队：文案带位置 / 编号 / 等待 / 预计', () => {
  const line = formatQueueEntry({
    position: 2, displayId: 'tp-0041', title: '支付对账', waitedMs: 3 * 60_000, etaMs: 6 * 60_000,
  });
  assert.match(line, /第 2 位/);
  assert.match(line, /tp-0041 支付对账/);
  assert.match(line, /已等 3 分钟/);
  assert.match(line, /预计 6 分钟内/);
});

test('排队：超过阈值才算需要主动提示', () => {
  const entries = [
    { position: 1, waitedMs: 30_000 },
    { position: 2, waitedMs: 90_000 },
  ];
  assert.deepEqual(staleEntries(entries, { thresholdMs: 60_000 }).map((e) => e.position), [2]);
});

test('排队：store.listQueued 只取 todo，且按创建时间', () => {
  const late = store.insertTask({ title: '后来的' });
  const early = store.insertTask({ title: '先来的' });
  store.updateTask(late.id, { status: 'running' });
  const queued = store.listQueued();
  assert.ok(queued.every((t) => t.status === 'todo'));
});

// ── ⑤ 心跳 ──────────────────────────────────────────────────────────────────

test('心跳：刚开始跑 → healthy，不打扰', () => {
  const r = classifyHeartbeat({ startedAt: 0, now: 30_000 });
  assert.equal(r.state, STATES.HEALTHY);
  assert.equal(r.shouldReport, false);
});

test('心跳：超 20 分钟 → 报进度，且同一 step 只报一次', () => {
  const base = { startedAt: 0, lastBeatAt: 20 * 60_000, now: 21 * 60_000, step: 3, totalSteps: 8 };
  const first = classifyHeartbeat(base);
  assert.equal(first.state, STATES.OVERDUE);
  assert.equal(first.shouldReport, true);
  assert.match(first.report, /当前到第 3\/8 步/);

  const again = classifyHeartbeat({ ...base, lastReportedStep: 3 });
  assert.equal(again.shouldReport, false, '同一步不重复打扰');
});

test('心跳：60 秒无心跳 → 判失联，转 failed', () => {
  const r = classifyHeartbeat({ startedAt: 0, lastBeatAt: 10_000, now: 10_000 + HEARTBEAT.lostAfterMs + 1 });
  assert.equal(r.state, STATES.LOST);
  assert.equal(r.shouldReport, true);
  assert.match(r.report, /判定失联/);
});

test('心跳：失联优先于进度汇报', () => {
  const r = classifyHeartbeat({
    startedAt: 0, lastBeatAt: 30 * 60_000, now: 40 * 60_000, step: 2,
  });
  assert.equal(r.state, STATES.LOST, '失联时不再发"还在跑"');
});

test('心跳：阈值可注入', () => {
  const r = classifyHeartbeat({ startedAt: 0, now: 5_000, lostAfterMs: 1_000 });
  assert.equal(r.state, STATES.LOST);
});

// ── 度量埋点 ────────────────────────────────────────────────────────────────

test('度量：percentile 取最近秩', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile([], 0.95), null);
});

test('度量：recordTurn 由时间戳推延迟，汇总出 P50/P95 与达标率', () => {
  recordTurn(store, { entrySessionId: 's1', startedAt: 0, firstReplyAt: 1000 });
  recordTurn(store, { entrySessionId: 's1', startedAt: 10_000, firstReplyAt: 12_000 });
  recordTurn(store, { entrySessionId: 's1', startedAt: 20_000, firstReplyAt: 25_000 });
  recordTurn(store, { entrySessionId: 's1', startedAt: 30_000, dispatchedTaskId: 7, outcome: 'dispatch' });

  const rows = store.listEntryTurns();
  assert.equal(rows.length, 4);

  const m = summarizeTurns(rows);
  assert.equal(m.count, 4);
  assert.equal(m.measured, 3, '没有首条回复的回合不计入延迟样本');
  assert.equal(m.p50, 2000);
  assert.equal(m.p95, 5000);
  assert.equal(m.dispatched, 1);
  assert.equal(m.withinBudget, 2 / 3, '1000/2000 达标，5000 超预算');
});

test('度量：预算与闸门同源（避免两处阈值漂移）', () => {
  assert.equal(ENTRY_BUDGET.maxDurationMs, 3000);
  const m = summarizeTurns([{ latency_ms: 2999, outcome: 'reply' }], { budgetMs: ENTRY_BUDGET.maxDurationMs });
  assert.equal(m.withinBudget, 1);
});

// ── ① 派工闸门 ──────────────────────────────────────────────────────────────

test('闸门：3 秒内且 1 次工具调用以内 → 允许入口内完成', () => {
  const r = checkEntryBudget({ action: 'short-reply', estimatedMs: 800, toolCalls: 1 });
  assert.equal(r.allowed, true);
  assert.equal(r.action, 'local');
});

test('闸门：超 3 秒 → 强制派工', () => {
  const r = checkEntryBudget({ action: 'dispatch', estimatedMs: 3001, toolCalls: 1 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /3001ms > 3000ms/);
});

test('闸门：超 1 次工具调用 → 强制派工', () => {
  assert.equal(mustDispatch({ action: 'register-task', estimatedMs: 500, toolCalls: 2 }), true);
});

test('闸门：白名单外动作一律派工（禁止「先试试看」）', () => {
  const r = checkEntryBudget({ action: 'run-build', estimatedMs: 100, toolCalls: 0 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /不在入口白名单内/);
});
