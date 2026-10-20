// Bale webhook. Bale posts updates here, and four things can happen:
//  - a private message: the chat id is stored (file delivery needs it). A Telegram message link starts a lookup,
//    which the worker answers with an info card. Anything else gets the welcome button.
//  - a tap on Accept or Decline under a download card: the job is queued or declined, once.
//  - anything else (groups, edits, other events): acknowledged and ignored.
// Bale does not sign requests here, so access is gated by a secret path segment compared in constant time.

import type { BaleApi } from "./bale.ts";
import { timingSafeEqualString } from "./crypto.ts";
import { errorResponse, HttpError, jsonResponse, readJson } from "./http.ts";
import {
  AWAITING_STATE,
  isAwaitingExpired,
  MAX_LOOKUPS_PER_HOUR,
  type MessageLink,
  parseConfirmData,
  parseMessageLink,
  segmentsAfter,
} from "./logic.ts";
import { enqueue, JOB_QUEUE, LOOKUP_QUEUE } from "./queue.ts";
import type { Db } from "./rest.ts";

export interface WebhookDeps {
  db: Db;
  secret: string;
  /** Without a Bale client the webhook only stores chats. */
  bale?: BaleApi;
  /** The welcome button needs the Mini App address. Without it no button is sent. */
  miniAppUrl?: string;
  now?: () => number; // unix seconds
}

export interface PrivateChat {
  baleUserId: string;
  chatId: string;
}

export const WELCOME_TEXT = "برای دیدن پیام‌های کانال‌ها، دکمهٔ زیر را بزنید. برای دیدن اطلاعات یک پیام، لینک آن را همین‌جا بفرستید.";
export const OPEN_BUTTON_TEXT = "باز کردن نمایشگر کانال";
export const LOOKUP_ACK_TEXT = "پیام را پیدا می‌کنم و اطلاعات آن را همین‌جا می‌فرستم.";
export const LOOKUP_LIMIT_TEXT = "درخواست‌های زیادی فرستاده‌اید. چند دقیقه بعد دوباره امتحان کنید.";
export const CALLBACK_ACCEPTED_TEXT = "درخواست تأیید شد. فایل به‌زودی ارسال می‌شود.";
export const CALLBACK_DECLINED_TEXT = "لغو شد.";
export const CALLBACK_EXPIRED_TEXT = "این درخواست منقضی شده است. از نمایشگر دوباره درخواست دهید.";
export const CALLBACK_GONE_TEXT = "این درخواست دیگر فعال نیست.";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/.test(value)) return value;
  return null;
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "unknown";
}

/** Extracts the sender and private chat from an update. Returns null for anything else (groups, edits, other events). */
export function privateChatFromUpdate(update: Record<string, unknown>): PrivateChat | null {
  const message = asRecord(update.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  if (!chat || !from || chat.type !== "private") return null;
  const chatId = asId(chat.id);
  const baleUserId = asId(from.id);
  if (chatId === null || baleUserId === null) return null;
  return { baleUserId, chatId };
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  try {
    if (req.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED");
    const [pathSecret] = segmentsAfter(new URL(req.url).pathname, "bale-webhook");
    if (!pathSecret || !timingSafeEqualString(pathSecret, deps.secret)) {
      throw new HttpError(404, "NOT_FOUND");
    }

    const update = await readJson(req);
    const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))();
    const callback = asRecord(update.callback_query);
    if (callback) {
      await handleCallback(callback, deps, now);
    } else {
      const chat = privateChatFromUpdate(update);
      if (chat) {
        const text = asRecord(update.message)?.text;
        await handlePrivateChat(chat, typeof text === "string" ? text : null, deps, now);
      }
    }
    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    return errorResponse(err, {});
  }
}

async function handlePrivateChat(chat: PrivateChat, text: string | null, deps: WebhookDeps, now: number): Promise<void> {
  const rows = await deps.db.upsert<{ id: string }>(
    "users",
    [{ bale_user_id: chat.baleUserId, bale_chat_id: chat.chatId }],
    "bale_user_id",
  );
  const userId = rows[0]?.id;
  const link = parseMessageLink(text);
  if (link && userId) {
    await startLookup(userId, chat.chatId, link, deps, now);
    return;
  }
  await replyWelcome(chat.chatId, deps);
}

