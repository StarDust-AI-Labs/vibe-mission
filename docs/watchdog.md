# Watchdog —— 值守机制（系统盯着系统）

> Status: v1 (2026-11-28)。关联任务 #44；固化自办公室原型 `offices/zcode/reports/child-runs/watchdog.sh`。
> 空缺定位：[implementation-gaps.md](implementation-gaps.md) **G9「告警双通道 / 无告警定时器」**——本机制补齐其中"定时巡检 + 停摆检测"半边（Stop 钩子兜底仍未接，见 §7）。
> 落点：`scripts/watchdog.mjs`（巡检+报告）、`channels/feishu/notify.mjs` `notifyWatchdog()`（推送）、owner skill §9（值守会话模板）。

---

## 1. 为什么：把"人盯着系统"反转为"系统盯着系统，异常才找人"

VibeMission 已经把"盯任务"从人转移给 owner；但 owner 自己也是会话——**会话停摆、PR 被要求返修、CI 挂了，这些 owner 不会主动喊人**（turn.failed 之后它不会再产生任何输出，人以为它在跑，实际已经死了）。原型 watchdog.sh 在 2026-11-28 实际抓到过这类事故：轮询各会话日志末条事件，`turn.failed` 超时即拉响。

原型的三个问题（固化动机）：

| 原型（bash） | 固化后（scripts/watchdog.mjs） |
|---|---|
| 阈值 240 秒硬编码、路径/会话 id 硬编码 | 全部进 `--config`，判据可审计 |
| `echo` 一行就走人，没有报告出口 | md/json 报告 + 退出码 0/1/2，报告落 `offices/` 留痕 |
| while+sleep 占住一个 shell | 值守会话按 15–30 分钟一轮跑，生命周期随被盯任务（skill §9） |

对应 SuperAgent 设计的两条：**状态说实话**（正常静默写报告，留痕即报告）与**通知有节奏**（异常才分级打扰，见 §4）。

## 2. 三不变式

1. **独立于被看者**。巡检证据来自宿主 JSONL 日志与 gh，不依赖被盯会话自报——turn.failed 之后会话不会再自报，自报不可信。
2. **只报可验证事实**。每条发现必须带证据（日志时间戳+文件行号、PR/CI 链接）；脚本不推断"可能挂了"，值守会话只转述报告。
3. **异常才分级打扰**。正常轮静默（报告写文件，不推送）；`immediate` 级才推 owner；`daily` 级只进报告，等汇总日报（v0.5）。

## 3. 与 9 态账本 / 看板的互补

| 层 | 谁主动 | 管什么 | 管不到什么 |
|---|---|---|---|
| 账本（9 态状态机） | owner 写，人/owner 查 | 任务**管理态**：todo/running/blocked… + 事件流水 | 会话运行时（turn.failed 是宿主层事实，账本不知道） |
| 看板 | 人**被动查** | 注意力界面：阻塞/待决策/待验收 | 不主动找人；账本同源 |
| **watchdog** | **系统主动巡** | 会话**运行时**（停摆）、仓库**交付线**（PR 返修要求/CI 结论） | 不改任务状态（那是 owner 的职责，值守只有三不铁律） |

一句话：账本管"任务该不该有人管"，watchdog 管"还在跑的东西死没死、交付线绿不绿"。

## 4. 告警分级

| 级别 | 触发（`type`） | 动作 |
|---|---|---|
| **立即**（immediate） | `session_stall`（停摆）/ `pr_changes_requested`（返修要求）/ `ci_failed`（CI 挂） | 值守会话每轮调 `notifyWatchdog` 推飞书；同一发现跨轮用 `suppressKeys` 去重 |
| **汇总**（daily） | `log_missing`（日志缺失=检查不可用）/ `session_unseen`（会话盲区） | 只写报告；v0.5 汇总日报合并输出 |

**停摆判据**：该 sessionId 在**今日**日志（回退**昨日**，与原型一致）最后一条事件为 `turn.failed`，且距今 > `stallThresholdMinutes`（默认 10）。判据是纯函数可测，阈值不硬编码。

## 5. 使用

```bash
node scripts/watchdog.mjs --config <config.json> --format md   # 或 json
```

```jsonc
// config.json
{
  "sessions": [{ "name": "#39 支付对账", "sessionId": "sess_0a4e5a6a" }],  // sessionId 支持前缀
  "logsDir": "C:/Users/24424/.zcode/cli/log",
  "stallThresholdMinutes": 10,
  "repos": [{ "owner": "StarDust-AI-Labs", "name": "vibe-mission", "branches": ["feat/x"] }],
  "ghPath": "C:/Users/24424/tools/gh/bin/gh.exe"   // 可选；gh 不存在/未登录 → 跳过并注明，不算发现
}
```

- 退出码：**0** 无发现（空报告）；**1** 有发现；**2** 配置错误（坏 JSON/缺字段/坏格式）。报告只在 stdout，不落盘——落盘是值守会话的职责（报告唯一出口=报告文件，见 skill §9）。
- 每条发现四要素：类型 / 对象 / 证据 / 建议动作。

## 6. 值守会话（怎么跑起来）

值守会话是 owner 派出的独立执行会话，按 owner skill **§9「值守会话（Watchdog）模板」**拉起：标准 prompt 骨架、停摆判据以脚本为准、**报告唯一出口**为 `offices/<product>/reports/watchdog/YYYY-MM-DD.md`（按轮追加，空发现也写"本轮无发现"）、**三不铁律**（不代答 / 不派工 / 不改码）、**生命周期 = 被盯任务全部闭环即解散**。

推送通道：值守会话对 immediate 级发现调 `channels/feishu/notify.mjs` 的 `notifyWatchdog({ findings, userId, suppressKeys })`，复用 `sendViaLarkCli`（含 dry-run）与既有推送路径，不另起炉灶。

## 7. 幂等取舍与 G9/G5 的关系

- **G9（告警双通道/无告警定时器）→ 部分补齐**：watchdog 提供了"定时巡检 + 停摆检测 + 报告出口"这半边；Stop 钩子兜底（owner 空闲/任务会话自结束时直调）仍未接，见 implementation-gaps.md G9。
- **幂等不用 `alert_sent` 事件**：watchdog 发现不是任务，`events.task_id NOT NULL REFERENCES tasks(id)`（G5）使非任务事件写不进账本。v1 采用 `suppressKeys`（`type:object`）由值守会话跨轮去重——语义与 10 分钟窗口一致（同一发现不重复打扰），代价是值守会话要自己维护已推清单；G5/G6 schema 迁移落地后可改为落库幂等。

## 8. 未来（不在本 PR）

- v0.5 汇总日报：daily 级发现按日合并推送，替代逐条；
- 发现落账本（依赖 G5/G6 迁移）→ 看板可渲染"值守发现"；
- worktree/分支级停摆检测（原型有 git rev-parse 对比，暂未固化——PR/CI 检查已覆盖大部分交付线风险）。
