// TaskPier core — zero-dependency MCP stdio server.
// Framing: newline-delimited JSON-RPC 2.0 on stdio (same transport pattern the
// official ZCode panel plugins use). Methods: initialize, notifications/*,
// tools/list, tools/call, ping.
//
// Usage:
//   node mcp-server.mjs [--db <path>]
// DB path resolution order: --db flag > TASKPIER_DB_PATH env >
// TASKPIER_PLUGIN_DATA env (host-provided data dir) > ./taskpier.sqlite

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { openStore } from './store.mjs';
import { buildTools } from './tools.mjs';
import { TaskPierError } from './errors.mjs';

const SERVER_INFO = { name: 'taskpier-core', version: '0.1.0' };
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-11-25']);

function resolveDbPath(argv) {
  const flagIdx = argv.indexOf('--db');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  if (process.env.TASKPIER_DB_PATH) return process.env.TASKPIER_DB_PATH;
  if (process.env.TASKPIER_PLUGIN_DATA) return `${process.env.TASKPIER_PLUGIN_DATA}/taskpier.sqlite`;
  return './taskpier.sqlite';
}

/** Build the JSON-RPC method router against a store. */
export function createRouter(store) {
  const { toolDefs, handlers } = buildTools(store);

  return function route(msg) {
    const { id, method, params } = msg;

    // Notifications (no id): nothing to answer.
    if (id === undefined || id === null) return null;

    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const version =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION;
        return {
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        };
      }
      case 'tools/list':
        return { id, result: { tools: toolDefs } };
      case 'tools/call': {
        const name = params?.name;
        const handler = handlers[name];
        if (!handler) {
          return {
            id,
            error: { code: -32602, message: `unknown tool: ${name}` },
          };
        }
        try {
          const result = handler(params?.arguments ?? {});
          return {
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result) }],
              structuredContent: result,
            },
          };
        } catch (err) {
          if (err instanceof TaskPierError) {
            return {
              id,
              result: {
                isError: true,
                content: [{ type: 'text', text: `[${err.code}] ${err.message}` }],
                structuredContent: { error: err.code, message: err.message, data: err.data ?? null },
              },
            };
          }
          return {
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `[internal] ${err?.message ?? String(err)}` }],
            },
          };
        }
      }
      case 'ping':
        return { id, result: {} };
      default:
        return { id, error: { code: -32601, message: `method not found: ${method}` } };
    }
  };
}

export function main(argv = process.argv) {
  const dbPath = resolveDbPath(argv.slice(2));
  const store = openStore(dbPath);
  const route = createRouter(store);
  const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const reply = route(msg);
    if (reply) write(reply);
  });
  rl.on('close', () => {
    try { store.close(); } catch { /* best effort */ }
    process.exit(0);
  });
  process.on('SIGINT', () => {
    try { store.close(); } catch { /* best effort */ }
    process.exit(0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
