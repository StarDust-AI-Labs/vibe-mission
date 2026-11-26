// VibeMission — shared DB path resolution chain.
// One source of truth for every process that touches the task store:
// MCP server, SessionStart hook, board server, snapshot exporter.
// Order: --db flag > TASKPIER_DB_PATH > ~/.agents/mcp.json (taskpier env)
//        > TASKPIER_PLUGIN_DATA > ZCODE_PLUGIN_DATA > ./taskpier.sqlite

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** @param {string[]} [argv] process.argv.slice(2) style args */
export function resolveDbPath(argv = []) {
  const flagIdx = argv.indexOf('--db');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  if (process.env.TASKPIER_DB_PATH) return process.env.TASKPIER_DB_PATH;

  // ~/.agents/mcp.json is the runtime wiring source (D17): the taskpier entry's
  // env.TASKPIER_DB_PATH is where the MCP server writes — hooks/board follow it.
  try {
    const agentMcp = join(homedir(), '.agents', 'mcp.json');
    if (existsSync(agentMcp)) {
      const conf = JSON.parse(readFileSync(agentMcp, 'utf8'));
      const env = conf?.mcpServers?.vibemission?.env ?? conf?.mcpServers?.taskpier?.env;
      if (env?.TASKPIER_DB_PATH) return env.TASKPIER_DB_PATH;
    }
  } catch { /* absent or unreadable — fall through */ }

  if (process.env.TASKPIER_PLUGIN_DATA) return `${process.env.TASKPIER_PLUGIN_DATA}/taskpier.sqlite`;
  if (process.env.ZCODE_PLUGIN_DATA) return `${process.env.ZCODE_PLUGIN_DATA}/taskpier.sqlite`;
  return resolve('./taskpier.sqlite');
}
