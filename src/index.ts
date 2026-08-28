#!/usr/bin/env node
import { loadConfig, redactSecret } from "./config.js";
import { CursorClient } from "./cursor/client.js";
import { Store } from "./store/db.js";
import { TelegramChannel } from "./channels/telegram/bot.js";
import { Router } from "./core/router.js";
import { ActiveStreamTracker } from "./sync/active-streams.js";
import { AgentCatalog } from "./sync/agent-catalog.js";
import { ModelCatalog } from "./sync/model-catalog.js";
import { RepoCatalog } from "./sync/repo-catalog.js";
import { Poller } from "./sync/poller.js";

async function main(): Promise<void> {
  console.log("outpost: loading config…");
  const config = loadConfig();
  console.log(
    `outpost: config ok (dir=${config.paths.configDir}, key=${redactSecret(config.cursorApiKey)}, projects=${config.projects.length})`,
  );

  if (!config.telegramBotToken) {
    throw new Error(
      `Missing TELEGRAM_BOT_TOKEN. Set it in ${config.paths.envFile}`,
    );
  }
  if (config.telegramAllowUserIds.length === 0) {
    throw new Error(
      `Missing TELEGRAM_ALLOW_USER_IDS. Set comma-separated Telegram user ids in ${config.paths.envFile}`,
    );
  }

  const store = new Store(config.paths.stateDb);
  store.syncProjectsFromConfig(config.projects);
  store.syncAllowlist("telegram", config.telegramAllowUserIds);
  const projects = store.listProjects();
  if (projects.length === 0) {
    console.log("outpost: no config projects — private chat disabled until default repo set");
  }
  console.log(
    `outpost: db ok (${config.paths.stateDb}, projects=${projects.length}` +
      (projects.length
        ? `: ${projects.map((p) => `${p.slug}→${p.repo_url}@${p.ref}`).join(", ")}`
        : "") +
      `, allowlist=${config.telegramAllowUserIds.length})`,
  );

  const client = new CursorClient({
    apiKey: config.cursorApiKey,
    apiBase: config.apiBase,
  });

  console.log("outpost: Cursor backend = @cursor/sdk");
  await client.probe();
  console.log("outpost: Cursor API probe ok");

  const streams = new ActiveStreamTracker();

  const catalog = new AgentCatalog({
    store,
    cursor: client,
    intervalMs: config.agent_catalog.interval_ms,
  });
  catalog.start();

  const models = new ModelCatalog({ cursor: client });

  const repos = new RepoCatalog({
    cursor: client,
    intervalMs: config.repo_catalog.interval_ms,
  });

  const telegram = new TelegramChannel({
    token: config.telegramBotToken,
    store,
    verboseDefault: config.telegram.verbose,
  });

  const router = new Router({
    store,
    cursor: client,
    channel: telegram,
    config,
    streams,
    catalog,
    models,
    repos,
  });

  const poller = new Poller({
    store,
    cursor: client,
    channel: telegram,
    streams,
    intervalMs: config.poller.interval_ms,
  });

  await telegram.start(async (msg) => {
    try {
      await router.handle(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("outpost: handler error:", message);
      try {
        await telegram.sendText(
          {
            channel: msg.channel,
            chatId: msg.chatId,
            threadId: msg.threadId,
          },
          `内部错误：${message}`,
        );
      } catch {
        /* ignore */
      }
    }
  });

  poller.start();

  const shutdown = async (signal: string) => {
    console.log(`outpost: ${signal}, shutting down…`);
    catalog.stop();
    poller.stop();
    await telegram.stop();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`outpost: fatal: ${message}`);
  process.exit(1);
});
