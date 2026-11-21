# channels/ — TaskPier 告警通道

出向告警的宿主无关实现（与 HostAdapter 正交，见 docs/adapters.md §5）。

## feishu（已实现）

`feishu/notify.mjs`：扫描任务库中三个告警态（`waiting_decision` / `blocked` / `review`），经 lark-cli（bot 身份）推送。

```bash
# 实发（默认收件人可用 TASKPIER_FEISHU_TO 环境变量）
node channels/feishu/notify.mjs --user-id ou_xxx

# 其他
--dry-run            # 走 lark-cli 但不实际投递
--print              # 只渲染消息不调 lark-cli（测试用）
--window-min 10      # 幂等去重窗口（分钟），--force 越过
```

- **幂等**：发送成功后写 `alert_sent` 事件；窗口内同任务不重复推
- **调用方式**：优先 `node <npm全局>/node_modules/@larksuite/cli/scripts/run.js` 直调（无 shell，消息含换行/空格安全），回退 PATH 上的 `lark-cli`
- **触发方式（v1）**：owner skill 在 `task_update` 返回 `transition.alert=true` 后调用；也可手动/定时跑

## 计划

- slack / telegram：同一 `collect()` 逻辑复用，仅换 send 实现
