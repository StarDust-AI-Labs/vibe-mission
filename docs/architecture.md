# Architecture

> Status: v0 draft (2026-11-18). Working language: Chinese; English translation comes with v1.

## 1. 目标与非目标

**目标**

- 在**单个宿主内**部署一个 Super Agent（"工程负责人"），统一管理**该宿主的所有任务会话**：登记、派工、跟踪、状态反馈、告警、验收回流。
- 人只与这一个代理交互（聊天入口可为飞书/宿主会话），把"逐个任务盯守"的注意力负担转移给代理——多任务的上限不在模型，在人的注意力。思想来源：DeepSeek Harness 的 Super-agent 探索（Router/Worker 双层、常驻实体、事件驱动）。
- 持久化只有一处：任务库。宿主会话、负责人会话都可以生灭。

**非目标**

- **不做跨宿主任务聚合**。一个部署管一个宿主；多宿主 = 多个部署（同一套产品模式经适配器复用），不做"所有宿主任务汇总到一块屏"。
- 不重造各宿主已有的原生任务列表/会话系统（定位见 §5）。
- 不做通用项目管理 SaaS（Jira/Linear 的替代品）。
- v1 不做生产环境自动部署/审批绕过（安全边界见 §7）。

## 2. 分层

```
┌─────────────────────────────────────────────────────────┐
│ 用户入口                                                   │
│   飞书/Lark（DM + 群）  ·  宿主会话  ·  Web 看板             │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────┐
│ Channel 适配层（出向告警/入向指令 → 规范化消息）              │
│   feishu  ·  slack(later)  ·  telegram(later)            │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────┐
│ Owner 角色（负责人）—— 半自动编排                            │
│   意图路由 · 拆解 · 派工（经 Host 适配层） · 状态回写 · 回报     │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────┐
│ TaskPier Core（唯一持久层）                                 │
│   任务库(SQLite) + 事件审计 + MCP 工具面                     │
│   task_create / task_update / task_query / board_summary … │
└──────────────┬──────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────┐
│ Host 适配层（薄）                                          │
│   zcode  ·  claude-code  ·  generic(MCP-only 宿主)        │
│   能力：dispatch（建会话/发消息/等待/中断）、observe（活动信号）│
│         surface（可选：内嵌面板 or 无）                      │
└─────────────────────────────────────────────────────────┘
```

**范围口径：一个部署 = 一个宿主。** 适配器决定 TaskPier 落在哪个宿主（zcode 首发）；一个部署管理该宿主内的全部任务会话，不做跨宿主汇总。

## 3. 协议选择：为什么是 MCP

- MCP 是当前工具接入的事实标准：ZCode、Claude Code、Cursor、Codex 等宿主均支持 MCP 客户端接入。核心能力（任务库读写）以 MCP server 形态提供，**任何 MCP 宿主无需专门适配即可用**。
- 各宿主差异大的部分（会话编排 API、钩子事件、UI 面）被隔离在 Host 适配层，协议不外泄。
- Channel（飞书等）与 MCP 无关，走适配层，未来可替换。

含义：**"通用插件协议"的落法 = MCP 为核心协议 + 每宿主一个薄适配器**，而不是发明一个新协议。

### 3.1 两个接口面（最易混淆点）

| | 接口面 ①：任务库 MCP | 接口面 ②：会话操作 |
|---|---|---|
| 谁开发 | **TaskPier 自研**（core 的 MCP server） | **宿主原生**（ZCode 的 CreateSession/ReadSession…，我们只"用"不"造"） |
| 管什么 | 任务记录：登记、状态、审计、看板数据 | 真实执行：建会话、跟进、读上下文、叫停 |
| 谁来调 | owner / 任意代理 / 看板 / Channel | **owner（它自己就是宿主里的一个会话，天生有这些工具）** |
| 形态 | 标准 MCP，任何宿主零适配接入 | 非通用：各宿主各一套，适配器写成"使用说明书 + 胶水" |

技术细节：MCP server 是宿主拉起的独立子进程，**拿不到宿主的会话工具**（那些只在 agent 会话的工具列表里）。所以"创建会话"由 owner 会话调用宿主工具完成。**2026-11-19 拍板：v1 即采用此"借用宿主"模式**，不依赖宿主扩展 API；日后若扩展 API（sessions.*）确认对第三方开放，再评估升级（含代批能力）。

### 3.2 角色模型：Bot、owner、入口会话、任务会话

**owner 不是一个独立的 Bot，而是一个角色。** 飞书 Bot 是本体；它在入口会话里加载 `vibemission-owner` 技能后，以 owner 身份工作。

| 名称 | 是什么 | 谁创建 | 职责 |
|---|---|---|---|
| 飞书 Bot | ZCode 飞书机器人账号（如“ZCode开发”） | 平台/用户安装 | 收发飞书消息；本体 |
| owner | 一个角色（工程负责人） | 由 Bot 加载技能后扮演 | 识别意图、登记任务、派工、跟踪、汇报 |
| 入口会话 | 飞书群/私聊对应的 ZCode 会话 | Bot | 接待用户、路由消息、向用户汇报；**不是任务会话** |
| 任务会话 | 一条任务的独立执行会话 | **owner**（`CreateSession`） | 执行任务；里面的 agent 是执行者，不是 owner |
| VibeMission MCP | 任务账本工具进程 | 宿主拉起 | 提供 `task_*` 工具；不是 agent，也不是 Bot |

