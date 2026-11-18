# Status model

> Status: v0 draft (2026-11-18). 8 态生命周期。

## 状态机

```
                ┌──────────┐
   飞书消息/登记 │  inbox   │  未分类新请求
                └────┬─────┘
                     ▼ 立项
                ┌──────────┐
                │   todo   │  已登记，待派工（并发超限时在此排队）
                └────┬─────┘
                     ▼ 派工（建任务会话）
                ┌──────────┐
       ┌────────│ running  │────────────┐
       ▼        └──────────┘            ▼
 ┌──────────────┐            ┌──────────────────┐
 │  waiting_    │            │     blocked      │
 │  decision    │            │  须填阻塞原因      │
 └──────┬───────┘            └────────┬─────────┘
        │ 你拍板后                     │ 解除后
        └────────► running ◄───────────┘
                     ▼ 干完
                ┌──────────┐
                │  review  │  等你验收
                └────┬─────┘
              通过 ▼    │ 打回 → running
                ┌──────────┐
                │   done   │
                └──────────┘
   任意态 ──► cancelled（你叫停）   running/blocked 异常 ──► failed
```

## 状态表

| 状态 | 含义 | 谁推进 | 告警 | 看板列 |
|---|---|---|---|---|
| `inbox` | 新请求未分类 | owner | 静默 | 收件箱 |
| `todo` | 已立项待派工 | owner | 静默 | 待派 |
| `running` | 任务会话执行中 | observe 信号 / owner | 静默 | 执行中 |
| `waiting_decision` | **需要用户拍板** | owner 发起（附问题+选项） | 🔔 推送 | 待决策（高亮） |
| `blocked` | 依赖/权限/环境卡住，须写原因 | owner / observe 超时 | 🔔 推送（超时升级） | 阻塞（高亮） |
| `review` | 完成，等验收 | owner | 🔔 推送 | 待验收 |
| `done` | 用户确认通过 | **用户** | 静默 | 完成（折叠） |
| `failed` / `cancelled` | 异终 / 叫停 | owner / 用户 | 静默+记录 | 折叠 |

## 设计要点

1. **告警只有三个状态**（`waiting_decision` / `blocked` / `review`）。告警疲劳会让用户关掉通知——宁可少推。
2. `blocked` 与 `waiting_decision` 分开：前者是"我不能动"，后者是"等你选"。看板上分列，超时策略不同（blocked 按 N 小时升级提醒；decision 无超时，等用户）。
3. `done` 只能由用户置位（"通过"），owner 最多到 `review`——验收权在人。
4. 每次状态迁移必须写 `events` 审计流水（actor、时间、原因），这是看板可信度的来源。
5. 任务携带外链（host、session_id、workspace、artifacts、evidence），TaskPier 不复制宿主内容，只引用。

## 字段约束

- `blocked` 必须填 `blocked_reason`；空原因视为非法迁移。
- `waiting_decision` 必须带 `decision_question` + `decision_options`（供聊天入口渲染选项）。
- `done` 建议附 `evidence`（验收证据链接/路径）。
