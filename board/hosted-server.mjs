// TaskPier board — hosted mode server (zero-dependency node:http).
//
// The cloud site cannot reach the local SQLite ledger, so it keeps its own copy
// of the board JSON. The local publisher (board/publish.mjs) POSTs the latest
// board data to /api/ingest; the page loads it once via the boot object and then
// polls /api/board every 8s.
//
// Demand push (default for the publisher): the page's「刷新」button POSTs
// /api/refresh, which bumps a counter and releases a held
// GET /api/refresh-wait long-poll on the local publisher, so the push happens
// on demand instead of on a fixed 30s loop.
//
// Env:
//   PORT             listen port (default 3000)
//   BOARD_TOKEN      required for /api/ingest; unset means ingest is closed
//   DATA_DIR         directory holding board.json (default /data)
//   REFRESH_WAIT_MS  how long /api/refresh-wait holds a request (default 25000)
//
// Usage: PORT=3000 BOARD_TOKEN=... node board/hosted-server.mjs

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = join(HERE, 'page.html');
const BOOT_MARKER = '/*__BOOT__*/null';
const MAX_BODY = 2 * 1024 * 1024; // 2 MB

// Keep in sync with board/data.mjs (the stage only ships this file + page.html).
const STATUS_ORDER = [
  'running', 'waiting_decision', 'blocked', 'review',
  'todo', 'inbox', 'done', 'failed', 'cancelled',
];
const STATUS_LABEL = {
  running: '执行中',
  waiting_decision: '待决策',
  blocked: '阻塞',
  review: '待验收',
  todo: '待派',
  inbox: '收件箱',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};
const ALERT = ['waiting_decision', 'blocked', 'review'];

/** Board shape served before the first push (same fields as buildBoardData). */
export function emptyBoard() {
  const counts = {};
  const columns = {};
  for (const s of STATUS_ORDER) {
    counts[s] = 0;
    columns[s] = [];
  }
  return {
    generatedAt: null,
    counts,
    needsAttention: 0,
    columns,
    labels: { ...STATUS_LABEL },
    alertStatuses: [...ALERT],
  };
}

/** @param {unknown} body */
function isBoardShape(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && typeof body.counts === 'object' && body.counts !== null
    && typeof body.columns === 'object' && body.columns !== null;
}

/** Constant-time token comparison; length mismatch short-circuits safely. */
export function tokenMatches(given, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** @param {import('node:http').IncomingMessage} req */
function headerValue(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Read the request body with a hard size cap.
 * Resolves {ok:true, text} | {ok:false, status:413} — never rejects.
 */
function readBody(req, res, limit = MAX_BODY) {
  const declared = Number(headerValue(req, 'content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    // Drain the oversized request before closing; otherwise Node's client can
    // see ECONNRESET instead of the 413 response (flaky under fetch()).
    req.resume();
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
    res.end(JSON.stringify({ error: 'payload too large', limit }));
    return Promise.resolve({ ok: false, status: 413 });
  }
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let done = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', connection: 'close' });
        res.end(JSON.stringify({ error: 'payload too large', limit }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (tooLarge) resolve({ ok: false, status: 413 });
      else resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      if (done) return;
      done = true;
      resolve(tooLarge ? { ok: false, status: 413 } : { ok: false, status: 400 });
    });
  });
}

/** Write board.json atomically (temp file + rename in the same directory). */
function writeBoardAtomic(dataDir, board) {
  mkdirSync(dataDir, { recursive: true });
  const target = join(dataDir, 'board.json');
  const tmp = join(dataDir, `.board.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(board)}\n`, 'utf8');
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* temp file may not exist */ }
    throw err;
  }
  return target;
}

/**
 * Build the hosted-mode HTTP server. Exported for tests.
 * @param {{dataDir?: string, token?: string, pagePath?: string, refreshWaitMs?: number}} [opts]
 */
