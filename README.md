# TaskPier

> One pier for all your agent tasks. — 一个码头，停靠所有 AI 代理的任务。

**TaskPier** is a host-agnostic unified task hub for AI coding agents (ZCode, Claude Code, Codex, …): one task store, one status model, one board, one alert channel. Hosts keep their native task systems — TaskPier adds the **cross-host layer** on top and speaks **MCP** (Model Context Protocol), so any MCP-capable host or agent can dock.

**Status**: pre-alpha · design & probe phase · not yet usable.

---

## Why TaskPier

If you run coding agents in more than one tool, three problems appear immediately:

1. **Tasks are scattered.** Every host has its own task/session list. Nobody answers "what is *everything* doing right now?"
2. **You must babysit.** Agents stall on permissions or decisions, silently. You find out hours later.
3. **You can't steer remotely.** You want to say "do X", "stop #12", "approve" from your phone — without opening the host.

TaskPier's answer:

- **Core (MCP)** — a task store + tool surface. The only durable component.
- **Board** — a local web dashboard across hosts: running / blocked / needs-your-decision.
- **Alerts** — push to Feishu/Lark (later Slack, Telegram) only for `waiting_decision` / `blocked` / `review`.
- **Owner persona** — a semi-automatic "project owner" agent that dispatches work into task sessions, tracks status, and reports back. v1 is command-driven ("把 X 做了" → create session, track, report); automatic decomposition is v1.1.

**Design stance**: the store and the adapters are persistent; sessions are ephemeral. The owner is a *role*, not a long-lived chat — any session can pick the role up from the store and continue.

## Repository layout

```
taskpier/
├── marketplace.json  Local test marketplace root — add this folder in the ZCode UI to install (planned)
├── core/             Task store (SQLite) + MCP server design; v1 implementation lives inside the zcode plugin
├── adapters/         Host adapters: zcode (plugin-creator packaged), claude-code, generic
├── board/            Local web dashboard                          (placeholder)
└── docs/             Architecture, adapter contract, status model, roadmap
```

ZCode users: after cloning, the repo root doubles as a plugin marketplace — add it under 插件市场 → 添加 and install `taskpier` from there. Remote users can add it as a `git` marketplace source; no npm required.

## Documentation

| Doc | What it covers |
|---|---|
| [Architecture](docs/architecture.md) | Layers, protocol choice (MCP), positioning vs native host task systems |
| [Adapter contract](docs/adapters.md) | What a host adapter must provide; ZCode / Claude Code notes |
| [Status model](docs/status-model.md) | The 8-state lifecycle and alert rules |
| [Roadmap](docs/roadmap.md) | P0 probes → v1 → v1.1, open questions |

## Roadmap (short)

| Phase | Deliverable |
|---|---|
| **P0** | Feasibility probes: MCP/extension capability check, permission behavior, channel reuse, board rendering |
| **v1** | Task store + MCP tools + web board + alerts + semi-automatic owner |
| **v1.1** | Automatic task decomposition; card buttons; more channels |

## License

[MIT](LICENSE) © StarDust AI Labs and contributors.

---

## 中文简介

**TaskPier** 是一个**跨宿主的统一任务枢纽**，面向 AI 编码代理（ZCode、Claude Code、Codex 等）：一套任务库、一套状态模型、一块看板、一条告警通道。各宿主保留自己的原生任务系统，TaskPier 在其上补齐跨宿主状态层，以 **MCP**（Model Context Protocol）为统一协议接入。

三个核心问题的解法：

1. **任务散落** → 跨宿主任务库 + 本地网页看板：执行中 / 阻塞 / 待你决策，一目了然。
2. **无人盯守** → 仅对 `waiting_decision` / `blocked` / `review` 三个状态主动推送（飞书优先）。
3. **无法遥控** → 「工程负责人」角色：你在聊天里说"把 X 做了"，它建任务会话、跟踪、回报；v1 由你指令驱动，v1.1 再做自动拆解。

设计立场：**持久的是任务库与适配器，会话是易逝的**。负责人是一个"角色"，不是某个长命会话——任何会话都能从任务库恢复身份、接着干。

当前状态：预发布前的设计与探针阶段。文档见 [docs/](docs/)。
