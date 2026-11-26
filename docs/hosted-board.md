# 云端 hosted 看板（近实时）

**为什么不用静态快照**：静态快照把数据写死在 HTML 里，任务一变就得重新 build + deploy；hosted 模式让云端站点自己保存一份 board JSON，本机推送器把 SQLite 最新数据 POST 上去，页面轮询刷新——部署一次，长期近实时。

静态快照模式（`board/snapshot.mjs`）保持不变，两者可并存。

## 组成

| 组件 | 位置 | 职责 |
|---|---|---|
| `board/hosted-server.mjs` | 云端（stage 根目录） | 提供 `/`、`/api/board`、`/api/ingest`、`/api/refresh`、`/api/refresh-wait`；原子写 `$DATA_DIR/board.json` |
| `board/page.html` | 云端（stage 根目录） | 与本地/快照共用同一页面；`mode:'hosted'` 时轮询 `/api/board`，顶部「刷新」按钮按需触发推送 |
| `board/publish.mjs` | 本机 | 读本机账本（`core/src/dbpath.mjs` 解析链）→ POST `${BOARD_SITE_URL}/api/ingest`；`--demand` 模式等待刷新请求 |
| `start.sh` | 云端（stage 根目录） | `exec node hosted-server.mjs`，监听 `0.0.0.0:$PORT`（默认 3000） |

数据流（按需推送，默认）：

```
点「刷新」──POST /api/refresh──▶ 云端 seq+1 ──唤醒──▶ 本机 publish --demand
                                                      │
本机 SQLite ──publish.mjs──POST /api/ingest──▶ 云端 $DATA_DIR/board.json ──▶ 页面刷新
```

- 首屏：`GET /` 把最新 board JSON 注入 `window.__TASKPIER_BOOT__ = {mode:'hosted', data:...}`，无需等第一次轮询。
- 轮询：`page.html` 判断 `mode !== 'snapshot'` 后每 8 秒 `fetch('/api/board')`。
- 按需推送：页面按钮 `POST /api/refresh` 让云端 `refreshSeq+1` 并释放挂起的 `GET /api/refresh-wait`；本机 `publish.mjs --demand` 长期挂着一个 long-poll，被唤醒后立刻推一次。空闲时只有一条挂起连接，不再每 30 秒整包推送。
- 兜底：`--demand` 默认每 30 分钟也推一次（`--safety-min` / `BOARD_SAFETY_MIN` 可调），用于云端实例重启后 `$DATA_DIR` 被清空、或 long-poll 断线时的自愈。
- 写入：先写同目录临时文件再 `rename`，读到的 `board.json` 永远是完整 JSON。
- 零点依赖：只用 Node 内置模块，stage 不需要 `node_modules`。

## 部署（ZCode Sites）

ZCode Sites 运行时：Linux x86-64、预装 Node 24、端口 `0.0.0.0:3000`、`$DATA_DIR` 默认 `/data`（**临时存储，实例重启/重新部署会清空**）。

### 1. 组装 stage

在仓库根目录执行：

```bash
STAGE=.zcode-site/hosted-stage
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp board/hosted-server.mjs board/page.html "$STAGE"/

cat > "$STAGE/start.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

export NODE_ENV=production
export PORT="${PORT:-3000}"
export DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

# ZCode Sites 不注入密钥，也不打包 .env；BOARD_TOKEN 只能在这里提供。
# 部署前把下面的空串换成真实口令（不要提交仓库），否则 /api/ingest 拒绝所有推送。
# 按“可轮换的弱口令”对待，建议 >= 32 字节随机串。
export BOARD_TOKEN="${BOARD_TOKEN:-}"

exec node hosted-server.mjs
SH
chmod +x "$STAGE/start.sh"
```

部署前把 `BOARD_TOKEN` 的空串换成真实 token（只改本机 stage 文件，不进 Git）；漏填时服务仍能启动，但 `/api/ingest` 会拒绝所有推送（fail closed）。若改用支持环境变量注入的托管平台，直接注入 `BOARD_TOKEN` 即可。

### 2. 本地自检

```bash
node "<zcode-site skill>/scripts/zcode-site.mjs" check "$STAGE"
# 期望输出 {"status":"live","httpStatus":200}
```

### 3. 部署

```bash
node "<zcode-site skill>/scripts/zcode-site.mjs" deploy "$STAGE" --site <hosted-site-id>
```

- 建议 hosted 站点**单独建一个 site**：仓库根 `.zcode-site.json` 已绑定现有快照站点，直接 `deploy` 或 `--new` 会改写该绑定并替换快照站点。用 `--site <id>` 显式指向 hosted 站点，或先把 `.zcode-site.json` 备份/切换。
- 部署成功后 `GET /` 返回 200 即通过健康检查。

