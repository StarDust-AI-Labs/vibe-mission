// TaskPier core — MCP tool facade (the 6 tools finalized in docs/architecture.md §4.1).
// Pure functions over the Store: parse args, enforce FSM, write facts, return
// structured results. No transport concepts here.

import { TaskPierError, Codes } from './errors.mjs';
import { assertTransition, assertGuards, isAlertStatus, STATUSES, TERMINAL_STATUSES } from './state-machine.mjs';

/** @param {string|number} id accepts "tp-12" | "12" | 12 */
function parseTaskId(id) {
  const m = /^tp-(\d+)$/.exec(String(id));
  const n = m ? Number(m[1]) : Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TaskPierError(Codes.INVALID_INPUT, `invalid task id: ${id}`);
  }
  return n;
}

function requireString(args, field, { required = false, max = 2000 } = {}) {
  const v = args[field];
  if (v === undefined || v === null || v === '') {
    if (required) throw new TaskPierError(Codes.INVALID_INPUT, `\`${field}\` is required`);
    return null;
  }
  if (typeof v !== 'string') throw new TaskPierError(Codes.INVALID_INPUT, `\`${field}\` must be a string`);
  if (v.length > max) throw new TaskPierError(Codes.INVALID_INPUT, `\`${field}\` exceeds ${max} chars`);
  return v;
}

function requireStringArray(args, field, { maxItems = 50 } = {}) {
  const v = args[field];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new TaskPierError(Codes.INVALID_INPUT, `\`${field}\` must be an array of strings`);
  }
  if (v.length > maxItems) throw new TaskPierError(Codes.INVALID_INPUT, `\`${field}\` exceeds ${maxItems} items`);
  return v.map((x) => x.slice(0, 500));
}

/**
 * Build the 6 tools: JSON-Schema defs + handlers bound to a store.
 * @param {import('./store.mjs').Store} store
 */
