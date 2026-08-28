import { Bot, InputFile, type Context } from "grammy";
import type { Store } from "../../store/db.js";
import type {
  ChannelAdapter,
  ChatKind,
  IncomingImage,
  IncomingMessage,
  MessageHandler,
  OutgoingImage,
  OutgoingTarget,
  SendOptions,
} from "../types.js";
import {
  chunkText,
  formatImageCorrupt,
  formatPhotoOnlyPrompt,
  formatPhotoUnsupported,
  formatUnsupportedImageType,
  TELEGRAM_STATUS_LIMIT,
  TELEGRAM_TEXT_LIMIT,
} from "./format.js";
import {
  downloadTelegramFileAsImage,
  normalizeImageMime,
} from "./media.js";
export const TELEGRAM_DM_THREAD_ID = "0";

/** Forum "General" topic id in Telegram. */
export const TELEGRAM_GENERAL_TOPIC_ID = "1";

export type TelegramBotOptions = {
  token: string;
  store: Store;
  /** Global default from config.yaml telegram.verbose */
  verboseDefault: boolean;
};

type WorkSession = {
  statusMessageId: number;
  lastText: string;
  startedAt: number;
  typingTimer: ReturnType<typeof setInterval>;
  heartbeatTimer: ReturnType<typeof setInterval>;
};

function parseCommand(text: string): {
  command?: string;
  commandArgs?: string;
  text: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return { text: trimmed };
  }
  const match = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { text: trimmed };
  }
  return {
    command: match[1]!.toLowerCase(),
    commandArgs: match[2]?.trim() || undefined,
    text: trimmed,
  };
}

function threadIdFromMessage(ctx: Context): string {
  const msg = ctx.message;
  if (!msg) return TELEGRAM_DM_THREAD_ID;
  if (msg.message_thread_id != null) {
    return String(msg.message_thread_id);
  }
  return TELEGRAM_DM_THREAD_ID;
}

function chatKindFromContext(ctx: Context): ChatKind {
  const chat = ctx.chat;
  const msg = ctx.message;
  if (!chat) return "group";
  if (chat.type === "private") return "dm";

  // Forum supergroup with Topics enabled
  if ("is_forum" in chat && chat.is_forum) {
    const threadId = msg?.message_thread_id;
    // Telegram's General topic is always id 1.
    // Some clients omit is_topic_message even inside custom topics — don't require it.
    if (threadId == null || threadId === 1) {
      return "general";
    }
    return "topic";
  }

  return "group";
}

/** Default (English) slash menu — used when no language-specific list matches. */
export const TELEGRAM_BOT_COMMANDS_EN = [
  { command: "bind", description: "Bind this topic to a project: /bind <slug>" },
  { command: "status", description: "Show session / queue status" },
  { command: "new", description: "Start a new agent mapping (does not archive cloud)" },
  { command: "cancel", description: "Cancel current run and clear queue" },
  { command: "verbose", description: "Detail mode: /verbose on|off" },
  { command: "ping", description: "Connectivity check" },
] as const;

/** Chinese slash menu for Telegram clients with language zh*. */
export const TELEGRAM_BOT_COMMANDS_ZH = [
  { command: "bind", description: "绑定当前 topic 到项目：/bind <slug>" },
  { command: "status", description: "查看会话 / 队列状态" },
  { command: "new", description: "新开会话映射（不 archive 云端）" },
  { command: "cancel", description: "取消当前 run 并清空队列" },
  { command: "verbose", description: "详细模式：/verbose on|off" },
  { command: "ping", description: "连通性测试" },
] as const;

/** @deprecated Use TELEGRAM_BOT_COMMANDS_EN */
export const TELEGRAM_BOT_COMMANDS = TELEGRAM_BOT_COMMANDS_EN;

export class TelegramChannel implements ChannelAdapter {
  readonly channel = "telegram" as const;
  private readonly bot: Bot;
  private readonly token: string;
  private readonly store: Store;
  private readonly verboseDefault: boolean;
  private handler: MessageHandler | undefined;
  private running = false;
  private readonly workSessions = new Map<string, WorkSession>();

  constructor(opts: TelegramBotOptions) {
    this.bot = new Bot(opts.token);
    this.token = opts.token;
    this.store = opts.store;
    this.verboseDefault = opts.verboseDefault;
  }

  async start(handler: MessageHandler): Promise<void> {
    if (this.running) return;
    this.handler = handler;

    await this.registerBotCommands();

    this.bot.on("message:text", async (ctx) => {
      await this.onTextMessage(ctx);
    });

    this.bot.on("message:photo", async (ctx) => {
      await this.onPhotoMessage(ctx);
    });

    this.bot.on("message:document", async (ctx) => {
      await this.onDocumentMessage(ctx);
    });

    this.bot.catch((err) => {
      console.error("outpost: telegram error:", err.error ?? err);
    });

    this.running = true;
    console.log("outpost: telegram bot starting (long polling)…");
    void this.bot.start({
      onStart: (info) => {
        console.log(`outpost: telegram bot @${info.username} ready`);
      },
    });
  }

