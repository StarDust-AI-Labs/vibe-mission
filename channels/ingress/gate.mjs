// VibeMission ingress — 入口预算闸门（① 入口只做 3 秒内的事）。
//
// 实现与常量在 core/src/budget.mjs（插件自包含，sync-core 只同步 core），
// 这里只做 ingress 侧的统一入口，避免调用方跨层找文件。

export {
  ENTRY_BUDGET,
  ENTRY_ALLOWED,
  checkEntryBudget,
  mustDispatch,
} from '../../core/src/budget.mjs';
