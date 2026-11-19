# core/ — Task store + MCP server（已实现）

TaskPier 的唯一持久层与工具面。**源码以本目录为 canonical（D14）**：宿主插件打包时由构建脚本复制进插件根（满足"组件路径不得越出插件根"约束），core 本身不感知宿主。

## 布局

```
core/
├── src/
│   ├── errors.mjs         TaskPierError + 稳定错误码
│   ├── state-machine.mjs  转移表 + guards（blocked 须原因；waiting_decision 须问题+选项）
│   ├── store.mjs          node:sqlite（WAL）；tasks/events 两表；events append-only
│   ├── tools.mjs          6 个 MCP 工具的 facade + JSON Schema（§4.1 定稿）
│   └── mcp-server.mjs     stdio JSON-RPC（newline 帧）；initialize/tools/list/tools/call/ping
├── types/ports.d.ts       D13 端口声明（HostAdapter/DispatchPort/ObservePort/NotifyPort）
└── test/                  node:test，25 用例（状态机/存储/工具/MCP 端到端）
```

## 运行

```bash
npm test                      # 25 用例
# 独立起服务（开发冒烟）：
node core/src/mcp-server.mjs --db /tmp/taskpier.sqlite
# DB 路径解析顺序：--db > TASKPIER_DB_PATH > TASKPIER_PLUGIN_DATA（宿主插件数据目录）> ./taskpier.sqlite
```

## 约束

- Node **≥ 23.4.0**（node:sqlite 去旗标版本，D14；Node 官方仍标 experimental，API 稳定前锁 minor）
- 零第三方依赖；MCP stdio 帧与官方面板插件同款（newline JSON-RPC 2.0）
- 状态逻辑只存在于 state-machine.mjs 的转移表；存储不感知状态语义，工具面不感知传输
