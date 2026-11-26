import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { buildTools } from '../src/tools.mjs';
import { TaskPierError } from '../src/errors.mjs';

let dir;
let store;
let tools;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-tools-'));
  store = openStore(join(dir, 'tasks.sqlite'));
  tools = buildTools(store);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('six tools registered with schemas', () => {
  const names = tools.toolDefs.map((d) => d.name);
  assert.deepEqual(names, [
    'task_create', 'task_update', 'task_query', 'task_list', 'board_summary', 'decision_answer',
  ]);
  for (const d of tools.toolDefs) {
    assert.equal(d.inputSchema.type, 'object');
    assert.equal(d.inputSchema.additionalProperties, false);
  }
});

test('task_create → todo; full lifecycle to done via review', () => {
  const { task } = tools.handlers.task_create({ title: 'fix bug', keywords: ['首页'] });
  assert.equal(task.status, 'todo');

  tools.handlers.task_update({ id: task.id, status: 'running' });
  tools.handlers.task_update({ id: task.id, status: 'review', evidence: ['pr#1'] });
  const { task: done, transition } = tools.handlers.task_update({
    id: task.id, status: 'done', actor: 'user',
  });
  assert.equal(done.status, 'done');
  assert.deepEqual(transition, { from: 'review', to: 'done', alert: false });

  const { events } = tools.handlers.task_query({ id: task.id });
  const kinds = events.map((e) => e.kind).reverse();
  // review 带了 evidence 字段 → 该次迁移额外产生一条 field_update
  assert.deepEqual(kinds, ['create', 'status_change', 'status_change', 'field_update', 'status_change']);
});

test('todo → done is illegal (acceptance gate)', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  assert.throws(
    () => tools.handlers.task_update({ id: task.id, status: 'done' }),
    (e) => e instanceof TaskPierError && e.code === 'illegal_transition',
  );
});

test('blocked without reason rejected; with reason ok and alert flag set', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  tools.handlers.task_update({ id: task.id, status: 'running' });
  assert.throws(
    () => tools.handlers.task_update({ id: task.id, status: 'blocked' }),
    (e) => e.code === 'missing_guard_field',
  );
  const { transition } = tools.handlers.task_update({
    id: task.id, status: 'blocked', blocked_reason: 'needs DB creds',
  });
  assert.deepEqual(transition, { from: 'running', to: 'blocked', alert: true });
});

test('waiting_decision requires question+options; decision_answer resumes or cancels', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  tools.handlers.task_update({ id: task.id, status: 'running' });
  assert.throws(
    () => tools.handlers.task_update({
      id: task.id, status: 'waiting_decision', decision_question: 'A or B?',
    }),
    (e) => e.code === 'missing_guard_field',
  );
  const { task: waiting } = tools.handlers.task_update({
    id: task.id,
    status: 'waiting_decision',
    decision_question: 'A or B?',
    decision_options: ['A', 'B'],
  });
  assert.equal(waiting.status, 'waiting_decision');

  const resumed = tools.handlers.decision_answer({ id: task.id, answer: 'A', actor: 'user' });
  assert.equal(resumed.task.status, 'running');
  assert.equal(resumed.transition.alert, false);

  // cycle again and abort this time
  tools.handlers.task_update({
    id: task.id, status: 'waiting_decision', decision_question: 'C or D?', decision_options: ['C', 'D'],
  });
  const aborted = tools.handlers.decision_answer({ id: task.id, answer: '不做了', action: 'abort' });
  assert.equal(aborted.task.status, 'cancelled');

  // terminal now
  assert.throws(
    () => tools.handlers.task_update({ id: task.id, status: 'running' }),
    (e) => e.code === 'terminal_task',
  );
});

test('decision_answer on non-waiting task rejected', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  assert.throws(
    () => tools.handlers.decision_answer({ id: task.id, answer: 'x' }),
    (e) => e.code === 'invalid_input',
  );
});

