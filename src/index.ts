#!/usr/bin/env node
import { loadConfig, redactSecret } from "./config.js";
import { CursorClient } from "./cursor/client.js";
import { Store } from "./store/db.js";
import { TelegramChannel } from "./channels/telegram/bot.js";
import { Router } from "./core/router.js";
import { ActiveStreamTracker } from "./sync/active-streams.js";
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

  console.log("outpost: probing Cursor Cloud Agents API…");
  await client.probe();
  console.log("outpost: Cursor API probe ok");

  const streams = new ActiveStreamTracker();

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
