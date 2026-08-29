**English** | [中文](README.zh-CN.md)

# cursor-outpost

**Self-hosted bridge between Telegram and [Cursor Cloud Agents](https://cursor.com).**

Ask Cursor cloud agents from Telegram (including Topics) and get replies in chat. **Agents Window** conversations sync both ways—messages in the Cursor web UI also appear in Telegram.

For developers who want Telegram as a mobile or group-chat front-end for Cloud Agents. The bot runs on your machine; Cursor traffic uses the official Cloud Agents API (`@cursor/sdk`).

---

## What you can do

| Scenario | Description |
|----------|-------------|
| Telegram prompts | Create agents or send follow-ups; see progress and body in a bubble, then Done + link |
| Agents Window | Chats in the Cursor web UI sync to the bound Telegram Topic |
| Multiple Topics | One supergroup, many Topics—each can bind a different repo |
| Sessions | `/resume` to switch agents, `/new` for a fresh local mapping |

---

## Before you start

1. **Cursor account** with Cloud Agents enabled  
2. **Cursor API Key** from Cursor settings (Cloud Agents access)  
3. **Telegram Bot** via [@BotFather](https://t.me/BotFather) → `TELEGRAM_BOT_TOKEN`  
4. **Your Telegram user ID** (e.g. [@userinfobot](https://t.me/userinfobot))  
5. **Node.js ≥ 22.13**

Optional: a Telegram **supergroup with Topics** to separate repos (private chat works too).

---

## Install and run

### 1. Clone and install

```bash
git clone https://github.com/gaojuzhang/cursor-outpost.git
cd cursor-outpost
npm install
```

### 2. Config directory (default `~/.config/cursor-outpost/`)

```bash
mkdir -p ~/.config/cursor-outpost
cp config.example.yaml ~/.config/cursor-outpost/config.yaml
```

### 3. Environment variables

Create `~/.config/cursor-outpost/.env`:

```env
CURSOR_API_KEY=your_cursor_api_key
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOW_USER_IDS=123456789
```

| Variable | Description |
|----------|-------------|
| `CURSOR_API_KEY` | Cursor API key |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather |
| `TELEGRAM_ALLOW_USER_IDS` | Allowed Telegram user IDs, **comma-separated** (others are ignored) |

### 4. Start

```bash
npm run build
npm start
```

You should see `outpost: Cursor API probe ok` and poller startup logs.

Development:

```bash
npm run dev
```

---

## Security and secrets

**Never commit real keys to Git.**

| File | In repo? | Notes |
|------|----------|-------|
| `.env.example` | ✅ template only | Copy to `~/.config/cursor-outpost/.env` |
| `config.example.yaml` | ✅ example | Copy to `~/.config/cursor-outpost/config.yaml` |
| `.env`, `config.yaml`, `*.db` | ❌ gitignored | Secrets or local state |

Keep secrets only in `~/.config/cursor-outpost/.env`, not in the project tree. See [SECURITY.md](SECURITY.md) ([中文](SECURITY.zh-CN.md)).

---

## First-time usage

### Option A: Supergroup + Topics (recommended)

1. Create a supergroup, enable **Topics**, add the bot  
2. In a Topic, send `/repos` to list Cursor-connected GitHub repos  
3. Note the **slug** for the repo you want  
4. In the same Topic: `/bind <slug>` (e.g. `/bind flux`)  
5. Send a message, e.g. `What branches exist in this repo?`  
6. Wait for Working → body → **Done** + agent link  

Each Topic binds one repo; switch Topic → bind again.

### Option B: Private chat with the bot

1. Set at least one repo in `config.yaml` `projects` with `default: true` (see `config.example.yaml`)  
2. Message the bot directly (no `/bind` needed)  

Topic `/bind` overrides config; private chat does not use `/bind`.

### With Agents Window

- Prompt the **same agent** in Cursor Agents Window → poller pushes user messages and replies to the bound Telegram Topic  
- Telegram-originated messages are **not** echoed back (filtered)  

---

## Commands

Telegram slash menu is English or Chinese depending on client language.

| Command | Description |
|---------|-------------|
| `/repos` | List Cursor-connected GitHub repos |
| `/bind <slug>` | Bind **this Topic** to a repo (use `/repos` for slug) |
| `/status` | Binding, agent, model, queue |
| `/new` | Clear local agent mapping (**does not** archive cloud agent) |
| `/resume` | List or switch recoverable Cloud Agents |
| `/model` | View/set model, e.g. `/model auto`, `/model <id>` |
| `/cancel` | Cancel current run and clear queue |
| `/verbose on` / `off` | Show thinking, tools, context usage |
| `/ping` | Connectivity check |

Plain text (not a command) = prompt or follow-up to the bound agent.

---

## Configuration (`config.yaml`)

| Key | Meaning |
|-----|---------|
| `projects` | Default repo for private chat; group Topics use `/bind` |
| `telegram.verbose` | Default verbose mode (overridable per Topic) |
| `poller.interval_ms` | Window → Telegram poll interval (default 8s) |
| `agent_catalog.interval_ms` | `/resume` list cache refresh |
| `repo_catalog.interval_ms` | `/repos` list cache refresh |

See `config.example.yaml` in the repo root.

Local SQLite state: `~/.config/cursor-outpost/state.db` (bindings, run dedup, etc.).

---

## How replies look

- Common **Markdown** is rendered as HTML (bold, code, links)  
- Telegram has **no tables**—tables appear as monospace blocks  
- Footer: **Done** + Cursor agent URL (and PR URLs when present)  

---

## FAQ

**`Missing CURSOR_API_KEY` on start**  
Check `.env` path and variable names, or export env vars before starting.

**No response to messages**  
Ensure your Telegram ID is in `TELEGRAM_ALLOW_USER_IDS`; check logs for `ignore non-allowlist`.

**Topic asks to bind first**  
Run `/repos` then `/bind <slug>` in that Topic.

**Stuck on Working, no body**  
Restart outpost (`npm run build && npm start`); look for `run delivered` in logs. Short prompts use conversation fallback for body text.

**Done with no body text**  
API may omit `result`; a placeholder is shown—open the agent link in Cursor.

**Answer in Window but Telegram still waiting**  
Use the latest build; stream timeouts fall back to resolver + conversation.

---

## Architecture (for contributors)

Telegram prompt path:

```
Router → RunSession → RunBodyResolver → TelegramRunPresenter → Telegram
```

- `src/core/router.ts` — commands and delivery entry  
- `src/delivery/` — run observation, body resolution, presentation  
- `src/sync/poller.ts` — Agents Window → Telegram  
- `src/cursor/client.ts` — `@cursor/sdk` wrapper  

---

## Development

```bash
npm run build   # compile to dist/
npm run dev     # run src/ with tsx
```

## License

MIT