/** A Telegram message link. The worker fetches the message (only it can reach Telegram) and sends the card. */
async function startLookup(
  userId: string,
  chatId: string,
  link: MessageLink,
  deps: WebhookDeps,
  now: number,
): Promise<void> {
  const recent = await deps.db.select<{ id: string }>("lookup_requests", {
    select: "id",
    user_id: `eq.${userId}`,
    created_at: `gte.${iso(now - 3600)}`,
    limit: String(MAX_LOOKUPS_PER_HOUR),
  });
  if (recent.length >= MAX_LOOKUPS_PER_HOUR) {
    await say(deps, chatId, LOOKUP_LIMIT_TEXT);
    return;
  }
  const row = await deps.db.insertOne<{ id: string }>("lookup_requests", {
    user_id: userId,
    username: link.username,
    message_id: link.messageId,
    status: "queued",
  });
  await enqueue(deps.db, LOOKUP_QUEUE, "lookup_requests", row.id, { lookup_id: row.id });
  await say(deps, chatId, LOOKUP_ACK_TEXT);
}

async function replyWelcome(chatId: string, deps: WebhookDeps): Promise<void> {
  if (!deps.bale || !deps.miniAppUrl) return;
  try {
    await deps.bale.sendMessage({
      chatId: Number(chatId),
      text: WELCOME_TEXT,
      replyMarkup: { inline_keyboard: [[{ text: OPEN_BUTTON_TEXT, web_app: { url: deps.miniAppUrl } }]] },
    });
  } catch (err) {
    // The button is a convenience. A failed reply must not make Bale retry the whole update.
    console.error("welcome reply failed", errorName(err));
  }
}

async function say(deps: WebhookDeps, chatId: string, text: string): Promise<void> {
  if (!deps.bale) return;
  try {
    await deps.bale.sendMessage({ chatId: Number(chatId), text });
  } catch (err) {
    console.error("bot reply failed", errorName(err));
  }
}

interface JobRow {
  id: string;
  status: string;
  created_at?: string | null;
}

const awaitingFilter = (jobId: string) => ({ id: `eq.${jobId}`, status: `eq.${AWAITING_STATE}` });

/**
 * A tap on Accept or Decline. Only the user who owns the job can answer it, and only while it is awaiting.
 * The status change is a compare-and-set, so a double tap queues the file once.
 */
async function handleCallback(query: Json, deps: WebhookDeps, now: number): Promise<void> {
  const bale = deps.bale;
  const callbackId = typeof query.id === "string" ? query.id : null;
  if (!bale || callbackId === null) return;

  const answer = async (text: string): Promise<void> => {
    try {
      await bale.answerCallbackQuery(callbackId, text);
    } catch (err) {
      console.error("callback answer failed", errorName(err));
    }
  };
  const finish = async (text: string): Promise<void> => {
    await answer(text);
    const message = asRecord(query.message);
    const chatId = asId(asRecord(message?.chat)?.id);
    const messageId = typeof message?.message_id === "number" ? message.message_id : null;
    if (chatId === null || messageId === null) return;
    try {
      await bale.clearButtons(Number(chatId), messageId);
    } catch (err) {
      console.error("clearing buttons failed", errorName(err));
    }
  };

  const decision = parseConfirmData(query.data);
  const baleUserId = asId(asRecord(query.from)?.id);
  if (!decision || baleUserId === null) return answer(CALLBACK_GONE_TEXT);

  const user = await deps.db.selectOne<{ id: string }>("users", { select: "id", bale_user_id: `eq.${baleUserId}` });
  const job = user
    ? await deps.db.selectOne<JobRow>("download_jobs", {
        select: "id,status,created_at",
        id: `eq.${decision.jobId}`,
        user_id: `eq.${user.id}`,
      })
    : null;
  if (!job || job.status !== AWAITING_STATE) return answer(CALLBACK_GONE_TEXT);

  if (!decision.accept) {
    const changed = await deps.db.update("download_jobs", awaitingFilter(job.id), { status: "declined" });
    return changed.length === 0 ? answer(CALLBACK_GONE_TEXT) : finish(CALLBACK_DECLINED_TEXT);
  }

  if (isAwaitingExpired(job, now)) {
    await deps.db.update("download_jobs", awaitingFilter(job.id), {
      status: "declined",
      error_code: "CONFIRM_EXPIRED",
    });
    return finish(CALLBACK_EXPIRED_TEXT);
  }

  const moved = await deps.db.update("download_jobs", awaitingFilter(job.id), { status: "queued" });
  if (moved.length === 0) return answer(CALLBACK_GONE_TEXT);
  await enqueue(deps.db, JOB_QUEUE, "download_jobs", job.id, { job_id: job.id });
  return finish(CALLBACK_ACCEPTED_TEXT);
}
