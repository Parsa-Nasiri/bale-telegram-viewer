// In-memory stand-in for the Bale client. It records what the user would see, so tests can assert on it.

import { BaleError, type BaleApi, type SentMessage } from "../_shared/bale.ts";

export interface SentCard {
  kind: "message" | "photo";
  chatId: number;
  text: string;
  replyMarkup?: unknown;
  photoBytes?: number;
  messageId: number;
}

export class FakeBale implements BaleApi {
  readonly sent: SentCard[] = [];
  readonly answers: { callbackId: string; text: string }[] = [];
  readonly cleared: { chatId: number; messageId: number }[] = [];
  failPhoto = false;
  failMessage = false;
  private seq = 500;

  async sendMessage(input: { chatId: number; text: string; replyMarkup?: unknown }): Promise<SentMessage> {
    if (this.failMessage) throw new BaleError(500, "sendMessage failed");
    const messageId = ++this.seq;
    this.sent.push({ kind: "message", chatId: input.chatId, text: input.text, replyMarkup: input.replyMarkup, messageId });
    return { message_id: messageId };
  }

  async sendPhoto(input: { chatId: number; photo: Uint8Array; caption: string; replyMarkup?: unknown }): Promise<SentMessage> {
    if (this.failPhoto) throw new BaleError(400, "sendPhoto failed");
    const messageId = ++this.seq;
    this.sent.push({
      kind: "photo",
      chatId: input.chatId,
      text: input.caption,
      replyMarkup: input.replyMarkup,
      photoBytes: input.photo.byteLength,
      messageId,
    });
    return { message_id: messageId };
  }

  async answerCallbackQuery(callbackId: string, text: string): Promise<void> {
    this.answers.push({ callbackId, text });
  }

  async clearButtons(chatId: number, messageId: number): Promise<void> {
    this.cleared.push({ chatId, messageId });
  }
}
