# 设计落地对照与差距清单（Implementation Gaps）

> Status: v1 (2026-11-27)。**方法**：逐条取设计条款 → 找代码落点 → 用可复现命令验证 → 标注差距与实现路径。
> 对照对象：[design-philosophy.md](design-philosophy.md)、[architecture.md](architecture.md)、[ingress-aggregation.md](ingress-aggregation.md)、[status-model.md](status-model.md)、[workspace-and-memory.md](workspace-and-memory.md)、[roadmap.md](roadmap.md)。
> 关联任务 #38。本文只做对照与计划，**不含实现**；实现按 §5 拆 PR。

---

## 0. 一页纸结论

| 域 | 设计预期 | 现状（证据见 §7） | 差距 | 优先级 |
|---|---|---|---|---|
| 账本与 9 态状态机 | 唯一真相 + 迁移校验 + guard | ✅ 已实现（`core/src/store.mjs`、`state-machine.mjs`，27 测试） | — | — |
| 编号与一句话命名 | `#N` / `tp-N` 等价，≤80 字 | ✅ 已实现（`format.mjs`、`tools.mjs`） | — | — |
| 三态告警（出向） | 幂等 10 分钟窗口 | ✅ 已实现（`channels/feishu/notify.mjs`） | — | — |
| 项目索引路由 | 原话 → 项目 → 目录 | ✅ 已实现（`projects.json`、`project-index.mjs`，7 测试） | — | — |
| **会话恢复引导** | SessionStart 每次注入态势 | ❌ **运行期钩子指向已删除的旧路径**，失败静默退出 0 | **断线** | **P0** |
| **owner skill 与设计一致** | 运行时 = 仓库 = 设计 | ❌ 运行时 146 行（旧版）/ 仓库 215 行（含角色模型全节） | **陈旧** | **P0** |
| **入口响应性** | ack ≤1s、快通道 ≤5s、禁长等 | ❌ 无入向层；skill §4 仍写 `WaitSessions` 批量长等 | **完全缺失** | **P0** |
| **入向消息聚合** | 静默窗口 + 规则路由 + 一次抽取 | ❌ `channels/` 仅出向；无 `ingress.mjs`、无测试 | **完全缺失** | **P0** |
| burst 审计 | 结算即落库（§3.5） | ❌ `events.task_id NOT NULL REFERENCES tasks(id)` → 建任务前写不进 | schema 阻塞 | P1 |
| schema 演进 | 可加列 | ❌ 仅 `CREATE TABLE IF NOT EXISTS`，无 ALTER 迁移 | 无迁移机制 | P1 |
| 入口 → 多任务绑定 | `entry_session_id` / 绑定表 | ❌ DDL 无该字段（design-philosophy §9 自认缺口） | 缺字段 | P1 |
| 配置策略（D22） | 重要/大型 → 用户确认；白名单外 → waiting_decision | ❌ 账本无 `config`/`important`；`projects.json` 无 preset；skill 无规则 | 无落点 | P1 |
| 告警双通道 | Stop 钩子兜底 | ❌ `hooks.json` 只有 SessionStart；运行期 Stop 只有 ai-memory | 缺一路 | P1 |
| 并发上限（默认 3） | 超出排队 todo | ⚠️ 仅 skill 文本；`plugin.json` 无 userConfig，core 无校验 | 文本约束 | P1 |
| 高延迟任务下放 | 入口不执行 | ⚠️ 仓库 skill §2.3 已写，但无客观判据/前置检查 | 文本约束 | P1 |
| 自动拆解 | `parent_id` 树 | ⚠️ schema 有 `parent_id`，无拆解逻辑 | v1.1 计划内 | P2 |
| Mission / Task / Run | 三层模型 | ❌ 单层 `tasks` | v1.1 计划内 | P2 |
| handoff | 显式转派 + 事件 | ❌ 无工具 | v1.1 计划内 | P2 |
| 看板父子/批次 | 层级视图 | ❌ `board/data.mjs` 不输出 `parentId` | v1.1 计划内 | P2 |

**一句话**：账本、编号、告警出向、索引这些"记录层"是扎实的；**真正缺的是"入口运行时"这一整层**——聚合、响应性、恢复引导接线、skill 同步。而这一层恰好是你日常感知最强的地方。

---

## 1. 已落地：不要重做