**从一句话到任务会话：**

1. 用户在飞书发消息 → Bot 在入口会话接住
2. owner 识别意图：闲聊/问答不登记；明确任务才进入下一步
3. `task_create` 登记，拿到编号 `#N` 与一句话名字
4. owner 用 `CreateSession` 创建**独立任务会话**
5. `RenameSession(任务会话, "[#N] 名字")`；入口会话标题保持「飞书 · 群 · 话题」不改
6. `task_update(session_id=任务会话, status=running, workspace=…)`
7. 后续用户消息用 `SendToSession` 路由进任务会话；owner 在入口会话汇报

**三条边界：**

- owner 与 Bot 是**一体两面**：同一个 Bot，戴上 owner 角色。不是两个机器人。
- 入口会话 ≠ 任务会话：入口只做接待/路由/汇报，任务会话才承载执行。
- 任务会话里的 agent 不是 owner：prompt 固定声明“你是执行会话，不是 owner；不登记、不派工、不建子会话”，防止递归派工。

**能力前提**：owner 角色依赖三样东西——`vibemission-owner` 技能已加载、VibeMission MCP 可用、宿主会话工具（`CreateSession` / `RenameSession` / `SendToSession` …）可用。缺任何一项，Bot 只是普通 Bot，不是 owner。

## 4. 任务库（初稿 schema）

```sql
tasks(
  id INTEGER PRIMARY KEY AUTOINCREMENT, -- 数字任务号；接口展示 tp-0007，口头 #7
  title TEXT NOT NULL,            -- 一句话名字（动词+对象+结果，硬上限 80 字）
  keywords TEXT,                  -- 路由别名/关键词（JSON 数组，供意图匹配）
  status TEXT NOT NULL,           -- 9 态，见 status-model.md
  host TEXT,                      -- zcode / claude-code / …
  project TEXT,                   -- 宿主内项目/工作区标识
  session_id TEXT,                -- 宿主任务会话 id（可空）
  workspace TEXT,                 -- 落点目录
  parent_id INTEGER,              -- 拆解父子关系
  blocked_reason TEXT,
  decision_question TEXT,         -- waiting_decision 时的问题+选项
  decision_options TEXT,
  artifacts TEXT,                 -- 产出物路径[]
  evidence TEXT,                  -- 验收证据[]
  created_at INT, updated_at INT
);
events(                           -- 审计流水，只追加
  id, task_id, ts, kind,          -- status_change / note / dispatch / alert / decision
  actor TEXT,                     -- owner / host:<id> / user / channel:feishu
  payload TEXT
);
```

数据落点：宿主提供的插件数据目录（如 ZCode 的 `${ZCODE_PLUGIN_DATA}`），不入仓、不上传。

**编号与名字**：`id` 是自增数字，永不变、永不复用；接口/看板展示为 `tp-0007`，聊天口头用 `#7`（解析统一兼容 `7` / `#7` / `#0007` / `tp-7` / `tp-0007`）。`title` 是唯一的人读名字，规则见 owner skill §3.1：一句话、动词+对象+结果、一件事、硬上限 80 字；改名只改 `title`，编号不变，事件里留 `from → to`。

### 4.1 MCP 工具面（v1 定稿）

| 工具 | 关键入参 | 语义 | 状态约束 |
|---|---|---|---|
| `task_create` | title, keywords?, workspace?, project?, parent_id? | 登记任务；title = 一句话名字（≤80 字），编号自动生成 | → `todo`（未分类先落 `inbox`） |
| `task_update` | id, status?, session_id?, blocked_reason?, decision_question?, decision_options?, keywords?, artifacts?, evidence?, title? | 状态迁移 / 补字段 / 改名（编号不变） | 校验迁移合法性，**写 events**；迁移到三告警态时供告警路径消费 |
| `task_query` | id | 单任务详情 + 最近 events | — |
| `task_list` | filter: status / host / project | 任务列表 | — |
| `board_summary` | — | 仪表盘计数 + 高亮项（running / waiting_decision / blocked / review） | — |
| `decision_answer` | id, answer | 用户拍板回流 | `waiting_decision` → `running` / `done` |

**告警路径（v1 双通道，不依赖 owner 在线）**：owner 在线时由 owner 统一发送（skill 规则）；owner 空闲或任务会话自行结束时，由 Stop 钩子胶水脚本直接调 lark-cli 推送固定模板。两条路径都以 `task_update` 的落库动作为事实来源，先库后推，幂等（同任务 10 分钟内不重复推）。

## 5. 与宿主原生任务系统的关系

