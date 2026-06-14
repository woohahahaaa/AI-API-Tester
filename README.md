# 🧪 AI API Tester

一个本地跑的 AI API 调试工具。有界面，填字段比写 JSON 省事，切换模型/渠道点一下就切；**请求体和返回体完全透明** —— 你发出去什么、收回来什么，全部摊开，方便调试。

<details><summary>🇬🇧 English</summary>

A local AI API debugging tool. With a UI — filling fields beats hand-writing JSON, switching models/providers is one click; **full request/response transparency** — everything you send and receive is fully laid out for debugging.

</details>

支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 三种协议，以及兼容这三家的中转。

![Preview](./preview.png)

> ⚠️ **这个 README 是 AI 写的，可能有幻觉**。具体行为请以代码为准，描述跟实际对不上的地方欢迎提 issue / 直接改。
>
> 虽然俺的本职工作是UI和用户体验设计, 但确实在这里比较偷懒, 没有精力打磨, 凑合用吧
>
> <details><summary>English</summary>This README is AI-generated and may hallucinate. Code is the source of truth — open an issue or fix directly when descriptions diverge from reality.</details>

---

## 💡 为什么做这个

从真实痛点里长出来的。

最早只是想给 opencode 里的模型开 thinking 模式，折腾半天发现：**同样是 OpenAI Chat Completions 这个"通用协议"，各家字段还是不一样** —— OpenAI o-series 要 `reasoning_effort`，Anthropic 要 `thinking.type` + `budget_tokens`，字节豆包、智谱 GLM、月之暗面 MiniMax 又各自有别的字段名，各种 NewAPI / oneapi 中转根本没文档，只能一个个字段试。

返回也乱：推理数据有的包在 `🙰...🙱` 标签里，有的在 `reasoning_content` 字段，有的只在 SSE 流的某个 event 里闪过。更烦的是 —— opencode、Cline 这些上层工具**不给你看真实的 HTTP 请求体和返回数据**，debug 全靠猜。

所以做了这个**过程透明**的工具：你发出去的 URL / headers / body，和收回来的 status / headers / body / 原始 SSE 帧，全部摊在你面前。字段怎么配，自己试，立刻看到结果。

<details><summary>🇬🇧 English</summary>

Born from real pain. I just wanted to enable thinking mode for a model inside opencode, and discovered that even within the supposedly "universal" OpenAI Chat Completions protocol, every vendor has different fields — OpenAI o-series wants `reasoning_effort`, Anthropic wants `thinking.type` + `budget_tokens`, Doubao/GLM/MiniMax each invent their own. Relay services often have no docs at all, so you end up guessing field names one by one.

Responses are equally messy: reasoning data hides inside `🙰...🙱` tags, or in a `reasoning_content` field, or flickers past in one specific SSE event. Worst of all, upper-layer tools like opencode and Cline **don't show you the real HTTP request/response** — debugging becomes pure guesswork.

So I built this **fully transparent** tool: every URL / header / body you send, and every status / header / body / raw SSE frame you receive, is laid out in front of you. Configure fields, try them, see results immediately.

</details>

---

## 🚀 启动

这个项目天生适合让 AI agent 帮忙跑 —— 启动、清理端口、健康检查这些重复劳动全部可以交给 agent。

需要 Node.js 18+。

### 1. 📥 下载到本地

```bash
git clone <repo-url>
```

clone 下来后**什么都不用手动改**，把项目目录丢给 AI agent 就行。

### 2. 🤖 让 AI agent 帮你启动

把项目路径告诉 agent（OpenCode、Claude Code、Cursor 等），然后对它说一句：

> **帮我启动这个项目**

agent 会自动：

1. 装 `server/` 和 `client/` 的依赖
2. 清理 3001 / 28001 端口的旧进程
3. 启动后端（Express，端口 3001）
4. 启动前端（Vite，端口 28001）
5. 健康检查两个服务
6. 报告本机 + 局域网访问地址

### 3. 🌍 打开浏览器

agent 启动完会告诉你访问地址，默认是 **http://localhost:28001/**。

### 🛟 兜底：手动启动

