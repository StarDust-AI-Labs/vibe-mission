# Adapter contract

> Status: v0 draft (2026-11-18). 适配器是宿主差异的唯一收口处。**一个部署 = 一个宿主**：适配器把这套产品模式接到某个宿主上（zcode 首发）；一个部署管理该宿主内全部任务会话，不存在跨宿主任务汇总。
>
> 澄清：适配器**不开发也不包装**会话操作接口——建会话/读上下文用的是宿主原生能力（owner 会话自带这些工具）。适配器写的是"怎么用宿主的手"（skill 指令包）+ "宿主事件 → 回写 TaskPier 任务库 MCP"（胶水）。见 architecture.md §3.1。

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

### 1.1 宿主能力阶梯（不赌宿主开放什么）

| 阶梯 | 宿主具备什么 | TaskPier 能做到 | 典型宿主 |
|---|---|---|---|
| **Tier 2** 原生编排 | 宿主给 agent 开放会话工具（建/发/读/停） | 完整闭环：派工、跟进、读上下文、叫停 | ZCode（已实证） |
| **Tier 1** CLI / 无头模式 | 产品有命令行形态 | **shell 派工**：拉起 `kimi cli` / `claude -p` / `codex exec` 子进程当任务会话；上下文=CLI 会话恢复 + git 工作区 | Kimi CLI、Claude Code、Codex 等 |
| **Tier 0** 无自动化 | 只能人操作 | 降级：登记 + 跟踪 + 告警，人工执行，owner 盯状态催办 | 纯 GUI 产品 |

跨宿主不变的：任务库 schema（`session_id` 在 Tier 2=宿主会话 ID、Tier 1=子进程记录、Tier 0=空）、8 态状态机、owner skill 骨架、告警规则。**变的只有 dispatch 一节**——每个宿主填一张"它有哪些手"的表。

宿主开放性验证方法（10 分钟）：在该宿主会话里问 agent"列出你当前可用工具"，有会话类工具即 Tier 2；否则查 CLI 形态；都没有即 Tier 0。

### 1.2 端口定义与模式选型（2026-11-20 定）

总体架构 = **Ports & Adapters（六边形）**：core 定义端口，每宿主实现适配器。四个关键设计点：

1. **端口按能力隔离（ISP），非 fat interface**——Tier 0 不被迫实现不存在的能力：

```ts
type DispatchMode = 'native' | 'cli' | null;   // Tier2 / Tier1 / Tier0

interface HostAdapter {
  readonly id: string;                          // 'zcode' | 'workbuddy' | 'kimi-cli' | …
  capabilities(): { dispatch: DispatchMode; observe: boolean; surface: 'panel' | null };
}

interface DispatchPort {                        // Strategy: NativeSessionDispatch | CliProcessDispatch
  create(spec: DispatchSpec): Promise<SessionRef>;
  send(ref: SessionRef, message: string): Promise<Ack>;
  wait(refs: SessionRef[], mode: 'any' | 'all', timeoutMs: number): Promise<WaitResult>;
  interrupt(ref: SessionRef): Promise<Ack>;
  readContext?(ref: SessionRef): Promise<string>;   // 可选能力
}

interface ObservePort {                         // hooks → HostEvent → 回写 core
  subscribe(handler: (e: HostEvent) => void): () => void;
}

interface NotifyPort { }                        // 与 HostAdapter 正交的另一族：feishu/slack/telegram
```

2. **Tier = 运行期能力探测结果，非静态枚举**——owner skill 读 `capabilities()` 决定降级行为，无散落 if-else。
3. **ACL（DDD）**——宿主词汇（如 ZCode `activeTaskId`）在 adapter 内翻译成 core 统一语言（Task/Status/SessionRef）后才入库。
4. **adapter = code + skill patch（本域特有）**——执行者是 agent 会话，dispatch 知识一半在端口代码、一半在 owner skill 的 dispatch 章节；每个 HostAdapter 交付端口实现 + skill 补丁段。

模式清单：

| 模式 | 落点 | 解决什么 |
|---|---|---|
| Ports & Adapters | 总体 | core 零宿主依赖 |
| ACL | adapter 翻译层 | 宿主词汇不泄漏进任务库 |
| ISP + 能力探测 + Null Object | 三端口 + `capabilities()` | 优雅降级 |
| Strategy | native / cli 两个 DispatchPort 实现 | Tier 2/1 可互换可混用 |
| Abstract Factory | plugin-creator 清单 | 每宿主装配端口实现 + skill 补丁 |
| 显式状态机（转移表 + guard） | core `task_update` | 约束集中一处 |
| Transactional Outbox（简化版） | events 表 | 告警先库后推、幂等 |
| Facade | 6 个 MCP 工具 | 隐藏存储细节 |

**明确不做**：微内核、通用插件运行时（YAGNI）。端口先以接口 + 文档存在，ZCode 为第一个实现；第二个适配器落地时回头验证抽象边界（rule of two）。

