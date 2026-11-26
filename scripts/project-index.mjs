// VibeMission project index — intent → project → execution workspace.
// Single source of routing: the owner resolves a task's project from user intent
// and takes the execution directory from here, never from memory.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INDEX_PATH = resolve(HERE, '..', 'projects.json');

/** @typedef {{id:string,name:string,product:string,workspace:string,keywords:string[]}} Project */

export function loadIndex(path = DEFAULT_INDEX_PATH) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(raw.projects)) throw new Error(`projects.json: "projects" must be an array (${path})`);
  for (const p of raw.projects) {
    for (const key of ['id', 'name', 'workspace']) {
      if (!p[key]) throw new Error(`projects.json: project missing "${key}" (${JSON.stringify(p)})`);
    }
    if (!Array.isArray(p.keywords)) p.keywords = [];
  }
  return raw;
}

/**
 * Resolve which project an intent belongs to.
 * @returns {{status:'ok',project:Project,score:number}
 *          |{status:'ambiguous',candidates:Array<{project:Project,score:number}>}
 *          |{status:'none',candidates:[]}}
 */
export function resolveProject(intent, index = loadIndex()) {
  const text = String(intent || '').toLowerCase();
  if (!text.trim()) return { status: 'none', candidates: [] };

  const scored = index.projects.map((project) => {
    let score = 0;
    // Direct id/name hit is the strongest signal.
    if (text.includes(project.id.toLowerCase())) score += 10;
    if (text.includes(project.name.toLowerCase())) score += 8;
    for (const kw of project.keywords) {
      const k = String(kw).toLowerCase();
      if (k && text.includes(k)) score += k.length; // longer keyword = more specific
    }
    return { project, score };
  });

  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length === 0) return { status: 'none', candidates: [] };
  if (hits.length > 1 && hits[0].score === hits[1].score) {
    return { status: 'ambiguous', candidates: hits.filter((h) => h.score === hits[0].score) };
  }
  return { status: 'ok', project: hits[0].project, score: hits[0].score };
}

/** Human-readable one-liner for the owner to echo back before dispatching. */
export function describeResolution(res) {
  if (res.status === 'ok') return `→ ${res.project.name}（${res.project.workspace}）`;
  if (res.status === 'ambiguous') {
    return `候选不唯一：${res.candidates.map((c) => `${c.project.name}(${c.project.workspace})`).join(' / ')}`;
  }
  return '未命中任何项目：需要人指定执行目录';
}

// ── CLI ───────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--resolve');
  const index = loadIndex();
  if (idx !== -1) {
    const res = resolveProject(args.slice(idx + 1).join(' '), index);
    console.log(JSON.stringify({ status: res.status, ...(res.status === 'ok'
      ? { project: res.project.id, name: res.project.name, workspace: res.project.workspace, product: res.project.product }
      : { candidates: (res.candidates || []).map((c) => ({ id: c.project.id, workspace: c.project.workspace })) }) }, null, 2));
    process.exit(res.status === 'ok' ? 0 : 2);
  }
  // default: list
  for (const p of index.projects) console.log(`${p.id}\t${p.name}\t${p.product}\t${p.workspace}\t${p.keywords.join(',')}`);
}
