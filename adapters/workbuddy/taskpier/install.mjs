// TaskPier WorkBuddy adapter installer (migrated from the foreman prototype
// install.mjs; 2026-11-23 merge decision D4: reference-style install).
//
// WorkBuddy loads MCP servers from ~/.workbuddy/mcp.json by absolute path —
// unlike the ZCode plugin-marketplace mode there is NO self-containment
// requirement, so this adapter references the repo's core directly
// (core/src/mcp-server.mjs) and needs no bundled core copy.
//
// Three states: dry-run (default, writes nothing) / --apply / --rollback.
// Deployment store (D5): <adapter>/.taskpier/tasks.sqlite, injected via
// TASKPIER_DB_PATH so server/hook/observer all resolve the same db.

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(ADAPTER_ROOT, '..', '..', '..');
const HOME = process.env.USERPROFILE || process.env.HOME;
const MCP_JSON = join(HOME, '.workbuddy', 'mcp.json');
const EXPERT_DEST = join(HOME, '.workbuddy', 'plugins', 'marketplaces', 'my-experts', 'plugins', 'taskpier-foreman');
const SERVER = join(REPO_ROOT, 'core', 'src', 'mcp-server.mjs');
const DB_PATH = join(ADAPTER_ROOT, '.taskpier', 'tasks.sqlite');
// Prefer WorkBuddy's bundled node (PATH is unreliable when the host spawns
// the MCP child); fall back to bare `node` when the bundled one is absent.
const BUNDLED_NODE = join(HOME, '.workbuddy', 'binaries', 'node', 'versions', '22.22.2-6', 'node.exe');
const NODE_BIN = existsSync(BUNDLED_NODE) ? BUNDLED_NODE : 'node';

const MCP_ENTRY = {
  taskpier: {
    type: 'stdio',
    command: NODE_BIN,
    args: [SERVER],
    env: { TASKPIER_DB_PATH: DB_PATH },
  },
};

const apply = process.argv.includes('--apply');
const rollback = process.argv.includes('--rollback');
const log = (...a) => console.log(...a);

function backup(path) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dst = `${path}.taskpier-bak-${stamp}`;
  copyFileSync(path, dst);
  return dst;
}

if (rollback) {
  const expertOk = existsSync(EXPERT_DEST);
  if (expertOk) rmSync(EXPERT_DEST, { recursive: true, force: true });
  log(`[rollback] 专家包已移除: ${EXPERT_DEST} (${expertOk ? 'existed' : 'not found'})`);
  if (existsSync(MCP_JSON)) {
    const mcp = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
    if (mcp.mcpServers?.taskpier) {
      delete mcp.mcpServers.taskpier;
      writeFileSync(MCP_JSON, JSON.stringify(mcp, null, 2) + '\n');
      log('[rollback] mcp.json 中 taskpier 条目已删除');
    } else log('[rollback] mcp.json 无 taskpier 条目，跳过');
  } else log('[rollback] mcp.json 不存在，跳过');
  log('[rollback] 完成。请重启 WorkBuddy 使 MCP 列表刷新。');
  process.exit(0);
}

log(`模式: ${apply ? 'APPLY（真写）' : 'DRY-RUN（只预览，不写任何文件）'}`);
log(`node     : ${NODE_BIN} ${NODE_BIN === 'node' ? '(bundled 缺失，回退 PATH)' : '[OK]'}`);
log(`mcp.json : ${MCP_JSON} ${existsSync(MCP_JSON) ? '[OK]' : '[MISSING — apply 时将创建]'}`);
log(`MCP server: ${SERVER} ${existsSync(SERVER) ? '[OK]' : '[MISSING!]'}`);
log(`部署任务库: ${DB_PATH}（首次调用时自动建库）`);
log(`专家包源 : ${join(ADAPTER_ROOT, 'expert')}`);
log(`专家包目标: ${EXPERT_DEST}`);
log(`MCP 条目 :
${JSON.stringify(MCP_ENTRY, null, 2).replace(/^/gm, '  ')}
`);

if (!apply) {
  log('未写入任何文件。确认后加 --apply 执行；反悔用 --rollback。');
  process.exit(0);
}

// --apply
if (!existsSync(SERVER)) { log('[abort] core/src/mcp-server.mjs 不存在，仓库不完整'); process.exit(1); }
mkdirSync(dirname(DB_PATH), { recursive: true });
mkdirSync(dirname(EXPERT_DEST), { recursive: true });
cpSync(join(ADAPTER_ROOT, 'expert'), EXPERT_DEST, { recursive: true });
log(`[apply] 专家包已安装: ${EXPERT_DEST}`);

if (existsSync(MCP_JSON)) {
  const bak = backup(MCP_JSON);
  const mcp = JSON.parse(readFileSync(MCP_JSON, 'utf8'));
  mcp.mcpServers = mcp.mcpServers ?? {};
  mcp.mcpServers.taskpier = MCP_ENTRY.taskpier;
  writeFileSync(MCP_JSON, JSON.stringify(mcp, null, 2) + '\n');
  log(`[apply] mcp.json 已写入（备份: ${bak}）`);
} else {
  mkdirSync(dirname(MCP_JSON), { recursive: true });
  writeFileSync(MCP_JSON, `${JSON.stringify({ mcpServers: MCP_ENTRY }, null, 2)}\n`);
  log('[apply] mcp.json 已创建');
}
log('[apply] 完成。请重启 WorkBuddy，然后对包工头说「今天有哪些任务在跑？」验收。');
