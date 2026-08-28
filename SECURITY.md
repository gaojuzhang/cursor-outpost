# Security

## Secrets

**Do not commit** API keys, bot tokens, or personal config into this repository.

| Secret | Where to put it |
|--------|-----------------|
| `CURSOR_API_KEY` | `~/.config/cursor-outpost/.env` |
| `TELEGRAM_BOT_TOKEN` | same |
| `TELEGRAM_ALLOW_USER_IDS` | same |

- Copy `.env.example` → `~/.config/cursor-outpost/.env` and fill in values locally.
- Copy `config.example.yaml` → `~/.config/cursor-outpost/config.yaml` (no secrets in yaml; repo URLs are fine).

`.gitignore` excludes `.env`, `config.yaml`, `*.db`, and common credential filenames. Only `.env.example` and `config.example.yaml` are tracked as templates.

## Logs

Outpost logs redact API keys (`redactSecret` in `src/config.ts`). Avoid pasting full tokens into issues or screenshots.

## Reporting

If you believe a secret was committed, rotate the key immediately and open an issue or contact the maintainer.