export function createHostedServer({
  dataDir = process.env.DATA_DIR || '/data',
  token = process.env.BOARD_TOKEN,
  pagePath = PAGE_PATH,
  refreshWaitMs = Number(process.env.REFRESH_WAIT_MS ?? 25000),
} = {}) {
  const page = readFileSync(pagePath, 'utf8');
  if (!page.includes(BOOT_MARKER)) {
    throw new Error(`page.html missing boot marker ${BOOT_MARKER}: ${pagePath}`);
  }

  const boardPath = join(dataDir, 'board.json');
  let board = emptyBoard();
  try {
    const saved = JSON.parse(readFileSync(boardPath, 'utf8'));
    if (isBoardShape(saved)) board = saved;
    else console.warn(`[hosted-board] ignoring ${boardPath}: not a board object`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[hosted-board] ignoring unreadable ${boardPath}: ${err.message}`);
  }

  const sendJson = (res, status, obj, extra = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  };

  // Demand push: the page asks once (POST /api/refresh); the local publisher
  // holds GET /api/refresh-wait open until that click, then pushes. No fixed
  // 30s push loop is needed — one idle long-poll replaces it.
  let refreshSeq = 0;
  const waiters = new Set(); // { res, since, timer }

  const flushWaiters = () => {
    for (const w of [...waiters]) {
      if (refreshSeq === w.since) continue;
      waiters.delete(w);
      clearTimeout(w.timer);
      sendJson(w.res, 200, { seq: refreshSeq });
    }
  };

  const addWaiter = (res, since) => {
    const w = { res, since, timer: null };
    w.timer = setTimeout(() => {
      if (!waiters.delete(w)) return;
      sendJson(res, 200, { seq: refreshSeq, timeout: true });
    }, Math.max(0, refreshWaitMs));
    w.timer.unref?.();
    waiters.add(w);
    res.on('close', () => {
      if (!waiters.delete(w)) return;
      clearTimeout(w.timer);
    });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
        return;
      }
      // Escape "<" so task titles can never close the inline <script> tag.
      const boot = JSON.stringify({ mode: 'hosted', data: board }).replace(/</g, '\\u003c');
      const html = page.replace(BOOT_MARKER, boot);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : html);
      return;
    }

    if (url.pathname === '/api/board') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(board));
      return;
    }

    if (url.pathname === '/api/ingest') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return;
      }
      if (!tokenMatches(headerValue(req, 'x-board-token'), token)) {
        // Drain a bounded amount so the connection can close cleanly.
        req.resume();
        sendJson(res, 401, { error: 'unauthorized' }, { connection: 'close' });
        return;
      }
      const body = await readBody(req, res);
      if (!body.ok) return; // 413 already sent
      let parsed;
      try {
        parsed = JSON.parse(body.text);
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      if (!isBoardShape(parsed)) {
        sendJson(res, 400, { error: 'invalid board shape: expected {counts, columns}' });
        return;
      }
      try {
        writeBoardAtomic(dataDir, parsed);
      } catch (err) {
        console.error(`[hosted-board] ingest write failed: ${err.message}`);
        sendJson(res, 500, { error: 'write failed' });
        return;
      }
      board = parsed;
      console.log(`[hosted-board] ingested board generatedAt=${board.generatedAt ?? 'unknown'}`);
      sendJson(res, 200, { ok: true, generatedAt: board.generatedAt ?? null });
      return;
    }

    if (url.pathname === '/api/refresh') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return;
      }
      // Public on purpose: the worst a stranger can do is ask the owner's
      // publisher to push a fresh copy of already-public board data.
      refreshSeq += 1;
      flushWaiters();
      sendJson(res, 200, { ok: true, seq: refreshSeq });
      return;
    }

    if (url.pathname === '/api/refresh-wait') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
        return;
      }
      const since = Number(url.searchParams.get('since') ?? '');
      // Differing seq (a click, or a server restart that reset the counter)
      // answers immediately so the publisher pushes right away.
      if (!Number.isFinite(since) || since !== refreshSeq) {
        sendJson(res, 200, { seq: refreshSeq });
        return;
      }
      addWaiter(res, since);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.dataDir = dataDir;
  server.boardPath = boardPath;
  server.on('close', () => {
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.res.destroy?.();
    }
    waiters.clear();
  });
  return server;
}

export function main() {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT ?? 3000);
  const dataDir = process.env.DATA_DIR || '/data';
  if (!process.env.BOARD_TOKEN) {
    console.warn('[hosted-board] BOARD_TOKEN is not set — /api/ingest will reject every push');
  }
  const server = createHostedServer({ dataDir });
  server.listen(port, host, () => {
    const actual = server.address().port;
    console.log(`TaskPier hosted board: http://${host}:${actual}  (data: ${join(dataDir, 'board.json')})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
