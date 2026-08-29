[English](README.md) | **中文**

# cursor-outpost

**自建 Telegram ↔ [Cursor Cloud Agents](https://cursor.com) 桥接。**

在 Telegram（含 Topic 话题）里向 Cursor 云端 Agent 提问、收回复；并与 Cursor **Agents Window** 双向同步（Window 里的对话也会推到 Telegram）。

适合想用 Telegram 当「移动端 / 群聊入口」操作 Cloud Agent 的开发者。Bot 跑在你自己的机器上；Cursor 侧走官方 Cloud Agents API（`@cursor/sdk`）。

---

## 你能做什么

| 场景 | 说明 |
|------|------|
| Telegram 发问 | 创建 agent 或追问，气泡里看进度和回复，结束有 Done + 链接 |
| Agents Window | 在 Cursor 网页里聊的内容，会同步到对应 Telegram Topic |
| 多 Topic | 一个群多个 Topic 可绑定不同仓库，互不干扰 |
| 会话 | `/resume` 切历史 agent，`/new` 开新映射 |

---

## 使用前准备

1. **Cursor 账号** + Cloud Agents 可用  
2. **Cursor API Key**：Cursor 设置里创建（需有 Cloud Agents 权限）  
3. **Telegram Bot**：通过 [@BotFather](https://t.me/BotFather) 创建，拿到 `TELEGRAM_BOT_TOKEN`  
4. **你的 Telegram 用户 ID**：例如用 [@userinfobot](https://t.me/userinfobot) 查看（纯数字）  
5. **Node.js ≥ 22.13**

可选：一个 Telegram **超级群 + Topic**，方便按仓库分话题（私聊也能用）。

---

## 安装与启动

### 1. 克隆并安装

```bash
git clone https://github.com/gaojuzhang/cursor-outpost.git
cd cursor-outpost
npm install
```

### 2. 配置目录（默认 `~/.config/cursor-outpost/`）

```bash
mkdir -p ~/.config/cursor-outpost
cp config.example.yaml ~/.config/cursor-outpost/config.yaml
```

### 3. 环境变量

创建 `~/.config/cursor-outpost/.env`：

```env
CURSOR_API_KEY=你的_Cursor_API_Key
TELEGRAM_BOT_TOKEN=你的_Bot_Token
TELEGRAM_ALLOW_USER_IDS=123456789
```

| 变量 | 说明 |
|------|------|
| `CURSOR_API_KEY` | Cursor API 密钥 |
| `TELEGRAM_BOT_TOKEN` | BotFather 给的 token |
| `TELEGRAM_ALLOW_USER_IDS` | 允许使用的 Telegram 用户 ID，**逗号分隔**（不在列表里的人消息会被忽略） |

### 4. 运行

```bash
npm run build
npm start
```

终端出现 `outpost: Cursor API probe ok` 和 poller 启动日志即表示正常。

开发调试：

```bash
npm run dev
```

### 5. 后台运行（关闭终端不退出）

在终端里直接 `npm start` 时，**关闭终端或断开 SSH 会结束进程**。需要常驻请用：

**方式 A — `nohup`（无需额外安装）**

```bash
cd cursor-outpost
npm run build
nohup npm start >> ~/.config/cursor-outpost/outpost.log 2>&1 &
echo $! > ~/.config/cursor-outpost/outpost.pid
```

- 看日志：`tail -f ~/.config/cursor-outpost/outpost.log`
- 停止：`kill $(cat ~/.config/cursor-outpost/outpost.pid)`

**方式 B — [pm2](https://pm2.keymetrics.io/)（崩溃可自动拉起）**

先安装（若提示 `pm2: command not found`）：

```bash
npm install -g pm2
```

然后：

```bash
npm run build
pm2 start dist/index.js --name cursor-outpost
pm2 save          # 可选：重启后恢复
pm2 startup       # 可选：开机自启（Linux/macOS）
```

不想全局安装时，用 `npx pm2 start dist/index.js --name cursor-outpost` 代替 `pm2`。

- 看日志：`pm2 logs cursor-outpost`（或 `npx pm2 logs …`）
- 停止：`pm2 stop cursor-outpost`

**方式 C — systemd（Linux 服务器）**

`npm run build` 后，用 `ExecStart=/usr/bin/node /path/to/cursor-outpost/dist/index.js`，`WorkingDirectory` 指向仓库目录。密钥可通过 `EnvironmentFile=~/.config/cursor-outpost/.env` 注入（systemd 格式：每行 `KEY=value`）。

长期运行建议用 **pm2** 或 **systemd**，不要依赖一直开着 SSH。

---

## 安全与密钥

**不要把真实密钥提交到 Git。**

| 文件 | 是否进仓库 | 说明 |
|------|------------|------|
| `.env.example` | ✅ 仅模板（空值） | 复制到 `~/.config/cursor-outpost/.env` 后填写 |
| `config.example.yaml` | ✅ 示例 | 复制到 `~/.config/cursor-outpost/config.yaml` |
| `.env`、`config.yaml`、`*.db` | ❌ 已 `.gitignore` | 含密钥或本地状态 |

密钥只放在本机 `~/.config/cursor-outpost/.env`，不要放在项目目录里。详见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)（[English](SECURITY.md)）。

---

## 第一次怎么用

### 方式 A：群 + Topic（推荐）

1. 建超级群，开启 **Topics**，把 bot 拉进群  
2. 在某个 Topic 里发 `/repos`，看 Cursor 已连接的 GitHub 仓库列表  
3. 记下要用的 **slug**（列表里每行前面的短名）  
4. 在同一 Topic 发：`/bind <slug>`（例如 `/bind flux`）  
5. 直接发文字提问，例如：`当前项目有哪些分支？`  
6. 等气泡从 Working → 正文 → **Done** + agent 链接  

每个 Topic 单独绑定一个仓库；换 Topic 要重新 `/bind`。

### 方式 B：私聊 bot

1. 在 `config.yaml` 的 `projects` 里配置至少一个仓库，并设 `default: true`（见 `config.example.yaml`）  
2. 私聊 bot 直接发问题（无需 `/bind`）  

Topic 绑定优先于配置文件；私聊不走 `/bind`。

### 和 Agents Window 一起用

- 在 Cursor Agents Window 里对**同一个 agent** 发问 → Poller 会把用户消息和 agent 回复推到已绑定的 Telegram Topic  
- 在 Telegram 发的消息**不会**再原样推回 Telegram（回声已过滤）  

---

## 常用命令

在 Telegram 输入（支持中英文菜单，取决于客户端语言）：

| 命令 | 作用 |
|------|------|
| `/repos` | 列出 Cursor 连接的 GitHub 仓库 |
| `/bind <slug>` | 把**当前 Topic** 绑定到某仓库（先 `/repos` 看 slug） |
| `/status` | 当前绑定、agent、模型、队列 |
| `/new` | 清除本 Topic 的 agent 映射（**不**归档云端 agent） |
| `/resume` | 列出 / 切换可恢复的 Cloud Agent |
| `/model` | 查看或设置模型，如 `/model auto`、`/model <id>` |
| `/cancel` | 取消当前 run，清空排队消息 |
| `/verbose on` / `off` | 是否显示 thinking、tool、上下文用量等详情 |
| `/ping` | 测 bot 是否在线 |

**非命令的普通文字** = 向当前 Topic 绑定的 agent 发问或追问。

---

## 配置（`config.yaml`）

| 配置项 | 含义 |
|--------|------|
| `projects` | 私聊默认仓库；群 Topic 以 `/bind` 为准 |
| `telegram.verbose` | 全局默认是否详细模式（可被 `/verbose` 覆盖） |
| `poller.interval_ms` | Window → Telegram 轮询间隔（默认 8s） |
| `agent_catalog.interval_ms` | `/resume` 列表缓存刷新 |
| `repo_catalog.interval_ms` | `/repos` 列表缓存刷新 |

完整示例见仓库根目录 `config.example.yaml`。

本地状态 SQLite：`~/.config/cursor-outpost/state.db`（Topic 绑定、run 去重等）。

---

## 回复展示说明

- Agent 回复支持常见 **Markdown**（粗体、行内代码、代码块、链接）  
- Telegram **不支持表格**，表格会以等宽块展示  
- 结束时消息底部为 **Done** + Cursor agent 链接（及 PR 链接若有）  

---

## 常见问题

**启动报错 `Missing CURSOR_API_KEY`**  
检查 `.env` 路径与变量名，或导出环境变量后重试。

**发消息没反应**  
确认你的 Telegram ID 在 `TELEGRAM_ALLOW_USER_IDS` 里；看终端是否有 `ignore non-allowlist`。

**群 Topic 里提示要先 bind**  
在该 Topic 执行 `/repos` → `/bind <slug>`。

**一直显示 Working、不出正文**  
重启 outpost（`npm run build && npm start`）；看日志是否有 `run delivered`。快问类问题会走 conversation 回退拿正文。

**Done 下面没有文字**  
多为 API 未返回 `result`；会显示占位提示，点 agent 链接在 Cursor 里查看。

**Window 里已经答完，Telegram 还在等**  
同上，确保版本最新；SDK stream 超时后会自动走解析回退。

---

## 架构（给想改代码的人）

Telegram 发问主路径：

```
Router → RunSession → RunBodyResolver → TelegramRunPresenter → Telegram
```

- `src/core/router.ts` — 命令与发问入口  
- `src/delivery/` — 单次 run 的观测、正文解析、展示  
- `src/sync/poller.ts` — Agents Window → Telegram  
- `src/cursor/client.ts` — `@cursor/sdk` 封装  

---

## 开发

```bash
npm run build   # 编译到 dist/
npm run dev     # tsx 直接运行 src/
```

## License

MIT
