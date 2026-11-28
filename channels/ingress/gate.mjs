// VibeMission — 入口预算闸门（3 秒 / 1 次工具调用）。
//
// 设计原文：入口只做 3 秒内能完成的事——识别意图、登记任务卡、派工、短回复。
// 判据写死：预估 >3 秒，或需要 >1 次工具调用 → 强制派到执行会话；禁止「先试试看」。
//
// 为什么禁止试探：试探性执行是入口阻塞的第一大来源——一旦开始跑，入口就再也不能
// 秒回，后面的消息全部排队。所以这里不给"试着做一下看看"的中间态。
//
// 纯函数，无 IO，可单测。

export const ENTRY_BUDGET = {
  maxDurationMs: 3_000,
  maxToolCalls: 1,
};

/** 入口允许的动作白名单（只有这四类可以在入口回合内完成）。 */
export const ENTRY_ALLOWED = ['recognize-intent', 'register-task', 'dispatch', 'short-reply'];

/**
 * 判定一个动作能否在入口回合内完成。
 *
 * @param {{action?: string, estimatedMs?: number, toolCalls?: number}} input
 * @returns {{allowed: boolean, action: 'local'|'dispatch', reason: string,
 *            violations: string[], budget: {maxDurationMs:number,maxToolCalls:number}}}
 */
export function checkEntryBudget(input = {}) {
  const estimatedMs = Number(input.estimatedMs ?? 0);
  const toolCalls = Number(input.toolCalls ?? 0);
  const action = input.action;

  const violations = [];
  if (estimatedMs > ENTRY_BUDGET.maxDurationMs) {
    violations.push(`预估 ${estimatedMs}ms > ${ENTRY_BUDGET.maxDurationMs}ms`);
  }
  if (toolCalls > ENTRY_BUDGET.maxToolCalls) {
    violations.push(`需 ${toolCalls} 次工具调用 > ${ENTRY_BUDGET.maxToolCalls} 次`);
  }
  if (action != null && !ENTRY_ALLOWED.includes(action)) {
    violations.push(`动作 ${action} 不在入口白名单内`);
  }

  if (violations.length) {
    return {
      allowed: false,
      action: 'dispatch',
      reason: `超出入口预算（${violations.join('；')}）→ 强制派执行会话`,
      violations,
      budget: { ...ENTRY_BUDGET },
    };
  }
  return {
    allowed: true,
    action: 'local',
    reason: '在入口预算内：可在入口回合内完成',
    violations: [],
    budget: { ...ENTRY_BUDGET },
  };
}

/** 便捷判定：只关心"是否必须派出去"。 */
export function mustDispatch(input = {}) {
  return !checkEntryBudget(input).allowed;
}