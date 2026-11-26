## 变更内容

<!-- 一句话说明这个 PR 做了什么；必要时列要点。 -->

## 关联任务

<!-- 任务号（#N / tp-N）或 issue 链接；没有就写「无」。 -->

## 验证

- [ ] `npm test`（core）通过
- [ ] board / channels / scripts / workbuddy 测试通过
- [ ] `node scripts/validate-plugin.mjs` PASS
- [ ] 改了 `core/src/**` 已跑 `node scripts/sync-core.mjs`
- [ ] 改了 owner skill 已跑 `node scripts/install-skill.mjs`（需重启宿主生效）

## 发布影响

- [ ] 需要更新版本号与 `CHANGELOG.md`
- [ ] 需要运行时重装/重启宿主
- [ ] 无发布影响（纯文档/重构）

## 自查

- [ ] 目标分支为 `main`，本分支从最新 `main` 拉出
- [ ] 没有直接 push 到 `main`
- [ ] 没有提交密钥、本机路径或账本数据