  private async registerBotCommands(): Promise<void> {
    const en = [...TELEGRAM_BOT_COMMANDS_EN];
    const zh = [...TELEGRAM_BOT_COMMANDS_ZH];
    await this.bot.api.setMyCommands(en);
    await this.bot.api.setMyCommands(zh, { language_code: "zh" });
    console.log(
      `outpost: telegram commands registered (en default + zh) (${en.map((c) => c.command).join(", ")})`,
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    await this.bot.stop();
  }

  async sendPhoto(
    target: OutgoingTarget,
    image: OutgoingImage,
    opts?: SendOptions,
  ): Promise<void> {
    const buf = Buffer.from(image.data, "base64");
    const ext = image.mimeType.split("/")[1] ?? "jpg";
    const caption = image.caption?.trim();
    await this.bot.api.sendPhoto(
      Number(target.chatId),
      new InputFile(buf, `window.${ext}`),
      {
        ...this.threadSendOpts(target),
        disable_notification: opts?.silent ?? false,
        caption: caption ? caption.slice(0, 1024) : undefined,
        parse_mode: caption && opts?.parseMode ? opts.parseMode : undefined,
      },
    );
  }

  async sendText(
    target: OutgoingTarget,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    const parseMode = opts?.parseMode;
    const chunks = chunkText(text, TELEGRAM_TEXT_LIMIT);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(Number(target.chatId), chunk, {
        ...this.threadSendOpts(target),
        disable_notification: opts?.silent ?? false,
        parse_mode: parseMode,
      });
    }
  }

  async sendStatus(target: OutgoingTarget, text: string): Promise<void> {
    await this.updateWork(target, text);
  }

  async beginWork(target: OutgoingTarget, status: string): Promise<void> {
    await this.endWork(target);
    const clipped = this.clipStatus(status);
    const sent = await this.bot.api.sendMessage(
      Number(target.chatId),
      clipped,
      {
        ...this.threadSendOpts(target),
        disable_notification: true,
      },
    );
    const chatId = Number(target.chatId);
    void this.bot.api.sendChatAction(chatId, "typing", this.threadSendOpts(target));

    const typingTimer = setInterval(() => {
      void this.bot.api.sendChatAction(
        chatId,
        "typing",
        this.threadSendOpts(target),
      );
    }, 4000);

    const startedAt = Date.now();
    const heartbeatTimer = setInterval(() => {
      const mins = Math.floor((Date.now() - startedAt) / 60000);
      if (mins > 0) {
        void this.updateWork(target, `⏳ Working — ${mins} min`);
      }
    }, 60000);

    this.workSessions.set(this.workKey(target), {
      statusMessageId: sent.message_id,
      lastText: clipped,
      startedAt,
      typingTimer,
      heartbeatTimer,
    });
  }

  async updateWork(target: OutgoingTarget, status: string): Promise<void> {
    const key = this.workKey(target);
    const session = this.workSessions.get(key);
    const clipped = this.clipStatus(status);
    if (!session) {
      await this.beginWork(target, clipped);
      return;
    }
    if (clipped === session.lastText) return;

    try {
      await this.bot.api.editMessageText(
        Number(target.chatId),
        session.statusMessageId,
        clipped,
      );
      session.lastText = clipped;
    } catch {
      // Message too old or unchanged — ignore.
    }
  }

  async endWork(target: OutgoingTarget): Promise<void> {
    const key = this.workKey(target);
    const session = this.workSessions.get(key);
    if (!session) return;

    clearInterval(session.typingTimer);
    clearInterval(session.heartbeatTimer);
    this.workSessions.delete(key);

    try {
      await this.bot.api.deleteMessage(
        Number(target.chatId),
        session.statusMessageId,
      );
    } catch {
      // Already deleted or too old — ignore.
    }
  }

  private workKey(target: OutgoingTarget): string {
    return `${target.chatId}:${target.threadId}`;
  }

  private threadSendOpts(target: OutgoingTarget): {
    message_thread_id?: number;
  } {
    return {
      message_thread_id:
        target.threadId !== TELEGRAM_DM_THREAD_ID
          ? Number(target.threadId)
          : undefined,
    };
  }

  private clipStatus(text: string): string {
    const t = text.trim();
    if (t.length <= TELEGRAM_STATUS_LIMIT) return t;
    return `${t.slice(0, TELEGRAM_STATUS_LIMIT - 1)}…`;
  }

  private async onTextMessage(ctx: Context): Promise<void> {
    const from = ctx.from;
    const chat = ctx.chat;
    const text = ctx.message?.text;
    if (!from || !chat || text == null) return;

    const gate = await this.gateIncoming(ctx, from.id, chat);
    if (!gate) return;

    const parsed = parseCommand(text);
    const msg: IncomingMessage = {
      channel: this.channel,
      chatId: gate.target.chatId,
      threadId: gate.target.threadId,
      senderId: gate.senderId,
      chatKind: gate.chatKind,
      text: parsed.text,
      command: parsed.command,
      commandArgs: parsed.commandArgs,
    };

    if (msg.command === "verbose") {
      await this.handleVerbose(msg);
      return;
    }

    if (!this.handler) return;
    await this.handler(msg);
  }