### 1.3 新宿主接入流水线（标准 6 步）

```
1. Capability Probe（10 分钟）：问 agent "列出你的工具清单" + 查 CLI 形态 → capabilities() 事实依据
2. 实现 HostAdapter：按探测结果实现端口子集
   Tier 2 → NativeSessionDispatch + ObservePort(hooks) + surface
   Tier 1 → CliProcessDispatch（spawn + resume；上下文 = CLI 会话 + git 工作区）
   Tier 0 → capabilities 全 null，core 自动降级 observe-only
3. skill patch：dispatch 章节文本，拼进 owner skill
4. 打包注册：plugin-creator 插件 / 裸 MCP 配置 / npm 包，按宿主生态选
5. P0 同款探针：建会话 / 推送 / 面板，口径如实标注
6. 灰度：先 observe-only 跑三天，再开 dispatch
```

工作量：Tier 1 ≈ 1-2 天（CLI 参数调通 + skill patch）；Tier 2 视宿主 API 文档质量；Tier 0 ≈ 半天。

扩展性四轴（正交）：新宿主 = 新 HostAdapter（core 零改动）；新能力 = 端口可选方法 + capabilities 新字段（向后兼容）；新通道 = ChannelAdapter 族；schema = SQLite 单向 migration + events append-only。扩展性地板：任何 agent 产品零适配即可以 Tier 0 使用登记+盯守+告警（MCP 工具面是稳定 API）。

## 2. ZCode 适配器（首发）

已核实的机制（2026-11-18，ZCode 桌面版）：

- **dispatch**：宿主会话工具 `CreateSession / SendToSession / WaitSessions / ReadSession / InterruptSession / ListProjects`——P0 已实证新会话内全套可用。
- **observe**：钩子事件共 7 种（`SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest / PostToolUse / PostToolUseFailure / Stop`），插件钩子自动启用 runner；`Stop` 可续跑最多 3 次。
- **surface**：`ui.surfaces` + MCP App（官方 documents/pdf 等 4 个插件同款做法）；面板可用性字段为 `session` 级——是否常驻待 P0 复验。
- **扩展 API（不作为 v1 依赖）**：宿主内部存在 `sessions.read/write/fullAccess + notifications` 四级授权（含 `resolveInteraction` 代批）。**2026-11-19 owner 拍板：借用宿主**——v1 dispatch 全部走 owner 会话工具，不依赖该 API；日后若确认对第三方开放，可再评估升级（尤其代批）。
- **飞书**：宿主原生机器人（DM 绑 workspace + activeTask，长连接由宿主维护）负责入向；出向告警复用 `lark-cli`（同一应用，bot 身份推送已实证）。

已知坑：
- 私聊一个 bot 同时只绑一个 activeTask；owner 不要用 `/new` 切绑定。
- 子会话默认落点跟随所属项目，需显式指定 workspace。
- 插件 MCP server 的启动命令需跨平台（`node` + `${ZCODE_PLUGIN_ROOT}`，宿主 PATH 无 `node` 时回退宿主内嵌方式）。

### 2.1 打包与开发流程（plugin-creator 模式）

开发与分发走 ZCode 官方 **plugin-creator** 流程：

- **插件形态**：`.zcode-plugin/plugin.json` 声明 `skills`（owner 行为规范）/ `hooks`（observe）/ `mcpServers`（任务库工具 + 面板）/ `userConfig`（看板端口等非敏感项）。所有组件路径必须在插件根内。
- **本地测试市场**：**本仓库根目录即市场**（`marketplace.json`，条目指向 `adapters/zcode/taskpier`）。开源用户 clone 后把仓库路径粘进 ZCode 插件市场即可安装；远程分发用 `git` 源市场（marketplace 支持目录/github/git/url/git-subdir），**不依赖 npm**。
- **交付闭环**：agent 负责生成源码 + 本地校验（JSON 合法性 / 路径越界 / 冒烟测试）；「添加市场 → 安装 → 启用 → 试用」必须由用户在 UI 完成——plugin-creator 原则禁止 agent 代做交接。改码后无热重载，需「刷新市场 + 更新」两步。
- **接受的硬约束**（官方文档明示）：`userConfig` 的 `sensitive` 字段 UI 输不进也存不了（飞书凭据一律走环境变量或宿主凭据库）；`agents/channels/lspServers/outputStyles/settings` 字段声明但不执行；无 npm/pip 分发。
- **core 代码落位**：MCP server 必须自包含在插件根内（路径不得越界）。v1 把 core 实现放在插件内，顶层 `core/` 只承载设计与共享约定；等第二个宿主适配器落地时再抽取到顶层，两边 sync。
- **扩展字段说明**：宿主二进制存在 `extension` 字段 schema，但 plugin-creator 规范未记载；2026-11-19 已拍板不依赖该路线（借用宿主），本插件清单**不使用文档外字段**。

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
