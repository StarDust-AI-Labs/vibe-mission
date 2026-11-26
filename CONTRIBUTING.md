# 贡献与发布流程

> 自 v0.2.0 起，`main` 是发布分支，**只接受 PR 合入**。任何新特性、功能优化、修复都不再直接 push 到 main。

## 分支模型

| 分支 | 用途 |
|---|---|
| `main` | 发布分支，受保护；只通过 PR 更新 |
| `feat/<slug>` | 新特性 |
| `fix/<slug>` | 修复 |
| `docs/<slug>` | 纯文档 |
| `chore/<slug>` | 构建、脚本、杂项 |

- 分支从最新 `main` 拉出，保持短生命周期；合并后删除。
- 一个 PR 只做一件事；跨模块的大改拆成多个 PR。

## PR 流程

1. `git switch main && git pull --ff-only`
2. 拉分支：`git switch -c feat/<slug>`
3. 开发并本地验证（见下节）
4. push 分支，开 PR 到 `main`
5. CI 全绿 + 自查清单勾完 → 合并（推荐 **Squash and merge**，保持 main 线性、一条 PR 一个提交）
6. 删除远端分支

**PR 必须包含**：变更内容、关联任务号（如有）、验证方式与结果、发布影响（是否需要版本号/CHANGELOG）。

## 本地验证（提交前必跑）

```bash
npm test                                        # core
node --test board/test/*.test.mjs               # board
node --test channels/test/*.test.mjs            # channels
node --test scripts/project-index.test.mjs      # routing
node --test adapters/workbuddy/taskpier/test/reconcile.test.mjs
node scripts/validate-plugin.mjs                # 插件清单校验
```

- 改了 `core/src/**` 后必须跑 `node scripts/sync-core.mjs`，把共享实现同步到 zcode 适配器副本；
- 改了 owner skill 后跑 `node scripts/install-skill.mjs` 安装到运行时，并重启宿主让 skill 生效。

## 发布流程（版本化）

版本号遵循 SemVer，正式版本用 annotated tag `vX.Y.Z` 标记。

1. 从 `main` 拉 `chore/release-vX.Y.Z` 分支
2. 统一版本号：`package.json`、`marketplace.json`、`adapters/zcode/vibemission/.zcode-plugin/plugin.json`、`core/src/mcp-server.mjs` 的 `SERVER_INFO.version`（改完跑 `node scripts/sync-core.mjs`）
3. 在 `CHANGELOG.md` 写入 `vX.Y.Z` 条目（新增 / 变更 / 修复 / 验证）
4. PR 合入 main
5. 打 tag 并推送：

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. 在 GitHub Releases 用 `CHANGELOG.md` 对应条目作为发布说明

**版本含义**：`MAJOR` 破坏性变更；`MINOR` 向后兼容的新能力/里程碑；`PATCH` 向后兼容的修复与文档。

## 直接 push main 的唯一例外

无。紧急修复也走 `fix/<slug>` + PR；若线上事故必须立即回滚，用 `git revert` 的 PR，而不是强推 main。
