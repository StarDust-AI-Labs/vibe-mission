// TaskPier adapter validator — zero-dependency node equivalent of
// plugin-creator's validate_plugin.py (python3 unavailable on this machine;
// deviation recorded in docs/decisions.md D15).
//
// Since the WorkBuddy adapter landed (2026-11-23, rule of two), this walks
// EVERY adapter under adapters/ and applies the checks that fit its install
// mode:
//  - zcode (plugin-marketplace mode): manifest/hooks/skills/marketplace +
//    bundled-core freshness (self-contained copies required)
//  - workbuddy (reference mode): expert manifest/skill + referenced-core
//    existence (no bundled copies — D4)
//
// Checks (per plugin-creator discipline):
//  1. manifest parses, name matches, no [TODO placeholders
//  2. every ${ZCODE_PLUGIN_ROOT}/... reference in manifest resolves (zcode)
//  3. skills/ present with valid SKILL.md frontmatter (name + description)
//  4. hooks/hooks.json: events among the 7 supported; process hooks have command+args (zcode)
//  5. repo-root marketplace.json entry resolves (zcode)
//  6. zcode bundled core freshness: core/src/*.mjs hashes equal plugin copies
//  7. workbuddy: referenced core files exist; config parses; installer+observer present

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SUPPORTED_HOOK_EVENTS = new Set([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
  'PostToolUse', 'PostToolUseFailure', 'Stop',
]);

const problems = [];
const ok = (msg) => console.log(`  ok   ${msg}`);
const fail = (msg) => { problems.push(msg); console.log(`  FAIL ${msg}`); };

// ---------------- zcode adapter (plugin-marketplace mode) ----------------

function validateZcode() {
  const pluginRoot = join(repoRoot, 'adapters', 'zcode', 'vibemission');
  console.log('\n[zcode adapter]');

  // 1. manifest
  const manifestPath = join(pluginRoot, '.zcode-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    ok(`manifest parses (${manifest.name}@${manifest.version})`);
  } catch (e) {
    fail(`manifest unreadable: ${e.message}`);
    return;
  }
  if (manifest.name !== 'vibemission') fail(`manifest.name mismatch: ${manifest.name}`);
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
  const skillPath = join(pluginRoot, 'skills', 'vibemission-owner', 'SKILL.md');
  if (!existsSync(skillPath)) fail('missing skills/vibemission-owner/SKILL.md');
  else {
    const head = readFileSync(skillPath, 'utf8').slice(0, 800);
    if (!/^---\s*\n[\s\S]*name:\s*vibemission-owner/.test(head)) fail('SKILL.md frontmatter missing name: vibemission-owner');
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
}

// ---------------- workbuddy adapter (reference mode, D4) ----------------

function validateWorkbuddy() {
  const pluginRoot = join(repoRoot, 'adapters', 'workbuddy', 'taskpier');
  console.log('\n[workbuddy adapter]');

  // 1. expert manifest
  const manifestPath = join(pluginRoot, 'expert', '.codebuddy-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    ok(`expert manifest parses (${manifest.name}@${manifest.version})`);
  } catch (e) {
    fail(`expert manifest unreadable: ${e.message}`);
    return;
  }
  if (manifest.name !== 'taskpier-foreman') fail(`manifest.name mismatch: ${manifest.name}`);
  if (JSON.stringify(manifest).includes('[TODO')) fail('manifest contains [TODO placeholder]');
  if (manifest.license !== 'MIT') fail('manifest.license must be MIT (repo-wide)');

  // 2. agents references resolve (relative to the manifest file)
  for (const rel of manifest.agents ?? []) {
    const p = resolve(dirname(manifestPath), rel);
    if (!existsSync(p)) fail(`manifest agents ref missing: ${rel}`);
    else ok(`agents ref exists: ${rel}`);
  }

  // 3. skill frontmatter (inside expert/ — it ships with the expert package)
  const skillPath = join(pluginRoot, 'expert', 'skills', 'workbuddy-foreman', 'SKILL.md');
  if (!existsSync(skillPath)) fail('missing skills/workbuddy-foreman/SKILL.md');
  else {
    const head = readFileSync(skillPath, 'utf8').slice(0, 800);
    if (!/^---\s*\n[\s\S]*name:\s*workbuddy-foreman/.test(head)) fail('SKILL.md frontmatter missing name: workbuddy-foreman');
    else if (!/description:/.test(head)) fail('SKILL.md frontmatter missing description');
    else ok('foreman SKILL.md frontmatter valid');
  }

  // 4. adapter components present
  for (const rel of ['reconcile/observer.mjs', 'install.mjs', 'test/reconcile.test.mjs']) {
    if (!existsSync(join(pluginRoot, rel))) fail(`missing adapter file: ${rel}`);
    else ok(`adapter file exists: ${rel}`);
  }
  try {
    JSON.parse(readFileSync(join(pluginRoot, 'config', 'workbuddy.json'), 'utf8'));
    ok('config/workbuddy.json parses');
  } catch (e) {
    fail(`config/workbuddy.json unreadable: ${e.message}`);
  }

  // 5. referenced core exists (reference install: no bundled copies by design)
  for (const f of ['dbpath', 'store', 'state-machine', 'errors']) {
    const p = join(repoRoot, 'core', 'src', `${f}.mjs`);
    if (!existsSync(p)) fail(`referenced core missing: core/src/${f}.mjs`);
    else ok(`referenced core exists: core/src/${f}.mjs`);
  }
}

validateZcode();
validateWorkbuddy();

console.log(problems.length === 0 ? '\nvalidate: PASS' : `\nvalidate: FAIL (${problems.length})`);
process.exit(problems.length === 0 ? 0 : 1);
