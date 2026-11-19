import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, assertTransition, assertGuards, isAlertStatus } from '../src/state-machine.mjs';
import { TaskPierError } from '../src/errors.mjs';

test('legal transitions from the table', () => {
  assert.equal(canTransition('inbox', 'todo'), true);
  assert.equal(canTransition('todo', 'running'), true);
  assert.equal(canTransition('running', 'review'), true);
  assert.equal(canTransition('running', 'blocked'), true);
  assert.equal(canTransition('blocked', 'running'), true);
  assert.equal(canTransition('review', 'done'), true);
  assert.equal(canTransition('review', 'running'), true); // 打回
  assert.equal(canTransition('waiting_decision', 'running'), true);
});

test('illegal transitions rejected', () => {
  assert.equal(canTransition('todo', 'done'), false);          // 必须经 review 验收
  assert.equal(canTransition('done', 'running'), false);       // 终态不可复活
  assert.equal(canTransition('cancelled', 'todo'), false);
  assert.equal(canTransition('inbox', 'done'), false);
  assert.throws(() => assertTransition('done', 'running'), TaskPierError);
});

test('unknown status rejected with INVALID_INPUT', () => {
  assert.throws(() => assertTransition('todo', 'flying'), (e) => {
    assert.ok(e instanceof TaskPierError);
    assert.equal(e.code, 'invalid_input');
    return true;
  });
});

test('guards: blocked requires blocked_reason', () => {
  assert.throws(() => assertGuards('blocked', {}), (e) => {
    assert.equal(e.code, 'missing_guard_field');
    assert.equal(e.data.field, 'blocked_reason');
    return true;
  });
  assertGuards('blocked', { blocked_reason: 'waiting for DB credentials' }); // no throw
  assert.throws(() => assertGuards('blocked', { blocked_reason: '   ' }), TaskPierError);
});

test('guards: waiting_decision requires question + options', () => {
  assert.throws(() => assertGuards('waiting_decision', { decision_question: '选 A 还是 B' }), TaskPierError);
  assert.throws(
    () => assertGuards('waiting_decision', { decision_question: 'q', decision_options: [] }),
    TaskPierError,
  );
  assertGuards('waiting_decision', { decision_question: 'q', decision_options: ['A', 'B'] }); // no throw
});

test('alert statuses are exactly the three push states', () => {
  assert.equal(isAlertStatus('waiting_decision'), true);
  assert.equal(isAlertStatus('blocked'), true);
  assert.equal(isAlertStatus('review'), true);
  assert.equal(isAlertStatus('running'), false);
  assert.equal(isAlertStatus('done'), false);
});
