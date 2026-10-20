import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CALLBACK_ACCEPTED_TEXT,
  CALLBACK_DECLINED_TEXT,
  CALLBACK_EXPIRED_TEXT,
  CALLBACK_GONE_TEXT,
  LOOKUP_ACK_TEXT,
  LOOKUP_LIMIT_TEXT,
  OPEN_BUTTON_TEXT,
  WELCOME_TEXT,
  handleWebhook,
  privateChatFromUpdate,
  type WebhookDeps,
} from "../_shared/webhook.ts";
import type { Db } from "../_shared/rest.ts";
import { FAKE_CLOCK_ISO, FakeDb, type Row } from "./fake-db.ts";
import { FakeBale } from "./fake-bale.ts";

const SECRET = "hook-secret-value";
const MINI_APP_URL = "https://owner.github.io/bale-telegram-viewer/";
const NOW = 1_800_000_000;
const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const at = (seconds: number): string => new Date(seconds * 1000).toISOString();

function privateMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

function callback(data: string, from = 42): Record<string, unknown> {
  return {
    callback_query: {
      id: "cb-1",
      from: { id: from },
      data,
      message: { message_id: 500, chat: { id: 42, type: "private" } },
    },
  };
}

function userRow(): Row {
  return { id: USER_ID, bale_user_id: "42", bale_chat_id: "42" };
}

async function post(
  db: FakeDb,
  path: string,
  body: unknown,
  method = "POST",
  extra: Partial<Omit<WebhookDeps, "db" | "secret">> = {},
): Promise<Response> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return handleWebhook(
    new Request(`https://functions.test/functions/v1/bale-webhook/${path}`, { method, body: payload }),
    { db: db as unknown as Db, secret: SECRET, now: () => NOW, ...extra },
  );
}

describe("privateChatFromUpdate", () => {
  it("extracts the sender and private chat", () => {
    assert.deepEqual(privateChatFromUpdate(privateMessage()), { baleUserId: "42", chatId: "42" });
  });

  it("accepts numeric-string ids", () => {
    const update = privateMessage({ from: { id: "42" }, chat: { id: "42", type: "private" } });
    assert.deepEqual(privateChatFromUpdate(update), { baleUserId: "42", chatId: "42" });
  });

  it("ignores group chats, edits, and malformed updates", () => {
    assert.equal(privateChatFromUpdate(privateMessage({ chat: { id: -100, type: "group" } })), null);
    assert.equal(privateChatFromUpdate({ edited_message: {} }), null);
    assert.equal(privateChatFromUpdate(privateMessage({ from: undefined })), null);
    assert.equal(privateChatFromUpdate(privateMessage({ from: { id: 1.5 } })), null);
  });
});

