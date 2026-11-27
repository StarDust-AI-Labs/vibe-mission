// VibeMission — Entry router engine (L0 rules only).
//
// Pure functions: no IO, no network, no clock. Input is a normalized message
// (see docs/entry-router.md §5.1); output is a *decision* (§5.2), not a topic
// label, so the aggregator and the owner can act on it without re-interpreting.
//
// Cost ladder lives in rules.mjs (`priority` = cost of getting it wrong).
// L1 (light model) and L2 (ask once) are represented in the result shape only;
// this version never calls a model.

import { RULES, FALLBACK, QUESTION_MARKERS, MULTI_INTENT_WORDS } from './rules.mjs';
import { parseTaskRef } from '../../core/src/format.mjs';

/** The five entry routes. Keep in sync with docs/entry-router.md §2. */
export const ROUTES = ['reply', 'query', 'create', 'dispatch', 'meta'];

const ORDERED_RULES = [...RULES].sort((a, b) => a.priority - b.priority);

const REF_IN_TEXT = /(?:tp-|#)\s*0*(\d+)/i;

/**
 * Normalize any channel payload into the router's input shape.
 * @param {{text?: string, meta?: object}|string} input
 */
export function normalize(input) {
  if (typeof input === 'string') return { text: input, meta: {} };
  return {
    text: String(input?.text ?? ''),
    meta: { ...(input?.meta ?? {}) },
  };
}

/** @returns {{text: string, meta: object, ref: number|null, anchor: boolean, isQuestion: boolean}} */
export function detectSignals(input) {
  const { text, meta } = normalize(input);
  const refFromMeta = meta.ref != null ? parseTaskRef(meta.ref) : null;
  const refFromText = parseTaskRef(REF_IN_TEXT.exec(text)?.[1] ?? '');
  const ref = refFromMeta ?? refFromText ?? null;
  return {
    text,
    // Case/space-insensitive view for keyword matching (English ids like
    // VibeMission may arrive spaced or capitalized).
    compact: text.replace(/\s+/g, '').toLowerCase(),
    meta,
    ref: Number.isInteger(ref) ? ref : null,
    // A reply/quote or an explicit #N is a hard pointer to an existing task.
    anchor: Boolean(ref) || Boolean(meta.quoted),
    isQuestion: QUESTION_MARKERS.some((k) => text.includes(k)),
  };
}

function flattenAnyWords(anyWords) {
  return (anyWords ?? []).flat();
}

function matches(rule, sig) {
  const when = rule.when ?? {};
  if (when.anchor === true && !sig.anchor) return false;
  if (when.question === true && !sig.isQuestion) return false;
  if (when.question === false && sig.isQuestion) return false;
  if (when.keywords && !when.keywords.some((k) => sig.compact.includes(k))) return false;
  if (when.anyWords && !flattenAnyWords(when.anyWords).some((k) => sig.compact.includes(k))) return false;
  if (when.pattern && !new RegExp(when.pattern).test(sig.text)) return false;
  return true;
}

function actionFor(rule, text) {
  if (rule.slots?.action) return rule.slots.action;
  if (!rule.actions) return null;
  for (const [action, words] of Object.entries(rule.actions)) {
    if (words.some((w) => text.includes(w))) return action;
  }
  return null;
}

function detectMultiIntent(text) {
  if (!MULTI_INTENT_WORDS.some((w) => text.includes(w))) return false;
  // Two substantive clauses around a connector ("把 X 合了，然后把 Y 做完").
  const clauses = text.split(new RegExp(MULTI_INTENT_WORDS.join('|'))).filter((c) => c.trim().length >= 4);
  return clauses.length >= 2;
}

function buildDecision(rule, sig, layer) {
  const action = actionFor(rule, sig.text);
  let needAsk = Boolean(rule.needAsk);
  let ask = rule.ask ?? null;
  let confidence = rule.confidence ?? 0.8;

  // A decision word without an anchored task is not a ruling yet: ask once,
  // default to "no action" (docs/entry-router.md §3.3).
  if (rule.actions && !sig.anchor) {
    needAsk = true;
    ask = '这条拍板针对哪条任务？回编号即可（默认不动）';
    confidence = 0.6;
  }

  return {
    route: rule.route,
    confidence,
    layer,
    ruleId: rule.id,
    reason: rule.why,
    slots: {
      taskRef: sig.ref,
      action,
      urgent: Boolean(rule.slots?.urgent),
      multiIntent: detectMultiIntent(sig.text),
    },
    needAsk,
    ask,
    defaultRoute: rule.route,
  };
}

/**
 * Classify one message into a route decision.
 * @param {{text?: string, meta?: object}|string} input
 * @param {{routes?: string[]}} [opts]
 */
export function classifyRoute(input, opts = {}) {
  const allowed = new Set(opts.routes ?? ROUTES);
  const sig = detectSignals(input);

  if (!sig.text.trim()) {
    return {
      ...buildDecision(FALLBACK, sig, 'L2'),
      ruleId: null,
      confidence: 0,
      reason: '空消息：无内容可判，回执即可',
    };
  }

  for (const rule of ORDERED_RULES) {
    if (!allowed.has(rule.route)) continue;
    if (!matches(rule, sig)) continue;
    return buildDecision(rule, sig, 'L0');
  }

  return { ...buildDecision(FALLBACK, sig, 'L2'), ruleId: null };
}