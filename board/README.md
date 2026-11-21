# board/ — TaskPier 任务看板

两个形态，共用同一渲染页（`page.html`）与同一任务库（SQLite）：

## 1. 本地实时看板（基准）

```bash
node board/server.mjs                 # http://127.0.0.1:3210
node board/server.mjs --port 4000 --host 0.0.0.0   # 局域网/tailscale 场景
```

- `GET /` 看板页（每 8 秒自动刷新）；`GET /api/board` 看板数据；`GET /api/task?id=tp-N` 单任务+事件流水
- DB 解析与 MCP server/钩子共用 `core/dbpath.mjs` 链（D17）

## 2. 快照发布（ZCode Sites，用户选定形态 B）

```bash
node board/snapshot.mjs               # 构建 .zcode-site/stage/（index.html 内嵌数据 + 官方 static 模板）
node <zcode-site skill>/scripts/zcode-site.mjs deploy .zcode-site/stage   # 发布/更新
```

- **快照非实时**：页面顶部有生成时间横幅；数据变化后需重跑 snapshot + deploy
- ⚠️ **公开可见**：任务标题/状态/阻塞原因对任何拿到链接的人可见（用户 2026-11-21 知情选定）；脱敏选项（--redact）留作 v1.x
- 首次发布：https://taskpier-board-kcuk.zai.site

## 测试

```bash
node --test board/test/board.test.mjs
```