| 能力 | 落点 | 验证 |
|---|---|---|
| 任务/事件持久化（WAL、只追加） | `core/src/store.mjs:11-41` | `npm test` 27 通过 |
| 9 态迁移表 + 三态 guard + 告警态判定 | `core/src/state-machine.mjs:24-97` | 同上 |
| 六工具 MCP 面（含 `#N`/`tp-N` 解析） | `core/src/tools.mjs:16-22, 245-334` | 同上 |
| 编号/命名格式 | `core/src/format.mjs:15-36`；`tools.mjs:9-10`（80 字上限） | 同上 |
| DB 路径单源（四进程同库） | `core/src/dbpath.mjs:11-30` | 运行期 mcp.json 实测一致 |
| 出向三态告警 + 幂等 | `channels/feishu/notify.mjs:56-69, 116` | channels 2 测试 |
| 本地看板 / 快照 / hosted | `board/server.mjs`、`data.mjs`、`page.html`、`hosted-server.mjs` | board 9 测试 |
| 项目索引 | `projects.json`、`scripts/project-index.mjs` | 7 测试 |
| 简报钩子**代码** | `adapters/zcode/vibemission/hooks/session-start.mjs` | 代码正确，**但没接线**（G1） |
| WorkBuddy Tier 0 对账 | `adapters/workbuddy/taskpier/` | 7 测试 |

---

## 2. P0：阻断"设计真正生效"的四处断线

### G1 运行期 SessionStart 钩子指向已删除路径（恢复引导断线）

- **预期**：architecture §6.2 —— 每次开工（startup/resume/compact）注入任务态势简报。
- **现状**：`~/.zcode/cli/config.json` 的 `hooks.events.SessionStart` 第二条指向
  `D:\aiCoding\projects\taskpier\adapters\zcode\taskpier\hooks\session-start.mjs`。
  该目录**已不存在**（仓库早已更名/迁移到 `vibe-mission`）；钩子约定"失败静默 exit 0"，所以没有任何报错。
- **影响**：新会话从来没有简报，owner 上任引导实际靠人肉提醒。设计里"会话是缓存、库是记忆"这半条腿是断的。
- **实现**：
  1. 改运行时 `config.json` 指向 `D:\aiCoding\projects\vibe-mission\adapters\zcode\vibemission\hooks\session-start.mjs`（MCP 条目已正确，无需动）；
  2. 新增 `scripts/doctor.mjs`：检查（a）MCP 路径存在，（b）SessionStart 钩子路径存在，（c）skill 同步状态，（d）DB 可读、计数可返回；输出逐项 PASS/FAIL。
- **验收**：重启宿主导入新会话出现 `【VibeMission 任务态势】`；`node scripts/doctor.mjs` 全绿。

### G2 运行时 owner skill 陈旧（bot 现在没按新设计工作）

- **预期**：运行时 skill = 仓库 skill（`install-skill.mjs --check` 为 IN SYNC）。
- **现状**（**更正**：上一轮口头判断方向说反了，以本节实测为准）：
  - 仓库 `adapters/zcode/vibemission/skills/vibemission-owner/SKILL.md` = **215 行**（2026-11-26 23:57，含 §2.1 登记时机、§2.2 A 方案、§2.3 高延迟下放、§2.4 归属逐条判断、§3.1 命名、§5.1 改名）；
  - 运行时 `~/.agents/skills/vibemission-owner/SKILL.md` = **146 行**（2026-11-26 16:41，旧版，**无上述任何一节**）；
  - `node scripts/install-skill.mjs --check` → `OUT OF SYNC`；
  - 运行时独有 11 行均为被取代的旧文案（含 `init-layout --root "D:ibemission"` 路径笔误），无保留价值。
- **影响**：**这是"每句话都推理、消息堆积"的直接原因之一**——bot 跑的是没有角色模型与归属规则的旧 skill。
- **实现**：先按 G3 修正仓库 skill，再 `node scripts/install-skill.mjs`，重启宿主。
- **验收**：`--check` 为 IN SYNC；新会话 skill 内容含 §2.1–§2.4。

### G3 skill §4 与响应性预算冲突

