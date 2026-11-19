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

待定项随探针回填结论后移入"已定"。
