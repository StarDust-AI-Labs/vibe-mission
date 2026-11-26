# 安装与初始化

> 面向用户，也面向"引导用户安装的 AI"：照着这份文档一步步做，不需要先读源码。
> 目标产物：一个共享账本 + 每个 agent 产品一间私有办公室 + 一个已接入的插件。

---

## 0. 先确认三件事

| 项 | 要求 |
|---|---|
| Node | ≥ 23.4（`node --version`） |
| 宿主 | ZCode（v1.0 首发；其他产品走适配器，见 `docs/adapters.md`） |
| 目录 | 一个可写的顶层目录，下文以 `D:\vibemission` 为例 |

---

## 1. 目录规范（必须按这个建）

```
D:\vibemission\
├── shared/                     所有产品可读的共享层
│   ├── ledger/
│   │   └── tasks.sqlite        任务账本：唯一真相（首次运行自动创建）
│   └── tasks/                  任务过程稿、证据、跨产品交接说明
└── offices/                    每个产品一间办公室（私有，只由该产品写）
    ├── zcode/
    │   ├── inbox/              收件：待整理的输入
    │   └── reports/            日报、阶段小结
    └── workbuddy/              第二个产品（未接入时可以先建空目录）
        ├── inbox/
        └── reports/
```

**为什么这样分**（一句话版）：任务可能跨产品执行，所以任务资产必须放 `shared/`；日报和草稿属于某个产品，所以办公室按产品隔离、互不覆盖。

**三条硬规矩**

1. `offices/<产品>/` 只有该产品能写；其他产品只读。
2. `shared/ledger/` 只由接口人经 MCP 写；人和其他产品都只读。
3. 办公室不放任务状态——状态只进账本。

---

## 2. 一条命令建目录

仓库自带脚手架（幂等，重复执行不会覆盖已有文件）：

```bash
node scripts/init-layout.mjs --root D:\vibemission --products zcode,workbuddy
```

输出会告诉你：建了哪些目录、账本在哪、下一步配什么。加 `--dry-run` 只看计划不落盘。

---

## 3. 安装插件（ZCode）

1. 打开 ZCode → 插件市场 → 添加本地目录；
2. 选仓库里的 `adapters/zcode`（注意是这一层，不是仓库根）；
3. 安装后重启 ZCode。

重启后应当看到：

- 插件列表出现 **VibeMission**；
- 工具面出现 `mcp__vibemission__*`（6 个任务工具）；
- 每次新会话开始时，注入一条任务态势简报。

**技能**：目录扫描方式加载的插件只挂 MCP，不带技能。要让"接口人行为规范"生效，把技能复制到用户级目录：

```bash
node scripts/install-skill.mjs          # 复制到 ~/.agents/skills/vibemission-owner
```

（`--check` 只比对是否一致，不写文件。）

---

## 4. 指到共享账本

MCP 服务从环境变量 `TASKPIER_DB_PATH` 取账本路径。默认落在项目内，多产品共用时要指到共享层：

```json
// ~/.agents/mcp.json
{
  "mcpServers": {
    "vibemission": {
      "type": "stdio",
      "command": "node",
      "args": ["<仓库绝对路径>\\adapters\\zcode\\vibemission\\core\\mcp-server.mjs"],
      "env": { "TASKPIER_DB_PATH": "D:\\vibemission\\shared\\ledger\\tasks.sqlite" }
    }
  }
}
```

改完重启 ZCode。

---

## 5. 配置项目索引

任务卡上的执行目录来自仓库根的 [`projects.json`](../projects.json)。装好后先改成你自己的项目：

```json
{
  "projects": [
    {
      "id": "my-site",
      "name": "我的网站",
      "product": "zcode",
      "workspace": "D:\\code\\my-site",
      "keywords": ["网站", "首页", "分享页"]
    }
  ]
}
```

验证：

```bash
node scripts/project-index.mjs --resolve "改一下首页"
# → { "status": "ok", "project": "my-site", "workspace": "D:\\code\\my-site" }
```

命中 `ambiguous` 或 `none` 时，接口人必须先问人，不许猜。

---

## 6. 自检清单

```bash
node scripts/validate-plugin.mjs        # 期望 validate: PASS
node --test core/test/*.test.mjs        # 期望 25 pass
node --test scripts/project-index.test.mjs
node board/server.mjs                   # 打开 http://127.0.0.1:3210
```

| 检查 | 通过标准 |
|---|---|
| 目录 | `shared/ledger`、`shared/tasks`、`offices/<产品>/{inbox,reports}` 都存在 |
| 账本 | 启动后 `shared/ledger/tasks.sqlite` 存在且可写入 |
| 插件 | 插件列表有 VibeMission，工具面有 `mcp__vibemission__*` |
| 技能 | `/` 菜单里能找到 `vibemission-owner` |
| 看板 | 首页 200，能看到任务计数 |

---

## 7. 多产品 / 多设备

- **同一台机器多个产品**：每个产品建一间 `offices/<产品>/`，共用同一个 `shared/ledger/`。
- **多台机器**：每台机器各有自己的 `shared/` 与 `offices/`；跨设备汇总只做**只读**（汇总层不直接派工）。
- **跨产品执行**：任务可以转派，但同一时刻只有一个执行产品；转派必须写 `handoff` 事件（从谁到谁、原因、已完成、待办、证据）。

---

## 8. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件装了但没工具 | 选错目录 | 市场里添加的是 `adapters/zcode` |
| 技能不出现 | 目录扫描不加载技能 | 跑 `node scripts/install-skill.mjs` |
| 任务写到意外位置 | 账本路径没改 | 检查 `TASKPIER_DB_PATH` |
| 派工目录不对 | `projects.json` 没配或关键词不匹配 | 跑 `--resolve` 看命中结果 |
| 看板打不开 | 没启动服务 | `node board/server.mjs` |
