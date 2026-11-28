// VibeMission core — task heartbeat classification (⑤ 重活要有心跳和超时).
//
// Two thresholds, straight from the design:
//   - running > 20 min  → report progress ("还在跑，当前到第几步")
//   - no beat for 60 s  → treat as lost, state goes `failed`
//
// A "beat" is an explicit progress event (task_update with a step counter), not
// mere liveness of the process. Until a task emits its first beat the state is
// `no_source` — neither healthy nor lost — so wiring this up cannot mass-fail
// tasks that never reported anything.

export const HEARTBEAT = {
  lostAfterMs: 60_000,
  progressAfterMs: 20 * 60_000,
};

export const STATES = {
  HEALTHY: 'healthy',
  OVERDUE: 'overdue',
  LOST: 'lost',
  NO_SOURCE: 'no_source',
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
  const lastBeatAt = input.lastBeatAt == null ? null : Number(input.lastBeatAt);
  const elapsedMs = Math.max(0, now - startedAt);

  // No beat source: most tasks do not emit beats yet. Judging them "lost" would
  // mass-fail every running task the moment this gets wired up (review,
  // 2026-11-29), so the lost rule only applies once a real beat has been seen.
  if (lastBeatAt == null) {
    return {
      state: STATES.NO_SOURCE,
      silentMs: 0,
      elapsedMs,
      shouldReport: false,
      report: null,
      step: input.step ?? null,
      totalSteps: input.totalSteps ?? null,
    };
  }

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
