import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyWatchdog, renderWatchdogMessage, watchdogKey } from '../feishu/notify.mjs';

const stall = {
  type: 'session_stall',
  object: '#39 支付对账（sess_aaa-1234）',
  severity: 'immediate',
  evidence: '最后一条事件 turn.failed @ 2026-11-28T02:00:11Z（距今 40 分钟，阈值 10 分钟）',
  suggestedAction: '催办一次；连续 2 轮仍停摆 → 通知 owner',
};
const ciFailed = {
  type: 'ci_failed',
  object: 'o/n#feat/watchdog',
  severity: 'immediate',
  evidence: 'PR #44 CI 失败，https://x/run/9',
  suggestedAction: '把失败原因转回对应任务会话返修',
};
const logMissing = {
  type: 'log_missing',
  object: 'C:/log',
  severity: 'daily', // daily 只进报告，不推送
  evidence: '今日与昨日日志均不存在',
  suggestedAction: '检查 logsDir 配置',
};

function fakeSend(calls = []) {
  return (message, userId, dryRun) => {
    calls.push({ message, userId, dryRun });
    return { ok: true, data: { message_id: 'om_test_1' } };
  };
}

test('renderWatchdogMessage：聚合多条发现，含类型/对象/证据/建议', () => {
  const msg = renderWatchdogMessage([stall, ciFailed], { generatedAt: '2026-11-28T06:40:00Z' });
  assert.match(msg, /【VibeMission 看门狗】2 条发现需要 owner 处理/);
  assert.match(msg, /报告时间：2026-11-28T06:40:00Z/);
  assert.match(msg, /\[session_stall\] #39 支付对账/);
  assert.match(msg, /证据：.*turn\.failed/);
  assert.match(msg, /建议：催办一次/);
  assert.match(msg, /\[ci_failed\] o\/n#feat\/watchdog/);
});

test('notifyWatchdog：只推 immediate；daily 不打扰', () => {
  const calls = [];
  const r = notifyWatchdog({
    findings: [stall, ciFailed, logMissing],
    userId: 'ou_owner',
    send: fakeSend(calls),
  });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].message.includes('log_missing'), 'daily 级不进推送');
  assert.deepEqual(r.keys, [watchdogKey(stall), watchdogKey(ciFailed)]);
});

test('notifyWatchdog：suppressKeys 跨轮幂等——同一发现已推过则不重复打扰', () => {
  const calls = [];
  const suppress = [watchdogKey(stall), watchdogKey(ciFailed)];
  const r = notifyWatchdog({ findings: [stall, ciFailed, logMissing], userId: 'ou_owner', suppressKeys: suppress, send: fakeSend(calls) });
  assert.equal(r.sent, false);
  assert.equal(calls.length, 0);
  assert.equal(r.reason, 'suppressed');

  // 新发现出现 → 只推新的那条
  const calls2 = [];
  const r2 = notifyWatchdog({
    findings: [stall, ciFailed, logMissing, { ...stall, object: '#41 书页渲染（sess_new-1）' }],
    userId: 'ou_owner',
    suppressKeys: suppress,
    send: fakeSend(calls2),
  });
  assert.equal(r2.sent, true);
  assert.equal(calls2.length, 1);
  assert.match(calls2[0].message, /#41 书页渲染/);
  assert.ok(!calls2[0].message.includes('#39 支付对账'));
});

test('notifyWatchdog：无 immediate 发现 / 缺收件人时不发送', () => {
  const calls = [];
  const none = notifyWatchdog({ findings: [logMissing], userId: 'ou_owner', send: fakeSend(calls) });
  assert.equal(none.sent, false);
  assert.equal(none.reason, 'none-immediate');

  const noUser = notifyWatchdog({ findings: [stall], send: fakeSend(calls) });
  assert.equal(noUser.sent, false);
  assert.equal(noUser.reason, 'recipient-missing');
  assert.equal(calls.length, 0);
});