如果手头没 AI agent：

```bash
# 终端 1
cd server && npm install && npm run dev

# 终端 2
cd client && npm install && npm run dev
```

Windows 用户可以直接双击项目根的 `start-dev.ps1` 一键启动。

<details><summary>🇬🇧 English — Getting Started</summary>

This project is built to be launched by an AI agent — starting servers, killing port conflicts, and health-checking can all be delegated.

Requires Node.js 18+.

1. **Clone**: `git clone <repo-url>` — don't touch anything manually, just hand the directory to your AI agent.
2. **Let an AI agent start it**: Point your agent (OpenCode / Claude Code / Cursor / etc.) at the project and say **"Start this project for me"**. The agent will: install deps, kill stale processes on ports 3001/28001, start backend (Express, port 3001) and frontend (Vite, port 28001), health-check both, and report local + LAN URLs.
3. **Open browser**: defaults to **http://localhost:28001/**.

**Fallback — manual start**:

```bash
# Terminal 1
cd server && npm install && npm run dev

# Terminal 2
cd client && npm install && npm run dev
```

On Windows, double-click `start-dev.ps1` in the project root.

</details>

---

## 🖥️ 界面

三栏布局，分隔线可拖：

```
┌─────────────┬───────────────────┬───────────────────┐
│  Providers  │     Request       │     Response      │
│  渠道列表    │   构造请求         │   看响应          │
└─────────────┴───────────────────┴───────────────────┘
```

**👈 左 — Providers** —— 渠道列表（名字 / 协议 / baseUrl / API key / 模型列表），点一条加载到中间栏。

**✏️ 中 — Request** —— 协议、模型、baseUrl、采样参数、API key、reasoning 模板、messages、system、extra body。

**👀 右 — Response** —— 流式时实时显示 Output / Reasoning；完成后展开看 Sent Request、Received Response、原始 SSE Frames。

<details><summary>🇬🇧 English — UI Layout</summary>

Three-column layout with draggable dividers.

- **Left — Providers**: provider list (name / protocol / baseUrl / API key / models). Click one to load it into the middle column.
- **Middle — Request**: protocol, model, baseUrl, sampling params, API key, reasoning template, messages, system, extra body.
- **Right — Response**: real-time Output / Reasoning while streaming; expand panels afterwards to inspect Sent Request, Received Response, and raw SSE Frames.

</details>

---

## 🔌 三个协议

| 协议 | 路径 |
|---|---|
| `openai-completions` | `{baseUrl}/v1/chat/completions` |
| `openai-responses` | `{baseUrl}/v1/responses` |
| `anthropic` | `{baseUrl}/v1/messages` |

---

## 🧠 Reasoning 模板

不同家的"先想后答"字段不一样，工具用模板抹平。预置了三个模板：

| 模板 | 字段 |
|---|---|
| **GPT o-series / GPT-5.1** | `reasoning_effort`（none / minimal / low / medium / high / xhigh） |
| **火山方舟 Coding Plan** | `thinking.type`（enabled / disabled）+ `reasoning_effort`（minimal / low / medium / high / max） |
| **MiniMax** | `thinking.type`（adaptive / disabled）+ `reasoning_split`（true / false） |

> 📝 Anthropic / Claude 的 `thinking.type` + `budget_tokens` 走自定义模板或 extra body 配。

下拉框选一个就行，自定义后可以保存为新模板。

<details><summary>🇬🇧 English — Reasoning Templates</summary>

Every vendor names their "think first" fields differently — templates paper over the differences. Three are bundled:

| Template | Fields |
|---|---|
| **GPT o-series / GPT-5.1** | `reasoning_effort` (none / minimal / low / medium / high / xhigh) |
| **Volcengine Ark Coding Plan** | `thinking.type` (enabled / disabled) + `reasoning_effort` (minimal / low / medium / high / max) |
| **MiniMax** | `thinking.type` (adaptive / disabled) + `reasoning_split` (true / false) |

> 📝 Anthropic / Claude's `thinking.type` + `budget_tokens` are configured via a custom template or the extra body.

