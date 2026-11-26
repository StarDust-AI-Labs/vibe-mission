# Decision log

> 关键决策留痕。开源项目的可信度来自"为什么这么定"可追溯。

| # | 日期 | 决策 | 理由 / 依据 | 状态 |
|---|---|---|---|---|
| D1 | 2026-11-18 | 项目名 **TaskPier**（任务码头） | 查证 6 个候选名（taskdeck/taskdock/taskharbor/taskport/taskloom/taskweave）均同名撞车；taskpier 无同名仓库 | ✅ |
| D2 | 2026-11-18 | **定位：单宿主 Super Agent**，不做跨宿主汇总 | 用户纠正：核心价值=一个代理管一个宿主全部任务会话，吸收人的注意力负担（DeepSeek Harness 思想） | ✅ |
| D3 | 2026-11-18 | 协议：**MCP 为核心协议** + 每宿主薄适配器 | MCP 是工具接入事实标准；宿主差异隔离在适配层 | ✅ |
| D4 | 2026-11-18 | ZCode 打包走 **plugin-creator 模式**，仓库根即测试市场 | 用户指定；分发不依赖 npm（git 源市场） | ✅ |
| D5 | 2026-11-18 | **v1 范围**：任务库+看板+告警+半自动 owner；自动拆解放 v1.1 | 用户拍板；拆解风险最高，先闭环再自主 | ✅ |
| D6 | 2026-11-19 | **两个接口面**：自研 MCP=任务库（记录层）；会话操作=宿主原生（owner 自带工具） | 用户提问澄清；MCP 子进程拿不到宿主会话工具 | ✅ |
| D7 | 2026-11-19 | **上下文持久化三机制**：库是记忆会话是缓存 / SessionStart 注入恢复引导 / 引用不复制 | 用户要求保证对话连续性 | ✅ |
| D8 | 2026-11-19 | **并发上限（默认 3）+ todo 排队**；意图路由五级决策树（分发进原任务会话） | 用户要求并发与精确路由 | ✅ |
| D9 | 2026-11-19 | **P0-A 拍板：借用宿主**——dispatch 走 owner 会话调宿主原生工具 | 用户决定；扩展 API 文档外字段风险大且已实证老路可用；resolveInteraction 代批随之出局 | ✅ |
| D10 | 2026-11-19 | **宿主能力阶梯 Tier 2/1/0**（原生编排 / CLI 派工 / 只盯不派） | 不赌 Workbuddy/Kimi 开放性；Tier 1 用 CLI 子进程派工不依赖任何宿主 API | ✅ |
| D11 | 待定 | 权限策略：阻塞告警 vs 全自动+白名单 | 由 P0-B 子会话权限行为实测决定 | ⏳ |
| D12 | 待定 | 看板默认载体：宿主面板 vs 本地 Web | 由 P0-D 面板渲染实测决定（v1 先按 Web 兜底开发） | ⏳ |
| D13 | 2026-11-20 | **端口化选型**：Ports & Adapters + ISP 三端口（Dispatch/Observe/Notify）+ 能力探测降级 + ACL + adapter=code+skill patch | 用户（专业软件工程师）提出抽象适配问题；Tier 是运行期探测结果非枚举；不做微内核（YAGNI），rule of two | ✅ |
| D14 | 2026-11-20 | **core 源码定位**：canonical 在顶层 `core/src/`，宿主插件打包时构建复制进插件根（取代先前"实现放插件内"的口径）；**Node 下限上调至 ≥ 23.4.0**（node:sqlite 去旗标版本） | canonical 与宿主解耦更干净，打包复制满足路径约束；node:sqlite 是零依赖存储的唯一选择，代价是 Node 版本下限 | ✅ |
| D15 | 2026-11-20 | **plugin-creator 对齐**：流程纪律照本地 skill（六步：骨架→清单无占位→校验→市场→手动安装→如实交付）；产物用 **ZCode 风味**（`.zcode-plugin/` + `hooks/hooks.json`），非 Codex 风味（`.codex-plugin`+`~/.agents` 市场+deeplink）。偏差两条：python3 缺失→零依赖 node 校验脚本等价 validate_plugin.py；市场=仓库根 marketplace.json（ZCode UI 机制） | 本机 skill 为 Codex 版；ZCode 三路径探测兼容但字段语义以官方插件为准；python 不可用是环境事实 | ✅ |
| D16 | 2026-11-20 | **插件加载机制（实证）**：宿主插件注册表在**应用启动时缓存、运行期只读**——用户级 config.json、workspace `.zcode/config.json`、伪造市场记录三种注入均不热生效（三次探针 6/6 缺失）。正确机制=**`plugins.dirs`（inline directories 发现源）**，已配置，待宿主重启生效。**P0-B 结论（先行实测）**：新建子会话遇 Bash 审批 = 阻塞等待（`WaitSessions` 返回 `needs_attention{kind:approval}`），不自动执行/拒绝——① D11 证据：默认行为即"阻塞"，告警策略与其对齐；② owner 可经 WaitSessions 程序化感知"卡审批"，**告警链路无需扩展 API** | 用户要求端到端完成；重启宿主是唯一无法从会话内执行的步骤（会话本身运行在宿主里）；探针会话 3 次 + P0-B 会话 1 次均为自主执行 | ✅（重启后复核） |
| D17 | 2026-11-21 | **运行期接线改走配置通道**（插件打包路径暂置）：① SessionStart 钩子经 config.json `hooks.events.SessionStart`（与 ai-memory 同款，**运行期即生效**——TaskPier 态势简报已注入真实会话上下文，实测）；② MCP 经 **`~/.agents/mcp.json`**（ZCode 兼容 agents 目录约定，configKeyName=mcpServers）——创建于上次启动之后，故工具面待**下一次重启**加载。`plugins.dirs` 重启后仍未生效、语义待查，不阻塞功能；插件市场打包保留为分发形态 | 探针 5：钩子通/MCP 缺（同运行期内 mcp.json 已存在仍不加载）→ 宿主仅启动时读 MCP 配置；两通道独立判定 | ⏳（重启后复核 MCP） |
| D18 | 2026-11-21 | **看板交付形态**：本地实时服务（基准）+ **快照发布 ZCode Sites**（用户三选一拍板 B）；快照非实时、任务标题/状态公开可见（用户知情选定）。共享渲染页双模式（API 轮询 / 内嵌数据），stage 用官方 static 模板 | 用户问"能否发布/部署"；云端读不到本机 SQLite → 实时形态需数据上云（v1.1），快照是最小正确解；已部署 https://taskpier-board-kcuk.zai.site | ✅ |
| D19 | 2026-11-21 | **channel-feishu 交付**：notify.mjs 扫描三告警态 → lark-cli bot 直调（node 调 npm 入口 run.js，绕开 Windows shell 引号/换行问题）；幂等=alert_sent 事件+10 分钟窗口（实测去重生效）。真实告警已送达用户飞书（message_id om_x100b7f2ef4a5c0a0c1c969ccf961b8d，tp-1 待验收）。通道测试 2/2 | 用户选 B 时同时要求完成告警闭环；lark-cli shim 是 .cmd（需 shell）→ 改直调 run.js 根治 | ✅ |

