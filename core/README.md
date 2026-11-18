# core/ — Task store + MCP server

TaskPier 的唯一持久层与工具面设计：

- 任务库（SQLite：tasks / events 两张表，schema 见 [../docs/architecture.md §4](../docs/architecture.md)）
- stdio MCP server（零第三方依赖，node:sqlite），工具面：
  `task_create` / `task_update` / `task_query` / `task_list` / `board_summary` / `decision_answer`

## 实现落位（plugin-creator 约束）

ZCode 插件的组件路径不得越出插件根，因此 **v1 的 core 实现放在 `adapters/zcode/taskpier/` 插件内**（随插件分发、自包含）。本目录在 v1 只承载设计文档与 schema 约定；待第二个宿主适配器（claude-code）落地时，把实现抽取到此处作为共享源，各插件以 sync 脚本带入副本。

约束：纯 Node ≥ 20；数据落在宿主插件数据目录（如 `${ZCODE_PLUGIN_DATA}`），不入仓、不上传。
