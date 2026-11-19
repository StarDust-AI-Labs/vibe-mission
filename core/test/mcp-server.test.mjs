// End-to-end smoke: spawn the stdio MCP server as a child process and speak
// newline-delimited JSON-RPC to it, exactly like a host would.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'src', 'mcp-server.mjs');

let dir;
let dbPath;
let child;
let nextId;
const pending = new Map();
let buffer = '';

function start() {
  child = spawn(process.execPath, [SERVER, '--db', dbPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const resolver = pending.get(msg.id);
      if (resolver) {
        pending.delete(msg.id);
        resolver(msg);
      }
    }
  });
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
}

function rpc(method, params) {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const p = new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for response to ${method} (id=${id})`));
      }
    }, 15000);
  });
  child.stdin.write(`${line}\n`);
  return p;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'taskpier-mcp-'));
  dbPath = join(dir, 'tasks.sqlite');
  nextId = 1;
  await start();
});

afterEach(async () => {
  // Windows: must wait for the child to release the SQLite file handle
  // before removing the temp dir, otherwise rmSync fails with EPERM.
  if (child && child.exitCode === null) {
    await new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill();
      setTimeout(resolve, 3000); // fallback if kill is ignored
    });
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  } catch {
    // best effort cleanup — never fail the test on temp-dir removal
  }
});

test('MCP handshake → tools/list → tools/call end to end', async () => {
  // 1. initialize (client asks for 2025-11-25, server supports it)
  const init = await rpc('initialize', {
    protocolVersion: '2025-11-25',
    clientInfo: { name: 'test-harness', version: '0' },
  });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  assert.equal(init.result.serverInfo.name, 'taskpier-core');
  assert.equal(init.result.capabilities.tools.listChanged, false);

  // 2. initialized notification (no response expected)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // 3. tools/list
  const list = await rpc('tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, [
    'task_create', 'task_update', 'task_query', 'task_list', 'board_summary', 'decision_answer',
  ]);

  // 4. tools/call task_create
  const created = await rpc('tools/call', {
    name: 'task_create',
    arguments: { title: 'fix homepage bug', keywords: ['首页'], actor: 'owner' },
  });
  assert.equal(created.result.isError, undefined);
  const task = created.result.structuredContent.task;
  assert.equal(task.status, 'todo');
  assert.equal(task.displayId, `tp-${task.id}`);

  // 5. illegal transition surfaces as a tool error (isError), not a crash
  const bad = await rpc('tools/call', {
    name: 'task_update',
    arguments: { id: task.id, status: 'done' },
  });
  assert.equal(bad.result.isError, true);
  assert.equal(bad.result.structuredContent.error, 'illegal_transition');

  // 6. valid transitions → review → done
  await rpc('tools/call', { name: 'task_update', arguments: { id: task.id, status: 'running' } });
  await rpc('tools/call', { name: 'task_update', arguments: { id: task.id, status: 'review' } });
  const finished = await rpc('tools/call', {
    name: 'task_update', arguments: { id: task.id, status: 'done', actor: 'user' },
  });
  assert.equal(finished.result.structuredContent.task.status, 'done');

  // 7. board_summary reflects the done task
  const board = await rpc('tools/call', { name: 'board_summary', arguments: {} });
  assert.equal(board.result.structuredContent.counts.done, 1);

  // 8. unknown method → JSON-RPC error
  const unknown = await rpc('resources/list', {});
  assert.equal(unknown.error.code, -32601);

  // 9. unknown tool → JSON-RPC error -32602
  const unknownTool = await rpc('tools/call', { name: 'nope', arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
});
