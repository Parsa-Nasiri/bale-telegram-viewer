// Calls to the Bale Bot API made by the Edge Functions. The token lives only in the request URL, and errors never
// include it. The photo upload is multipart, like Bale's document upload. Bale's docs do not spell out every
// detail of these calls, so every photo has a text fallback (see sendCard).

const BALE_API = "https://tapi.bale.ai";

export interface SentMessage {
  message_id?: number;
}

/** The subset of the Bot API the functions use. Tests substitute an in-memory fake (tests/fake-bale.ts). */
export interface BaleApi {
  sendMessage(input: { chatId: number; text: string; replyMarkup?: unknown }): Promise<SentMessage>;
  sendPhoto(input: { chatId: number; photo: Uint8Array; caption: string; replyMarkup?: unknown }): Promise<SentMessage>;
  answerCallbackQuery(callbackId: string, text: string): Promise<void>;
  clearButtons(chatId: number, messageId: number): Promise<void>;
}

// Written without constructor parameter properties so the same file runs under Node's type stripping (tests).
export class BaleError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class BaleBot implements BaleApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl?: typeof fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  sendMessage(input: { chatId: number; text: string; replyMarkup?: unknown }): Promise<SentMessage> {
    return this.post("sendMessage", {
      json: { chat_id: input.chatId, text: input.text, reply_markup: input.replyMarkup },
    });
  }

  sendPhoto(input: { chatId: number; photo: Uint8Array; caption: string; replyMarkup?: unknown }): Promise<SentMessage> {
    const form = new FormData();
    form.append("chat_id", String(input.chatId));
    form.append("caption", input.caption);
    if (input.replyMarkup !== undefined) form.append("reply_markup", JSON.stringify(input.replyMarkup));
    form.append("photo", new Blob([input.photo], { type: "image/jpeg" }), "thumb.jpg");
    return this.post("sendPhoto", { form });
  }

  async answerCallbackQuery(callbackId: string, text: string): Promise<void> {
    await this.post("answerCallbackQuery", { json: { callback_query_id: callbackId, text } });
  }

  async clearButtons(chatId: number, messageId: number): Promise<void> {
    await this.post("editMessageReplyMarkup", {
      json: { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
    });
  }

  private async post(method: string, body: { json?: Record<string, unknown>; form?: FormData }): Promise<SentMessage> {
    const url = `${BALE_API}/bot${this.token}/${method}`;
    const init: RequestInit = body.form
      ? { method: "POST", body: body.form }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.json ?? {}) };
    const response = await this.fetchImpl(url, init);
    let parsed: { ok?: unknown; result?: SentMessage } = {};
    try {
      parsed = (await response.json()) as typeof parsed;
    } catch {
      // Not JSON: treated as a failure below.
    }
    if (!response.ok || parsed.ok !== true) throw new BaleError(response.status, `${method} failed`);
    return parsed.result ?? {};
  }
}

/**
 * Sends a card with its buttons. With a thumbnail it is sent as a photo; if the photo is refused, the same text
 * goes out as a plain message, so a bad thumbnail never stops the card. Returns the Bale message id, if any.
 */
export async function sendCard(
  bale: BaleApi,
  input: { chatId: number; caption: string; replyMarkup?: unknown; thumb: Uint8Array | null },
): Promise<number | null> {
  if (input.thumb) {
    try {
      const sent = await bale.sendPhoto({
        chatId: input.chatId,
        photo: input.thumb,
        caption: input.caption,
        replyMarkup: input.replyMarkup,
      });
      return sent.message_id ?? null;
    } catch (err) {
      console.error("card photo failed, sending text", err instanceof Error ? err.name : "unknown");
    }
  }
  const sent = await bale.sendMessage({ chatId: input.chatId, text: input.caption, replyMarkup: input.replyMarkup });
  return sent.message_id ?? null;
}
