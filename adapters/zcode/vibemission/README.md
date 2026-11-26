# vibemission（ZCode 适配器插件）

VibeMission 的 ZCode 宿主实现：工程负责人 skill + 任务库（MCP 工具面）+ 会话开始简报钩子。

## 结构

- `.zcode-plugin/plugin.json` — 清单（mcpServers → `core/mcp-server.mjs`）
- `core/` — **构建产物**：由 `scripts/sync-core.mjs` 从仓库顶层 `core/src/` 复制（D14），勿手改
- `hooks/hooks.json` + `hooks/session-start.mjs` — SessionStart 简报（进程型钩子，无 shell，跨平台）
- `skills/zcode-task-owner/SKILL.md` — 工程负责人行为规范（owner 的"脑子"）

## 开发流程（plugin-creator 六步，D15）

```bash
# 1. 改完 core 后同步进插件根
node scripts/sync-core.mjs
# 2. 本地校验（node 等价 validate_plugin.py，python3 不可用）
node scripts/validate-plugin.mjs
# 3. 安装（用户手动）：ZCode 插件市场 → 添加 → 粘贴仓库根 D:\aiCoding\projects\taskpier
#    → 个人市场 taskpier → 安装 → 新会话说"创建一个测试任务"
```

## 已知待验证项（装好后第一轮实测 = P0-B/C 观测点）

1. `SessionStart` 钩子的 `additionalContext` 注入是否生效、输出 schema 是否被宿主接受
2. MCP server 的 DB 落点：`TASKPIER_PLUGIN_DATA` / `ZCODE_PLUGIN_DATA` 环境变量在宿主 MCP 子进程与 hook 子进程中是否可用；不可用则落到 `cwd/taskpier.sqlite`（当前为 `${ZCODE_PROJECT_DIR}`，可接受但需确认）
3. 子会话卡权限时的宿主行为（P0-B）→ 决定 D11 权限策略
4. `node` 是否在宿主 MCP 启动的 PATH 中；不在则回退宿主内嵌启动方式（`ZCode.exe + zcode.cjs __zcode-plugin-host`）
