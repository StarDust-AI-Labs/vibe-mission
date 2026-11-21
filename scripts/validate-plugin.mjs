// TaskPier plugin validator — zero-dependency node equivalent of
// plugin-creator's validate_plugin.py (python3 unavailable on this machine;
// deviation recorded in docs/decisions.md D15).
//
// Checks (per plugin-creator discipline):
//  1. manifest parses, name matches folder, no [TODO placeholders
//  2. every ${ZCODE_PLUGIN_ROOT}/... reference in manifest resolves to an existing file
//  3. skills/ present with valid SKILL.md frontmatter (name + description)
//  4. hooks/hooks.json: events are among the 7 supported; process hooks have command+args
//  5. repo-root marketplace.json entry resolves; manifest name matches entry
//  6. bundled core freshness: core/src/*.mjs hashes equal plugin copies

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(repoRoot, 'adapters', 'zcode', 'taskpier');
const SUPPORTED_HOOK_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Stop',
]);

const problems = [];
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { problems.push(msg); console.log(`  FAIL ${msg}`); };

// 1. manifest
const manifestPath = join(pluginRoot, '.zcode-plugin', 'plugin.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  ok(`manifest parses (${manifest.name}@${manifest.version})`);
} catch (e) {
  fail(`manifest unreadable: ${e.message}`);
  process.exit(1);
}
if (manifest.name !== 'taskpier') fail(`manifest.name mismatch: ${manifest.name}`);
if (JSON.stringify(manifest).includes('[TODO')) fail('manifest contains [TODO placeholder]');

// 2. ${ZCODE_PLUGIN_ROOT} references resolve inside plugin root
function walkRefs(node, cb) {
  if (typeof node === 'string') {
    for (const m of node.matchAll(/\$\{ZCODE_PLUGIN_ROOT\}\/([^\s"]+)/g)) cb(m[1]);
  } else if (Array.isArray(node)) node.forEach((x) => walkRefs(x, cb));
  else if (node && typeof node === 'object') Object.values(node).forEach((x) => walkRefs(x, cb));
}
walkRefs(manifest, (rel) => {
  const p = join(pluginRoot, rel);
  if (!existsSync(p)) fail(`manifest references missing file: ${rel}`);
  else ok(`manifest ref exists: ${rel}`);
});

// 3. skills
const skillPath = join(pluginRoot, 'skills', 'zcode-task-owner', 'SKILL.md');
if (!existsSync(skillPath)) fail('missing skills/zcode-task-owner/SKILL.md');
else {
  const head = readFileSync(skillPath, 'utf8').slice(0, 800);
  if (!/^---\s*\n[\s\S]*name:\s*zcode-task-owner/.test(head)) fail('SKILL.md frontmatter missing name: zcode-task-owner');
  else if (!/description:/.test(head)) fail('SKILL.md frontmatter missing description');
  else ok('owner SKILL.md frontmatter valid');
}

// 4. hooks
const hooksPath = join(pluginRoot, 'hooks', 'hooks.json');
if (existsSync(hooksPath)) {
  try {
    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
    for (const [event, matchers] of Object.entries(hooks.hooks ?? {})) {
      if (!SUPPORTED_HOOK_EVENTS.has(event)) fail(`unsupported hook event: ${event}`);
      for (const m of matchers ?? []) {
        for (const h of m.hooks ?? []) {
          if (h.type === 'process' && !(h.command && Array.isArray(h.args))) {
            fail(`hook ${event}: process hook missing command/args`);
          }
        }
      }
      ok(`hook event ${event} declared (${(matchers ?? []).length} matcher)`);
    }
  } catch (e) {
    fail(`hooks.json unreadable: ${e.message}`);
  }
}

// 5. marketplace entry
const mpPath = join(repoRoot, 'marketplace.json');
try {
  const mp = JSON.parse(readFileSync(mpPath, 'utf8'));
  const entry = (mp.plugins ?? []).find((p) => p.name === manifest.name);
  if (!entry) fail(`marketplace.json has no entry for ${manifest.name}`);
  else {
    const dir = resolve(repoRoot, entry.source?.path ?? entry.source ?? '');
    if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`marketplace source path missing: ${entry.source?.path ?? entry.source}`);
    else ok(`marketplace entry resolves: ${entry.source?.path ?? entry.source}`);
  }
} catch (e) {
  fail(`marketplace.json unreadable: ${e.message}`);
}

// 6. core freshness (hash compare)
for (const f of ['errors', 'dbpath', 'state-machine', 'store', 'tools', 'mcp-server']) {
  const src = readFileSync(join(repoRoot, 'core', 'src', `${f}.mjs`));
  const dstPath = join(pluginRoot, 'core', `${f}.mjs`);
  if (!existsSync(dstPath)) { fail(`bundled core missing: core/${f}.mjs (run scripts/sync-core.mjs)`); continue; }
  const a = createHash('sha256').update(src).digest('hex');
  const b = createHash('sha256').update(readFileSync(dstPath)).digest('hex');
  if (a !== b) fail(`bundled core stale: core/${f}.mjs (run scripts/sync-core.mjs)`);
  else ok(`core/${f}.mjs in sync`);
}

console.log(problems.length === 0 ? '\nvalidate: PASS' : `\nvalidate: FAIL (${problems.length})`);
process.exit(problems.length === 0 ? 0 : 1);
