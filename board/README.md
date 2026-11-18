# board/ — Local web dashboard

本宿主任务看板（一个部署 = 一个宿主，宿主内跨项目聚合；规划，未实现）：

- 静态 HTML + JSON API，`localhost` 打开即用，浏览器/手机同网可看。
- 内容：8 态看板列、仪表盘计数（running / waiting_decision / blocked / review）、阻塞与待决策高亮、事件流水。
- v1 不做登录鉴权（本机/内网使用场景）；如需远程访问，走用户自己的隧道方案。
