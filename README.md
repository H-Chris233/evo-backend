# 数字余生 · 对话与打字机后端

本仓库是黑客松项目「数字余生」的后端：接收网页或实体打字机上的输入，调用聊天模型生成回复，并把适合实体设备的英文内容交给打印链路。它以 [EvoMap Evolver](https://github.com/EvoMap/evolver) 为基础改造；仓库中仍保留 Evolver 的 CLI、自演化源码及多语言上游说明，但本项目的运行入口是 `src/backend/`，不是上游 Evolver CLI。

## 在项目中的位置

```text
web（React/Vite） ── /api/v1 + SSE ── 本后端 ── 聊天模型 / 阿里云 ASR
                                     │
                                     └── HTTP + WebSocket ── board/host ── ESP32-S3 ── KX-R530
```

- `web` 提供展览页、文字和语音输入、流式对话、Agent 与设备状态；其 Vite 服务在服务端附加网页访问令牌。
- 本后端管理网页与打字机各自的会话、模型调用、事件流、设备连接、英文翻译和打印队列；运行数据写入 `.backend-data/`。
- `board` 的 PC 上位机占用串口，向后端转交实体键盘提交，接收回复与打印命令。网页对话和实体键盘对话是不同会话。
- 当前对话人格来自 `skills/steve-jobs-skill/SKILL.md`，作为「数字余生」演示中的数字延续表达；这不代表系统拥有未经提供的私人记忆。后端目前可供模型调用的工具是打字机状态查询，不能把展示性文案描述成真实记忆检索。

## 本地启动

需要 Node.js 22.12+。在 Windows PowerShell 中，从本仓库目录执行：

```powershell
npm.cmd ci
Copy-Item -LiteralPath ".env.backend.example" -Destination ".env"
# 编辑 .env：设置不同的 BACKEND_WEB_TOKEN 与 BACKEND_DEVICE_TOKEN；
# 对话还需填写 BACKEND_MODEL_BASE_URL、BACKEND_MODEL、BACKEND_MODEL_API_KEY。
npm.cmd run backend
```

`npm.cmd start` 是继承的 Evolver CLI 入口，不能用来启动数字余生后端。后端默认监听 `0.0.0.0:3000`；`GET http://127.0.0.1:3000/api/v1/health` 只检查进程可达，不验证模型、ASR 或实体打印。

语音转写需要在后端 `.env` 配置 `BACKEND_ASR_API_KEY`（或 `DASHSCOPE_API_KEY`）。前端在相邻的 `../web` 中运行，并通过服务端网关使用 `BACKEND_WEB_TOKEN`；不要把令牌或供应商密钥写进浏览器代码。完整变量见 [环境变量示例](.env.backend.example)。

接入实体设备时，先运行 `../board` 的上位机，再配置 `BACKEND_BOARD_HTTP_URL=http://127.0.0.1:8765`；`BACKEND_BOARD_WS_URL` 可指向 `ws://127.0.0.1:8766/api/v1/agent`。HTTP 与 WebSocket 是两个端口。实体设备不可用时，网页文字对话仍可使用；需要无硬件联调时，可用 `npm.cmd run backend:device` 启动设备模拟器。`start.cmd` 是本机快捷入口，普通开发可直接用上述 npm 命令。

## 当前能力与边界

- 网页会话的创建、恢复、提交消息及 SSE 流式事件；模型请求支持工具调用和错误收尾。
- 音频转写通过后端调用 ASR；语音识别文字回填网页草稿，由用户确认后发送。
- 设备状态、实体键盘输入、英文翻译及顺序打印；断连或交付结果不确定时保留待确认状态，避免静默重打。
- 打印状态是软件与设备回执所能证明的状态；不能仅凭 HTTP 成功或队列排空声称纸面已完整打印。
- 不含通用网页搜索、私人记忆库检索或真实人物私人经历资料。现有 `memory/` 属于继承的 Evolver 代码结构，不应当作为本演示的个人记忆来源来介绍。

主要实现位于 `src/backend/index.js`（配置和启动）、`server.js`（HTTP/SSE）、`service.js`（会话与设备状态）、`model.js`（人格和模型）、`asr.js`（语音）、`board.js`（上位机适配）和 `printing.js`（打印编排）。

## 验证

```powershell
npm.cmd run test:backend
```

该命令运行后端、ASR 和打字机适配测试；测试通过不等于真实模型密钥、麦克风、串口或纸面打印已现场验证。

## 来源与许可

后端基于 EvoMap Evolver 改造；继承代码与项目改动遵循仓库 [GPL-3.0-or-later 许可证](LICENSE)。人格 skill 的来源和许可见 `skills/steve-jobs-skill/`。其他语言的 `README.zh-CN.md`、`README.ja-JP.md`、`README.ko-KR.md` 仍是上游 Evolver 资料，**本文件才是数字余生后端的项目说明**。
