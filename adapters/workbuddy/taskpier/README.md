# TaskPier · WorkBuddy 适配器（包工头）

把 TaskPier 的统一任务库接进 WorkBuddy 宿主。角色名沿用前身项目的**包工头**（foreman）：
用户只在飞书跟包工头说话，它负责登记、派工、对账、回报——台账（TaskPier 任务库）是唯一状态真相源。

> 沿革：本适配器由独立原型 `D:\foreman-agent`（2026-11-10 从 ai-factory/foreman 迁出的 v1 骨架，
> 从未部署）于 2026-11-23 并入 TaskPier。资产去向见仓库 docs/decisions.md 合并决策。

## 能力矩阵（Tier 0 起步）

| 能力 | 状态 | 说明 |
|---|---|---|
| 任务库（`task_*` 六工具） | ✅ | 直接挂 core MCP server（`core/src/mcp-server.mjs`），工具面与 zcode 适配器完全一致 |
| 意图路由 / 登记 / 跟踪 / 验收回流 | ✅ | expert/skills/workbuddy-foreman/SKILL.md（包工头岗位卡，随专家包安装） |
| 对账（reconcile） | ✅ | `reconcile/observer.mjs`：只读解析 WorkBuddy 主库 + tasks/*/1.json，输出 drift/unregistered 报告 |
| 告警 | ✅ | 岗位卡在飞书会话内直接回复（WorkBuddy 有宿主原生飞书 bot，无需外发通道） |
| 自动派工（dispatch） | ❌ Tier 0 | 宿主未开放跨会话编排 API；派工=本会话执行或人工执行，任务留库盯守 |

**升级 Tier 的探针方法**（10 分钟）：在 WorkBuddy 会话里问 agent「列出你当前可用的工具清单」。
出现会话类工具（建/发/读/停别的会话）即 Tier 2——届时按 docs/adapters.md §1 契约实现 DispatchPort，
岗位卡的派工一节同步替换，其余不变。

## 安装（引用式，区别于 zcode 的插件市场模式）

```bash
node adapters/workbuddy/taskpier/install.mjs            # dry-run：只预览
node adapters/workbuddy/taskpier/install.mjs --apply    # 真写
node adapters/workbuddy/taskpier/install.mjs --rollback # 反悔
```

`--apply` 做三件事：专家包装进 `~/.workbuddy/plugins/marketplaces/my-experts/plugins/taskpier-foreman`；
`~/.workbuddy/mcp.json` 写入 `taskpier` 条目（command 优先用 WorkBuddy 内嵌 node，绝对路径引用
core server——**不复制 core**，升级 = `git pull`）；部署库落在 `adapters/workbuddy/taskpier/.taskpier/tasks.sqlite`
（经 `TASKPIER_DB_PATH` 注入，与 observer 共用同一解析链）。之后**重启 WorkBuddy**。

## 验收口径（v1 · WorkBuddy 侧）

1. 对包工头说「今天有哪些任务在跑？」→ 岗位卡跑上任引导（`board_summary`）并报到
2. 派一句话任务 → `task_create` 落库（keywords 必填）+ 回执「已登记为 #N」
3. 任务推进 → `task_update` 落库，主观产物置 `waiting_decision` 等飞书拍板
4. 收尾跑 `node adapters/workbuddy/taskpier/reconcile/observer.mjs` → 报告与实际一致（drift/unregistered 为空或可解释）

## 部署边界（重申架构立场）

**一个部署管一个宿主**：WorkBuddy 部署用本目录的 `.taskpier/tasks.sqlite`，与 zcode 部署的库互不相干，
不做跨宿主任务汇总。
