# Adapter contract

> Status: v0 draft (2026-11-18). 适配器是宿主差异的唯一收口处。

## 1. 契约（v0）

一个 Host 适配器需要提供（按必需程度排序）：

| 能力 | 方法（概念名） | 必需 | 说明 |
|---|---|---|---|
| dispatch | `task_session.create(prompt, workspace, project?)` | ✅ | 建任务会话并派工。这是 owner 的手。 |
| dispatch | `task_session.send(id, text)` / `.wait(id, timeout)` / `.interrupt(id)` | ✅ | 跟进、等待、叫停。 |
| observe | `activity.hook`（会话开始/工具活动/结束/等用户） | ⚠️ 尽力 | 用于自动置 `running`、检测卡死。无钩子的宿主退化为 owner 显式上报。 |
| identity | `host.list_projects()` / `host.list_sessions()` | ✅ | 动态解析，不写死路径。 |
| surface | 内嵌面板（可选） | ⬜ | 有则挂（如 ZCode `ui.surfaces`），无则看板走 Web。 |
| notify | 出向通道（Feishu/Lark/Slack/Telegram） | ✅ | 属 Channel 适配层，与 Host 无关，可独立复用。 |

**禁止**：适配器不得绕过宿主权限体系（代批、改权限模式）——除非 §P0 探针结论明确允许且用户显式开启。

## 2. ZCode 适配器（首发）

已核实的机制（2026-11-18，ZCode 桌面版）：

- **dispatch**：宿主会话工具 `CreateSession / SendToSession / WaitSessions / ReadSession / InterruptSession / ListProjects`——P0 已实证新会话内全套可用。
- **observe**：钩子事件共 7 种（`SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop`），插件钩子自动启用 runner；`Stop` 可续跑最多 3 次。
- **surface**：`ui.surfaces` + MCP App（官方 documents/pdf 等 4 个插件同款做法）；面板可用性字段为 `session` 级——是否常驻待 P0 复验。
- **扩展 API（探索中）**：宿主内部存在 `sessions.read/write/fullAccess + notifications` 四级授权，含 `createSession/forkSession/sendToSession/interruptSession/resolveInteraction/setPermissionMode` 及 `onDidChange*` 订阅。**是否对第三方插件开放未证实**——若可用，dispatch/observe/代批都有更正统的落点；P0-A 探针验证。
- **飞书**：宿主原生机器人（DM 绑 workspace + activeTask，长连接由宿主维护）负责入向；出向告警复用 `lark-cli`（同一应用，bot 身份推送已实证）。

已知坑：
- 私聊一个 bot 同时只绑一个 activeTask；owner 不要用 `/new` 切绑定。
- 子会话默认落点跟随所属项目，需显式指定 workspace。
- 插件 MCP server 的启动命令需跨平台（`node` + `${ZCODE_PLUGIN_ROOT}`，宿主 PATH 无 `node` 时回退宿主内嵌方式）。

## 3. Claude Code 适配器（计划）

- dispatch：待验证的 headless 入口（`claude -p`）或宿主内会话工具。
- observe：hooks 事件集与 ZCode 高度相似（同源设计），预期可映射；待逐项核对。
- surface：无内嵌面板预期，看板走 Web。
- 顺序：P0 完成、v1 稳定后启动；接口按 §1 契约实现，不倒逼契约变更。

## 4. Generic 适配器（零成本兜底）

任何支持 MCP 宿主：直接挂 TaskPier core 的 MCP server，得到任务库全部工具；dispatch 缺席时，owner 退化为"登记 + 跟踪 + 告警"（任务由用户在该宿主手动执行）。这保证 TaskPier 在未适配宿主上也不会一无是处。

## 5. Channel 适配器

| Channel | 方向 | v1 | 备注 |
|---|---|---|---|
| 飞书/Lark | 双向 | ✅ | 入向走宿主原生机器人；出向走 lark-cli / 飞书 API。文本优先，卡片按钮 v1.1 再议。 |
| Slack | 出向优先 | v1.x | 同一套告警规则。 |
| Telegram / 企微 / 钉钉 | 出向优先 | v1.x | 跟随宿主原生支持情况。 |

告警规则统一：仅 `waiting_decision` / `blocked` / `review` 推送，其余状态静默入库；每条告警附任务号、一句话进展、所需动作。