- **预期**：ingress-aggregation §3.0 —— 入口回合禁挂长等待，跟踪走事件驱动。
- **现状**：仓库 skill §4 第 105 行"用 `WaitSessions` 批量等待活跃任务会话（mode: any），避免傻等单个"；运行时旧版第 43 行同款。这与"入口保持即时可回复"直接冲突（挂长等期间用户消息憋在队列）。
- **实现**：改写为——跟踪走 `hooks` + `notify.mjs` 事件驱动；`WaitSessions` 仅允许在任务会话内部使用，或入口场景下带 ≤30s 超时；入口回合必须秒级结束。
- **验收**：skill 内不存在无界 `WaitSessions` 表述（grep 可查）。

### G4 入向聚合层完全不存在

- **预期**：ingress-aggregation §3.0–§3.5 —— ack、快速通道、静默窗口、规则路由、一次意图抽取、burst 审计。
- **现状**：`channels/` 只有 `feishu/notify.mjs`（出向）+ `test/feishu.test.mjs`；无 `ingress.mjs`，无任何入向测试；飞书消息直接进 bot 会话逐条触发推理。
- **影响**：用户最初提出的痛点（堆积、割裂、改主意作废）一个都没解。
- **实现**：见 §5 PR-B / PR-D。

---

## 3. P1：让新设计"有落点"的六项

### G5 burst 审计被 schema 阻塞

`events.task_id INTEGER NOT NULL REFERENCES tasks(id)`（`store.mjs:31-37`，且 `PRAGMA foreign_keys=ON` at `store.mjs:196`）意味着**任务创建之前**的 burst 无法写入 events。设计 §3.5 要求"结算即写"，§3.1 要求"崩溃可从 events 恢复未结算桶"——两者当前都做不到。

**实现**：不复用 `events`（改可空会削弱现有约束），新增 `ingress_bursts` 表：

```sql
ingress_bursts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket_key TEXT NOT NULL,        -- channel:chat:user
  first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  messages TEXT NOT NULL,          -- JSON [{ts, text, msg_id}]
  resolution TEXT,                 -- pending | fast | rules | intent | asked | dropped
  task_id INTEGER,                 -- 结算后关联，可空
  created_at INTEGER NOT NULL
)
```

### G6 无 schema 迁移机制

`store.mjs:11` 的 DDL 全部是 `CREATE TABLE IF NOT EXISTS`，`openStore`（`store.mjs:185-203`）直接 exec。给生存库加列会**静默不生效**（老库表已存在，IF NOT EXISTS 跳过）。

**实现**：`migrate(db)`——`PRAGMA table_info(tasks)` 比对目标列，缺则 `ALTER TABLE ADD COLUMN`；加 `schema_meta(version INTEGER)` 记录版本。测试：构造旧 schema 库 → `openStore` 两次 → 列齐且幂等。**改生存库前先备份**。

### G7 入口会话 → 多任务绑定缺失

design-philosophy §9 自认缺口。DDL 无 `entry_session_id`，也无绑定表。

**实现**：`entry_session_tasks(entry_session_id TEXT, task_id INTEGER, first_seen_at INT, last_seen_at INT, PRIMARY KEY(entry_session_id, task_id))`。选表而非单字段，因为一个入口会话承载多任务（§2.4）。`task_update` 增加可选 `entry_session_id` 以便回写。需在 decisions 记一条 D23。

### G8 配置策略（D22）无字段、无预设

- `tasks` 无 `config` / `important`；
- `projects.json` 无 preset / skills 白名单；
- `plugin.json` 无 `userConfig`（architecture §6.3 提到"并发上限 userConfig 可配"也未落地）；
- skill 无"配置自选规则"。

**实现**：`tasks` + `config TEXT DEFAULT '{}'`（`{model, thought, skills:[]}`）、`important INTEGER DEFAULT 0`；`projects.json` 每项 + `preset: {model, thought, skills:{allow:[]}}`；skill §3 增补——默认自主、重要/大型先问、白名单外走 `waiting_decision`。

### G9 Stop 钩子兜底告警缺失

architecture §4.1 承诺双通道："owner 空闲或任务会话自行结束时，由 Stop 钩子直接调 lark-cli"。实际：`hooks.json` 仅 SessionStart；运行期 `Stop` 只有 ai-memory 一条。

**实现**：`hooks/stop-notify.mjs`（复用 `notify.mjs` 的 `collect()`/发送逻辑，60s 冷却 + 现有 10 分钟幂等），在 `hooks.json` 与运行期 `config.json` **两处**接线（D17：运行期以 config.json 为准）。需注意 Stop 触发频繁，冷却与幂等缺一不可。

### G10 并发闸门与高延迟判据只在文本里

