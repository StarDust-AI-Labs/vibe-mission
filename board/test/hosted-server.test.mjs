import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostedServer } from '../hosted-server.mjs';
import { buildBoardData } from '../data.mjs';
import { openStore } from '../../core/src/store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const TOKEN = 'test-board-token';
const MAX_BODY = 2 * 1024 * 1024;

let dir;
let cur; // { server, base }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-hosted-'));
  cur = null;
});

afterEach(async () => {
  if (cur) {
    const { server } = cur;
    cur = null;
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
});

async function startServer(dataDir) {
  const server = createHostedServer({ dataDir, token: TOKEN });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function ensureServer() {
  if (!cur) cur = await startServer(dir);
  return cur;
}

/** Realistic board fixture via the same builder the local server uses.
 *  Round-trip through JSON so `undefined` fields match what HTTP serves. */
function makeLedgerBoard(ledgerPath) {
  const store = openStore(ledgerPath);
  try {
    store.insertTask({ title: '托管模式任务', status: 'running', host: 'zcode' });
    store.insertTask({ title: '待决策任务', status: 'waiting_decision' });
    return JSON.parse(JSON.stringify(buildBoardData(store)));
  } finally {
    store.close();
  }
}

function postIngest(base, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) headers['x-board-token'] = token;
  return fetch(`${base}/api/ingest`, { method: 'POST', headers, body });
}

function runPublish(args, env = {}) {
  const child = spawn(process.execPath, [join(REPO, 'board', 'publish.mjs'), ...args], {
    env: { ...process.env, BOARD_SITE_URL: '', BOARD_TOKEN: '', ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, 20000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

test('hosted board: empty board before first push', async () => {
  const { base } = await ensureServer();
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.generatedAt, null);
  assert.equal(board.counts.running, 0);
  assert.deepEqual(board.columns.running, []);
  assert.ok(Array.isArray(board.alertStatuses));
});

test('hosted board: ingest rejects missing and wrong token with 401', async () => {
  const { base } = await ensureServer();
  const fixture = makeLedgerBoard(join(dir, 'ledger.sqlite'));
  const body = JSON.stringify(fixture);

  const missing = await postIngest(base, body);
  assert.equal(missing.status, 401);

  const wrong = await postIngest(base, body, 'not-the-token');
  assert.equal(wrong.status, 401);

  // Rejected pushes must not change the served board.
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.generatedAt, null);
  assert.equal(existsSync(join(dir, 'board.json')), false);
});

test('hosted board: correct token stores data and GET /api/board returns it', async () => {
  const { base } = await ensureServer();
  const fixture = makeLedgerBoard(join(dir, 'ledger.sqlite'));

  const res = await postIngest(base, JSON.stringify(fixture), TOKEN);
  assert.equal(res.status, 200);
  const ack = await res.json();
  assert.equal(ack.ok, true);
  assert.equal(ack.generatedAt, fixture.generatedAt);

  const board = await (await fetch(`${base}/api/board`)).json();
  assert.deepEqual(board, fixture);
  assert.equal(board.counts.running, 1);
  assert.equal(board.counts.waiting_decision, 1);
  assert.equal(board.columns.running[0].title, '托管模式任务');

  const saved = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'));
  assert.deepEqual(saved, fixture);
});

test('hosted board: GET / injects hosted boot data into page.html', async () => {
  const { base } = await ensureServer();
  const fixture = makeLedgerBoard(join(dir, 'ledger.sqlite'));
  assert.equal((await postIngest(base, JSON.stringify(fixture), TOKEN)).status, 200);

  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('TaskPier 任务看板'), 'page shell rendered');
  assert.ok(html.includes('"mode":"hosted"'), 'hosted mode injected');
  assert.ok(html.includes('托管模式任务'), 'current board data injected');
  assert.ok(!html.includes('/*__BOOT__*/null'), 'boot marker replaced');
  assert.ok(html.includes("boot.mode === 'snapshot'"), 'page polling branch intact');
});

test('hosted board: invalid JSON and invalid shape -> 400, oversize -> 413', async () => {
  const { base } = await ensureServer();

  const badJson = await postIngest(base, '{not json', TOKEN);
  assert.equal(badJson.status, 400);

  const badShape = await postIngest(base, JSON.stringify({ counts: {} }), TOKEN);
  assert.equal(badShape.status, 400);

  const oversize = await postIngest(base, JSON.stringify({ padding: 'x'.repeat(MAX_BODY) }), TOKEN);
  assert.equal(oversize.status, 413);

  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.generatedAt, null, 'rejected pushes do not mutate state');
});

test('hosted board: board.json survives a server restart', async () => {
  const first = await ensureServer();
  const fixture = makeLedgerBoard(join(dir, 'ledger.sqlite'));
  assert.equal((await postIngest(first.base, JSON.stringify(fixture), TOKEN)).status, 200);

  first.server.closeAllConnections?.();
  await new Promise((r) => first.server.close(r));
  cur = null;

  const second = await ensureServer();
  const board = await (await fetch(`${second.base}/api/board`)).json();
  assert.deepEqual(board, fixture);
  const html = await (await fetch(`${second.base}/`)).text();
  assert.ok(html.includes('托管模式任务'));
});

test('publish.mjs: pushes local ledger once; bad token exits 2; missing url exits 1', async () => {
  const { base } = await ensureServer();
  const ledger = join(dir, 'tasks.sqlite');
  makeLedgerBoard(ledger);

  const ok = await runPublish(['--db', ledger, '--url', base, '--token', TOKEN]);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.code, 0, `stdout=${ok.stdout}\nstderr=${ok.stderr}`);
  assert.match(ok.stdout, /\[publish\] ok HTTP 200/);
  const board = await (await fetch(`${base}/api/board`)).json();
  assert.equal(board.columns.running[0].title, '托管模式任务');

  const badToken = await runPublish(['--db', ledger, '--url', base, '--token', 'wrong']);
  assert.equal(badToken.code, 2);
  assert.match(badToken.stderr, /推送失败.*HTTP 401/);

  const noUrl = await runPublish(['--db', ledger]);
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.stderr, /缺少站点地址/);
});
