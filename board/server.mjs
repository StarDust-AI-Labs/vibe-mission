// TaskPier board — local realtime server (zero-dependency node:http).
// Modes: serves the board page + JSON API over the live task store.
// Usage: node board/server.mjs [--db <path>] [--port <n>] [--host <addr>]

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDbPath } from '../core/src/dbpath.mjs';
import { openStore } from '../core/src/store.mjs';
import { buildBoardData } from './data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = readFileSync(join(HERE, 'page.html'), 'utf8');

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return {
    db: get('--db'),
    port: Number(get('--port') ?? process.env.BOARD_PORT ?? 3210),
    host: get('--host') ?? '127.0.0.1',
  };
}

/**
 * Build the HTTP server against a store. Exported for tests.
 * @param {import('../core/src/store.mjs').Store} store
 */
export function createBoardServer(store) {
  return createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/board') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(buildBoardData(store)));
      return;
    }
    if (url.pathname === '/api/task') {
      const raw = String(url.searchParams.get('id') ?? '').trim();
      const m = /^(?:tp-|#)?0*(\d+)$/.exec(raw);
      if (!m || Number(m[1]) <= 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid id' }));
        return;
      }
      const task = store.getTask(Number(m[1]));
      if (!task) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ task, events: store.listEvents(task.id, 50) }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE.replace('/*__BOOT__*/null', '{mode:"api"}'));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
}

export function main(argv = process.argv.slice(2)) {
  const { db: dbFlag, port, host } = parseArgs(argv);
  const dbPath = dbFlag ?? resolveDbPath();
  const store = openStore(dbPath);
  const server = createBoardServer(store);
  server.listen(port, host, () => {
    const actual = server.address().port;
    console.log(`TaskPier board: http://${host}:${actual}  (db: ${dbPath})`);
  });
  const shutdown = () => { try { store.close(); } catch { /* noop */ } process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
