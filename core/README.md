# core/ — Task store + MCP server

TaskPier 的唯一持久层与工具面（规划，未实现）：

- `store.mjs` — SQLite 任务库（tasks / events 两张表，schema 见 [../docs/architecture.md §4](../docs/architecture.md)）
- `mcp-server.mjs` — stdio MCP server，零第三方依赖（node:sqlite），工具面：
  `task_create` / `task_update` / `task_query` / `task_list` / `board_summary` / `decision_answer`

约束：纯 Node ≥ 20；数据落在宿主插件数据目录，不入仓、不上传。