export function buildTools(store) {
  function mustGet(idArg) {
    const id = parseTaskId(idArg);
    const task = store.getTask(id);
    if (!task) throw new TaskPierError(Codes.TASK_NOT_FOUND, `task not found: ${idArg}`, { id });
    return task;
  }

  const handlers = {
    /**
     * @param {{title?: string, keywords?: string[], status?: string, host?: string,
     *          project?: string, workspace?: string, parent_id?: string|number, actor?: string}} args
     */
    task_create(args) {
      const title = requireString(args, 'title', { required: true, max: 500 });
      const keywords = requireStringArray(args, 'keywords') ?? [];
      const status = args.status ?? 'todo';
      if (!['inbox', 'todo'].includes(status)) {
        throw new TaskPierError(Codes.INVALID_INPUT, `\`status\` must be 'inbox' or 'todo' on create`);
      }
      let parentId = null;
      if (args.parent_id != null) parentId = parseTaskId(args.parent_id);
      if (parentId != null && !store.getTask(parentId)) {
        throw new TaskPierError(Codes.TASK_NOT_FOUND, `parent task not found: ${args.parent_id}`);
      }
      const task = store.insertTask({
        title,
        keywords,
        status,
        host: requireString(args, 'host', { max: 64 }),
        project: requireString(args, 'project', { max: 200 }),
        workspace: requireString(args, 'workspace', { max: 1000 }),
        parent_id: parentId,
      });
      store.appendEvent(task.id, 'create', args.actor ?? 'mcp', { status });
      return { task };
    },

    /**
     * @param {{id?: string|number, status?: string, session_id?: string, blocked_reason?: string,
     *          decision_question?: string, decision_options?: string[], keywords?: string[],
     *          artifacts?: string[], evidence?: string[], title?: string, workspace?: string,
     *          project?: string, host?: string, actor?: string}} args
     */
    task_update(args) {
      const task = mustGet(args.id);
      const actor = args.actor ?? 'mcp';
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new TaskPierError(Codes.TERMINAL_TASK, `task ${task.displayId} is ${task.status} (terminal)`);
      }

      // Collect provided field updates (whitelist).
      const fieldArgs = {
        title: requireString(args, 'title', { max: 500 }),
        keywords: requireStringArray(args, 'keywords'),
        session_id: requireString(args, 'session_id', { max: 200 }),
        host: requireString(args, 'host', { max: 64 }),
        project: requireString(args, 'project', { max: 200 }),
        workspace: requireString(args, 'workspace', { max: 1000 }),
        blocked_reason: requireString(args, 'blocked_reason'),
        decision_question: requireString(args, 'decision_question'),
        decision_options: requireStringArray(args, 'decision_options'),
        artifacts: requireStringArray(args, 'artifacts'),
        evidence: requireStringArray(args, 'evidence'),
      };
      /** @type {Record<string, unknown>} */
      const provided = {};
      for (const [k, v] of Object.entries(fieldArgs)) if (v !== null) provided[k] = v;

      /** @type {{from: string, to: string, alert: boolean}|null} */
      let transition = null;
      const toStatus = args.status;
      if (toStatus !== undefined && toStatus !== null) {
        if (toStatus === task.status) {
          throw new TaskPierError(Codes.INVALID_INPUT, `task is already ${toStatus}`);
        }
        assertTransition(task.status, toStatus);
        assertGuards(toStatus, { ...task, ...provided });
        provided.status = toStatus;
      }

      if (Object.keys(provided).length === 0) {
        throw new TaskPierError(Codes.INVALID_INPUT, 'nothing to update: provide status and/or fields');
      }

      const updated = store.updateTask(task.id, provided);
      if (toStatus) {
        transition = { from: task.status, to: toStatus, alert: isAlertStatus(toStatus) };
        store.appendEvent(task.id, 'status_change', actor, { ...transition });
      }
      const fieldNames = Object.keys(provided).filter((k) => k !== 'status');
      if (fieldNames.length > 0) {
        store.appendEvent(task.id, 'field_update', actor, { fields: fieldNames });
      }
      return { task: updated, transition };
    },

    /** @param {{id?: string|number, events_limit?: number}} args */
    task_query(args) {
      const task = mustGet(args.id);
      const limit = Math.min(Math.max(args.events_limit ?? 10, 1), 100);
      return { task, events: store.listEvents(task.id, limit) };
    },

    /**
     * @param {{status?: string|string[], host?: string, project?: string, limit?: number}} args
     */
    task_list(args) {
      let status = args.status;
      if (status !== undefined && status !== null) {
        const arr = Array.isArray(status) ? status : [status];
        for (const s of arr) {
          if (!STATUSES.includes(s)) throw new TaskPierError(Codes.INVALID_INPUT, `unknown status: ${s}`);
        }
        status = arr;
      }
      return { tasks: store.listTasks({ status, host: args.host, project: args.project, limit: args.limit }) };
    },

    /** @param {{}} _args */
    board_summary(_args) {
      const counts = store.counts();
      const highlight = (t) => ({
        id: t.id,
        displayId: t.displayId,
        title: t.title,
        host: t.host,
        workspace: t.workspace,
        blocked_reason: t.status === 'blocked' ? t.blocked_reason : undefined,
        decision_question: t.status === 'waiting_decision' ? t.decision_question : undefined,
        updated_at: t.updated_at,
      });
      const lists = store.listByStatus(['running', 'waiting_decision', 'blocked', 'review'], 50);
      const highlights = { running: [], waiting_decision: [], blocked: [], review: [] };
      for (const t of lists) highlights[t.status].push(highlight(t));
      return {
        counts,
        highlights,
        needs_attention: counts.waiting_decision + counts.blocked + counts.review,
        generatedAt: Date.now(),
      };
    },

    /**
     * User decision on a `waiting_decision` task.
     * @param {{id?: string|number, answer?: string, action?: string, actor?: string}} args
     */
    decision_answer(args) {
      const task = mustGet(args.id);
      if (task.status !== 'waiting_decision') {
        throw new TaskPierError(Codes.INVALID_INPUT, `task ${task.displayId} is not waiting_decision (it is ${task.status})`);
      }
      const answer = requireString(args, 'answer', { required: true });
      const action = args.action ?? 'continue';
      if (!['continue', 'abort'].includes(action)) {
        throw new TaskPierError(Codes.INVALID_INPUT, `\`action\` must be 'continue' or 'abort'`);
      }
      const to = action === 'abort' ? 'cancelled' : 'running';
      assertTransition(task.status, to);
      const updated = store.updateTask(task.id, { status: to });
      const transition = { from: task.status, to, alert: isAlertStatus(to) };
      store.appendEvent(task.id, 'status_change', args.actor ?? 'user', { ...transition, answer, action });
      return { task: updated, transition };
    },
  };

  /** JSON Schema for each tool (MCP inputSchema). */
  const str = { type: 'string' };
  const strArr = { type: 'array', items: { type: 'string' } };
  const toolDefs = [
    {
      name: 'task_create',
      description: 'Register a task. Lands in `todo` by default (or `inbox` when unclassified).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { ...str, maxLength: 500 },
          keywords: { ...strArr, description: 'routing aliases for intent matching' },
          status: { enum: ['inbox', 'todo'] },
          host: str,
          project: str,
          workspace: str,
          parent_id: { type: ['string', 'number'], description: 'parent task, accepts tp-N or N' },
          actor: str,
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'task_update',
      description: 'Update fields and/or perform a validated status transition. Writes events; returns transition info (alert flag for waiting_decision/blocked/review).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: ['string', 'number'] },
          status: { enum: [...STATUSES] },
          session_id: str,
          blocked_reason: { ...str, description: 'required when transitioning to blocked' },
          decision_question: { ...str, description: 'required when transitioning to waiting_decision' },
          decision_options: strArr,
          keywords: strArr,
          artifacts: strArr,
          evidence: strArr,
          title: str,
          workspace: str,
          project: str,
          host: str,
          actor: str,
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'task_query',
      description: 'Single task with its recent event history.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: ['string', 'number'] }, events_limit: { type: 'number', default: 10 } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    {
      name: 'task_list',
      description: 'List tasks ordered by last update.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: ['string', 'array'], items: { enum: [...STATUSES] } },
          host: str,
          project: str,
          limit: { type: 'number', default: 100 },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'board_summary',
      description: 'Dashboard: status histogram + highlighted running/waiting_decision/blocked/review tasks.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'decision_answer',
      description: 'Answer a pending decision: action=continue resumes the task (running), action=abort cancels it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: ['string', 'number'] },
          answer: { ...str, description: 'the user\u2019s decision text, recorded in events' },
          action: { enum: ['continue', 'abort'] },
          actor: str,
        },
        required: ['id', 'answer'],
        additionalProperties: false,
      },
    },
  ];

  return { toolDefs, handlers };
}
