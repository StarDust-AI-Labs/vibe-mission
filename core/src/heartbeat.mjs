// VibeMission core — task heartbeat classification (⑤ 重活要有心跳和超时).
//
// Two thresholds, straight from the design:
//   - running > 20 min  → report progress ("还在跑，当前到第几步")
//   - no beat for 60 s  → treat as lost, state goes `failed`
//
// A "beat" is an explicit progress event (task_update with a step counter), not
// mere liveness of the process. Inference from `updated_at` is the fallback when
// a task session has not emitted beats yet — see `classifyHeartbeat`.

export const HEARTBEAT = {
  lostAfterMs: 60_000,
  progressAfterMs: 20 * 60_000,
};

export const STATES = {
  HEALTHY: 'healthy',
  OVERDUE: 'overdue',
  LOST: 'lost',
};

/**
 * @param {{
 *   startedAt: number,
 *   lastBeatAt?: number|null,
 *   now?: number,
 *   step?: number|null,
 *   totalSteps?: number|null,
 *   lastReportedStep?: number|null,
 *   lostAfterMs?: number,
 *   progressAfterMs?: number,
 * }} input
 * @returns {{state: string, silentMs: number, elapsedMs: number,
 *            shouldReport: boolean, report: string|null,
 *            step: number|null, totalSteps: number|null}}
 */
export function classifyHeartbeat(input) {
  const now = input.now ?? Date.now();
  const lostAfter = input.lostAfterMs ?? HEARTBEAT.lostAfterMs;
  const progressAfter = input.progressAfterMs ?? HEARTBEAT.progressAfterMs;

  const startedAt = Number(input.startedAt);
  const lastBeatAt = input.lastBeatAt == null ? startedAt : Number(input.lastBeatAt);
  const elapsedMs = Math.max(0, now - startedAt);
  const silentMs = Math.max(0, now - lastBeatAt);

  // Lost takes precedence: a 20-minute progress report about a dead task is
  // worse than no report at all.
  if (silentMs > lostAfter) {
    return {
      state: STATES.LOST,
      silentMs,
      elapsedMs,
      shouldReport: true,
      report: `已 ${Math.round(silentMs / 1000)} 秒没有心跳，判定失联（状态转 failed）`,
      step: input.step ?? null,
      totalSteps: input.totalSteps ?? null,
    };
  }

  if (elapsedMs >= progressAfter) {
    // One report per step — otherwise a long task spams every scan interval.
    const step = input.step ?? null;
    const already = input.lastReportedStep != null && step != null && input.lastReportedStep === step;
    const where = step == null
      ? '还在跑'
      : input.totalSteps
        ? `还在跑，当前到第 ${step}/${input.totalSteps} 步`
        : `还在跑，当前到第 ${step} 步`;
    return {
      state: STATES.OVERDUE,
      silentMs,
      elapsedMs,
      shouldReport: !already,
      report: already ? null : where,
      step,
      totalSteps: input.totalSteps ?? null,
    };
  }

  return {
    state: STATES.HEALTHY,
    silentMs,
    elapsedMs,
    shouldReport: false,
    report: null,
    step: input.step ?? null,
    totalSteps: input.totalSteps ?? null,
  };
}

/**
 * A task is a heartbeat candidate only while it is actually executing.
 * @param {{status: string}} task
 */
export function isHeartbeating(task) {
  return task.status === 'running';
}
