import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseConfig,
  localDateStr,
  collectSessionFindings,
  collectRepoFindings,
  deriveCiConclusion,
  buildReport,
  renderMd,
} from '../watchdog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'watchdog.mjs');

// ---- fixture 帮助函数 -------------------------------------------------------

let dir;
function freshDir() {
  dir = mkdtempSync(join(tmpdir(), 'watchdog-test-'));
  return dir;
}

function isoMinutesAgo(min) {
  return new Date(Date.now() - min * 60_000).toISOString();
}

function logLine(event, sessionId, minAgo) {
  // 形似宿主 JSONL 的最小事件行（timestamp/event/sessionId 是停摆判据的字段）
  return JSON.stringify({
    timestamp: isoMinutesAgo(minAgo),
    level: event === 'turn.failed' ? 'error' : 'info',
    event,
    module: 'core.runtime',
    message: `fixture ${event}`,
    sessionId,
  });
}

/** 写一份日志目录；entries: [dateOffsetDays, lines[]] */
function writeLogs(logsDir, ...entries) {
  mkdirSync(logsDir, { recursive: true });
  const now = new Date();
  for (const [daysAgo, lines] of entries) {
    const date = localDateStr(new Date(now.getTime() - daysAgo * 86_400_000));
    writeFileSync(join(logsDir, `zcode-${date}.jsonl`), lines.join('\n') + '\n');
  }
}

function writeConfig(obj) {
  const p = join(dir, 'config.json');
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return p;
}

function runCli(configPath, format = 'json') {
  const args = [SCRIPT, '--config', configPath];
  if (format) args.push('--format', format);
  return spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60_000 });
}

// ---- 端到端（spawn 真进程，断言退出码与报告） ---------------------------------

test('正常：最后事件非 turn.failed / turn.failed 但未超阈值 → 无发现退出 0', () => {
  freshDir();
  const logsDir = join(dir, 'log');
  writeLogs(logsDir, [0, [
    logLine('model.sdk.stream.completed', 'sess_healthy-1111', 1),
    logLine('turn.failed', 'sess_flaky-2222', 2), // 2 分钟前 < 阈值 10 → 尚不算停摆
    logLine('turn.completed', 'sess_flaky-2222', 1),
  ]]);
  const cfg = writeConfig({
    sessions: [
      { name: '#39 支付对账', sessionId: 'sess_healthy-1111' },
      { name: '#41 书页渲染', sessionId: 'sess_flaky-2222' },
    ],
    logsDir,
    stallThresholdMinutes: 10,
  });
  const r = runCli(cfg);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.findings.length, 0);
  assert.equal(out.summary.immediate, 0);
});

test('停摆：最后事件 turn.failed 超阈值 → exit 1 + immediate 发现，证据带时间戳', () => {
  freshDir();
  const logsDir = join(dir, 'log');
  writeLogs(logsDir, [0, [
    logLine('turn.completed', 'sess_aaa-1234', 60),
    logLine('turn.failed', 'sess_aaa-1234', 40), // 最后一条=turn.failed，40 分钟前 > 10
  ]]);
  const cfg = writeConfig({
    sessions: [{ name: '#39 支付对账', sessionId: 'sess_aaa-1234' }],
    logsDir,
    stallThresholdMinutes: 10,
  });
  const r = runCli(cfg);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.findings.length, 1);
  const f = out.findings[0];
  assert.equal(f.type, 'session_stall');
  assert.equal(f.severity, 'immediate');
  assert.match(f.evidence, /turn\.failed/);
  assert.match(f.evidence, /sess_aaa-1234/);
  assert.match(f.suggestedAction, /催办|owner/);
  assert.equal(out.summary.immediate, 1);
});

test('停摆回退：今日日志缺失、昨日日志末条 turn.failed → 仍报停摆，证据出自昨日文件', () => {
  freshDir();
  const logsDir = join(dir, 'log');
  writeLogs(logsDir, [1, [logLine('turn.failed', 'sess_old-9f2e', 900)]]); // 只写昨日
  const cfg = writeConfig({
    sessions: [{ name: '#40 UI 升级', sessionId: 'sess_old-9f2e' }],
    logsDir,
    stallThresholdMinutes: 10,
  });
  const r = runCli(cfg);
  assert.equal(r.status, 1);
  const f = JSON.parse(r.stdout).findings[0];
  assert.equal(f.type, 'session_stall');
  assert.match(f.evidence, /zcode-\d{4}-\d{2}-\d{2}\.jsonl/);
});

test('日志缺文件：logsDir 为空目录 → log_missing 发现（exit 1）', () => {
  freshDir();
  const logsDir = join(dir, 'log'); // 不写任何日志
  const cfg = writeConfig({
    sessions: [{ name: '#42 关调试开关', sessionId: 'sess_any-0000' }],
    logsDir,
  });
  const r = runCli(cfg);
  assert.equal(r.status, 1);
  const f = JSON.parse(r.stdout).findings[0];
  assert.equal(f.type, 'log_missing');
  assert.equal(f.severity, 'daily'); // 只进报告不推送，但仍是发现
});

