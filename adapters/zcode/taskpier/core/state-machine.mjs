// TaskPier core — explicit task state machine.
// The transition table is the single source of truth; callers (tools facade)
// never embed status logic. Guards concentrate field requirements per docs/
// status-model.md.

import { TaskPierError, Codes } from './errors.mjs';

/** All task statuses, see docs/status-model.md */
export const STATUSES = /** @type {const} */ ([
  'inbox',
  'todo',
  'running',
  'waiting_decision',
  'blocked',
  'review',
  'done',
  'failed',
  'cancelled',
]);

export const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled']);

/** from → allowed next statuses */
const TRANSITIONS = {
  inbox: ['todo', 'cancelled'],
  todo: ['running', 'cancelled'],
  running: ['waiting_decision', 'blocked', 'review', 'failed', 'cancelled'],
  waiting_decision: ['running', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  review: ['done', 'running', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

/** @param {string} from @param {string} to */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * @param {string} from
 * @param {string} to
 * @throws {TaskPierError} code=illegal_transition
 */
export function assertTransition(from, to) {
  if (!STATUSES.includes(to)) {
    throw new TaskPierError(Codes.INVALID_INPUT, `unknown target status: ${to}`, { to });
  }
  if (!canTransition(from, to)) {
    throw new TaskPierError(
      Codes.ILLEGAL_TRANSITION,
      `illegal transition ${from} -> ${to}`,
      { from, to, allowed: TRANSITIONS[from] ?? [] },
    );
  }
}

/**
 * Guards required by docs/status-model.md:
 *  - blocked        requires blocked_reason
 *  - waiting_decision requires decision_question + non-empty decision_options
 * @param {string} to
 * @param {{blocked_reason?: string|null, decision_question?: string|null, decision_options?: string[]|null}} fields
 * @throws {TaskPierError} code=missing_guard_field
 */
export function assertGuards(to, fields) {
  if (to === 'blocked' && !(fields.blocked_reason && String(fields.blocked_reason).trim())) {
    throw new TaskPierError(
      Codes.MISSING_GUARD_FIELD,
      'transition to `blocked` requires non-empty `blocked_reason`',
      { status: to, field: 'blocked_reason' },
    );
  }
  if (to === 'waiting_decision') {
    if (!(fields.decision_question && String(fields.decision_question).trim())) {
      throw new TaskPierError(
        Codes.MISSING_GUARD_FIELD,
        'transition to `waiting_decision` requires non-empty `decision_question`',
        { status: to, field: 'decision_question' },
      );
    }
    const opts = fields.decision_options;
    if (!Array.isArray(opts) || opts.length === 0) {
      throw new TaskPierError(
        Codes.MISSING_GUARD_FIELD,
        'transition to `waiting_decision` requires non-empty `decision_options` array',
        { status: to, field: 'decision_options' },
      );
    }
  }
}

/** The only three statuses that trigger outbound alerts (docs/status-model.md). */
export function isAlertStatus(status) {
  return status === 'waiting_decision' || status === 'blocked' || status === 'review';
}
