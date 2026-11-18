# TaskPier

> One pier for all your agent tasks. — 一个码头，停靠所有 AI 代理的任务。

**TaskPier** turns an AI coding host into a managed workshop: a single **owner agent** — a super-agent in the spirit of DeepSeek's Harness exploration — manages **all task sessions inside one host** (ZCode first): dispatching work, tracking status, reporting back. You talk to **one agent** instead of juggling N sessions. Core capabilities speak **MCP** (Model Context Protocol); each host gets a thin adapter. **One deployment manages one host.**

**Status**: pre-alpha · design & probe phase · not yet usable.

---

## Why TaskPier

Running several agent tasks in one host today makes **you** the dispatcher: you create sessions, chase each one for status, unblock stalls, and switch context all day. DeepSeek's Harness exploration put the bottleneck precisely: *a single task is limited by model capability; parallel tasks are limited by human attention.* TaskPier moves that tracking burden from you to an agent:

1. **You are the dispatcher.** N task sessions = N threads you must hold in your head.
2. **Agents stall silently** on permissions or decisions; you find out hours later.
3. **You can't steer remotely** — you want to say "do X", "stop #12", "approve" from your phone.

TaskPier's answer — **one owner agent per host**:

- **Owner persona** — a super-agent that manages the host's task sessions end-to-end: dispatch, track, unblock, report. You talk only to it (chat entry: Feishu DM or the host itself). v1 is command-driven; automatic decomposition is v1.1.
- **Core (MCP)** — the task store + tool surface behind the owner. The only durable component; sessions — even the owner's own chat — can come and go.
- **Board** — a local web dashboard for this host's tasks: running / blocked / needs-your-decision.
- **Alerts** — push to Feishu/Lark (later Slack, Telegram) only for `waiting_decision` / `blocked` / `review`.

**Design stance**: the store and the adapters are persistent; sessions are ephemeral. The owner is a *role*, not a long-lived chat — any session can pick the role up from the store and continue. **Scope is one host per deployment**: the pattern is host-agnostic (ZCode first; Workbuddy, Claude Code and others later via adapters), but a deployment never aggregates multiple hosts.

Inspired by DeepSeek Harness's open-sourced Super-agent exploration (Router/Worker layering, attention as the bottleneck) — see [一文读懂 DeepSeek 开源的 Super-agent](https://zhuanlan.zhihu.com/p/2100479855917904700) for a walkthrough of the original proposal.

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

**TaskPier** 把一个 AI 编码宿主（ZCode 优先）变成"有人管的工坊"：部署后，一个**工程负责人代理**统一管理**该宿主内的所有任务会话**——派工、跟踪、状态反馈、告警。人只跟这一个代理对话，不再逐个盯任务。思想来源：DeepSeek Harness 的 Super-agent 架构探索（双层 Router/Worker、注意力是瓶颈）。

要解决的问题（多任务的上限不在模型，在人的注意力）：

1. **人就是调度员** → N 个任务会话就是 N 条要记在脑子里的线。TaskPier 把盯守负担交给代理。
2. **静默卡死** → 仅对 `waiting_decision` / `blocked` / `review` 三个状态主动推送（飞书优先）。
3. **无法遥控** → 你在飞书说"把 X 做了""停掉 #12""通过"，负责人建会话、跟踪、回报；v1 由你指令驱动，v1.1 再做自动拆解。

**范围口径：一个部署管一个宿主。** 产品模式经适配器可复用到其他宿主（Workbuddy / Claude Code 等），但一个部署不做多宿主任务汇总。

设计立场：**持久的是任务库与适配器，会话是易逝的**。负责人是一个"角色"，不是某个长命会话——任何会话都能从任务库恢复身份、接着干。

当前状态：预发布前的设计与探针阶段。文档见 [docs/](docs/)。