### 4. 首次推送与验证

```bash
BOARD_SITE_URL=https://<hosted-site> BOARD_TOKEN=<token> node board/publish.mjs --once
curl -s https://<hosted-site>/api/board | head -c 300   # 应返回刚推送的 board JSON
```

## 环境变量

| 变量 | 作用 | 默认 / 说明 |
|---|---|---|
| `BOARD_TOKEN` | `/api/ingest` 的写权限口令（请求头 `x-board-token`） | 必填。未设置时服务端拒绝所有推送（401）。只从环境变量读取，仓库不保存 |
| `DATA_DIR` | `board.json` 所在目录 | 默认 `/data`（ZCode Sites 提供，临时存储） |
| `PORT` | 监听端口 | 默认 `3000`，绑定 `0.0.0.0` |

`BOARD_SITE_URL`、`BOARD_TOKEN` 是本机推送器的变量，不影响云端进程。

## 本机推送器

```bash
export BOARD_SITE_URL=https://<hosted-site>
export BOARD_TOKEN=<token>

node board/publish.mjs             # 单次推送（默认 --once）
node board/publish.mjs --demand    # 先推一次，之后等页面「刷新」触发；兜底每 30 分钟推一次（推荐常驻）
node board/publish.mjs --watch 30  # 立即推一次，之后每 30 秒推一次（旧做法，仅作兜底/兼容）

# 覆盖环境变量（--db 可选，走 core/src/dbpath.mjs 解析链）
node board/publish.mjs --url https://... --token ... --db /path/to/taskpier.sqlite

# 兜底间隔可调：--safety-min 10 或 BOARD_SAFETY_MIN=10
node board/publish.mjs --demand --safety-min 10
```

- token 优先用环境变量：`--token` 会出现在进程列表（`ps`）里。
- 退出码：`0` 成功；`1` 配置缺失/非法；`2` 推送失败（HTTP 或网络）；`3` 账本打开失败。
- `--watch` / `--demand` 下单次推送失败只记日志并继续重试（`--demand` 指数退避，最长 30 秒一次），不会退出；收到 SIGINT/SIGTERM 正常退出 0。
- 长期运行建议：本机常驻 `--demand`（空闲时只挂一条 long-poll，不整包推送）；网络差或需要固定节奏时退回 `--watch 30`；也可用 cron 每 5 分钟跑一次 `--once` 兜底（token 放本机受控文件并 `export BOARD_TOKEN="$(cat ~/.secrets/board-token)"`，不要写进仓库）。

## 安全与可见性

- **数据公开可读**：看板页与 `/api/board` 与快照同口径，任何拿到链接的人可见任务标题、状态、阻塞原因（用户 2026-11-21 知情选定）。不要在账本里存密钥。
- **写接口仅 token 保护**：`POST /api/ingest` 校验 `x-board-token`，恒定时间比较；请求体上限 2 MB（超出 413）；非法 JSON/结构返回 400。
- 页面与 API 响应带 `cache-control: no-store`，避免 CDN 缓存旧看板。
- 平台前置 HTTPS；云端进程本身只监听明文 HTTP。

## 回退

- 不部署 hosted 站点：现有快照模式完全不受影响（本 PR 未改 `board/snapshot.mjs` 与页面渲染逻辑）。
- 已部署后回退：重新构建并部署静态快照 stage（`node board/snapshot.mjs` → 原 static stage），hosted 服务不再接收推送即可；`$DATA_DIR` 中的数据随实例回收消失。

## 已知限制

- **按需推送不是实时**：数据新鲜度 = 点「刷新」后一次唤醒 + 页面 8 秒轮询；不点刷新时只靠 30 分钟兜底推送。页面顶部按钮在手机端推送器未运行时会在 30 秒后提示「手机端未响应」。
- **`$DATA_DIR` 是临时存储**：实例重启或重新部署会清空 `board.json`；`--demand` 启动即推一次，且每 30 分钟兜底一次，通常能自愈；本机长时间离线期间云端显示旧数据（直到下一次成功推送）。
- **`/api/refresh` 无鉴权**：任何人点按钮最多让本机多推一次公开数据，不会泄露账本内容；如需限制可给该路由加 token（目前未做）。
- **ZCode Sites 无平台级环境变量注入**：`BOARD_TOKEN` 目前只能写在部署时的 `start.sh` 里（见上文），换用其他平台可直接注入环境变量。
- 本项目测试只覆盖本机进程内/子进程验证；真实云实例上的部署、公网访问与 token 配置需上线时人工验证。