**实现**：`scripts/dispatch-gate.mjs --check --db <path>` → `{active, limit, allowed, queuePosition, suggestion: "dispatch"|"local"}`；`limit` 取 `VIBEMISSION_MAX_CONCURRENCY`（默认 3）；skill 派工前引用。不做进 MCP——工具面冻结，且闸门是派工策略不是账本事实。

---

## 4. P2：路线图内，本文不展开

自动拆解（`parent_id` 树）、Mission/Task/Run 三层模型、handoff 事件与工具、看板父子/批次视图、入向幂等键（D20-⑦）、WorkBuddy Tier 1 shell 派工。详见 [roadmap.md](roadmap.md)。

---

## 5. 实施顺序（PR 拆分与依赖）

| 序 | PR | 范围 | 依赖 | 验收 |
|---|---|---|---|---|
| A | `fix/runtime-wiring` | G1 钩子路径 + `scripts/doctor.mjs` + G3 skill 条款修正 + `install-skill` | 无 | 新会话出现简报；doctor 全绿；`--check` IN SYNC |
| B | `feat/ingress-aggregator` | G4 纯逻辑：`channels/ingress.mjs` + 单测（**不接网络**） | 无（可与 A 并行） | 7 场景单测全绿 |
| C | `feat/ledger-ingress-schema` | G5/G6/G7/G8：迁移 + `ingress_bursts` + `tasks` 新列 + MCP 可选字段 + 测试 | 无 | 迁移幂等；burst/config 往返；旧库无损 |
| D | `feat/feishu-ingress` | 飞书入向探针（长连接 vs webhook、reaction ack）+ 接入 + ack | B（逻辑）、C（落库） | 探针结论入 `docs/probes/`；连发 3 条只产生 1 个 burst |
| E | `fix/alert-stop-hook` + `feat/dispatch-gate` | G9/G10 + skill 配置规则 | C（配置字段）、A（skill 安装通道） | 停会话后 10 分钟内收到一次兜底推送；闸门单测 |

**先做 A + B**：A 让现有设计真正生效（零代码风险、收益最大）；B 是可完全离线验证的骨架。

---

## 6. 风险

| 风险 | 应对 |
|---|---|
| 飞书入向能力未知（长连接/回调/权限） | 探针先行，不预先承诺形态；探针失败则退化为"定时拉取 + 本地收敛" |
| 改运行期 `config.json` 需重启宿主 | 无法从会话内完成，交付时明确标注"待你重启" |
| 生存库加列 | 先备份 `tasks.sqlite` + 迁移幂等测试 + 保留旧库回滚路径 |
| 双写期冲突（bot 原生会话 + 收敛器并存） | 收敛器默认关闭（env 开关），灰度验证后启用 |
| skill 安装后行为变化超出预期 | A 的验收限定为"简报出现 + IN SYNC"，行为回归单独立项 |

---

## 7. 证据索引（可复现）

| 结论 | 证据 / 命令 |
|---|---|
| 无入向层 | `find channels -type f` → 仅 `README.md`、`feishu/notify.mjs`、`test/feishu.test.mjs` |
| 无 Stop 钩子 | `grep -rn "Stop\|SessionEnd" adapters/` → 无结果 |
| 运行期钩子路径失效 | `~/.zcode/cli/config.json` → `hooks.events.SessionStart[1].hooks[0].args[0]`；`ls D:/aiCoding/projects/taskpier` → 不存在 |
| skill 陈旧 | `wc -l` 运行时 146 / 仓库 215；`node scripts/install-skill.mjs --check` → OUT OF SYNC |
| burst 无法落库 | `core/src/store.mjs:31-37`（`task_id NOT NULL REFERENCES`）、`:196`（foreign_keys=ON） |
| 无迁移 | `core/src/store.mjs:11`（IF NOT EXISTS）、`:185-203`（openStore 无 PRAGMA table_info） |
| 无配置字段 | `core/src/store.mjs:12-29`；`core/src/tools.mjs:249-263, 269-288` |
| 无预设 | `projects.json`（仅 id/name/product/workspace/keywords） |
| 无 userConfig | `adapters/zcode/vibemission/.zcode-plugin/plugin.json` |
| 看板无层级 | `board/data.mjs:48` 返回结构无 `parentId` |
| skill 长等待条款 | 仓库 `SKILL.md:105`；运行时 `SKILL.md:43` |
