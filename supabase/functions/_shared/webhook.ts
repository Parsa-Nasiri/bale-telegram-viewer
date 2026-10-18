// Bale webhook. Bale posts updates here. The only thing stored is the private chat id, which is what
// file delivery needs: a user can receive files only after writing to the bot once.
// Bale does not sign requests here, so access is gated by a secret path segment compared in constant time.

import { timingSafeEqualString } from "./crypto.ts";
import { errorResponse, HttpError, jsonResponse, readJson } from "./http.ts";
import { segmentsAfter } from "./logic.ts";
import type { Db } from "./rest.ts";

export interface WebhookDeps {
  db: Pick<Db, "upsert">;
  secret: string;
}

export interface PrivateChat {
  baleUserId: string;
  chatId: string;
}

function asId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?\d{1,20}$/.test(value)) return value;
  return null;
}

/** Extracts the sender and private chat from an update. Returns null for anything else (groups, edits, other events). */
export function privateChatFromUpdate(update: Record<string, unknown>): PrivateChat | null {
  const message = update.message;
  if (typeof message !== "object" || message === null) return null;
  const { chat, from } = message as { chat?: unknown; from?: unknown };
  if (typeof chat !== "object" || chat === null || typeof from !== "object" || from === null) return null;
  if ((chat as { type?: unknown }).type !== "private") return null;
  const chatId = asId((chat as { id?: unknown }).id);
  const baleUserId = asId((from as { id?: unknown }).id);
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
    const chat = privateChatFromUpdate(update);
    if (chat) {
      await deps.db.upsert(
        "users",
        [{ bale_user_id: chat.baleUserId, bale_chat_id: chat.chatId }],
        "bale_user_id",
      );
    }
    return jsonResponse({ ok: true }, 200);
  } catch (err) {
    return errorResponse(err, {});
  }
}