| | 宿主原生任务列表 | TaskPier |
|---|---|---|
| 范围 | 按 workspace 分散在宿主各处 | 本宿主全部项目，一个代理统一盯 |
| 状态 | 运行/归档等宿主自定义 | 统一 8 态 + 告警规则 |
| 可视化 | 宿主内 | 本地 Web 看板（宿主面板为可选增强） |
| 遥控 | 宿主内 | 聊天入口（飞书等）统一遥控 |
| 真相源 | 会话本身 | 任务库引用会话（session_id 外链） |

原则：**宿主任务系统是事实，owner 是它的统一管理者与状态层**。TaskPier 不重造宿主职责，只做宿主做不了的三件事：全宿主任务的统一盯守、主动告警、聊天遥控。

## 6. Owner 角色（v1 = 半自动）

- v1：用户说"把 X 做了"→ owner 判重、登记任务、经 Host 适配层建任务会话、跟踪状态、完成或卡住时回报。**不自动拆解**。
- v1.1：一句话自动拆解为子任务树（`parent_id`），按并发上限排队派工。
- Owner 是角色不是会话：其行为规则放在 adapter 的 skill/指令包里，任何被授命的会话读取任务库即可上任。

### 6.1 三类上下文，三个存放处（上下文持久化）

| 上下文 | 存放处 | 持久性 |
|---|---|---|
| 任务状态与历史 | 任务库（tasks + events，SQLite） | ✅ 持久，宿主重启不丢 |
| 任务会话的对话上下文 | 任务会话自身（宿主持有） | 会话存活期内持久；owner 用 ReadSession 按需取，**不复制** |
| owner 与用户的对话上下文 | events 审计 + 恢复引导注入 + 飞书聊天历史 | ✅ 持久，不依赖 owner 会话记忆 |

原则：单一 owner 会话只是"当班者"，所有事实实时落库——**会话只是缓存，库才是记忆**。

### 6.2 Owner 恢复引导（boot sequence）

- `SessionStart` 钩子（startup/resume/compact 均触发）读任务库，以 `additionalContext` 注入："你是工程负责人；当前 running N / waiting_decision M / blocked K；最近 10 条 events 摘要"。
- owner 任何时刻上任都走同一引导：换会话、被压缩、宿主重启后，对话连续性由任务库保证，而非会话记忆。
- 需要更早的来龙去脉：读 events 流水 + 回看飞书聊天历史（飞书侧本身持久）。

### 6.3 并发

- 任务会话天然并行；**并发上限**（默认 3，userConfig 可配），超出自动排队在 `todo`。
- owner 用 `WaitSessions` 批量等待多任务（mode: any/all）。
- 任务库由单进程 MCP server 串行写入（SQLite 单写者），多会话并发回写无冲突。
- 用户连续下达的指令各自登记为独立任务排队，互不阻塞。

### 6.4 意图路由（把消息分发进同一个任务会话）

owner skill 内置路由决策树（v1 核心）：

1. **显式编号**（"#12" / "tp-12" / "tp-0012"）→ 直达该任务；
2. **关键词精确匹配**（任务带 `keywords` 别名字段，见 §4）；
3. **模糊匹配**：候选唯一且任务活跃 → 附确认执行（"按 #12 处理"）；
4. **候选多个或不确定** → 列出候选（编号+标题）让用户选，**绝不猜**；
5. **全不匹配** → 判重后新建任务。

路由成功 → `SendToSession` 把消息派进**该任务的原会话**（延续其上下文）；若该会话已归档/失效 → owner 如实报告并问用户：重开会话续做，还是就此结案。

## 7. 权限与安全边界

1. **默认不代批**。任务会话遇权限审批时的策略由 P0 探针（见 roadmap）决定；候选：阻塞告警（最安全）/ 宿主侧全自动（需白名单）/ 宿主扩展 API 代批（能力存在但权限面极大，单独评审）。
2. 聊天指令**不得绕过宿主或仓库的生产门禁**（如 AGENTS.md 约束）。
3. 凭据不进插件配置（宿主多无安全凭据存储），走环境变量或宿主系统凭据库。
4. 告警通道只读用户绑定关系，不扫其他会话。

## 8. 可移植性

- Core：纯 Node（**≥ 23.4.0**，`node:sqlite` 去实验旗标的版本；D14），零第三方依赖（SQLite 走 node:sqlite，stdio JSON-RPC 手写帧）。注意：Node 对 node:sqlite 仍标 experimental，API 稳定前锁 minor 版本。
- 看板：本地 HTTP 静态页 + JSON API，浏览器打开即用。
- 部署形态：跟随宿主插件机制安装（ZCode 插件 / Claude Code plugin / 裸 MCP 配置），同一份源码。

## 9. 待定问题（随 P0 探针收敛）

- ~~宿主扩展 API 是否对第三方开放~~ **已拍板（2026-11-19）：借用宿主**——dispatch 走宿主会话工具，扩展 API 不作依赖。
- 内嵌面板是否 session 级 → 决定看板默认载体（Web vs 面板）。
- 入向聊天消息在宿主侧的会话复用规则 → 决定 owner 上下文恢复策略。
