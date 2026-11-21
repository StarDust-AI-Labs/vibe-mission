// TaskPier board — shared data builder for the live server and the snapshot
// exporter. Pure read over the store; no transport concepts.

const STATUS_ORDER = [
  'running', 'waiting_decision', 'blocked', 'review',
  'todo', 'inbox', 'done', 'failed', 'cancelled',
];

const STATUS_LABEL = {
  running: '执行中',
  waiting_decision: '待决策',
  blocked: '阻塞',
  review: '待验收',
  todo: '待派',
  inbox: '收件箱',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
};

const ALERT = new Set(['waiting_decision', 'blocked', 'review']);

/** @param {import('../core/src/store.mjs').Store} store */
export function buildBoardData(store, { limit = 500 } = {}) {
  const counts = store.counts();
  const tasks = store.listTasks({ limit });
  const columns = {};
  for (const s of STATUS_ORDER) columns[s] = [];
  for (const t of tasks) {
    if (!columns[t.status]) continue;
    columns[t.status].push({
      displayId: t.displayId,
      title: t.title,
      host: t.host ?? undefined,
      project: t.project ?? undefined,
      workspace: t.workspace ?? undefined,
      blocked_reason: t.status === 'blocked' ? t.blocked_reason ?? undefined : undefined,
      decision_question: t.status === 'waiting_decision' ? t.decision_question ?? undefined : undefined,
      updatedAt: new Date(t.updated_at).toISOString(),
    });
  }
  for (const s of Object.keys(columns)) {
    columns[s].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }
  return {
    generatedAt: new Date().toISOString(),
    counts,
    needsAttention: counts.waiting_decision + counts.blocked + counts.review,
    columns,
    labels: STATUS_LABEL,
    alertStatuses: [...ALERT],
  };
}

export { STATUS_ORDER, STATUS_LABEL };
