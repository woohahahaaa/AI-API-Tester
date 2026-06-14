# AI API Tester

> 一个本地跑的 AI API 调试控制台 —— 像 Postman,但是专门给大模型 API 用。
> 支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议,以及所有兼容这三家的中转(NewAPI / 银河 / 火山方舟 / ...)。
>
> A local AI API debugging console — Postman for LLM APIs. Unified OpenAI Chat, OpenAI Responses, and Anthropic Messages, with pluggable `baseUrl`, live streaming, and reasoning field templates.

---

## 这是什么

如果你手头有一堆 AI API key —— OpenAI 官方、Anthropic、或者各种中转站 —— 想在一个网页里:

- 切换不同模型调参数
- 看流式响应长什么样
- 看 thinking / reasoning 过程
- 临时构造一个请求,看实际发出去的 body 和返回的 response

那这个工具就是给你做的。所有 key 和请求历史都存在你电脑本地的 JSON 文件里,不联网、不上传。

---

## 为什么做这个

从真实痛点里长出来的。

最早只是想给 opencode 里的模型开 thinking 模式,折腾半天发现:**同样是 OpenAI Chat Completions 这个"通用协议",各家字段还是不一样** —— OpenAI o-series 要 `reasoning_effort`,Anthropic 要 `thinking.type` + `budget_tokens`,字节豆包、智谱 GLM、月之暗面 MiniMax 又各自有别的字段名,各种 NewAPI / oneapi 中转根本没文档,只能一个个字段试。

返回也乱:推理数据有的包在 `【think】...【/think】` 标签里,有的在 `reasoning_content` 字段,有的只在 SSE 流的某个 event 里闪过。更烦的是 —— opencode、Cline 这些上层工具**不给你看真实的 HTTP 请求体和返回数据**,debug 全靠猜。

所以做了这个**过程透明**的工具:你发出去的 URL / headers / body,和收回来的 status / headers / body / 原始 SSE 帧,全部摊在你面前。字段怎么配,自己试,立刻看到结果。

---

## 你能用它做什么

- **统一测三种协议** —— OpenAI Chat Completions / OpenAI Responses / Anthropic Messages 在一个界面切,不用给每家装一个客户端
- **接任何兼容中转** —— 改个 baseUrl 就能用 NewAPI、银河、火山方舟这类 OpenAI / Anthropic 兼容入口
- **实时看流式响应** —— 打开 Stream 开关,一个字一个字蹦出来,同时把 reasoning(思考过程)和正文分开渲染
- **调推理参数不用记字段名** —— 下拉框选模板就行(GPT o-series 的 `reasoning_effort`、Claude 的 `thinking`、通用 `budget_tokens`...)
- **保存多个渠道** —— 你有 5 个不同的 key / 渠道,存起来随时切换
- **自动拉模型列表** —— 填好 baseUrl + key,一键调 `/v1/models` 把所有可用模型塞进下拉框
- **完整审计** —— 发出去的请求体、收回来的响应体、原始 SSE 帧全都留着,排错方便

---

## 使用方式

这个项目天生适合让 AI agent 帮忙跑 —— 启动、清理端口、健康检查这些重复劳动全部可以交给 agent。

### 1. 下载到本地

```bash
git clone <repo-url>
cd apitest
```

需要 Node.js 18+。clone 下来后**什么都不用手动改**,把项目目录丢给 AI agent 就行。

### 2. 让 AI agent 帮你启动

把项目路径告诉 agent(OpenCode、Claude Code、Cursor 等),然后对它说一句:

> **帮我启动这个项目**

agent 会自动:

1. 装 `server/` 和 `client/` 的依赖
2. 清理 3001 / 28001 端口的旧进程
3. 启动后端(Express,端口 3001)
4. 启动前端(Vite,端口 28001)
5. 健康检查两个服务
6. 报告本机 + 局域网访问地址

### 3. 打开浏览器

agent 启动完会告诉你访问地址,默认是 **http://localhost:28001/**。

### (兜底)手动启动

如果手头没 AI agent:

```bash
# 终端 1
cd server && npm install && npm run dev

# 终端 2
cd client && npm install && npm run dev
```

Windows 用户可以直接双击项目根的 `start-dev.ps1` 一键启动两个进程。

---

## 界面怎么用

整个界面是三栏,中间的分隔线可以**拖动调列宽**:

```
┌─────────────┬───────────────────┬───────────────────┐
│  Providers  │     Request       │     Response      │
│             │                   │                   │
│  你所有的   │   构造请求的地方   │   看响应的地方    │
│  渠道列表   │                   │                   │
└─────────────┴───────────────────┴───────────────────┘
```

### 左边栏:Providers(渠道)

每条渠道是一个 Provider,存了:

- 名字(比如「我的 OpenAI」)
- 协议(OpenAI Chat / Responses / Anthropic)
- 模型列表(从 baseUrl 自动拉的)
- baseUrl(API 入口)
- API key
- 备注

**点一条**就把它的所有信息加载到中间栏,可以直接发请求。
**+ 添加 Provider** 可以新建渠道。

### 中间栏:Request(构造请求)

从上到下分区:

| 区块 | 干啥的 |
|---|---|
| 🎯 Protocol | 选三种协议之一 |
| 🔧 Endpoint | 模型下拉框 + baseUrl + 路径 |
| 🎚️ Sampling | 温度 / max tokens / top-p / Stream 开关 |
| 🔑 API Key | 你的 key,带显示 / 隐藏切换 |
| 🧠 Reasoning | 选推理模板(后面专门讲) |
| 💬 Messages | 多轮对话的消息列表 |
| 🛠 System / Extra Body | 系统提示词 + 任意自定义 JSON 字段 |

底部两个按钮:

- **⚡ Test** —— 发一条 `hi` 测试连通性
- **▶ Send** —— 发你当前写的请求

### 右边栏:Response(看响应)

- **Stream 开启时**:两个独立滚动框分别显示 `Output`(模型最终内容)和 `Reasoning`(思考过程)
- **完成后**:展开面板能看到完整的 Sent Request(URL / headers / body)、Received Response(状态码 / headers / body)、Raw Frames(原始 SSE 帧)
- 底部 **Show request preview** 能预览这次请求实际构造出来的 body —— 跟上游 API 文档对不上的时候,看这里

---

## 三个关键概念

### Protocol(协议)

虽然都叫"AI API",但有三种不同的"说话方式"。你接的是哪家,就选哪个:

| 协议 | 适用场景 |
|---|---|
| `OpenAI Chat Completions` | 最常见的,OpenAI 官方和几乎所有中转都支持 |
| `OpenAI Responses` | OpenAI 新推的,o-series 模型用它 |
| `Anthropic Messages` | Claude 用的 |

> 小贴士:有些中转(银河)同时支持前两个,同一个 baseUrl 可以切协议试。

### Provider(渠道)

就是你接入的"入口"。可以是:

- **官方** —— `api.openai.com`、`api.anthropic.com`
- **中转站** —— NewAPI、银河、火山方舟、各种 oneapi
- **自己部署的代理** —— 任何 OpenAI / Anthropic 兼容的 HTTP 服务

每个 provider 独立存 key、独立存模型列表,切换不需要重启。

### Reasoning(推理)

让模型"先想后答"的开关。不同家的字段不一样:

| Provider | 字段 |
|---|---|
| GPT o-series(Chat) | `reasoning_effort: low / medium / high` |
| GPT o-series(Responses) | `reasoning.effort`、`reasoning.summary` |
| Claude | `thinking.type=enabled` + `budget_tokens` |
| 通用 | 自定义 name / value / target 注入 |

工具里已经预置了 5 个模板,覆盖以上场景。下拉框选一个就行。

想完全自定义?

1. 下拉框选「自定义…」
2. 手动加字段(name / value / target)
3. 点 **保存** —— 你的模板会出现在下拉列表里,下次直接选

---

## 进阶玩法

### 请求参数自动记忆

每个模型用过的参数(温度、system、消息、reasoning)会自动按 `协议 + baseUrl + 模型` 缓存到浏览器 localStorage。切回同一个模型时自动恢复 —— 不用每次重新填。

### 拉不到模型列表?

不是所有中转都开放 `/v1/models`。工具会同时试 `/v1/models` 和 `/models`,都拿不到就在 Model 字段手填。

### 三栏独立拖

嫌左边渠道列表太占地方?拖分隔线往左压。想看完整响应?拖右侧分隔线往右拉。

---

## 数据存在哪

| 数据 | 位置 |
|---|---|
| Provider 配置(含 API key) | `server/data/configs.json` |
| Reasoning 模板 | `server/data/reasoning-templates.json` |
| 请求参数缓存 | 浏览器 localStorage(按 model 存) |