test('id formats: tp-N, tp-0NNN, #N, #0NNN and N all work; unknown id → task_not_found', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  const padded = `tp-${String(task.id).padStart(4, '0')}`;
  for (const ref of [`tp-${task.id}`, padded, `#${task.id}`, `#${String(task.id).padStart(4, '0')}`, task.id, String(task.id)]) {
    const got = tools.handlers.task_query({ id: ref });
    assert.equal(got.task.id, task.id, `ref ${ref}`);
    assert.equal(got.task.displayId, padded);
  }
  assert.throws(
    () => tools.handlers.task_query({ id: 'tp-99999' }),
    (e) => e.code === 'task_not_found',
  );
  assert.throws(() => tools.handlers.task_query({ id: 'bogus' }), (e) => e.code === 'invalid_input');
});

test('title is a one-line name: trimmed, blank rejected, 80-char cap', () => {
  const { task } = tools.handlers.task_create({ title: '  修复分享页手机字号  ' });
  assert.equal(task.title, '修复分享页手机字号'); // trimmed

  assert.throws(
    () => tools.handlers.task_create({ title: '   ' }),
    (e) => e.code === 'invalid_input',
  );
  assert.throws(
    () => tools.handlers.task_create({ title: 'x'.repeat(81) }),
    (e) => e.code === 'invalid_input',
  );
  const ok = tools.handlers.task_create({ title: 'x'.repeat(80) });
  assert.equal(ok.task.title.length, 80);

  // same rules on update
  assert.throws(
    () => tools.handlers.task_update({ id: task.id, title: '   ' }),
    (e) => e.code === 'invalid_input',
  );
  assert.throws(
    () => tools.handlers.task_update({ id: task.id, title: 'y'.repeat(81) }),
    (e) => e.code === 'invalid_input',
  );
  const renamed = tools.handlers.task_update({ id: task.id, title: ' 放大分享页正文手机字号 ' });
  assert.equal(renamed.task.title, '放大分享页正文手机字号');
});

test('title rename records from→to provenance in field_update event', () => {
  const { task } = tools.handlers.task_create({ title: '旧名字' });
  tools.handlers.task_update({ id: task.id, title: '新名字', actor: 'user' });
  const { events } = tools.handlers.task_query({ id: task.id });
  const rename = events.find((e) => e.kind === 'field_update' && e.payload.fields.includes('title'));
  assert.ok(rename, 'title field_update event exists');
  assert.equal(rename.payload.from, '旧名字');
  assert.equal(rename.payload.to, '新名字');
  assert.equal(rename.actor, 'user');
});

test('board_summary counts and highlights', () => {
  const { task: t1 } = tools.handlers.task_create({ title: 'run me' });
  tools.handlers.task_update({ id: t1.id, status: 'running' });
  tools.handlers.task_update({
    id: t1.id, status: 'waiting_decision', decision_question: 'style?', decision_options: ['dark'],
  });
  const { task: t2 } = tools.handlers.task_create({ title: 'blocked one' });
  tools.handlers.task_update({ id: t2.id, status: 'running' });
  tools.handlers.task_update({ id: t2.id, status: 'blocked', blocked_reason: 'no creds' });

  const board = tools.handlers.board_summary();
  assert.equal(board.counts.waiting_decision, 1);
  assert.equal(board.counts.blocked, 1);
  assert.equal(board.needs_attention, 2);
  assert.equal(board.highlights.waiting_decision[0].decision_question, 'style?');
  assert.equal(board.highlights.blocked[0].blocked_reason, 'no creds');
});

test('field-only update (no status) writes field_update event, no transition', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  const { transition } = tools.handlers.task_update({ id: task.id, keywords: ['kw1'] });
  assert.equal(transition, null);
  const { events } = tools.handlers.task_query({ id: task.id });
  assert.equal(events[0].kind, 'field_update');
});

test('parent task must exist', () => {
  assert.throws(
    () => tools.handlers.task_create({ title: 'child', parent_id: 'tp-424242' }),
    (e) => e.code === 'task_not_found',
  );
  const { task: parent } = tools.handlers.task_create({ title: 'parent' });
  const { task: child } = tools.handlers.task_create({ title: 'child', parent_id: parent.id });
  assert.equal(child.parentId, parent.id);
});

test('empty update rejected', () => {
  const { task } = tools.handlers.task_create({ title: 'x' });
  assert.throws(
    () => tools.handlers.task_update({ id: task.id }),
    (e) => e.code === 'invalid_input',
  );
});
