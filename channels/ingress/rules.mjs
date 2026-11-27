// VibeMission — Entry router vocabulary and rule table (data, not logic).
//
// The engine (router.mjs) only matches rules in `priority` order and builds the
// decision object. Anything that is a *word list* lives here so it can be
// edited, reviewed and covered by the corpus without touching the engine.
//
// priority = the cost of getting it wrong, NOT the frequency. Lower runs first.
// See docs/entry-router.md §3.1 for the signal table and §1 for the cost matrix.

/** Hard interrupts: bypass buffers and digest windows. */
export const URGENT_WORDS = ['停掉', '暂停', '别推了', '别发了', '先停', '立刻停', '马上停', '挂起', '别催了'];

/**
 * Decision words. `actions` maps word → slot recorded in `decision.slots.action`.
 * A decision word without an anchored task is a question, not a ruling — the
 * engine turns that into a single ask with a safe default (see §3.3).
 */
export const DECISION_WORDS = {
  approve: ['通过', '同意', '批准', '合入'],
  reject: ['打回', '退回', '不合', '驳回'],
  cancel: ['取消'],
  hold: ['暂缓', '先放着'],
};

/** Words that mean "we are talking about the system itself", not about work. */
export const META_WORDS = [
  '你刚才', '为什么你', '你的规则', '你的方案', '你的', '设计文档', '方案里',
  '架构上', '策略上', '记住这个', '以后别', '不记得', '忘了', '上下文', 'skill',
  'vibemission的规则', 'vibe-mission',
];

/** Question shape markers (any hit → isQuestion). */
export const QUESTION_MARKERS = [
  '？', '?', '吗', '怎么', '为什么', '为啥', '哪', '多少', '是否', '要不要',
  '能不能', '可不可以', '什么', '有没有', '是不是', '多久', '还是', '几',
];

/** Questions about ledger facts → route `query` instead of a plain reply. */
export const QUERY_WORDS = [
  '状态', '进度', '卡在', '卡住', '阻塞', '待办', '待决策', '哪些', '多少',
  '几条', '看板', '情况', '到哪', '发我', '给我', '告诉我', '还有什么', '谁在',
];

/** Actions that operate on a task (verbs appear in statements, not questions). */
export const TASK_VERBS = [
  '改', '修', '重做', '加', '继续', '推进', '调整', '优化', '复核', '复审',
  '评审', '发布', '上线', '部署', '迁移', '做', '写完', '整理', '排查', '接入',
  '跟进', '安排', '登记', '补', '更新', '删', '执行',
];

/** "Do it for me" phrasing — a request, not a question, even with 能不能/帮我. */
export const REQUEST_WORDS = ['能不能', '可以帮我', '帮我', '麻烦', '替我'];

/** Compliance/continuation without an explicit verb. */
export const COMPLY_WORDS = ['按你说的', '就按这个', '照这个', '按这个来', '那就这样', '继续吧'];

/** Short chat imperatives that mean "answer me", not "create a task". */
export const CHAT_PATTERN = '^(回复|说说|讲讲|解释下|看下|看一下|总结一下|说下)';

/** Pure acknowledgements. */
export const ACK_WORDS = ['收到', '好的', '好', '嗯', '明白', '知道了', '谢谢', '行'];

/** Markers of a second intent inside one burst ("然后 / 另外"). */
export const MULTI_INTENT_WORDS = ['然后', '另外', '顺便', '再帮我', '并且'];

/**
 * Rule table.
 *
 * `when` fields are ANDed; `keywords` is "any of"; `pattern` is a JS regexp
 * source; `anchor: true` means "quoted message or an explicit #N / tp-N".
 */
