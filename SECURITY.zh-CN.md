[English](SECURITY.md) | **中文**

# 安全说明

## 密钥

**不要将** API Key、Bot Token 或个人配置提交到本仓库。

| 密钥 | 存放位置 |
|------|----------|
| `CURSOR_API_KEY` | `~/.config/cursor-outpost/.env` |
| `TELEGRAM_BOT_TOKEN` | 同上 |
| `TELEGRAM_ALLOW_USER_IDS` | 同上 |

- 将 `.env.example` 复制为 `~/.config/cursor-outpost/.env`，在本机填写。
- 将 `config.example.yaml` 复制为 `~/.config/cursor-outpost/config.yaml`（yaml 里无密钥；仓库 URL 可写）。

`.gitignore` 已排除 `.env`、`config.yaml`、`*.db` 及常见凭据文件名。仓库中仅跟踪 `.env.example` 与 `config.example.yaml` 模板。

## 日志

Outpost 日志会对 API Key 脱敏（`src/config.ts` 中的 `redactSecret`）。请勿在 Issue 或截图中粘贴完整 token。

## 泄露上报

若发现密钥被提交，请立即轮换密钥并提 Issue 或联系维护者。
