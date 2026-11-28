// VibeMission — 忙时输入三档（busy input modes）。
//
// 语义对照 docs/entry-execution-split.md 与 Hermes 的设计：
//   interrupt — 原地纠正当前轮：把新指令直接送进正在跑的那一轮
//   steer     — 在当前原子动作之后注入
//   queue     — 排到下一轮，当前轮结束立刻执行
//
// 两条不可让渡的约束（踩过的坑）：
//   1. 任何档位都不丢弃消息；
//   2. 任何档位都不回「正忙」——回「正忙」会逼客户端重试，重试期间反而丢消息。
//
// 压缩进行中：steer / interrupt 强制降级为 queue。压缩中途被打断会产生分叉
// 会话，比排队更糟。
//
// 本模块是纯逻辑：不依赖宿主、不依赖网络、时钟可注入，可单测。

export const MODES = {
  INTERRUPT: 'interrupt',
  QUEUE: 'queue',
  STEER: 'steer',
};

/** 明确喊停 —— 唯一允许打断当前轮的措辞。 */
export const STOP_WORDS = ['停掉', '停下', '暂停', '别做了', '别跑了', '中断', '取消这个'];

/** 派工阶段：任务卡刚登记、会话还没真正开始执行。 */
export const PHASES = { DISPATCH: 'dispatch', EXECUTE: 'execute' };

export const DEFAULTS = {
  turnEstimateMs: 90_000, // 单轮预计耗时，用于「预计还要多久」的粗估
  escalateAfterMs: 60_000, // 排队超过这个时长要主动说明排第几
  compressionDegrade: true,
};

/**
 * 选档位。纯函数，是这段逻辑的唯一入口。
 * @param {{text?: string, phase?: string, compressInProgress?: boolean,
 *          compressionDegrade?: boolean}} input
 * @returns {{mode: string, degradedFrom: string|null, reason: string}}
 */
export function chooseBusyMode(input = {}) {
  const text = String(input.text ?? '');
  const phase = input.phase === PHASES.DISPATCH ? PHASES.DISPATCH : PHASES.EXECUTE;

  let mode;
  let reason;
  if (STOP_WORDS.some((w) => text.includes(w))) {
    mode = MODES.INTERRUPT;
    reason = '明确喊停：原地纠正当前轮';
  } else if (phase === PHASES.DISPATCH) {
    mode = MODES.STEER;
    reason = '派工中：在当前原子动作之后注入';
  } else {
    mode = MODES.QUEUE;
    reason = '执行中：排到下一轮，当前轮结束立即执行';
  }

  const degrade = input.compressionDegrade ?? DEFAULTS.compressionDegrade;
  if (degrade && input.compressInProgress && mode !== MODES.QUEUE) {
    return {
      mode: MODES.QUEUE,
      degradedFrom: mode,
      reason: '压缩进行中：steer/interrupt 降级为 queue，避免压缩被打断产生分叉会话',
    };
  }
  return { mode, degradedFrom: null, reason };
}

/**
 * 忙时消息队列。永不拒绝、永不回「正忙」。
 *
 * 一条消息的完整生命周期：
 *   admit() → 选档位 → interrupt（进当前轮）/ steer（进注入缓冲）/ queue（进队列）
 *   → drain()（轮次结束按 FIFO 出队，保留回程绑定）
 */
export class BusyQueue {
  constructor(opts = {}) {
    this.turnEstimateMs = opts.turnEstimateMs ?? DEFAULTS.turnEstimateMs;
    this.escalateAfterMs = opts.escalateAfterMs ?? DEFAULTS.escalateAfterMs;
    this.compressionDegrade = opts.compressionDegrade ?? DEFAULTS.compressionDegrade;
    this.now = opts.now ?? (() => Date.now());

    this.running = null; // {label, startedAt}
    this.queued = []; // FIFO，保留原始消息对象（含回程绑定）
    this.steerBuffer = [];
    this.interrupted = [];
    this.seq = 0;
    this.escalated = new Set(); // 已发过「排第几」提示的 messageId，避免重复打扰
  }

