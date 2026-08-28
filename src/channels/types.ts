/** Channel-agnostic adapter types. No Telegram chat_id in Cursor client. */

export type ChannelId = "telegram";

/** Where the message came from (Telegram routing). */
export type ChatKind = "dm" | "topic" | "general" | "group";

export type SessionKey = {
  channel: ChannelId;
  chatId: string;
  threadId: string;
};

/** Raster image for Cursor prompt.images (base64 + mime). */
export type IncomingImage = {
  data: string;
  mimeType: string;
  dimension?: { width: number; height: number };
};

/** Raster image for outbound channel delivery (base64 + mime). */
export type OutgoingImage = {
  data: string;
  mimeType: string;
  caption?: string;
};

export type SendOptions = {
  /** Suppress push notification when the channel supports it. */
  silent?: boolean;
  /** Telegram HTML formatting (Window sync messages). */
  parseMode?: "HTML";
};

export type IncomingMessage = SessionKey & {
  senderId: string;
  text: string;
  chatKind: ChatKind;
  /** Raw command name without slash, e.g. "verbose" */
  command?: string;
  commandArgs?: string;
  images?: IncomingImage[];
};

export type OutgoingTarget = SessionKey;

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly channel: ChannelId;
  start(handler: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  /** Send text, chunked to channel limit. */
  sendText(
    target: OutgoingTarget,
    text: string,
    opts?: SendOptions,
  ): Promise<void>;
  /** Send a photo with optional caption (Window image sync when API exposes bytes). */
  sendPhoto?(
    target: OutgoingTarget,
    image: OutgoingImage,
    opts?: SendOptions,
  ): Promise<void>;
  /** Short status — may edit an in-place work bubble when supported. */
  sendStatus(target: OutgoingTarget, text: string): Promise<void>;
  /** Start typing + single editable status bubble (Hermes-style). */
  beginWork?(target: OutgoingTarget, status: string): Promise<void>;
  updateWork?(target: OutgoingTarget, status: string): Promise<void>;
  endWork?(target: OutgoingTarget): Promise<void>;
  /** Append assistant body text (may edit the last outbound message). */
  appendAssistantContent?(
    target: OutgoingTarget,
    text: string,
    opts?: SendOptions,
  ): Promise<void>;
  /** Replace ⏳ tail with ✅ Done + links on the last message (or morph status bubble). */
  finalizeAssistant?(
    target: OutgoingTarget,
    doneTail: string,
    opts?: SendOptions & { fullBody?: string },
  ): Promise<void>;
}