describe("storing chats and the request shape", () => {
  it("stores the private chat id so files can be delivered", async () => {
    const db = new FakeDb();
    const res = await post(db, SECRET, privateMessage());
    assert.equal(res.status, 200);
    assert.equal(db.upserts.length, 1);
    assert.equal(db.upserts[0].onConflict, "bale_user_id");
    assert.deepEqual(db.upserts[0].rows, [{ bale_user_id: "42", bale_chat_id: "42" }]);
  });

  it("acknowledges group updates without storing anything", async () => {
    const db = new FakeDb();
    const res = await post(db, SECRET, privateMessage({ chat: { id: -100, type: "group" } }));
    assert.equal(res.status, 200);
    assert.equal(db.upserts.length, 0);
  });

  it("returns 404 for a wrong secret path and stores nothing", async () => {
    const db = new FakeDb();
    const res = await post(db, "guessed-secret", privateMessage());
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

describe("welcome button", () => {
  it("replies to a private chat with a button that opens the Mini App", async () => {
    const bale = new FakeBale();
    const res = await post(new FakeDb(), SECRET, privateMessage(), "POST", { bale, miniAppUrl: MINI_APP_URL });
    assert.equal(res.status, 200);
    assert.equal(bale.sent.length, 1);
    assert.equal(bale.sent[0].chatId, 42);
    assert.equal(bale.sent[0].text, WELCOME_TEXT);
    assert.deepEqual(bale.sent[0].replyMarkup, {
      inline_keyboard: [[{ text: OPEN_BUTTON_TEXT, web_app: { url: MINI_APP_URL } }]],
    });
  });

  it("sends nothing when the Mini App address is not set", async () => {
    const bale = new FakeBale();
    const res = await post(new FakeDb(), SECRET, privateMessage(), "POST", { bale });
    assert.equal(res.status, 200);
    assert.equal(bale.sent.length, 0);
  });

  it("does not reply in group chats", async () => {
    const bale = new FakeBale();
    await post(new FakeDb(), SECRET, privateMessage({ chat: { id: -100, type: "group" } }), "POST", {
      bale,
      miniAppUrl: MINI_APP_URL,
    });
    assert.equal(bale.sent.length, 0);
  });

  it("still answers 200 and keeps the stored chat when the reply fails", async () => {
    const db = new FakeDb();
    const bale = new FakeBale();
    bale.failMessage = true;
    const res = await post(db, SECRET, privateMessage(), "POST", { bale, miniAppUrl: MINI_APP_URL });
    assert.equal(res.status, 200);
    assert.equal(db.upserts.length, 1);
  });
});

describe("Telegram message links in the bot chat", () => {
  it("queues a lookup for a link and acknowledges it, without the welcome button", async () => {
    const db = new FakeDb({ users: [userRow()] });
    const bale = new FakeBale();
    const res = await post(db, SECRET, privateMessage({ text: "https://t.me/News_Channel/10" }), "POST", {
      bale,
      miniAppUrl: MINI_APP_URL,
    });
    assert.equal(res.status, 200);

    const lookup = db.inserts.find((insert) => insert.table === "lookup_requests");
    assert.equal(lookup?.row.user_id, USER_ID);
    assert.equal(lookup?.row.username, "news_channel");
    assert.equal(lookup?.row.message_id, 10);
    assert.deepEqual(db.rpcs[0], {
      name: "pgmq_send",
      args: { p_queue: "lookup_requests_q", p_msg: { lookup_id: lookup?.row.id } },
    });
    assert.equal(bale.sent.length, 1);
    assert.equal(bale.sent[0].text, LOOKUP_ACK_TEXT);
    assert.equal(bale.sent[0].replyMarkup, undefined);
  });

  it("accepts an identifier such as @name/10", async () => {
    const db = new FakeDb({ users: [userRow()] });
    await post(db, SECRET, privateMessage({ text: "@news_channel/10" }), "POST", { bale: new FakeBale() });
    const lookup = db.inserts.find((insert) => insert.table === "lookup_requests");
    assert.equal(lookup?.row.username, "news_channel");
  });

  it("answers other text with the welcome button", async () => {
    const db = new FakeDb({ users: [userRow()] });
    const bale = new FakeBale();
    await post(db, SECRET, privateMessage({ text: "hello there" }), "POST", { bale, miniAppUrl: MINI_APP_URL });
    assert.equal(db.inserts.length, 0);
    assert.equal(bale.sent[0].text, WELCOME_TEXT);
  });

  it("limits how many lookups one user can make per hour", async () => {
    const recent = Array.from({ length: 30 }, (_, i) => ({
      id: `old-${i}`,
      user_id: USER_ID,
      created_at: FAKE_CLOCK_ISO,
    }));
    const db = new FakeDb({ users: [userRow()], lookup_requests: recent });
    const bale = new FakeBale();
    await post(db, SECRET, privateMessage({ text: "https://t.me/news_channel/10" }), "POST", { bale });
    assert.equal(db.inserts.length, 0);
    assert.equal(db.rpcs.length, 0);
    assert.equal(bale.sent[0].text, LOOKUP_LIMIT_TEXT);
  });
});

describe("Accept and Decline under a download card", () => {
  function jobDb(overrides: Row = {}, extraUsers: Row[] = []): FakeDb {
    return new FakeDb({
      users: [userRow(), ...extraUsers],
      download_jobs: [
        {
          id: JOB_ID,
          user_id: USER_ID,
          channel_id: CHANNEL_ID,
          message_id: 10,
          status: "awaiting_confirmation",
          created_at: FAKE_CLOCK_ISO,
          ...overrides,
        },
      ],
    });
  }

  it("Accept queues the download once, and a second tap changes nothing", async () => {
    const db = jobDb();
    const bale = new FakeBale();
    const deps = { bale };
    await post(db, SECRET, callback(`dl:y:${JOB_ID}`), "POST", deps);
    assert.equal(db.tables.download_jobs[0].status, "queued");
    assert.deepEqual(db.rpcs[0], {
      name: "pgmq_send",
      args: { p_queue: "download_jobs_q", p_msg: { job_id: JOB_ID } },
    });
    assert.equal(bale.answers[0].text, CALLBACK_ACCEPTED_TEXT);
    assert.equal(bale.cleared.length, 1);

    await post(db, SECRET, callback(`dl:y:${JOB_ID}`), "POST", deps);
    assert.equal(db.rpcs.length, 1, "the file is queued once");
    assert.equal(bale.answers[1].text, CALLBACK_GONE_TEXT);
  });

  it("Decline marks the job declined and queues nothing", async () => {
    const db = jobDb();
    const bale = new FakeBale();
    await post(db, SECRET, callback(`dl:n:${JOB_ID}`), "POST", { bale });
    assert.equal(db.tables.download_jobs[0].status, "declined");
    assert.equal(db.rpcs.length, 0);
    assert.equal(bale.answers[0].text, CALLBACK_DECLINED_TEXT);
  });

  it("refuses a tap from someone who does not own the job", async () => {
    const db = jobDb({ user_id: USER_ID }, [{ id: OTHER_USER_ID, bale_user_id: "77", bale_chat_id: "77" }]);
    const bale = new FakeBale();
    await post(db, SECRET, callback(`dl:y:${JOB_ID}`, 77), "POST", { bale });
    assert.equal(db.tables.download_jobs[0].status, "awaiting_confirmation");
    assert.equal(db.rpcs.length, 0);
    assert.equal(bale.answers[0].text, CALLBACK_GONE_TEXT);
  });

  it("an expired card cannot be accepted", async () => {
    const db = jobDb({ created_at: at(NOW - 3600) });
    const bale = new FakeBale();
    await post(db, SECRET, callback(`dl:y:${JOB_ID}`), "POST", { bale });
    assert.equal(db.tables.download_jobs[0].status, "declined");
    assert.equal(db.tables.download_jobs[0].error_code, "CONFIRM_EXPIRED");
    assert.equal(db.rpcs.length, 0);
    assert.equal(bale.answers[0].text, CALLBACK_EXPIRED_TEXT);
  });

  it("malformed callback data is refused without changes", async () => {
    const db = jobDb();
    const bale = new FakeBale();
    await post(db, SECRET, callback("dl:x:not-a-job"), "POST", { bale });
    assert.equal(db.tables.download_jobs[0].status, "awaiting_confirmation");
    assert.equal(bale.answers[0].text, CALLBACK_GONE_TEXT);
  });
});