`server/data/` 整个目录在 `.gitignore` 里,默认**不会被 git track**。

---

## 密钥安全 🔒

⚠️ 这个工具把你的 key **明文**存在本地 JSON。所以:

1. **不要把 `server/data/*.json` commit 到 git** —— 项目已经 `.gitignore` 了,别手贱改 ignore
2. **不要把这个工具放到公网服务器** —— 它没有任何鉴权,谁访问都能拿你的 key
3. **如果不小心推过 key**,立刻去对应 provider 后台 rotate(吊销旧 key、发新 key),然后在工具里改
4. **轮换 key**:provider 后台生成新 key → 工具左边栏编辑对应渠道 → 替换 apiKey → 保存。**不用重启**,立即生效

---

## 常见问题

**Q: 启动后浏览器打不开?**
A: 看终端有没有 `EADDRINUSE`,端口被占了。换端口或者 kill 占用进程。

**Q: 提示 "API key is required"?**
A: 中间栏 🔑 API Key 是空的,或者你用的是占位 provider。换成你自己的 key。

**Q: 提示 "Model is required"?**
A: Endpoint 区域的 Model 字段是空的。下拉框选一个,或者自己输入模型名。

**Q: 流式响应到一半断了?**
A: 默认 60 秒超时。短回复一般不会触发,长文本生成可以改 `Tester.tsx` 里的 `TIMEOUT_MS`。

**Q: 中转站拉不到模型列表?**
A: 不是所有中转都开放 `/v1/models`。手动填模型名就行。

**Q: 报 "Invalid baseUrl"?**
A: baseUrl 必须带协议头,比如 `https://api.openai.com`,不能只填 `api.openai.com`。

**Q: 能同时给同事用吗?**
A: 不能。它没有任何鉴权,只适合本机调试。要团队用,得自己在外面套个登录层。

---

## 给开发者

### 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 · Vite 5 · TypeScript 5.6 |
| 后端 | Node.js · Express 4 · tsx 4.19 · TypeScript 5.6 |
| 存储 | 本地 JSON |
| 流式 | Server-Sent Events (SSE) |

### 项目结构

```
apitest/
├── client/                      # 前端 (Vite + React)
│   ├── src/
│   │   ├── App.tsx              # 三栏布局 + 列宽拖拽
│   │   ├── components/
│   │   │   ├── ConfigList.tsx   # 左侧 provider 列表 + CRUD
│   │   │   └── Tester.tsx       # 中右两栏:请求编辑器 + 响应显示
│   │   ├── hooks/useColumnResizer.ts
│   │   └── main.tsx
│   └── package.json
├── server/                      # 后端 (Express)
│   ├── src/index.ts             # 全部 API 路由 + SSE 解析 + 协议转换
│   └── data/                    # ⚠️ 已 gitignored,运行时数据
│       ├── configs.json         # provider 列表 + API key(自动生成)
│       └── reasoning-templates.json
├── start-dev.ps1                # 一键启动脚本(Windows)
└── README.md
```

### API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/proxy` | 转发请求到上游 LLM(支持流式) |
| `GET` | `/api/models?baseUrl=...&apiKey=...` | 拉取模型列表 |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/configs[/:id]` | Provider CRUD |
| `PATCH` | `/api/configs/:id/endpoint` | 部分更新 baseUrl / basePath |
| `GET` / `POST` / `PUT` / `DELETE` | `/api/reasoning-templates[/:id]` | Reasoning 模板 CRUD |

### `POST /api/proxy` 请求体

```json
{
  "protocol": "openai-completions",
  "stream": false,
  "model": "claude-opus-4-8",
  "messages": [{ "role": "user", "content": "..." }],
  "system": "optional system prompt",
  "maxTokens": 1024,
  "temperature": 1,
  "apiKey": "sk-...",
  "baseUrl": "https://api.example.com",
  "extraBody": {},
  "reasoningFields": [
    { "name": "effort", "value": "high", "target": "reasoning_effort" }
  ]
}
```

`protocol` 可选值对应的实际路径:

- `openai-completions` → `POST {baseUrl}/v1/chat/completions`
- `openai-responses` → `POST {baseUrl}/v1/responses`
- `anthropic` → `POST {baseUrl}/v1/messages`

---

## 许可证

MIT
