// 入口与执行分离：四档验收的可测部分（docs/entry-execution-split.md）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusyQueue, chooseBusyMode, MODES, PHASES, DEFAULTS } from '../ingress/queue.mjs';
import { checkEntryBudget, mustDispatch, ENTRY_BUDGET } from '../ingress/gate.mjs';

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('验收2：连发 5 条，0 条丢失、0 条「正忙」', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now });
  q.beginTurn('#39 支付对账');

  const admitted = [];
  for (let i = 1; i <= 5; i++) {
    const r = q.admit({ messageId: `m${i}`, chatId: 'oc_a', senderId: 'u1', text: `第 ${i} 句话` });
    admitted.push(r);
  }

  assert.equal(admitted.length, 5, '5 条都必须被接受');
  for (const r of admitted) {
    assert.equal(r.accepted, true, `${r.messageId} 未被接受`);
    assert.ok(!/正忙|busy/i.test(r.text ?? ''), '绝不能产生「正忙」回复');
    assert.ok([MODES.QUEUE, MODES.STEER, MODES.INTERRUPT].includes(r.mode));
  }
  // 执行中收到的都进队列，一条不少
  assert.equal(q.queued.length, 5);
});

test('验收2：空闲时首条直接起轮，不排队', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now });
  const r = q.admit({ messageId: 'm1', chatId: 'oc_a', text: '做掉这件事' });
  assert.equal(r.delivered, 'new-turn');
  assert.equal(q.queued.length, 0);
});

test('三档语义：派工中 steer / 执行中 queue / 喊停 interrupt', () => {
  assert.equal(chooseBusyMode({ text: '把颜色改深一点', phase: PHASES.DISPATCH }).mode, MODES.STEER);
  assert.equal(chooseBusyMode({ text: '把颜色改深一点', phase: PHASES.EXECUTE }).mode, MODES.QUEUE);
  assert.equal(chooseBusyMode({ text: '停掉这个任务', phase: PHASES.EXECUTE }).mode, MODES.INTERRUPT);
});

test('压缩进行中：steer / interrupt 降级为 queue', () => {
  const steer = chooseBusyMode({ text: '改一下', phase: PHASES.DISPATCH, compressInProgress: true });
  assert.equal(steer.mode, MODES.QUEUE);
  assert.equal(steer.degradedFrom, MODES.STEER);

  const stop = chooseBusyMode({ text: '停掉', compressInProgress: true });
  assert.equal(stop.mode, MODES.QUEUE);
  assert.equal(stop.degradedFrom, MODES.INTERRUPT);
});

test('steer 在原子动作之后被取走，不进主队列', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now });
  q.beginTurn('派工中');
  q.admit({ messageId: 'm1', chatId: 'oc_a', text: '顺便把标题也改短', phase: PHASES.DISPATCH });

  assert.equal(q.queued.length, 0);
  const steered = q.takeSteer();
  assert.equal(steered.length, 1);
  assert.equal(steered[0].messageId, 'm1');
});

test('验收3：30 分钟重任务期间，入口仍能接消息并给出排队位置', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now });
  q.beginTurn('#41 支付对账与超时关单');

  c.advance(30 * 60_000); // 重活跑了 30 分钟

  const r = q.admit({ messageId: 'ask', chatId: 'oc_a', text: '现在什么情况' });
  assert.equal(r.accepted, true);
  assert.equal(r.mode, MODES.QUEUE);
  assert.equal(r.position, 1, '重任务期间新消息照样入队，且位置可知');
});

test('验收4：排队消息结束自动出队，且保留回程绑定（不串群）', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now });
  q.beginTurn('#39');

  q.admit({ messageId: 'm1', chatId: 'oc_groupA', senderId: 'u1', threadId: 't1', text: 'A 群的话' });
  q.admit({ messageId: 'm2', chatId: 'oc_groupB', senderId: 'u2', threadId: 't2', text: 'B 群的话' });

  const next = q.endTurn();
  assert.equal(next.messageId, 'm1');
  assert.equal(next.chatId, 'oc_groupA', '必须回到原会话');
  assert.equal(next.senderId, 'u1');

  const after = q.endTurn();
  assert.equal(after.chatId, 'oc_groupB', 'B 群不能串到 A 群');
});

test('验收4：队列为空时 endTurn 不制造空轮', () => {
  const q = new BusyQueue();
  q.beginTurn('#39');
  assert.equal(q.endTurn(), null);
  assert.equal(q.isRunning(), false);
});

test('验收3：队列可见性带序号 / 入队时间 / 预计触发点', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now, turnEstimateMs: 60_000 });
  q.beginTurn('#39');
  q.admit({ messageId: 'm1', chatId: 'oc_a', text: 'x' });
  c.advance(10_000);
  q.admit({ messageId: 'm2', chatId: 'oc_a', text: 'y' });

  const v = q.visibility();
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.position), [1, 2]);
  assert.equal(v[0].enteredAt, c.now() - 10_000);
  assert.ok(v[0].etaMs > 0);
  assert.ok(v[1].etaMs > v[0].etaMs, '位置越后预计越晚');
});

test('③ 超 60 秒未处理：主动说明排第几，且只提醒一次', () => {
  const c = clock();
  const q = new BusyQueue({ now: c.now, escalateAfterMs: 60_000 });
  q.beginTurn('tp-0041 支付对账');
  q.admit({ messageId: 'm1', chatId: 'oc_a', text: '在吗' });

  assert.equal(q.escalations().length, 0, '未到 60 秒不打扰');

  c.advance(DEFAULTS.escalateAfterMs + 1);
  const first = q.escalations();
  assert.equal(first.length, 1);
  assert.match(first[0].text, /还在等 tp-0041 支付对账 结束/);
  assert.match(first[0].text, /排第 1/);
  assert.match(first[0].text, /预计 \d+ 分钟内处理/);
  assert.equal(first[0].chatId, 'oc_a', '提示要回到原会话');

  assert.equal(q.escalations().length, 0, '同一位置不重复打扰');
});

test('① 闸门：超 3 秒或超 1 次工具调用一律派出去', () => {
  assert.equal(checkEntryBudget({ action: 'short-reply', estimatedMs: 200, toolCalls: 0 }).action, 'local');
  assert.equal(checkEntryBudget({ action: 'dispatch', estimatedMs: 15_000, toolCalls: 0 }).action, 'dispatch');
  assert.equal(checkEntryBudget({ action: 'register-task', estimatedMs: 500, toolCalls: 3 }).action, 'dispatch');
  assert.equal(ENTRY_BUDGET.maxDurationMs, 3000);
  assert.equal(ENTRY_BUDGET.maxToolCalls, 1);
});

test('① 闸门：白名单外的动作直接派出去（禁止入口内试探执行）', () => {
  const r = checkEntryBudget({ action: 'run-build', estimatedMs: 100, toolCalls: 1 });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /不在入口白名单内/);
  assert.equal(mustDispatch({ action: 'run-build' }), true);
});
