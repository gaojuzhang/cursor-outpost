# cursor-outpost

自建 **Telegram ↔ Cursor Cloud Agents** 桥接：在 Telegram（含 Topic）里发消息、收回复，并与 Cursor Agents Window 双向同步。

后端使用 [@cursor/sdk](https://cursor.com)（Cloud Agents），本地 SQLite 保存 Topic 绑定、run 去重与会话状态。

## 功能

- **Telegram 发问**：创建 agent / 追问，流式展示进度与正文，结束时 Done + 链接
- **Agents Window 同步**：Window 侧用户消息 → Telegram；Window 侧 agent 结果 → Telegram
- **Topic 绑定**：`/repos` + `/bind` 绑定仓库与分支（不依赖配置文件里的项目列表）
- **会话管理**：`/new`、`/resume`、`/cancel`、`/status`
- **模型**：`/model` 选择模型（Auto 显式传 default）
- **Markdown**：agent 回复在 Telegram 中以 HTML 渲染（粗体、代码、链接；表格为等宽块）
- **上下文观测**：usage 提示、接近满容时警告、压缩通知（verbose 下更详细）

## 快速开始

### 1. 依赖

- Node.js **≥ 22.13**
- Cursor API Key（Cloud Agents）
- Telegram Bot Token

### 2. 配置目录

默认：`~/.config/cursor-outpost/`

```bash
mkdir -p ~/.config/cursor-outpost
cp config.example.yaml ~/.config/cursor-outpost/config.yaml
```

### 3. 环境变量（`~/.config/cursor-outpost/.env`）

```env
CURSOR_API_KEY=你的_Cursor_API_Key
TELEGRAM_BOT_TOKEN=你的_Bot_Token
TELEGRAM_ALLOW_USER_IDS=123456789
```

`TELEGRAM_ALLOW_USER_IDS` 为逗号分隔的 Telegram 用户 ID，仅这些用户可使用 bot。

### 4. 构建与运行

```bash
npm install
npm run build
npm start
```

开发模式（无需先 build）：

```bash
npm run dev
```

改代码后需重新 `npm run build && npm start`（或 dev）。

## 配置说明（`config.yaml`）

| 项 | 说明 |
|----|------|
| `projects` | 可选；私聊默认仓库。Topic 以 `/bind` 为准 |
| `telegram.verbose` | 默认是否输出 thinking / tool / usage 详情 |
| `poller.interval_ms` | Window 同步轮询间隔 |
| `agent_catalog.interval_ms` | `/resume` 用的 agent 列表缓存刷新 |
| `repo_catalog.interval_ms` | `/repos` 用的 GitHub 仓库列表缓存 |

见仓库内 `config.example.yaml`。

## Telegram 命令

| 命令 | 说明 |
|------|------|
| `/bind` | 绑定当前 Topic 到仓库（需先 `/repos`） |
| `/repos` | 列出 Cursor 已连接 GitHub 仓库 |
| `/status` | 当前 Topic 绑定、agent、模型等 |
| `/new` | 清除本地 agent 绑定（不归档云端 agent） |
| `/resume` / `/sessions` | 列出可恢复的 agent 会话 |
| `/model` | 查看 / 设置模型 |
| `/cancel` | 取消当前 run |
| `/verbose on\|off` | 本 Topic 详细日志 |
| `/ping` | 连通性测试 |

直接发文字（非命令）即向当前 Topic 绑定的 agent 发问或追问。

## 架构概览

### 消息管道（Telegram → Agent → Telegram）

```
Router.deliverRun()
  → RunSession        （观测 stream / 等待 run 结束）
  → RunBodyResolver   （唯一正文解析）
  → TelegramRunPresenter（气泡、正文、Done 尾标）
```

**正文解析优先级**（`RunBodyResolver`）：

1. Stream 缓冲正文  
2. `run.result`（SDK wait / getRun）  
3. `run.conversation()`（SDK）  
4. v0 `GET /agents/{id}/conversation`（按 prompt 匹配）  
5. 占位文案（禁止只显示 Done + 链接）

### 主要模块

| 路径 | 职责 |
|------|------|
| `src/core/router.ts` | 命令、建 agent、追问、`deliverRun` |
| `src/delivery/run-session.ts` | 单次 run：stream 观测 + resolver + finalize |
| `src/delivery/run-body-resolver.ts` | 轮询解析正文 |
| `src/delivery/telegram-presenter.ts` | Telegram 展示（含 Markdown HTML） |
| `src/cursor/client.ts` | `@cursor/sdk` 封装（stream / wait / conversation） |
| `src/sync/poller.ts` | Window → Telegram 同步 |
| `src/channels/telegram/bot.ts` | Grammy bot、work 气泡、流式编辑 |
| `src/store/db.ts` | SQLite：threads、runs、outbound_prompts 等 |

### Window 同步（Poller）

- 跳过 `origin=telegram` 及正在 SSE 的 run，避免回声
- 未知 run 默认视为 Window 来源；无正文孤儿 `ERROR` run 静默吸收，不推送
- Window 结果走同一套 `RunBodyResolver` + `TelegramRunPresenter`

### 数据与清理

- `runs`：run 元数据（去重、是否已通知），单行很小
- `/new` 或 agent 失效时 `clearAgentSyncState` 会清理该 agent 的 `runs`、`outbound_prompts`、`conversation_msgs`
- `outbound_prompts.run_id`：Telegram 发出的 prompt 与 run 绑定，用于 conversation 正文匹配

## 常见问题

**Telegram 一直显示 Working？**  
多为 SDK `stream` / `wait` 挂起；已加超时并回退到 resolver + conversation。请重启 outpost 后再试。

**只有 Done + 链接、无正文？**  
检查日志中 `run delivered` 与 `bodySource`；快问类 run 会走 conversation 回退。

**Agents Window 已有回复，Telegram 仍等待？**  
同上；确保使用最新构建。

## 开发

```bash
npm run build   # tsc → dist/
npm run dev     # tsx 直接跑 src
```

类型检查即 `npm run build`（`tsc` 无 emit 分离，当前与 build 相同）。

## License

MIT
