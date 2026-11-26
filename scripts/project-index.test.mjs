import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, loadIndex, describeResolution } from './project-index.mjs';

const index = loadIndex();

test('explicit project hit routes to its workspace', () => {
  const res = resolveProject('把 VibeMission 的任务卡字段补上 workspace', index);
  assert.equal(res.status, 'ok');
  assert.equal(res.project.id, 'vibemission');
  assert.match(res.project.workspace, /vibe-mission$/);
});

test('domain keyword routes to shibei repo', () => {
  const res = resolveProject('分享页在 iPhone 上字太小，帮我改一下', index);
  assert.equal(res.status, 'ok');
  assert.equal(res.project.id, 'shibei');
  assert.match(res.project.workspace, /shibei-memory-book$/);
});

test('office material routes to the office dir, not a code repo', () => {
  const res = resolveProject('把这个会议纪要整理成日报', index);
  assert.equal(res.status, 'ok');
  assert.equal(res.project.id, 'vibemission-office');
});

test('unknown intent resolves to none so the human decides', () => {
  const res = resolveProject('明天天气怎么样', index);
  assert.equal(res.status, 'none');
});

test('equal scores are reported as ambiguous instead of guessing', () => {
  const custom = {
    projects: [
      { id: 'a', name: 'A', product: 'zcode', workspace: 'D:\\a', keywords: ['模板'] },
      { id: 'b', name: 'B', product: 'zcode', workspace: 'D:\\b', keywords: ['模板'] },
    ],
  };
  const res = resolveProject('把模板改一下', custom);
  assert.equal(res.status, 'ambiguous');
  assert.equal(res.candidates.length, 2);
});

test('every project carries a workspace (dispatch gate depends on it)', () => {
  for (const p of index.projects) {
    assert.ok(p.workspace && p.workspace.length > 2, `${p.id} missing workspace`);
    assert.ok(p.product, `${p.id} missing product`);
  }
});

test('describeResolution is human readable', () => {
  assert.match(describeResolution(resolveProject('分享页字号', index)), /→ 拾贝网站（D:/);
  assert.match(describeResolution(resolveProject('天气', index)), /未命中/);
});