  isRunning() {
    return this.running !== null;
  }

  /** 开始一轮。 */
  beginTurn(label = '') {
    this.running = { label, startedAt: this.now() };
  }

  /**
   * 投递一条消息。无论忙闲都接受。
   * @param {{messageId: string, chatId: string, senderId?: string, threadId?: string,
   *          text?: string, phase?: string}} msg
   */
  admit(msg) {
    const enteredAt = this.now();
    this.seq += 1;
    const record = { ...msg, seq: this.seq, enteredAt };

    if (!this.isRunning()) {
      this.beginTurn(msg.messageId ?? '');
      record.mode = MODES.QUEUE;
      record.delivered = 'new-turn';
      record.reason = '空闲：直接开始新一轮';
      return { ...record, accepted: true };
    }

    const choice = chooseBusyMode({
      text: msg.text,
      phase: msg.phase,
      compressInProgress: msg.compressInProgress,
      compressionDegrade: this.compressionDegrade,
    });

    record.mode = choice.mode;
    record.degradedFrom = choice.degradedFrom;
    record.reason = choice.reason;

    if (choice.mode === MODES.INTERRUPT) {
      record.delivered = 'running-turn';
      this.interrupted.push(record);
    } else if (choice.mode === MODES.STEER) {
      record.delivered = 'steer-buffer';
      this.steerBuffer.push(record);
    } else {
      record.delivered = 'queue';
      this.queued.push(record);
    }

    return { ...record, accepted: true, position: this.positionOf(record.messageId), etaMs: this.etaFor(record) };
  }

  /** 当前轮可消费的 steer 消息（原子动作结束处调用）。 */
  takeSteer() {
    const out = this.steerBuffer;
    this.steerBuffer = [];
    return out;
  }

  /** 结束当前轮并排空队列；返回下一条要执行的消息（保留回程绑定）。 */
  endTurn() {
    this.running = null;
    if (this.queued.length === 0) return null;
    const next = this.queued.shift();
    this.beginTurn(next.messageId ?? '');
    return next;
  }

  /** 一次性排空（测试 / 批量回放用）。 */
  drain() {
    const out = this.queued;
    this.queued = [];
    this.running = null;
    return out;
  }

  positionOf(messageId) {
    const i = this.queued.findIndex((m) => m.messageId === messageId);
    return i === -1 ? 0 : i + 1;
  }

  etaFor(record) {
    const pos = this.positionOf(record.messageId);
    if (!pos) return 0;
    const remaining = this.running ? Math.max(0, this.turnEstimateMs - (this.now() - this.running.startedAt)) : 0;
    return remaining + (pos - 1) * this.turnEstimateMs;
  }

  /** 队列可见性：每条带序号、入队时间、预计触发点。 */
  visibility() {
    const now = this.now();
    return this.queued.map((m, i) => ({
      messageId: m.messageId,
      seq: m.seq,
      position: i + 1,
      enteredAt: m.enteredAt,
      waitedMs: now - m.enteredAt,
      etaMs: this.etaFor(m),
    }));
  }

  /**
   * 超过 escalateAfterMs 仍未被处理的消息 → 生成「排第几、还要多久」的说明。
   * 每条消息只提示一次，除非位置发生变化。
   */
  escalations() {
    const now = this.now();
    const out = [];
    this.queued.forEach((m, i) => {
      const waited = now - m.enteredAt;
      if (waited < this.escalateAfterMs) return;
      const key = `${m.messageId}:${i + 1}`;
      if (this.escalated.has(key)) return;
      this.escalated.add(key);
      const etaMin = Math.max(1, Math.round(this.etaFor(m) / 60_000));
      const waiting = this.running?.label ? `还在等 ${this.running.label} 结束` : '还在等上一个任务结束';
      out.push({
        messageId: m.messageId,
        chatId: m.chatId,
        position: i + 1,
        waitedMs: waited,
        text: `${waiting}，你这条排第 ${i + 1}，预计 ${etaMin} 分钟内处理`,
      });
    });
    return out;
  }
}