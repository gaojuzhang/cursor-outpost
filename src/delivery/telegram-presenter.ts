import type { ChannelAdapter, OutgoingTarget, SendOptions } from "../channels/types.js";
import {
  formatContentDoneTailHtml,
  formatRunBodyUnavailable,
  formatWindowResult,
  formatWindowResultHtml,
  formatWorkStatus,
  TELEGRAM_TEXT_LIMIT,
} from "../channels/telegram/format.js";
import { markdownToTelegramHtml } from "../channels/telegram/markdown.js";

/** Telegram: work bubble, streaming body, Done tail. */
export class TelegramRunPresenter {
  constructor(private readonly channel: ChannelAdapter) {}

  private htmlBody(text: string): string {
    return markdownToTelegramHtml(text);
  }

  private htmlOpts(): SendOptions {
    return { parseMode: "HTML" };
  }

  async beginWork(target: OutgoingTarget): Promise<void> {
    const status = formatWorkStatus("Working");
    if (this.channel.updateWork) {
      await this.channel.updateWork(target, status);
      return;
    }
    if (this.channel.beginWork) {
      await this.channel.beginWork(target, status);
    } else if (this.channel.sendStatus) {
      await this.channel.sendStatus(target, status);
    }
  }

  async updateWorkStatus(target: OutgoingTarget, statusLine: string): Promise<void> {
    if (this.channel.updateWork) {
      await this.channel.updateWork(target, statusLine);
    } else if (this.channel.sendStatus) {
      await this.channel.sendStatus(target, statusLine);
    }
  }

  async appendBody(
    target: OutgoingTarget,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    if (!text) return;
    if (this.channel.appendAssistantContent) {
      await this.channel.appendAssistantContent(target, text, opts);
      return;
    }
    await this.channel.sendText(target, text, opts);
  }

  async sendSideChannel(
    target: OutgoingTarget,
    text: string,
    opts?: SendOptions,
  ): Promise<void> {
    await this.channel.sendText(target, text, opts);
  }

  /**
   * Always shows body (or placeholder) + Done tail.
   * When bodyAlreadyStreamed, only finalizeAssistant updates the tail.
   */
  async finalize(
    target: OutgoingTarget,
    body: string,
    agentUrl: string,
    prUrls: string[],
    bodyAlreadyStreamed: boolean,
  ): Promise<void> {
    const text = body.trim() || formatRunBodyUnavailable();
    const htmlBody = this.htmlBody(text);
    const doneTail = formatContentDoneTailHtml(agentUrl, prUrls);
    const sendOpts = this.htmlOpts();

    if (!bodyAlreadyStreamed) {
      if (this.channel.appendAssistantContent) {
        await this.channel.appendAssistantContent(target, htmlBody, sendOpts);
      } else {
        await this.channel.sendText(
          target,
          `${htmlBody}\n\n${doneTail}`,
          sendOpts,
        );
        return;
      }
    }

    if (this.channel.finalizeAssistant) {
      await this.channel.finalizeAssistant(target, doneTail, {
        parseMode: "HTML",
        fullBody: htmlBody,
      });
    } else if (this.channel.endWork) {
      await this.channel.endWork(target);
      await this.channel.sendText(target, doneTail, sendOpts);
    } else {
      await this.channel.sendText(target, doneTail, sendOpts);
    }
  }

  async endWork(target: OutgoingTarget): Promise<void> {
    if (this.channel.endWork) await this.channel.endWork(target);
  }

  /** Agents Window terminal result — standalone IM message (not Telegram run bubble). */
  async sendWindowResult(
    target: OutgoingTarget,
    status: string,
    result: string,
    agentUrl: string,
    prUrls: string[],
  ): Promise<void> {
    const html = formatWindowResultHtml(status, result, agentUrl, prUrls);
    if (html.length <= TELEGRAM_TEXT_LIMIT) {
      await this.channel.sendText(target, html, { parseMode: "HTML" });
      return;
    }
    await this.channel.sendText(
      target,
      formatWindowResult(status, result, agentUrl, prUrls),
    );
  }
}
