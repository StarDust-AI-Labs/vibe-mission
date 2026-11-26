// TaskPier board — snapshot exporter (D18, user-chosen distribution form).
// Reads the live store, renders the board page with inline data, and builds a
// ZCode Sites stage (index.html + start.sh + static-server.mjs).
//
// Usage:
//   node board/snapshot.mjs                 # build .zcode-site/stage/
//   node board/snapshot.mjs --out <dir>     # custom stage dir
//
// Deploy (manual, per ZCode Sites skill):
//   node <zcode-site skill>/scripts/zcode-site.mjs deploy .zcode-site/stage

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveDbPath } from '../core/src/dbpath.mjs';
import { openStore } from '../core/src/store.mjs';
import { buildBoardData } from './data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
// Vendored copies of the ZCode Sites static templates (skill zcode-site 0.5.1),
// so snapshot builds are reproducible on any machine and in CI. To use a
// different skill version, point ZCODE_SITE_TEMPLATES at its templates dir.
const SKILL_TEMPLATES = process.env.ZCODE_SITE_TEMPLATES ?? join(HERE, 'templates');

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  return { out: get('--out'), db: get('--db') };
}

export function buildStage({ out, db } = {}) {
  const stage = out ? resolve(out) : join(REPO, '.zcode-site', 'stage');
  const dbPath = db ?? resolveDbPath();
  const store = openStore(dbPath);
  let data;
  try {
    data = buildBoardData(store);
  } finally {
    store.close();
  }

  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const page = readFileSync(join(HERE, 'page.html'), 'utf8');
  const boot = `window.__TASKPIER_BOOT__={mode:"snapshot",data:${JSON.stringify(data)}};`;
  writeFileSync(join(stage, 'index.html'), page.replace('window.__TASKPIER_BOOT__=/*__BOOT__*/null;', boot));

  // ZCode Sites static template: copy verbatim, then adjust the ADJUST lines.
  cpSync(join(SKILL_TEMPLATES, 'static-server.mjs'), join(stage, 'static-server.mjs'));
  const staticSh = readFileSync(join(SKILL_TEMPLATES, 'static.sh'), 'utf8')
    .replace('SITE_DIR=dist', 'SITE_DIR=.')
    .replace('export SPA_FALLBACK=1', 'export SPA_FALLBACK=0');
  writeFileSync(join(stage, 'start.sh'), staticSh);

  console.log(`stage built: ${stage}`);
  console.log(`  snapshot generatedAt: ${data.generatedAt}`);
  console.log(`  tasks: ${Object.values(data.counts).reduce((a, b) => a + b, 0)}`);
  return stage;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildStage(parseArgs(process.argv.slice(2)));
}
