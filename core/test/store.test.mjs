import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';

let dir;
let store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-test-'));
  store = openStore(join(dir, 'tasks.sqlite'));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('insert defaults: todo, empty json arrays', () => {
  const t = store.insertTask({ title: 'fix homepage bug' });
  assert.equal(t.status, 'todo');
  assert.equal(t.displayId, `tp-${t.id}`);
  assert.deepEqual(t.keywords, []);
  assert.deepEqual(t.artifacts, []);
  assert.deepEqual(t.evidence, []);
});

test('insert with keywords + inbox status', () => {
  const t = store.insertTask({ title: 'x', keywords: ['首页', 'bug'], status: 'inbox' });
  assert.equal(t.status, 'inbox');
  assert.deepEqual(t.keywords, ['首页', 'bug']);
});

test('update fields + updated_at bumps', async (t) => {
  const t1 = store.insertTask({ title: 'a' });
  // ensure a later timestamp
  await new Promise((r) => setTimeout(r, 5));
  const t2 = store.updateTask(t1.id, { session_id: 'sess_abc', workspace: '/tmp/w' });
  assert.equal(t2.session_id, 'sess_abc');
  assert.equal(t2.workspace, '/tmp/w');
  assert.ok(t2.updated_at > t1.updated_at);
});

test('events are append-only and queryable (desc) — raw store API', () => {
  const t = store.insertTask({ title: 'a' });
  // NOTE: raw store does NOT auto-append events; the tools facade owns that.
  store.appendEvent(t.id, 'status_change', 'owner', { from: 'todo', to: 'running' });
  store.appendEvent(t.id, 'field_update', 'owner', { fields: ['keywords'] });
  const events = store.listEvents(t.id, 10);
  assert.equal(events.length, 2);
  assert.equal(events[0].kind, 'field_update'); // desc: newest first
  assert.deepEqual(events[0].payload.fields, ['keywords']);
  assert.equal(events[1].kind, 'status_change');
  assert.equal(events[1].payload.from, 'todo');
});

test('counts histogram covers all nine statuses', () => {
  store.insertTask({ title: 'a' });
  store.insertTask({ title: 'b' });
  const counts = store.counts();
  assert.equal(counts.todo, 2);
  assert.equal(Object.keys(counts).length, 9);
});

test('list filters by status / host / project, ordered by updated desc', () => {
  const a = store.insertTask({ title: 'a' });
  const b = store.insertTask({ title: 'b', host: 'zcode', project: 'p1' });
  assert.equal(store.listTasks({ host: 'zcode' }).length, 1);
  assert.equal(store.listTasks({ host: 'zcode' })[0].id, b.id);
  assert.equal(store.listTasks({ project: 'p1' }).length, 1);
  assert.equal(store.listTasks({ status: 'todo' }).length, 2);
  store.updateTask(a.id, { status: 'running' });
  assert.equal(store.listTasks({ status: ['running', 'todo'] }).length, 2);
  assert.equal(store.listTasks({ status: 'running' })[0].id, a.id);
});

test('persist across reopen (WAL db readable again)', () => {
  const dbPath = join(dir, 'tasks.sqlite');
  const t = store.insertTask({ title: 'durable' });
  store.close();
  const store2 = openStore(dbPath);
  const got = store2.getTask(t.id);
  assert.equal(got.title, 'durable');
  assert.deepEqual(got.keywords, []);
  store2.close();
});
