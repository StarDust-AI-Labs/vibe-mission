# board/templates/

ZCode Sites stage 模板，**字节级原样拷贝**自 zcode-site 插件 0.5.1 的
`skills/site-deploy/templates`（`static-server.mjs` / `static.sh`）。

snapshot.mjs 默认从这里读取，使构建不依赖本机插件缓存（CI / 他人机器可复现）。
要用插件实时版本时，设置环境变量 `ZCODE_SITE_TEMPLATES` 指向插件模板目录覆盖。

插件升级后如模板有变，重新拷贝并同步调整 `snapshot.mjs` 的 ADJUST 替换与
`board/test/board.test.mjs` 的断言。