| D20 | 2026-11-23 | **foreman-agent 原型并入，WorkBuddy 适配器立项（v0.2 里程碑）**。七个子决策：① 工具面**统一 core `task_*` 六工具**（用户选定；foreman.* 别名出局，reconcile 不进 MCP、岗位卡 Bash 调脚本）；② 发布节奏 **v0.1.0=zcode 单适配器先行，v0.2.0=双适配器**（用户选定）；③ WorkBuddy 初版按 **Tier 0**（dispatch=null、observe=拉式 reconcile；探针升级口留适配器 README）；④ 安装形态**引用式**（mcp.json 绝对路径指 core/src/mcp-server.mjs，**无 bundled core 副本**，区别于 zcode 市场的自包含约束；sync-core 不扩展）；⑤ 部署库独立（adapter 下 `.taskpier/tasks.sqlite`，TASKPIER_DB_PATH 注入）；⑥ 告警=岗位卡飞书会话内直接回复（宿主原生 bot，不复用 lark-cli 出向）；⑦ foreman 的 message_id 入向幂等**不为此改 core**（v0.1 冻结），岗位卡加"疑似重复先 task_list 核对"护栏，幂等键列 v1.1 core 增强候选。资产去留：observer.mjs 迁移为 reconcile（+WorkBuddy→core 状态翻译表，ACL）；foreman.md 岗位卡改写为 SKILL.md（保留飞书单一入口/台账真相源/审批门禁/状态词汇表/对账不认模型自评）；install.mjs 三态保留改指向；ledger.mjs/index.mjs 不迁移（core 已覆盖且更强：9 态 FSM+guard+alert）。foreman-agent 仓本地归档不迁历史 | foreman 原型（2026-11-10 从 ai-factory/foreman 迁出）从未部署（无 mcp.json 条目、无 data/、专家包未装）→ 零兼容包袱；恰逢 D13 预留的 rule of two 时点，第二适配器落地验证抽象边界 | ✅（实装验收待用户） |

| D21 | 2026-11-27 | **入向消息聚合收敛器立项**：连发消息先收敛（静默窗口 + 规则路由 + 一次意图抽取）再建任务，替代逐条即时推理 | 用户提出：飞书连发消息堆积、逐条推理割裂上下文、改主意作废早期推理；总体设计 [docs/ingress-aggregation.md](ingress-aggregation.md)（v0 待评审），关联任务 #38 | 🔄（设计评审中） |
| D22 | 2026-11-27 | **任务会话配置策略**：AI 自主为默认（模型/思考强度/skills 白名单内）；重要/大型任务或用户主动要求时由用户决定（创建前一次配置确认）；skills 白名单外一律 `waiting_decision` 问一次 | 用户拍板（#38 讨论）；产品主张"人只下达意图、拍板"，事中逐项问配置 = 注意力税；机制见 [docs/ingress-aggregation.md](ingress-aggregation.md) §4 | ✅ |

待定项随探针回填结论后移入"已定"。
