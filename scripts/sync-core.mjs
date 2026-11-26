// VibeMission plugin build step (D14/D15): copy the canonical core into the
// plugin root so the installed plugin is self-contained (component paths must
// stay inside the plugin root). Idempotent — safe to re-run after core edits.

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'adapters', 'zcode', 'vibemission');

const files = [
  ['core/src/errors.mjs', 'core/errors.mjs'],
  ['core/src/dbpath.mjs', 'core/dbpath.mjs'],
  ['core/src/state-machine.mjs', 'core/state-machine.mjs'],
  ['core/src/store.mjs', 'core/store.mjs'],
  ['core/src/tools.mjs', 'core/tools.mjs'],
  ['core/src/mcp-server.mjs', 'core/mcp-server.mjs'],
  ['core/types/ports.d.ts', 'core/types/ports.d.ts'],
];

for (const [from, to] of files) {
  const src = resolve(pluginRoot, '..', '..', '..', from);
  const dst = join(pluginRoot, to);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  console.log(`synced ${from} -> adapters/zcode/vibemission/${to}`);
}
console.log('core sync complete');
