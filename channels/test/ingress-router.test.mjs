// Entry router: L0 rules + corpus gates (docs/entry-router.md §6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRoute, detectSignals, ROUTES } from '../ingress/router.mjs';
import { evaluate, formatReport, loadCorpus, GATES } from '../ingress/evaluate.mjs';

const corpus = loadCorpus();

test('corpus：准确率 / L0 覆盖 / 关键类召回均达标', () => {
  const m = evaluate(corpus);
  assert.ok(m.passed, `\n${formatReport(m)}`);
  assert.ok(m.accuracy >= GATES.accuracy, `accuracy ${m.accuracy}`);
  assert.ok(m.l0Coverage >= GATES.l0Coverage, `l0Coverage ${m.l0Coverage}`);
  assert.equal(m.criticalRecall, 1, '关键类（拍板 / 新建）必须 100% 判对');
});

test('引用锚：文本里的 #N 与 tp-N 等价', () => {
  const a = classifyRoute({ text: '#12 再改一版', meta: { chatType: 'group' } });
  const b = classifyRoute({ text: 'tp-0012 再改一版', meta: { chatType: 'group' } });
  assert.equal(a.route, 'dispatch');
  assert.equal(b.route, 'dispatch');
  assert.equal(a.slots.taskRef, 12);
  assert.equal(b.slots.taskRef, 12);
});

test('引用锚：quoted 也算锚（回复某条消息 = 指向任务）', () => {
  const d = classifyRoute({ text: '按这个来', meta: { quoted: true } });
  assert.equal(d.route, 'dispatch');
  assert.equal(d.layer, 'L0');
});

test('拍板词无锚点：不落动作，只问一次且默认不动', () => {
  const d = classifyRoute({ text: '通过' });
  assert.equal(d.route, 'reply');
  assert.equal(d.needAsk, true);
  assert.match(d.ask, /哪条任务/);
  assert.equal(d.defaultRoute, 'reply');
  assert.ok(d.confidence <= 0.6, '不确定时置信度必须降下来');
});

test('拍板词有锚点：直接判定并记录动作', () => {
  const approve = classifyRoute({ text: '通过 #7' });
  assert.equal(approve.slots.action, 'approve');
  assert.equal(approve.needAsk, false);

  const reject = classifyRoute({ text: '打回 #7，数据不对' });
  assert.equal(reject.slots.action, 'reject');
});

test('紧急词优先于一切，并标记 urgent', () => {
  const d = classifyRoute({ text: '停掉所有任务' });
  assert.equal(d.route, 'reply');
  assert.equal(d.slots.urgent, true);
  assert.equal(d.ruleId, 'urgent.stop');
});

test('问句分流：问账本 → query，问意见 → reply', () => {
  assert.equal(classifyRoute({ text: '#31 卡在哪了' }).route, 'query');
  assert.equal(classifyRoute({ text: '现在有哪些任务卡住了' }).route, 'query');
  assert.equal(classifyRoute({ text: '你觉得计划任务还是常驻进程好' }).route, 'reply');
});

test('元对话不落账本', () => {
  const d = classifyRoute({ text: '为什么你忘了昨天说的上线计划' });
  assert.equal(d.route, 'meta');
});

test('无可判信号时走最保守默认：先回话、不登记', () => {
  const d = classifyRoute({ text: '这个事儿我们再想想' });
  assert.equal(d.route, 'reply');
  assert.equal(d.layer, 'L2');
  assert.equal(d.needAsk, true);
  assert.match(d.ask, /默认不登记/);
});

test('一句话两件事：标记 multiIntent', () => {
  const d = classifyRoute({ text: '把 #7 合了，然后把首页视觉做完' });
  assert.equal(d.slots.multiIntent, true);
});

test('每条判定都带路线 / 依据 / 留痕字段', () => {
  for (const row of corpus) {
    const d = classifyRoute({ text: row.text, meta: row.meta });
    assert.ok(ROUTES.includes(d.route), `${row.id} route=${d.route}`);
    assert.ok(d.reason && d.reason.length > 0, `${row.id} 缺 reason`);
    assert.ok(['L0', 'L1', 'L2'].includes(d.layer), `${row.id} layer=${d.layer}`);
    if (d.needAsk) assert.match(d.ask ?? '', /默认/, `${row.id} 反问必须带默认值`);
    assert.equal(typeof d.slots.multiIntent, 'boolean');
  }
});

test('信号提取：ref / anchor / question', () => {
  const s = detectSignals({ text: '#0007 能不能改一下', meta: {} });
  assert.equal(s.ref, 7);
  assert.equal(s.anchor, true);
  assert.equal(s.isQuestion, true);

  const plain = detectSignals('收到');
  assert.equal(plain.ref, null);
  assert.equal(plain.anchor, false);
  assert.equal(plain.isQuestion, false);
});

test('空消息：不制造任务，置信度为 0', () => {
  const d = classifyRoute({ text: '   ' });
  assert.equal(d.route, 'reply');
  assert.equal(d.confidence, 0);
});