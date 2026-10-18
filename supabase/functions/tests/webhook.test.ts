import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Db } from "../_shared/rest.ts";
import { handleWebhook, privateChatFromUpdate } from "../_shared/webhook.ts";
import { FakeDb } from "./fake-db.ts";

const SECRET = "hook-secret-value";

function privateStart(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      text: "/start",
      ...overrides,
    },
  };
}

async function post(db: FakeDb, path: string, body: unknown, method = "POST"): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return handleWebhook(
    new Request(`https://functions.test/functions/v1/bale-webhook/${path}`, { method, body: payload }),
    { db: db as unknown as Pick<Db, "upsert">, secret: SECRET },
  );
}

describe("privateChatFromUpdate", () => {
  it("extracts the sender and private chat", () => {
    assert.deepEqual(privateChatFromUpdate(privateStart()), { baleUserId: "42", chatId: "42" });
  });

  it("accepts numeric-string ids", () => {
    const update = privateStart({ from: { id: "42" }, chat: { id: "42", type: "private" } });
    assert.deepEqual(privateChatFromUpdate(update), { baleUserId: "42", chatId: "42" });
  });

  it("ignores group chats, edits, and malformed updates", () => {
    assert.equal(privateChatFromUpdate(privateStart({ chat: { id: -100, type: "group" } })), null);
    assert.equal(privateChatFromUpdate({ edited_message: {} }), null);
    assert.equal(privateChatFromUpdate(privateStart({ from: undefined })), null);
    assert.equal(privateChatFromUpdate(privateStart({ from: { id: 1.5 } })), null);
  });
});

describe("handleWebhook", () => {
  it("stores the private chat id so files can be delivered", async () => {
    const db = new FakeDb();
    const res = await post(db, SECRET, privateStart());
    assert.equal(res.status, 200);
    assert.equal(db.upserts.length, 1);
    assert.equal(db.upserts[0].onConflict, "bale_user_id");
    assert.deepEqual(db.upserts[0].rows, [{ bale_user_id: "42", bale_chat_id: "42" }]);
  });

  it("acknowledges group updates without storing anything", async () => {
    const db = new FakeDb();
    const res = await post(db, SECRET, privateStart({ chat: { id: -100, type: "group" } }));
    assert.equal(res.status, 200);
    assert.equal(db.upserts.length, 0);
  });

  it("returns 404 for a wrong secret path and stores nothing", async () => {
    const db = new FakeDb();
    const res = await post(db, "guessed-secret", privateStart());
    assert.equal(res.status, 404);
    assert.equal(db.upserts.length, 0);
  });

  it("refuses non-POST methods", async () => {
    const res = await post(new FakeDb(), SECRET, undefined, "GET");
    assert.equal(res.status, 405);
  });

  it("rejects malformed JSON", async () => {
    const res = await post(new FakeDb(), SECRET, "{not json");
    assert.equal(res.status, 400);
  });
});