  private async onPhotoMessage(ctx: Context): Promise<void> {
    const from = ctx.from;
    const chat = ctx.chat;
    const photos = ctx.message?.photo;
    if (!from || !chat || !photos?.length) return;

    const gate = await this.gateIncoming(ctx, from.id, chat);
    if (!gate) return;

    const largest = photos[photos.length - 1]!;
    await this.dispatchImagePrompt(
      gate,
      largest.file_id,
      "image/jpeg",
      ctx.message?.caption,
      { width: largest.width, height: largest.height },
    );
  }

  private async onDocumentMessage(ctx: Context): Promise<void> {
    const from = ctx.from;
    const chat = ctx.chat;
    const doc = ctx.message?.document;
    if (!from || !chat || !doc) return;

    const gate = await this.gateIncoming(ctx, from.id, chat);
    if (!gate) return;

    const mime = normalizeImageMime(doc.mime_type);
    if (!mime) {
      const raw = (doc.mime_type ?? "").toLowerCase();
      if (raw.startsWith("image/")) {
        await this.sendText(
          gate.target,
          formatUnsupportedImageType(raw),
        );
      }
      return;
    }

    await this.dispatchImagePrompt(
      gate,
      doc.file_id,
      mime,
      ctx.message?.caption,
    );
  }

  private async dispatchImagePrompt(
    gate: {
      target: OutgoingTarget;
      senderId: string;
      chatKind: ChatKind;
    },
    fileId: string,
    mimeHint: string,
    caption?: string,
    dimension?: { width: number; height: number },
  ): Promise<void> {
    let image: IncomingImage | undefined;
    try {
      image = await downloadTelegramFileAsImage(
        this.bot.api,
        this.token,
        fileId,
        mimeHint,
        dimension,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`outpost: telegram image download failed: ${message}`);
      await this.sendText(gate.target, formatPhotoUnsupported());
      return;
    }

    if (!image) {
      await this.sendText(gate.target, formatImageCorrupt());
      return;
    }

    const text = (caption ?? "").trim() || formatPhotoOnlyPrompt();
    const msg: IncomingMessage = {
      channel: this.channel,
      chatId: gate.target.chatId,
      threadId: gate.target.threadId,
      senderId: gate.senderId,
      chatKind: gate.chatKind,
      text,
      images: [image],
    };

    console.log(
      `outpost: telegram image received mime=${image.mimeType} bytes~${Math.round(image.data.length * 0.75)}` +
        (image.dimension
          ? ` ${image.dimension.width}x${image.dimension.height}`
          : ""),
    );

    if (!this.handler) return;
    await this.handler(msg);
  }

  private async gateIncoming(
    ctx: Context,
    fromId: number,
    chat: NonNullable<Context["chat"]>,
  ): Promise<
    | {
        target: OutgoingTarget;
        senderId: string;
        chatKind: ChatKind;
      }
    | undefined
  > {
    const senderId = String(fromId);
    if (!this.store.isAllowed(this.channel, senderId)) {
      console.log(
        `outpost: telegram ignore non-allowlist sender=${senderId} chat=${chat.id}`,
      );
      return undefined;
    }

    const chatKind = chatKindFromContext(ctx);
    const threadId = threadIdFromMessage(ctx);
    const target: OutgoingTarget = {
      channel: this.channel,
      chatId: String(chat.id),
      threadId,
    };

    if (chatKind === "general") {
      const tid = threadIdFromMessage(ctx);
      await this.sendText(
        target,
        `Outpost does not accept the General topic (thread_id=${tid}).\n` +
          `Open a topic you created (not General), then send /bind <slug>.`,
      );
      return undefined;
    }

    if (chatKind === "group") {
      await this.sendText(
        target,
        "Outpost needs a private chat or a forum topic (supergroup with Topics enabled).",
      );
      return undefined;
    }

    return { target, senderId, chatKind };
  }

  private async handleVerbose(msg: IncomingMessage): Promise<void> {
    const arg = (msg.commandArgs ?? "").toLowerCase();
    const target: OutgoingTarget = {
      channel: msg.channel,
      chatId: msg.chatId,
      threadId: msg.threadId,
    };

    if (arg !== "on" && arg !== "off") {
      const current = this.store.resolveVerbose(
        msg.channel,
        msg.chatId,
        msg.threadId,
        this.verboseDefault,
      );
      await this.sendText(
        target,
        `Usage: /verbose on|off\nCurrent: ${current ? "on" : "off"}`,
      );
      return;
    }

    const on = arg === "on";
    this.store.setThreadVerbose(msg.channel, msg.chatId, msg.threadId, on);
    await this.sendText(
      target,
      on
        ? "verbose on (thinking + tool name/status; no full diffs)"
        : "verbose off (short status + chunked body only)",
    );
  }
}