Pick one from the dropdown, or build a custom one and save it as a new template.

</details>

---

## 💾 数据存在哪

| 数据 | 位置 |
|---|---|
| Provider 配置（含 API key） | `server/data/configs.json` |
| Reasoning 模板 | `server/data/reasoning-templates.json` |
| 请求参数缓存 | 浏览器 localStorage |

`server/data/` 已经在 `.gitignore`。

---

## 🔒 安全提醒

- 🚫 API key 明文存在本地 JSON。**别 commit、别放公网**。
- 🚫 工具没有任何鉴权，只能本机用。
- 🔄 不小心推了 key → 立刻去 provider 后台 rotate。

<details><summary>🇬🇧 English — Security Notes</summary>

- API keys are stored as plaintext JSON locally. **Never commit them, never expose this on the public internet.**
- No authentication whatsoever — local use only.
- Accidentally pushed a key? Rotate it on the provider's dashboard immediately.

</details>

---

## ❓ 常见问题

**Q: 启动后浏览器打不开？**
A: 看终端有没有 `EADDRINUSE`，端口被占了。换端口或者 kill 占用进程。

**Q: 提示 "API key is required"?**
A: 中间栏 🔑 API Key 是空的，或者你用的是占位 provider。换成你自己的 key。

**Q: 提示 "Model is required"?**
A: Endpoint 区域的 Model 字段是空的。下拉框选一个，或者自己输入模型名。

**Q: 中转站拉不到模型列表？**
A: 不是所有中转都开放 `/v1/models`。手动填模型名就行。

**Q: 报 "Invalid baseUrl"?**
A: baseUrl 必须带协议头，比如 `https://api.openai.com`，不能只填 `api.openai.com`。

**Q: 能同时给同事用吗？**
A: 不能。它没有任何鉴权，只适合本机调试。要团队用，得自己在外面套个登录层。

<details><summary>🇬🇧 English — FAQ</summary>

**Q: Browser can't open the page after startup?**
A: Check the terminal for `EADDRINUSE` — the port is taken. Change the port or kill the conflicting process.

**Q: "API key is required"?**
A: The API Key field in the middle column is empty, or you're on a placeholder provider. Plug in your own key.

**Q: "Model is required"?**
A: The Model field is empty. Pick one from the dropdown, or type a model name.

**Q: Relay can't return a model list?**
A: Not every relay exposes `/v1/models`. Just type the model name manually.

**Q: "Invalid baseUrl"?**
A: baseUrl needs a scheme — `https://api.openai.com`, not just `api.openai.com`.

**Q: Can I share this with teammates?**
A: Nope. There's no auth — local debugging only. For team use, wrap your own auth layer around it.

</details>

---

## 📁 项目结构

```
apitest/
├── client/                      # 前端 (Vite + React)
│   └── src/
│       ├── App.tsx
│       ├── components/
│       │   ├── ConfigList.tsx   # 左栏 provider CRUD
│       │   └── Tester.tsx       # 中右栏：请求编辑器 + 响应显示
│       └── hooks/useColumnResizer.ts
├── server/                      # 后端 (Express)
│   ├── src/index.ts             # API 路由 + SSE 解析 + 协议转换
│   └── data/                    # gitignored
└── start-dev.ps1
```

🛠️ **技术栈**: React 18 + Vite 5 + TypeScript 前端，Express 4 + tsx 后端，本地 JSON 存储，SSE 流式。

---

## 🌐 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/proxy` | 转发请求到上游 LLM（支持流式） |
| `GET` | `/api/models?baseUrl=...&apiKey=...` | 拉模型列表 |
| `GET/POST/PUT/DELETE` | `/api/configs[/:id]` | Provider CRUD |
| `PATCH` | `/api/configs/:id/endpoint` | 部分更新 baseUrl / basePath |
| `GET/POST/PUT/DELETE` | `/api/reasoning-templates[/:id]` | Reasoning 模板 CRUD |

📦 `POST /api/proxy` 请求体：

```json
{
  "protocol": "openai-completions",
  "stream": false,
  "model": "...",
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

---

## 📜 License

MIT ✨
