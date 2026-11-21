// TaskPier SessionStart hook — injects a short task-board briefing.
// Output contract (docs/diagnosing-hooks): stdout must be strict JSON; the
// recognized key `additionalContext` is injected into the conversation. Any
// failure exits 0 silently — a hook must never break the session.
//
// NOTE (P0-verify): the exact output schema for additionalContext on
// SessionStart is documented but not yet runtime-verified on this host; if the
// host rejects the output, adjust here first.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openStore } from '../core/store.mjs';

/**
 * DB path resolution — MUST match the MCP server's chain. The primary source
 * of truth is ~/.agents/mcp.json (taskpier server env), so the hook finds the
 * same store the server writes to even without shared environment variables.
 */
function findExistingDb() {
  const candidates = [];
  if (process.env.TASKPIER_DB_PATH) candidates.push(process.env.TASKPIER_DB_PATH);
  try {
    const agentMcp = resolve(homedir(), '.agents', 'mcp.json');
    if (existsSync(agentMcp)) {
      const conf = JSON.parse(readFileSync(agentMcp, 'utf8'));
      const env = conf?.mcpServers?.taskpier?.env;
      if (env?.TASKPIER_DB_PATH) candidates.push(env.TASKPIER_DB_PATH);
    }
  } catch { /* config absent or unreadable — fall through */ }
  if (process.env.TASKPIER_PLUGIN_DATA) candidates.push(`${process.env.TASKPIER_PLUGIN_DATA}/taskpier.sqlite`);
  if (process.env.ZCODE_PLUGIN_DATA) candidates.push(`${process.env.ZCODE_PLUGIN_DATA}/taskpier.sqlite`);
  candidates.push(resolve(process.cwd(), 'taskpier.sqlite'));
  return candidates.find((p) => existsSync(p)) ?? null;
}

function briefing() {
  const dbPath = findExistingDb();
  if (!dbPath) return null;
  const store = openStore(dbPath);
  try {
    const c = store.counts();
    const active = c.running + c.waiting_decision + c.blocked + c.review;
    if (active === 0 && c.todo === 0 && c.inbox === 0) return null; // nothing to say

    const lines = [`【TaskPier 任务态势】执行中 ${c.running} / 待决策 ${c.waiting_decision} / 阻塞 ${c.blocked} / 待验收 ${c.review}（待办 ${c.todo}）`];
    if (active > 0) {
      const alerts = store.listByStatus(['waiting_decision', 'blocked', 'review'], 5);
      for (const t of alerts) {
        const why = t.status === 'blocked' ? `：${t.blocked_reason ?? ''}`
          : t.status === 'waiting_decision' ? `：${t.decision_question ?? ''}`
          : '';
        lines.push(`- ${t.displayId} ${t.title} [${t.status}]${why}`);
      }
    }
    lines.push('若你被指派为工程负责人（owner），先调用 board_summary 获取完整看板再行动。');
    return lines.join('\n');
  } finally {
    store.close();
  }
}

try {
  const text = briefing();
  if (text) process.stdout.write(`${JSON.stringify({ additionalContext: text })}\n`);
  process.exit(0);
} catch {
  process.exit(0); // silent: never break the session on hook failure
}
