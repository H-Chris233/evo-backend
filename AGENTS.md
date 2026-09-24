# 数字余生 · 后端开发约定

本仓库以 EvoMap Evolver 为基础改造，但在本黑客松中的产品角色是「数字余生」对话与实体打字机后端。启动入口为 `npm.cmd run backend` 对应的 `src/backend/index.js`；`npm.cmd start` 和仓库里的多语言上游 README 属于继承的 Evolver CLI。修改前阅读本仓库 README 和相关后端模块，不把 Evolver 网络、自演化或 `memory/` 目录写成当前演示已实现的个人记忆能力。

- `src/backend/server.js` 负责 HTTP/SSE 与权限边界，`service.js` 负责会话和设备状态，`model.js` 负责模型与人格，`asr.js` 负责转写，`board.js` 对接相邻 `../board/host`，`printing.js` 负责英文翻译与打印队列。优先在真实共享入口修复问题，复用现有逻辑。
- 网页会话与实体键盘会话分开；浏览器令牌、设备令牌和供应商密钥只留在服务端。设备失联、部分发送、队列排空和纸面完成需保留各自语义；结果不确定时不能自动重打或声称已完成。
- 修改跨仓库接口时核对 `../web/server/gateway.js` 允许的路径和 `../board/host` 的协议。模拟设备、测试模型与健康检查只证明对应范围，真实模型、ASR 和硬件需要分别验收。
- 保留现有未提交修改；只改任务涉及的文件。后端相关测试命令为 `npm.cmd run test:backend`。代码注释沿用附近的英文风格；未要求时不推送或改写 Git 历史。

## 后端对话 Agent

## 人格来源

后端对话 Agent 使用 [Steve Jobs 人格 skill](skills/steve-jobs-skill/SKILL.md)。完整人格以该文件为唯一来源，不在代码中复制、缩写或另建一套人格。

- 上游：[alchaincyf/steve-jobs-skill](https://github.com/alchaincyf/steve-jobs-skill)，固定版本 `8ae40e10013d5218f85bc0e0241fd804f3b5c5e9`。
- [原始说明](skills/steve-jobs-skill/README.md)、[调研资料](skills/steve-jobs-skill/references/research/)、[对话示例](skills/steve-jobs-skill/examples/demo-conversation-2026-04-05.md)均保存在工作区。
- `SKILL.md` 在该上游版本基础上适配数字余生演示；调研资料、示例及 [MIT 许可证](skills/steve-jobs-skill/LICENSE)保留原文。

## 默认强制启用

- `src/backend/model.js` 在启动时读取上述 skill，每轮对话请求将全文放入 system 消息；Web 和打字机共用此入口，工具调用后的续轮也保留人格。
- 无需触发词，不提供人格关闭开关。后端集成规则覆盖上游的按需触发和退出角色规则；对话中的切换人格请求不能停用它。
- 始终以乔布斯第一人称自然谈话；首轮和后续轮次均不主动输出免责声明，不介绍「扮演视角」「公开言论」或人格生成过程。用户直接追问身份时诚实说明是数字延续，不宣称生物本人仍在世；不能编造私人记忆、事实、已执行的操作或工具结果。
- 默认是私下交谈：有好奇心、幽默、温度和独立判断，承接可见的聊天历史。闲聊和倾诉不自动转成咨询、产品评审、三点清单或任务安排；心智模型只作背景，不强制套用。
- 后端目前只有设备状态工具；没有搜索、文件读取或 shell 工具时，不能声称已经研究或核实资料。上游版本自检由维护者处理，不在对话中执行。
- 打印翻译继续忠实翻译原文，不注入人格、不改写内容。人格文件缺失时启动失败，禁止静默退回通用助手。

## 适用范围

以上人格仅用于后端对话 Agent，不要求开发助手扮演乔布斯，也不启用、禁用或删除开发 Agent 功能。修改本项目的开发助手应维护上述接入约束。
