# 入口与执行分离（PR-A 交付说明）

> Status: v2 (2026-11-28)。范围按与 Harvis 的确认收窄：**② 不进 PR-A**，单独成文见 [entry-busy-modes-design.md](entry-busy-modes-design.md)。
> 关联任务 #38 / tp-0038；相关：[entry-router.md](entry-router.md)、[implementation-gaps.md](implementation-gaps.md) G4/G7/G10。

---

## 0. 一句话

**入口被重活堵死，根因是入口同时当了执行会话。** PR-A 交付本仓能控制的那部分：入口预算闸门（①）、账本层排队可见（③）、回程绑定（④）、心跳判据（⑤）与度量埋点；② 因为要拦在宿主准入之前，只出设计不写代码。

---

## 1. PR-A 范围与落点

| # | 能力 | 落点 | 证据 |
|---|---|---|---|
| ① | 入口只做 3 秒内的事 | `channels/ingress/gate.mjs` | `checkEntryBudget` / `mustDispatch`；白名单四动作 |
| ③ | 账本层排队可见 | `core/src/queue.mjs` + `scripts/queue-view.mjs` | 位置 / 入队时间 / ETA / 超 60 秒提示 |
| ④ | 回程绑定 | `core/src/migrate.mjs` v1 + `store.bindEntrySession` / `listEntryBindings` | `entry_session_tasks` 表；多群不串台有单测 |
| ⑤ | 心跳与超时 | `core/src/heartbeat.mjs` | 20 分钟报进度、60 秒失联判 failed、失联优先 |
| — | 度量埋点 | `core/src/metrics.mjs` + `entry_turns` 表 | P50 / P95 / 达标率，预算与闸门同源 |

配套：`migrate.mjs` 提供**真正的 schema 迁移机制**（`schema_meta.version` + 事务回滚），这是 ④ 与埋点能落到生存库的前提，也顺手解掉了 G6。

---

## 2. 验收对照

| 判据 | 本 PR 的口径 |
|---|---|
| 1. 入口 P95 ≤ 3 秒 | **可测**：`entry_turns` 记录每个入口回合的 started_at / first_reply_at / latency_ms，`summarizeTurns` 出 P50/P95 与达标率。**不承诺**——宿主响应路径不在本仓 |
| 2. 连发 5 条 0 丢失 0「正忙」 | **宿主侧，本 PR 不承诺**。宿主侧怎么测见 §4 |
| 3. 30 分钟重活期间入口照常一问一答 | 由 ① 保证：入口不本地执行，一律派工；`gate` 白名单外直接判派 |
| 4. 排队消息结束自动执行且回原会话 | 由 ③④ 保证：队列位置可查、绑定表记住入口会话 |

---

## 3. 边界（写死）

- 本仓**不做**：宿主轮次准入、硬中断正在跑的模型调用、压缩期调度、客户端重试策略、消息级排队提示。
- 本仓**能做**：入口预算判据、任务级排队可见、任务↔入口会话绑定、任务心跳判定、入口回合延迟度量。
- ② 的完整契约见 [entry-busy-modes-design.md](entry-busy-modes-design.md)，**等入向层接上或宿主开放接口再做**。

---

## 4. 第 2 条验收在宿主侧怎么测

不写"待验证"了事，给可执行步骤：

1. 打开一个正在跑重活的入口会话（任一 30 分钟级任务）；
2. 用飞书连发 5 条消息，间隔 5 秒；
3. 从宿主日志（`~/.zcode/cli/log/<session>.jsonl`）取这 5 条消息的入站记录与对应轮次；
4. 判定：① 5 条都有入站记录（0 丢失）；② 没有一条收到「正忙」或等价的拒绝文案；
5. 若第 4 步不通过，说明缺口在宿主准入层，需宿主侧修复或由 PR-B 接管入向。

`scripts/watchdog.mjs` 已能读同一份日志判会话停摆，可复用其解析。

---

## 5. 反模式

- ❌ 回「正忙」（客户端会重试，重试期间反而丢消息）
- ❌ 入口回合里「先试试看」（一旦开始跑就再也秒不回）
- ❌ 排队状态只存在内存里（进程一重启就没人知道排到哪）
- ❌ 用 `updated_at` 猜心跳却不区分失联与慢（本 PR 用显式 beat 时间，失联优先于进度汇报）
