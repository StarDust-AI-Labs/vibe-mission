// VibeMission — Entry router evaluation (corpus → metrics).
//
// Gates (docs/entry-router.md §6): L0 coverage ≥ 70%, overall accuracy ≥ 90%,
// critical recall = 100%. `node channels/ingress/evaluate.mjs` prints the
// metrics and exits non-zero when a gate fails, so CI uses the same thresholds.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyRoute, ROUTES } from './router.mjs';

export const GATES = { l0Coverage: 0.7, accuracy: 0.9, criticalRecall: 1 };

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CORPUS = resolve(HERE, '..', 'test', 'fixtures', 'ingress-corpus.jsonl');

/** @param {string} path */
export function loadCorpus(path = DEFAULT_CORPUS) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, i) => {
      const row = JSON.parse(line);
      if (!ROUTES.includes(row.label)) throw new Error(`corpus line ${i + 1}: unknown label ${row.label}`);
      return row;
    });
}

/**
 * @param {Array} corpus
 * @returns {{total:number, correct:number, accuracy:number, l0:number, l0Coverage:number,
 *            criticalTotal:number, criticalCorrect:number, criticalRecall:number, misses:Array, passed:boolean}}
 */
export function evaluate(corpus) {
  const misses = [];
  let correct = 0;
  let l0 = 0;
  let criticalTotal = 0;
  let criticalCorrect = 0;

  for (const row of corpus) {
    const decision = classifyRoute({ text: row.text, meta: row.meta });
    const hit = decision.route === row.label;
    if (hit) correct++;
    if (decision.layer === 'L0') l0++;
    if (row.critical) {
      criticalTotal++;
      if (hit) criticalCorrect++;
    }
    if (!hit) {
      misses.push({
        id: row.id,
        text: row.text,
        expected: row.label,
        got: decision.route,
        ruleId: decision.ruleId,
        layer: decision.layer,
        note: row.note,
      });
    }
  }

  const total = corpus.length || 1;
  const accuracy = correct / total;
  const l0Coverage = l0 / total;
  const criticalRecall = criticalTotal ? criticalCorrect / criticalTotal : 1;
  const passed =
    accuracy >= GATES.accuracy && l0Coverage >= GATES.l0Coverage && criticalRecall >= GATES.criticalRecall;

  return { total, correct, accuracy, l0, l0Coverage, criticalTotal, criticalCorrect, criticalRecall, misses, passed };
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatReport(m) {
  const lines = [
    `语料 ${m.total} 条｜准确率 ${pct(m.accuracy)}（门槛 ${pct(GATES.accuracy)}）`,
    `L0 覆盖 ${m.l0}/${m.total} = ${pct(m.l0Coverage)}（门槛 ${pct(GATES.l0Coverage)}）`,
    `关键类召回 ${m.criticalCorrect}/${m.criticalTotal} = ${pct(m.criticalRecall)}（门槛 ${pct(GATES.criticalRecall)}）`,
    m.passed ? '判定：PASS' : '判定：FAIL',
  ];
  if (m.misses.length) {
    lines.push('', '错分明细：');
    for (const x of m.misses) {
      lines.push(`- ${x.id} 期望 ${x.expected} → 实际 ${x.got}（rule=${x.ruleId ?? 'fallback'}, ${x.layer}）「${x.text}」`);
    }
  }
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const corpusPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_CORPUS;
  const metrics = evaluate(loadCorpus(corpusPath));
  console.log(formatReport(metrics));
  process.exitCode = metrics.passed ? 0 : 1;
}