test('日志缺文件（md 格式）+ 会话盲区：日志在但 sessionId 不存在 → session_unseen', () => {
  freshDir();
  const logsDir = join(dir, 'log');
  writeLogs(logsDir, [0, [logLine('turn.completed', 'sess_other-beef', 3)]]);

  const cfgMissing = writeConfig({ sessions: [{ name: 'X', sessionId: 'sess_x-1' }], logsDir: join(dir, 'no-such-dir') });
  const md = runCli(cfgMissing, 'md');
  assert.equal(md.status, 1);
  assert.match(md.stdout, /# VibeMission 看门狗报告/);
  assert.match(md.stdout, /\[log_missing\]/);
  assert.match(md.stdout, /建议：/);

  const cfgUnseen = writeConfig({ sessions: [{ name: '#39 支付对账', sessionId: 'sess_ghost-7777' }], logsDir });
  const r = runCli(cfgUnseen);
  assert.equal(r.status, 1);
  const f = JSON.parse(r.stdout).findings[0];
  assert.equal(f.type, 'session_unseen');
  assert.equal(f.severity, 'daily');
});

test('JSON 坏配置 / 缺 --config / 坏格式 → exit 2', () => {
  freshDir();
  const bad = writeConfig('{ not-json !!!');
  assert.equal(runCli(bad).status, 2);

  const empty = writeConfig({});
  assert.equal(runCli(empty).status, 2); // sessions 与 repos 都没有

  const wrongTypes = writeConfig({ sessions: [{ name: 1 }], logsDir: 42 });
  assert.equal(runCli(wrongTypes).status, 2);

  const good = writeConfig({ sessions: [{ name: 'X', sessionId: 'sess_x-1' }], logsDir: join(dir, 'log') });
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2); // 缺 --config
  assert.equal(runCli(good, 'yaml').status, 2); // 未支持的格式
  writeLogs(join(dir, 'log'), [0, [logLine('turn.completed', 'sess_x-1', 1)]]);
  assert.equal(runCli(good).status, 0, '合法配置 + 健康日志 → 无发现退出 0');
});

test('PR：gh 缺失 → 跳过并注明（不算发现，exit 0）', () => {
  freshDir();
  const logsDir = join(dir, 'log');
  writeLogs(logsDir, [0, [logLine('turn.completed', 'sess_ok-2024', 1)]]);
  const cfg = writeConfig({
    sessions: [{ name: '健康会话', sessionId: 'sess_ok-2024' }],
    logsDir,
    repos: [{ owner: 'StarDust-AI-Labs', name: 'vibe-mission', branches: ['feat/watchdog'] }],
    ghPath: join(dir, 'gh-does-not-exist.exe'),
  });
  const r = runCli(cfg);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.findings.length, 0);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].reason, 'gh_unavailable');
});

// ---- 单元：配置校验 / CI 结论 / PR 发现（注入 fake runner，不碰网络） ----------

test('parseConfig：默认值与非法输入', () => {
  assert.equal(parseConfig('nope').error, 'config 必须是 JSON 对象');
  assert.equal(parseConfig({}).error, 'config 至少要有 sessions[] 或 repos[] 之一');
  assert.equal(parseConfig({ sessions: [{ name: 'a', sessionId: 's' }] }).error, undefined);
  const ok = parseConfig({ repos: [{ owner: 'o', name: 'n' }] }).config;
  assert.equal(ok.stallThresholdMinutes, 10); // 默认 10
  assert.equal(ok.repos[0].branches.length, 0); // branches 可省略
  assert.ok(ok.ghPath.length > 0);
  assert.equal(parseConfig({ sessions: 'x' }).error, 'sessions 必须是 [{name, sessionId}] 数组');
  assert.equal(parseConfig({ repos: [{}] }).error, 'repos 必须是 [{owner, name, branches?}] 数组');
  assert.equal(parseConfig({ repos: [{ owner: 'o', name: 'n' }], stallThresholdMinutes: -1 }).error, 'stallThresholdMinutes 必须是正数');
});

