// TaskPier — Feishu alert channel (D18-design: only three statuses push).
// Scans the task store for waiting_decision / blocked / review tasks and
// pushes alerts via lark-cli (bot identity). Idempotent: an `alert_sent`
// event per task suppresses re-pushes within the dedup window.
//
// Usage:
//   node channels/feishu/notify.mjs [--db <path>] [--user-id <openId>]
//        [--window-min <minutes=10>] [--force] [--dry-run] [--print]
//
// --print  : render messages and print JSON without contacting lark-cli (tests)
// --dry-run: build+send via lark-cli but with its own --dry-run (no delivery)
// recipient: --user-id > TASKPIER_FEISHU_TO env

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolveDbPath } from '../../core/src/dbpath.mjs';
import { openStore } from '../../core/src/store.mjs';

const ALERT_STATUSES = ['waiting_decision', 'blocked', 'review'];

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const has = (flag) => argv.includes(flag);
  return {
    db: get('--db'),
    userId: get('--user-id') ?? process.env.TASKPIER_FEISHU_TO,
    windowMin: Number(get('--window-min') ?? 10),
    force: has('--force'),
    dryRun: has('--dry-run'),
    print: has('--print'),
  };
}

function renderMessage(task) {
  const ref = `#${task.id}`; // chat shorthand; core accepts #N / tp-N / N
  const lines = [`【VibeMission】${ref} ${task.title}`];
  if (task.status === 'blocked') {
    lines.push(`⛔ 状态：阻塞`, `原因：${task.blocked_reason ?? '(未填)'}`, `动作：请到 ZCode 解除阻塞（或回复"取消 ${ref}"）`);
  } else if (task.status === 'waiting_decision') {
    lines.push(`❓ 状态：待你拍板`, `问题：${task.decision_question ?? ''}`);
    const opts = Array.isArray(task.decision_options) ? task.decision_options : [];
    if (opts.length) lines.push(`选项：${opts.join(' / ')}（回复选项文字即可）`);
  } else if (task.status === 'review') {
    lines.push(`✅ 状态：已完成，等验收`, `动作：回复"通过 ${ref}"或"打回 ${ref} + 意见"`);
  }
  return lines.join('\n');
}

/** @returns {{pushed: Array, skipped: Array}} */
export function collect(store, { windowMin = 10, force = false } = {}) {
  const pushed = [];
  const skipped = [];
  for (const task of store.listByStatus(ALERT_STATUSES, 50)) {
    const events = store.listEvents(task.id, 30);
    const lastAlert = events.find((e) => e.kind === 'alert_sent');
    if (!force && lastAlert && Date.now() - lastAlert.ts < windowMin * 60_000) {
      skipped.push({ displayId: task.displayId, reason: 'deduped' });
      continue;
    }
    pushed.push({ task, message: renderMessage(task) });
  }
  return { pushed, skipped };
}

function resolveLarkCli() {
  // Prefer the npm entry script (no shell → arguments with spaces/newlines
  // pass intact); fall back to the command on PATH for non-Windows setups.
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  const runJs = join(appData, 'npm', 'node_modules', '@larksuite', 'cli', 'scripts', 'run.js');
  if (existsSync(runJs)) return { cmd: process.execPath, base: [runJs] };
  return { cmd: 'lark-cli', base: [] };
}

function sendViaLarkCli(message, userId, dryRun) {
  const { cmd, base } = resolveLarkCli();
  const args = [...base, 'im', '+messages-send', '--as', 'bot', '--user-id', userId, '--text', message];
  if (dryRun) args.push('--dry-run');
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 30_000 });
  if (r.error) return { ok: false, error: r.error.message };
  try {
    const out = JSON.parse(r.stdout);
    return { ok: out.ok === true, data: out.data ?? null, stderr: r.stderr?.slice(0, 300) };
  } catch {
    return { ok: false, error: `unparseable output: ${(r.stdout || r.stderr || '').slice(0, 300)}` };
  }
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const dbPath = opts.db ?? resolveDbPath();
  const store = openStore(dbPath);
  const { pushed, skipped } = collect(store, { windowMin: opts.windowMin, force: opts.force });

  if (opts.print) {
    console.log(JSON.stringify({ db: dbPath, messages: pushed.map((p) => ({ displayId: p.task.displayId, message: p.message })), skipped }, null, 2));
    store.close();
    return;
  }

  if (!opts.userId) {
    console.error('recipient missing: pass --user-id <openId> or set TASKPIER_FEISHU_TO');
    store.close();
    process.exit(2);
  }

  const results = [];
  for (const { task, message } of pushed) {
    const r = sendViaLarkCli(message, opts.userId, opts.dryRun);
    if (r.ok && !opts.dryRun) {
      store.appendEvent(task.id, 'alert_sent', 'channel:feishu', { to: opts.userId, messageId: r.data?.message_id ?? null });
    }
    results.push({ displayId: task.displayId, ok: r.ok, dryRun: opts.dryRun, messageId: r.data?.message_id ?? null, error: r.error ?? null });
  }
  console.log(JSON.stringify({ db: dbPath, pushed: results, skipped }, null, 2));
  store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
