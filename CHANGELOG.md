# Changelog

本项目的版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。
正式版本以 annotated tag `vX.Y.Z` 标记，发布说明取本文件对应条目。

## v0.3.1 — 2026-11-27

### 新增

- **入向消息聚合与任务会话配置策略总体设计**（[docs/ingress-aggregation.md](docs/ingress-aggregation.md)，v0 待评审）：静默窗口（30s debounce / 120s 硬上限）+ 规则路由先行 + 一次意图抽取（后说覆盖先说）的收敛器机制；任务会话配置策略拍板——AI 自主为默认，重要/大型任务或用户主动要求时用户决定（D21/D22）。

### 修复

- **board snapshot 模板路径移植化**：zcode-site 0.5.1 stage 模板原样 vendor 到 `board/templates/`（`ZCODE_SITE_TEMPLATES` 环境变量可覆盖），移除硬编码本机路径——修复 main 连续三次 Linux CI failure 的根因。

### 验证

- core（27）/ board（9）/ channels（2）/ routing（7）/ workbuddy（7）测试全绿；`validate-plugin` PASS；PR CI（ubuntu-latest）通过。

## v0.3.0 — 2026-11-27

### 新增

- **hosted board**：`board/hosted-server.mjs` 站点直连账本并支持实时推送；`board/publish.mjs` 本地推送脚本；`docs/hosted-board.md` 与 7 项集成测试。
- **设计理念（内部实现版）**：`docs/design-philosophy.md`，集中说明角色模型、窗口≠任务、逐条任务归属、入口不执行高延迟任务、十条原则与反模式、代码落点。

### 修复

- hosted board 对超大请求先 drain 再返回 413，避免 `fetch` 偶发 `ECONNRESET`。

### 变更

- 修正 owner 规则表述：入口窗口可承载多个任务；任务归属逐条判断，不按窗口或消息条数默认同一个任务。

### 验证

- core / board / channels / routing / workbuddy 测试全绿；`validate-plugin` PASS。

## v0.2.0 — 2026-11-26

首个版本化发布（双适配器里程碑，D20）。此后 main 只接受 PR 合入，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 新增

- **core 任务库**：SQLite 账本 + 9 态状态机 + 只追加事件流水；MCP stdio 服务暴露 6 个工具（`task_create` / `task_update` / `task_query` / `task_list` / `board_summary` / `decision_answer`）。
- **adapter-zcode**：ZCode 插件清单（MCP + skill + SessionStart 简报钩子），`marketplace.json` 可直接作为 git 源市场安装。
- **adapter-workbuddy**（Tier 0 包工头）：统一 `task_*` 工具面、reconcile 只读对账、引用式安装（D20）。
- **看板 board**：本地 Web 看板（8 态列 + 仪表盘 + 阻塞/待决策高亮）与 Sites 快照发布。
- **channel-feishu**：`waiting_decision` / `blocked` / `review` 三态告警推送，带幂等去重（D19）。
- **项目索引**：`projects.json` + `scripts/project-index.mjs`，把「用户原话 → 项目 → 执行目录」解析固化。
- **目录脚手架与安装**：`scripts/init-layout.mjs`、`scripts/install-skill.mjs`、`docs/install.md`。
- **任务编号与一句话命名统一**：`#N` 与 `tp-N` 双格式等价；看板/列表显示统一标题。

### 变更

- 仓库与插件标识 `taskpier` → `vibe-mission` / `vibemission`；MCP `serverInfo` 为 `vibemission-core`。
- 目录边界：办公室按产品独立，任务资产放 `shared/`，账本为唯一真相。
- **owner 角色模型**：明确入口会话与任务会话的边界；入口窗口可承载多个任务，连续消息默认同一任务、逐条判断归属；入口会话不执行高延迟任务。
- 入口 session 的消息路由、恢复引导与并发上限规则写入 owner skill。

### 修复

- JSON-RPC 响应统一携带 `jsonrpc: '2.0'`，修复严格 MCP 客户端（官方 SDK zod 校验）断连；e2e 断言锁死该回归。
- MCP 连接 `Failed to connect: taskpier` 的根因修复（同上）。

### 验证

- `npm test` 27 通过（core）；board 2、channels 2、scripts 7、workbuddy 7 全绿。
- `node scripts/validate-plugin.mjs` PASS。
- 运行时 skill 与仓库同步（`node scripts/install-skill.mjs --check` 为 IN SYNC）。

## 未发布

后续特性与优化按 PR 合入 main，发布时在本文件新增条目并打 tag。
