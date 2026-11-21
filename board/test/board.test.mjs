import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../../core/src/store.mjs';
import { buildTools } from '../../core/src/tools.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-board-'));
  store = openStore(join(dir, 'tasks.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
});

function spawnServer(dbPath, port = '0') {
  const child = spawn(process.execPath, [join(REPO, 'board', 'server.mjs'), '--db', dbPath, '--port', port, '--host', '127.0.0.1']);
  return child;
}

test('board server: /api/board reflects store; / renders page; /api/task returns events', async (t) => {
  // create via the tools facade so events are appended (raw store does not)
  const { handlers } = buildTools(store);
  const { task: t1 } = handlers.task_create({ title: '看板冒烟任务', keywords: ['board'] });
  handlers.task_update({ id: t1.id, status: 'running' });

  const dbPath = join(dir, 'tasks.sqlite');
  const child = spawnServer(dbPath);
  try {
    // wait for the port line
    const port = await new Promise((resolve, reject) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        const m = /:(\d+)\s+\(db:/.exec(d) ?? /http:\/\/127\.0\.0\.1:(\d+)/.exec(d);
        if (m) resolve(Number(m[1]));
      });
      child.once('exit', () => reject(new Error('server exited early')));
      setTimeout(() => reject(new Error('timeout waiting for server start')), 15000);
    });
    assert.ok(port > 0);

    const board = await (await fetch(`http://127.0.0.1:${port}/api/board`)).json();
    assert.equal(board.counts.running, 1);
    assert.equal(board.columns.running[0].displayId, 'tp-1');
    assert.equal(board.needsAttention, 0);

    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.ok(html.includes('TaskPier 任务看板'));
    assert.ok(html.includes('{mode:"api"}'));

    const one = await (await fetch(`http://127.0.0.1:${port}/api/task?id=tp-1`)).json();
    assert.equal(one.task.title, '看板冒烟任务');
    assert.ok(one.events.length >= 2); // create + status_change
  } finally {
    child.kill();
    await new Promise((r) => { child.once('exit', r); setTimeout(r, 3000); });
  }
});

test('snapshot builds stage with inline data + ZCode Sites templates', async () => {
  store.insertTask({ title: '快照里的任务' });
  const dbPath = join(dir, 'tasks.sqlite');
  store.close();

  // invoke snapshot as child to exercise the real CLI path
  const child = spawn(process.execPath, [join(REPO, 'board', 'snapshot.mjs'), '--db', dbPath, '--out', join(dir, 'stage')]);
  const code = await new Promise((r) => child.once('exit', r));
  assert.equal(code, 0);

  const stage = join(dir, 'stage');
  const html = readFileSync(join(stage, 'index.html'), 'utf8');
  assert.ok(html.includes('{mode:"snapshot"'), 'inline boot object embedded');
  assert.ok(html.includes('快照里的任务'));
  assert.ok(existsSync(join(stage, 'start.sh')));
  assert.ok(existsSync(join(stage, 'static-server.mjs')));
  const startSh = readFileSync(join(stage, 'start.sh'), 'utf8');
  assert.ok(startSh.includes('SITE_DIR=.'), 'start.sh adjusted to serve stage root');
  assert.ok(!startSh.includes('SPA_FALLBACK=1'));
});
