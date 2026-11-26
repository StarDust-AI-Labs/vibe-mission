// TaskPier board — publisher for hosted mode.
//
// Reads the local ledger (same DB resolution chain as the MCP server / local
// board) and POSTs the board JSON to <BOARD_SITE_URL>/api/ingest, so the cloud
// site's /api/board serves near-live data.
//
// Usage:
//   BOARD_SITE_URL=https://xxx.zai.site BOARD_TOKEN=... node board/publish.mjs
//   BOARD_SITE_URL=... BOARD_TOKEN=... node board/publish.mjs --watch 30
//   node board/publish.mjs --url <site> --token <token> [--db <ledger>] [--once]
//
// Flags:
//   --once          push once and exit (default)
//   --watch <sec>   push immediately, then every <sec> seconds until SIGINT
//   --url <url>     override BOARD_SITE_URL
//   --token <t>     override BOARD_TOKEN (env preferred: args are visible in `ps`)
//   --db <path>     override the ledger path (see core/src/dbpath.mjs chain)
//
// Exit codes: 0 ok; 1 bad/missing configuration; 2 push failed; 3 ledger open failed.

import { pathToFileURL } from 'node:url';
import { resolveDbPath } from '../core/src/dbpath.mjs';
import { openStore } from '../core/src/store.mjs';
import { buildBoardData } from './data.mjs';

const TIMEOUT_MS = 15000;

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    return v === undefined || v.startsWith('--') ? '' : v;
  };
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    once: argv.includes('--once'),
    watchPresent: argv.includes('--watch'),
    watchRaw: get('--watch'),
    url: get('--url'),
    token: get('--token'),
    db: get('--db'),
  };
}

function fail(msg, code) {
  console.error(`[publish] ${msg}`);
  return code;
}

function taskCount(data) {
  return Object.values(data.counts ?? {}).reduce((a, b) => a + b, 0);
}

/**
 * One push. Returns the board data on success, throws on failure.
 * @param {{store: any, url: string, token: string}} opts
 */
export async function pushOnce({ store, url, token }) {
  const data = buildBoardData(store);
  const body = JSON.stringify(data);
  let res;
  try {
    res = await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-board-token': token },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const cause = err?.cause?.message ?? err?.message ?? String(err);
    throw new Error(`network error: ${cause}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const detail = text ? `: ${text.slice(0, 200)}` : '';
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  console.log(
    `[publish] ok HTTP ${res.status} · generatedAt=${data.generatedAt} · tasks=${taskCount(data)} · bytes=${Buffer.byteLength(body)}`,
  );
  return data;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: node board/publish.mjs [--once | --watch <sec>] [--url <site>] [--token <t>] [--db <path>]');
    return 0;
  }
  if (args.once && args.watchPresent) {
    return fail('--once 与 --watch 只能二选一', 1);
  }

  const rawUrl = args.url ?? process.env.BOARD_SITE_URL;
  const token = args.token ?? process.env.BOARD_TOKEN;
  if (!rawUrl) return fail('缺少站点地址：设置 BOARD_SITE_URL 或传 --url <site>', 1);
  if (!/^https?:\/\//i.test(rawUrl)) {
    return fail(`站点地址必须以 http(s):// 开头，收到 ${JSON.stringify(rawUrl)}`, 1);
  }
  if (!token) return fail('缺少 BOARD_TOKEN（环境变量或 --token）', 1);
  const url = rawUrl.replace(/\/+$/, '');

  let intervalMs = 0;
  if (args.watchPresent) {
    if (args.watchRaw === undefined || args.watchRaw === '') {
      return fail('--watch 需要一个秒数，例如 --watch 30', 1);
    }
    const sec = Number(args.watchRaw);
    if (!Number.isFinite(sec) || sec <= 0) {
      return fail(`--watch 秒数无效：${JSON.stringify(args.watchRaw)}`, 1);
    }
    intervalMs = Math.max(1000, Math.round(sec * 1000));
  }

  const dbPath = args.db ?? resolveDbPath(argv);
  let store;
  try {
    store = openStore(dbPath);
  } catch (err) {
    return fail(`打开账本失败 ${dbPath}: ${err.message}`, 3);
  }

  let stopping = false;
  let wake = null;
  let timer = null;
  function interruptSleep(ms) {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => { timer = null; wake = null; resolve(); }, ms);
    });
  }
  function onSignal() {
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    const r = wake; wake = null; if (r) r();
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    if (!intervalMs) {
      try {
        await pushOnce({ store, url, token });
        return 0;
      } catch (err) {
        return fail(`推送失败（${url}）: ${err.message}`, 2);
      }
    }

    console.log(`[publish] watch 模式：每 ${intervalMs / 1000}s 推送 ${url} ← ${dbPath}（Ctrl+C 退出）`);
    let failures = 0;
    while (!stopping) {
      try {
        await pushOnce({ store, url, token });
        if (failures) console.log(`[publish] 已恢复（此前连续失败 ${failures} 次）`);
        failures = 0;
      } catch (err) {
        failures += 1;
        console.error(`[publish] 第 ${failures} 次连续失败（${url}）: ${err.message}`);
      }
      if (stopping) break;
      await interruptSleep(intervalMs);
    }
    console.log('[publish] 收到退出信号，停止推送');
    return 0;
  } finally {
    try { store.close(); } catch { /* already closed */ }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`[publish] 未预期错误: ${err?.stack ?? err}`);
      process.exitCode = 3;
    });
}