test('deriveCiConclusion：failed / pending / success / none', () => {
  assert.equal(deriveCiConclusion([]), 'none');
  assert.equal(deriveCiConclusion([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'success');
  assert.equal(deriveCiConclusion([{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/run/1' }]), 'failed');
  assert.equal(deriveCiConclusion([{ context: 'ci', state: 'ERROR' }]), 'failed');
  assert.equal(deriveCiConclusion([{ name: 'ci', status: 'IN_PROGRESS' }]), 'pending');
  assert.equal(deriveCiConclusion([{ context: 'ci', state: 'PENDING' }]), 'pending');
});

function fakeGh(responses) {
  // 按 (slug#branch) 返回预置 gh 输出；--version 探针恒成功
  return (cmd, args) => {
    if (args[0] === '--version') return { status: 0, stdout: 'gh version 2.0.0', stderr: '' };
    const branch = args[args.indexOf('--head') + 1];
    const preset = responses[branch];
    if (preset === 'AUTH_FAIL') return { status: 1, stdout: '', stderr: 'gh: To use GitHub CLI in a GitHub Actions workflow, gh auth login' };
    if (preset === 'ERR') return { status: 1, stdout: '', stderr: 'boom' };
    return { status: 0, stdout: JSON.stringify(preset ?? []), stderr: '' };
  };
}

test('collectRepoFindings：changes_requested 与 CI 挂 → immediate 发现；merged/无 PR 只观察', () => {
  const prBody = (over = {}) => ({
    number: 44, title: '固化看门狗值守机制进仓库', state: 'OPEN', url: 'https://github.com/o/n/pull/44',
    reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    updatedAt: isoMinutesAgo(5), ...over,
  });
  const repos = [{ owner: 'o', name: 'n', branches: ['feat/a', 'feat/b', 'feat/c', 'feat/d'] }];
  const run = fakeGh({
    'feat/a': [prBody({ reviewDecision: 'CHANGES_REQUESTED' })],
    'feat/b': [prBody({ statusCheckRollup: [{ name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://x/run/9' }] })],
    'feat/c': [prBody({ state: 'MERGED' })],
    'feat/d': [],
  });
  const { findings, observed, skipped } = collectRepoFindings({ repos, ghPath: 'gh', run });
  assert.equal(skipped.length, 0);
  const types = findings.map((f) => f.type).sort();
  assert.deepEqual(types, ['ci_failed', 'pr_changes_requested']);
  for (const f of findings) assert.equal(f.severity, 'immediate');
  assert.match(findings.find((f) => f.type === 'ci_failed').evidence, /https:\/\/x\/run\/9/);

  const states = Object.fromEntries(observed.map((o) => [o.object, o]));
  assert.equal(states['o/n#feat/a'].ci, 'success');
  assert.equal(states['o/n#feat/c'].state, 'MERGED'); // closed/merged 只进 observed
  assert.equal(states['o/n#feat/d'].state, 'no_open_pr');
});

test('collectRepoFindings：gh 未登录 → 跳过注明；gh 探针失败 → 跳过（不算发现）', () => {
  const repos = [{ owner: 'o', name: 'n', branches: ['feat/a', 'feat/b'] }];
  const run = fakeGh({ 'feat/a': 'AUTH_FAIL', 'feat/b': 'ERR' });
  const { findings, skipped } = collectRepoFindings({ repos, ghPath: 'gh', run });
  assert.equal(findings.length, 0);
  assert.deepEqual(skipped.map((s) => s.reason), ['gh_auth_failed', 'gh_error']);
  const dead = collectRepoFindings({ repos, ghPath: 'no-such-gh', run: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } }) });
  assert.equal(dead.findings.length, 0);
  assert.equal(dead.skipped[0].reason, 'gh_unavailable');
});

// ---- 渲染 -------------------------------------------------------------------

test('renderMd：空报告写「本轮无发现」；发现含类型/对象/证据/建议四要素', () => {
  const empty = renderMd(buildReport({ findings: [] }));
  assert.match(empty, /本轮无发现/);

  const report = buildReport({
    findings: [{
      type: 'session_stall', object: '#39 支付对账（sess_aaa-1234）', severity: 'immediate',
      evidence: '最后一条事件 turn.failed @ 2026-11-28T02:00:11Z（距今 40 分钟，阈值 10 分钟）',
      suggestedAction: '催办一次；连续 2 轮仍停摆 → 通知 owner',
    }],
    observed: [{ object: 'o/n#feat/watchdog', pr: '#44 固化看门狗', state: 'OPEN', review: 'REVIEW_REQUIRED', ci: 'success', url: 'https://github.com/o/n/pull/44' }],
    skipped: [{ object: 'o/n', reason: 'gh_unavailable', detail: 'ENOENT' }],
  });
  const md = renderMd(report);
  assert.match(md, /⛔ \*\*\[session_stall\]\*\* #39 支付对账/);
  assert.match(md, /证据：.*turn\.failed @ 2026-11-28T02:00:11Z/);
  assert.match(md, /建议：催办一次/);
  assert.match(md, /观察到（事实，非发现）/);
  assert.match(md, /#44 固化看门狗/); // observed 事实照实渲染
  assert.match(md, /跳过（本轮无法检查）/);
  assert.match(md, /gh_unavailable/);
});

test('collectSessionFindings：前缀 sessionId 可命中（与原型 grep 行为一致）', async () => {
  freshDir();
  const logsDir = join(dir, 'log');
  writeLogs(logsDir, [0, [logLine('turn.failed', 'sess_0a4e5a6a-1111-2222-3333-444444444444', 30)]]);
  const findings = await collectSessionFindings({
    sessions: [{ name: '#39', sessionId: 'sess_0a4e5a6a' }], // 前缀
    logsDir,
    stallThresholdMinutes: 10,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].type, 'session_stall');
});
