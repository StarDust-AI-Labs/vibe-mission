# Roadmap

> Status: v0 draft (2026-11-18). 探针先行：架构分叉点用实验解决，不拍脑袋。

## P0 探针（半天，先于一切编码）

每个探针 = 一个最小插件，全部按 **plugin-creator 流程**打包（清单 → 本地校验 → 仓库根 `marketplace.json` 注册 → 用户 UI 安装验证），交付口径如实标注「已验证 / 待手动 / 未验证」。

**A 已拍板（2026-11-19），不再探针**：dispatch **借用宿主**——owner 会话直接调宿主原生会话工具（`CreateSession / SendToSession / ReadSession / WaitSessions / InterruptSession`，已实证齐全）。宿主扩展 API（sessions.* grants，含 resolveInteraction 代批）**不作为 v1 依赖**；日后确认对第三方开放可再评估升级。探针清单调整为：

| # | 探针 | 验什么 | 决定什么 |
|---|---|---|---|
| B | **子会话权限行为** | 建一个必然触发审批的子会话：卡住 / 自动拒 / 继承模式？ | 权限策略二选一（阻塞告警 / 全自动+白名单；扩展代批随 A 关闭出局） |
| C | **聊天入口会话复用** | 飞书 DM 连发两条消息，activeTask 复用还是新开？ | owner 上下文恢复策略 |
| D | **面板渲染** | 最小 MCP App 面板装进宿主 | 看板默认载体（面板 vs Web） |

历史：原 ZCode 定制方案下 P0 已跑过三项（会话工具齐全 ✅、飞书 bot 推送 ✅、面板源码冒烟 🟡）；本仓以通用协议重启，探针在**本仓代码**上重跑。

## v1（任务库 + 看板 + 告警 + 半自动负责人）

范围（已与 owner 对齐，2026-11-18）：

1. **core**：任务库（SQLite）+ MCP server（task_create / task_update / task_query / task_list / board_summary / decision_answer）。实现落在 zcode 插件内（插件根自包含约束），顶层 `core/` 承载设计，第二个适配器出现时抽取共享。
2. **board**：本地 Web 看板，8 态列 + 仪表盘计数 + 阻塞/待决策高亮。
3. **channel-feishu**：`waiting_decision` / `blocked` / `review` 三态推送；文本交互（"通过/打回/停掉 #N"）。
4. **adapter-zcode**：按 plugin-creator 模式打包（skills + hooks + mcpServers + userConfig）；dispatch = 宿主会话工具；observe = 钩子；P0 结论决定是否升级为扩展 API。仓库根即测试市场，开源后可作 git 源市场直接安装。
5. **owner skill**：登记→派工→跟踪→回报 + **意图路由决策树**（architecture.md §6.4，分发进同一任务会话）+ **恢复引导**（配合 SessionStart 钩子注入任务摘要）；半自动，不拆解。

验收 1（闭环）：用户在飞书说"把 X 做了"→ 任务被登记、派工、执行、回报，全程可在看板看到。
验收 2（连续性与路由）：隔天在飞书说"#12 的截图再改一版"→ 消息被路由进 #12 的原任务会话续做，而非新建任务；owner 换会话后依然能接上上下文。

**v1 开工顺序**：core（任务库+MCP server，无前置依赖）→ owner skill（路由+派工+护栏，见 owner-skill.md）→ board（Web 兜底）→ channel-feishu → plugin-creator 打包 + P0-B/C 回填结论。

## v1.1（自动拆解 + 体验）

- 一句话自动拆解任务树（并发上限、排队）。
- 告警卡片按钮（通过/打回/更多）。
- **Tier 1 通用 CLI 适配器**（shell 派工：Kimi CLI / Claude Code / Codex 等命令行形态的宿主，见 adapters.md §1.1）。
- Workbuddy 探针（问 agent 列工具清单，判定 Tier 2/1/0）+ Claude Code 适配器。

## 悬而未决（Open questions）

- ZCode 扩展 API 是否对第三方开放（P0-A）。
- 通用"插件协议"除 MCP 外是否需要适配 OpenClaw 等社区规范——观察生态，不抢先实现。
- Linux（headless/桌面 Beta）部署形态——迁移文档在旧仓 `D:\zcode-task-owner\docs\`，v1 后并入本仓。
- 开源发布渠道：GitHub（StarDust-AI-Labs org）+ npm scope 待定；docs 英文化随 v1。

## 风险

| 风险 | 应对 |
|---|---|
| 权限策略三选一无一完美 | v1 先用最安全的"阻塞告警"，全自动仅限白名单目录 |
| owner 上下文膨胀 | 角色化设计：规则在 skill、事实在任务库，会话可随时换 |
| 各宿主钩子/会话 API 变动 | 差异全部锁在 adapter，core 稳定 |
| 告警疲劳 | 三态告警 + 每任务合并推送（同任务 10 分钟内不重复推） |
