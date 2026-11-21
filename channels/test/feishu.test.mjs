import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../core/src/store.mjs';
import { buildTools } from '../../core/src/tools.mjs';
import { collect } from '../feishu/notify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let dir;
let store;
let tools;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-feishu-'));
  store = openStore(join(dir, 'tasks.sqlite'));
  tools = buildTools(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
});

test('collect: only three alert statuses; dedup via alert_sent within window', () => {
  const { task: d } = tools.handlers.task_create({ title: '决策任务' });
  tools.handlers.task_update({ id: d.id, status: 'running' });
  tools.handlers.task_update({
    id: d.id, status: 'waiting_decision', decision_question: 'A or B?', decision_options: ['A', 'B'],
  });
  const { task: b } = tools.handlers.task_create({ title: '阻塞任务' });
  tools.handlers.task_update({ id: b.id, status: 'running' });
  tools.handlers.task_update({ id: b.id, status: 'blocked', blocked_reason: 'no creds' });
  const { task: ok } = tools.handlers.task_create({ title: '普通任务' });
  tools.handlers.task_update({ id: ok.id, status: 'running' }); // 不该被推

  let { pushed, skipped } = collect(store, { windowMin: 10 });
  assert.equal(pushed.length, 2);
  assert.equal(skipped.length, 0);
  const msgs = pushed.map((p) => p.message);
  assert.ok(msgs.some((m) => m.includes('待你拍板') && m.includes('A / B')));
  assert.ok(msgs.some((m) => m.includes('阻塞') && m.includes('no creds')));
  assert.ok(!msgs.some((m) => m.includes('普通任务')));

  // 记录 alert_sent 后：窗口内去重
  for (const p of pushed) store.appendEvent(p.task.id, 'alert_sent', 'channel:feishu', {});
  ({ pushed, skipped } = collect(store, { windowMin: 10 }));
  assert.equal(pushed.length, 0);
  assert.equal(skipped.length, 2);

  // force 越过窗口
  ({ pushed } = collect(store, { windowMin: 10, force: true }));
  assert.equal(pushed.length, 2);
});

test('--print renders without contacting lark-cli', async () => {
  const { task: d } = tools.handlers.task_create({ title: '待验收任务', keywords: ['x'] });
  tools.handlers.task_update({ id: d.id, status: 'running' });
  tools.handlers.task_update({ id: d.id, status: 'review' });
  const dbPath = join(dir, 'tasks.sqlite');
  store.close();

  const child = spawn(process.execPath, [join(HERE, '..', 'feishu', 'notify.mjs'), '--db', dbPath, '--print']);
  const stdout = await new Promise((resolve, reject) => {
    let b = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => (b += c));
    child.once('exit', (code) => (code === 0 ? resolve(b) : reject(new Error(`exit ${code}`))));
  });
  const out = JSON.parse(stdout);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].displayId, `tp-${d.id}`);
  assert.ok(out.messages[0].message.includes('已完成，等验收'));
  assert.ok(out.messages[0].message.includes(`通过 ${d.displayId}`));
});