export const RULES = [
  {
    id: 'urgent.stop',
    priority: 0,
    route: 'reply',
    confidence: 0.98,
    slots: { urgent: true, action: 'pause' },
    when: { anyWords: [URGENT_WORDS] },
    why: '紧急中断词：绕过缓冲与合并窗口，立即回执',
  },
  {
    id: 'decision.word',
    priority: 10,
    route: 'reply',
    confidence: 0.95,
    actions: DECISION_WORDS,
    when: { anyWords: Object.values(DECISION_WORDS), question: false },
    why: '拍板词：错判代价最高，必须由规则兜住',
  },
  {
    id: 'meta.system',
    priority: 20,
    route: 'meta',
    confidence: 0.9,
    when: { keywords: META_WORDS },
    why: '指向系统本身（规则/设计/记忆），不碰账本',
  },
  {
    id: 'ref.info',
    priority: 29,
    route: 'query',
    confidence: 0.9,
    when: { anchor: true, keywords: ['发我', '给我', '告诉我', '看下', '看一下', '说说'] },
    why: '引用锚 + 索要信息：查库渲染，不路由也不登记',
  },
  {
    id: 'ref.request',
    priority: 30,
    route: 'dispatch',
    confidence: 0.93,
    when: { anchor: true, keywords: REQUEST_WORDS },
    why: '引用了某条任务且是"替我办"句式：路由进原任务会话',
  },
  {
    id: 'ref.status',
    priority: 33,
    route: 'query',
    confidence: 0.93,
    when: { anchor: true, keywords: QUERY_WORDS },
    why: '引用锚 + 问账本事实：查库渲染，零推理',
  },
  {
    id: 'ref.hold',
    priority: 31,
    route: 'dispatch',
    confidence: 0.9,
    slots: { action: 'hold' },
    when: { anchor: true, keywords: ['先不做', '缓一缓', '先放着', '暂缓'] },
    why: '引用锚 + 搁置：登记为持有，不关不派',
  },
  {
    id: 'ref.dispatch',
    priority: 32,
    route: 'dispatch',
    confidence: 0.92,
    when: { anchor: true, keywords: TASK_VERBS, question: false },
    why: '引用锚 + 动作词：续做/修正，走原任务会话',
  },
  {
    id: 'ref.comply',
    priority: 34,
    route: 'dispatch',
    confidence: 0.88,
    when: { anchor: true, keywords: COMPLY_WORDS },
    why: '引用锚 + 照办句式：视为对原任务的追加指令',
  },
  {
    id: 'ref.bare',
    priority: 35,
    route: 'dispatch',
    confidence: 0.7,
    needAsk: true,
    ask: '是接着这条任务继续吗？（默认接着）',
    when: { anchor: true },
    why: '只有引用锚、没有可判动作：默认续做，但问一次确认',
  },
  {
    id: 'question.query',
    priority: 40,
    route: 'query',
    confidence: 0.9,
    when: { question: true, keywords: QUERY_WORDS },
    why: '问句 + 账本词汇：直接查库',
  },
  {
    id: 'question.reply',
    priority: 41,
    route: 'reply',
    confidence: 0.88,
    when: { question: true },
    why: '问句：秒回，不入聚合缓冲',
  },
  {
    id: 'task.create',
    priority: 50,
    route: 'create',
    confidence: 0.88,
    when: { keywords: TASK_VERBS, question: false },
    why: '无引用锚的任务动作：登记新任务',
  },
  {
    id: 'chat.short',
    priority: 55,
    route: 'reply',
    confidence: 0.85,
    when: { pattern: CHAT_PATTERN },
    why: '短语式指令：回话即可，不登记',
  },
  {
    id: 'ack',
    priority: 60,
    route: 'reply',
    confidence: 0.8,
    when: { keywords: ACK_WORDS },
    why: '纯确认词：回执，不产生任务',
  },
];

/** Decision used when no rule matched: safest default is "answer, don't create". */
export const FALLBACK = {
  id: 'fallback',
  route: 'reply',
  confidence: 0.4,
  needAsk: true,
  ask: '要我登记成任务吗？（默认不登记，只回话）',
  why: '未命中任何规则：按最保守默认，先回一句、不登记',
};