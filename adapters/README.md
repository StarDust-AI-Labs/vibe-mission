# adapters/ — Host adapters

宿主差异的唯一收口处（契约见 [../docs/adapters.md](../docs/adapters.md)）：

- `zcode/` — 首发。dispatch=宿主会话工具（或 P0 验证通过的扩展 API）；observe=7 事件钩子；surface=`ui.surfaces` 面板（可选）。
- `claude-code/` — v1.1。
- `generic/` — 零成本兜底：任何 MCP 宿主直接挂 core 的 MCP server（无 dispatch，退化为登记+跟踪+告警）。
