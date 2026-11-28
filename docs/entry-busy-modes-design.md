# PR-B 设计稿：忙时输入三档（轮次准入层）

> Status: design-only (2026-11-28)。**本文件是设计，不含实现**，也不在本仓可执行范围内。
> 背景：Harvis《VibeMission 入口阻塞问题｜方案设计》§3②；PR-A（`feat/entry-pr-a`）已交付 ①③④⑤ 与埋点，② 按约定单独成文。
> 触发条件：**等入向层接上（本仓自己收飞书消息）或 ZCode 宿主开放轮次接口，再做。**

---

## 0. 为什么单独成文

② 要求「忙时不拒绝、不报正忙，而是把新指令分到 interrupt / queue / steer 三档」。这**必须发生在宿主准入一条消息的那一瞬间**。

VibeMission 位于 ZCode 宿主之上：

- 仓库里只有 `SessionStart` 钩子，且钩子在轮次准入**之后**才跑；
- `channels/` 只有出向 `feishu/notify.mjs`，入向消息由宿主自己收、自己排队；
- MCP 面只有 6 个 `task_*` 工具，没有会话控制能力。

所以在本仓硬做 ②，只能得到一组永远不会被调用的函数——即"空壳"。本文件把它固定为契约，等权限到位再实现。

---

## 1. 轮次准入锁（单会话单轮）

```
会话状态：{ running: bool, turnId, startedAt, compression: bool }

on message(m):
  if not running:
    running = true; startTurn(m); return
  else:
    mode = chooseMode(m, session)   # 见 §2
    deliver(m, mode)                # 不丢弃，不回"正忙"
```

三条硬约束：

1. **准入只决定去向，不决定收不收** —— 任何消息都必须被接受；
2. **永不返回「正忙」** —— 客户端收到「正忙」通常重试，重试期间消息可能丢弃或重复（Hermes 踩过的坑，已写入其注释）；
3. **一轮结束立刻 drain** —— 用户消息优先于系统跟进。

---

## 2. busy_input_mode 三档语义

| 档位 | 行为 | VibeMission 侧的触发判定 |
|---|---|---|
| `interrupt`（默认） | 原地纠正当前轮：把新指令送进正在跑的那一轮；不支持时退化为「硬中断 + 排队」 | 明确喊停词：停掉 / 停下 / 暂停 / 别做了 / 中断 / 取消这个 |
| `queue` | 排到下一轮，当前轮结束立即执行 | 执行中收到的一切非喊停消息 |
| `steer` | 在当前原子动作之后注入 | 派工阶段（任务卡已登记、会话尚未真正开始执行）收到的修正 |

**共同点：三档都不丢消息，都不回「正忙」。**

### 2.1 压缩期强制降级

```
if session.compression and mode in (steer, interrupt):
    mode = queue
    reason = "压缩中途被打断会产生分叉会话，比排队更糟"
```

这条看着像细节，实际是隔离性保障：压缩会重写上下文，此时注入新指令会让会话产生两条不一致的历史。

---

## 3. 队列可见与回程绑定（与 PR-A 的分工）

| 能力 | 归属 | 说明 |
|---|---|---|
| 账本层排队可见（任务队列的位置/等待/ETA） | **PR-A 已交付** | `core/src/queue.mjs` + `scripts/queue-view.mjs` |
| 消息队列可见（"你这条排第 2"） | **PR-B** | 需要入向层持有消息队列；宿主自带队列不可见 |
| 回程绑定（任务 ↔ 入口会话） | **PR-A 已交付** | `entry_session_tasks` 表 + `store.bindEntrySession/listEntryBindings` |
| 消息级回程绑定（消息 → 原会话推送） | **PR-B** | 当前由宿主负责，接向层后由我们保证 |

---

## 4. 验收（做 PR-B 时用）

| # | 判据 | 测法 |
|---|---|---|
| 1 | 连发 5 条，0 丢失、0「正忙」 | 入向层注入 5 条，断言 5 条都产生了投递记录 |
| 2 | 压缩期 steer/interrupt 被降级 | 构造 `compression: true`，断言 mode 全为 queue 且 `degradedFrom` 有值 |
| 3 | 排队消息回到原会话 | 两个不同 chatId 交错，断言回程 chatId 与来源一致 |
| 4 | drain 顺序 | 一轮结束后按入队顺序执行，用户消息优先于系统跟进 |

---

## 5. 前置条件（缺一不可）

1. **入向通道形态确认**：飞书长连接 vs webhook 回调（未探针）；
2. **与宿主 bot 双收消息的二选一**：我们接管入向就必须停用宿主的入向，否则一条消息被处理两次；
3. **burst 落库表**：`ingress_bursts` 需要 schema 支持（PR-A 的迁移机制已为此铺好路，v1 只建了绑定表与埋点表）；
4. **宿主是否开放注入接口**：若宿主只提供 `CreateSession/SendToSession`，`steer` 只能退化为 `queue`。

> 结论：PR-B 不是一个"多花点时间就能做"的任务，而是一个**位置问题**——Hermes 能做得成，是因为它自己就是入口宿主。
