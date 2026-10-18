import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { type ApiDeps, handleApi } from "../_shared/api.ts";
import type { ApiConfig } from "../_shared/config.ts";
import type { Db } from "../_shared/rest.ts";
import { signToken } from "../_shared/token.ts";
import { FakeDb, type Row } from "./fake-db.ts";

const NOW = 1_800_000_000;
const ORIGIN = "https://pages.example";
const CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const ISO_NOW = new Date(NOW * 1000).toISOString();

const config: ApiConfig = {
  botToken: "123456:TEST-BOT-TOKEN",
  tokenSecret: "t".repeat(40),
  allowedOrigins: [ORIGIN],
  initDataMaxAgeSeconds: 3600,
  tokenTtlSeconds: 3600,
  maxDownloadBytes: 50 * 1024 * 1024,
};

function message(id: number, extra: Row = {}): Row {
  return {
    channel_id: CHANNEL_ID,
    message_id: id,
    date: ISO_NOW,
    text: `post ${id}`,
    media_type: null,
    group_id: null,
    metadata: { available: false },
    ...extra,
  };
}

function seed(overrides: Record<string, Row[]> = {}): FakeDb {
  const messages = Array.from({ length: 10 }, (_, i) =>
    i + 1 === 10
      ? message(10, { media_type: "document", metadata: { available: true, size_bytes: 1000, file_name: "a.pdf" } })
      : message(i + 1),
  );
  return new FakeDb({
    users: [{ id: USER_ID, bale_user_id: "42", bale_chat_id: null }],
    channels: [{ id: CHANNEL_ID, telegram_peer_id: "100", username: "news_channel", title: "News" }],
    channel_sync: [
      { channel_id: CHANNEL_ID, oldest_message_id: 1, newest_message_id: 10, history_exhausted: false },
    ],
    messages,
    page_requests: [],
    download_jobs: [],
    ...overrides,
  });
}

function depsFor(db: FakeDb): ApiDeps {
  return { config, db: db as unknown as Db, now: () => NOW };
}

async function tokenFor(uid: string): Promise<string> {
  return signToken({ uid, exp: NOW + 600 }, config.tokenSecret);
}

async function call(
  deps: ApiDeps,
  method: string,
  path: string,
  options: { token?: string; body?: unknown; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: options.origin ?? ORIGIN };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  return handleApi(new Request(`https://functions.test/functions/v1/api${path}`, { method, headers, body }), deps);
}

function signedInitData(fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const check = [...Object.entries(fields)]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(config.botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

describe("routing and access", () => {
  it("answers the health check without authentication", async () => {
    const res = await call(depsFor(seed()), "GET", "/health");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("returns 404 for unknown routes", async () => {
    const res = await call(depsFor(seed()), "GET", "/nope");
    assert.equal(res.status, 404);
  });

  it("refuses data routes without an app token", async () => {
    const res = await call(depsFor(seed()), "GET", `/channels/${CHANNEL_ID}/messages`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "UNAUTHORIZED");
  });

  it("answers CORS preflight only for the allowed origin", async () => {
    const allowed = await call(depsFor(seed()), "OPTIONS", "/health", { origin: ORIGIN });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);

    const other = await call(depsFor(seed()), "OPTIONS", "/health", { origin: "https://evil.example" });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });
});

describe("POST /auth", () => {
  it("exchanges valid initData for an app token and stores only the Bale user id", async () => {
    const db = seed();
    const initData = signedInitData({
      auth_date: String(NOW - 10),
      user: JSON.stringify({ id: 42, first_name: "Test" }),
    });
    const res = await call(depsFor(db), "POST", "/auth", { body: { initData } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.token, "string");
    assert.equal(body.expiresAt, NOW + 3600);
    assert.equal(body.hasBaleChat, false);

    const [write] = db.upserts;
    assert.equal(write.table, "users");
    assert.equal(write.onConflict, "bale_user_id");
    assert.deepEqual(Object.keys(write.rows[0]).sort(), ["bale_user_id", "last_seen_at"]);
  });

  it("refuses initData with a bad signature", async () => {
    const initData = signedInitData({ auth_date: String(NOW - 10), user: JSON.stringify({ id: 42 }) }).replace(
      /hash=[0-9a-f]{64}$/,
      "hash=" + "0".repeat(64),
    );
    const res = await call(depsFor(seed()), "POST", "/auth", { body: { initData } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "INIT_DATA_INVALID");
  });
});

describe("GET /channels/:id/messages", () => {
  it("returns the newest page in chronological order with a cursor for older history", async () => {
    const res = await call(depsFor(seed()), "GET", `/channels/${CHANNEL_ID}/messages?limit=5`, {
      token: await tokenFor(USER_ID),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.items.map((item: { id: number }) => item.id),
      [6, 7, 8, 9, 10],
    );
    assert.equal(body.nextCursor, 6);
    assert.equal(body.hasMore, true);
    assert.equal(body.pendingRequestId, null);
  });

  it("treats before as an exclusive upper bound", async () => {
    const res = await call(depsFor(seed()), "GET", `/channels/${CHANNEL_ID}/messages?limit=3&before=8`, {
      token: await tokenFor(USER_ID),
    });
    const body = await res.json();
    assert.deepEqual(
      body.items.map((item: { id: number }) => item.id),
      [5, 6, 7],
    );
    assert.equal(body.nextCursor, 5);
  });

  it("queues an older fetch when the cache runs short and returns a pending request id", async () => {
    const db = seed({ messages: [message(1), message(2), message(3)] });
    const res = await call(depsFor(db), "GET", `/channels/${CHANNEL_ID}/messages?limit=5`, {
      token: await tokenFor(USER_ID),
    });
    const body = await res.json();
    assert.equal(typeof body.pendingRequestId, "string");

    const request = db.inserts.find((insert) => insert.table === "page_requests");
    assert.equal(request?.row.kind, "older");
    assert.equal(request?.row.before_message_id, 1);
    assert.deepEqual(db.rpcs[0], {
      name: "pgmq_send",
      args: { p_queue: "page_requests_q", p_msg: { request_id: body.pendingRequestId } },
    });
  });

  it("does not queue a fetch once history is exhausted", async () => {
    const db = seed({
      messages: [message(1), message(2), message(3)],
      channel_sync: [{ channel_id: CHANNEL_ID, oldest_message_id: 1, newest_message_id: 3, history_exhausted: true }],
    });
    const body = await (
      await call(depsFor(db), "GET", `/channels/${CHANNEL_ID}/messages?limit=5`, { token: await tokenFor(USER_ID) })
    ).json();
    assert.equal(body.hasMore, false);
    assert.equal(body.nextCursor, null);
    assert.equal(body.pendingRequestId, null);
    assert.equal(db.inserts.length, 0);
  });

  it("rejects a malformed channel id", async () => {
    const res = await call(depsFor(seed()), "GET", "/channels/not-a-uuid/messages", {
      token: await tokenFor(USER_ID),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "INVALID_ID");
  });
});

describe("POST /channels/open", () => {
  it("returns the channel at once when it is already cached", async () => {
    const res = await call(depsFor(seed()), "POST", "/channels/open", {
      token: await tokenFor(USER_ID),
      body: { username: "@News_Channel" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ready");
    assert.equal(body.channel.id, CHANNEL_ID);
  });

  it("queues an unknown channel once, even when the user asks twice", async () => {
    const db = seed();
    const deps = depsFor(db);
    const token = await tokenFor(USER_ID);
    const first = await (await call(deps, "POST", "/channels/open", { token, body: { username: "fresh_channel" } })).json();
    const second = await (await call(deps, "POST", "/channels/open", { token, body: { username: "fresh_channel" } })).json();
    assert.equal(first.status, "pending");
    assert.equal(second.requestId, first.requestId);
    assert.equal(db.inserts.filter((insert) => insert.table === "page_requests").length, 1);
  });

  it("rejects invalid usernames", async () => {
    const res = await call(depsFor(seed()), "POST", "/channels/open", {
      token: await tokenFor(USER_ID),
      body: { username: "not valid!" },
    });
    assert.equal(res.status, 400);
  });

  it("limits how many new channel requests one user can make per hour", async () => {
    const recent = Array.from({ length: 60 }, (_, i) => ({
      id: `old-${i}`,
      user_id: USER_ID,
      kind: "open",
      username: `old_${i}`,
      status: "succeeded",
      created_at: new Date((NOW - 60) * 1000).toISOString(),
    }));
    const res = await call(depsFor(seed({ page_requests: recent })), "POST", "/channels/open", {
      token: await tokenFor(USER_ID),
      body: { username: "one_more_channel" },
    });
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.code, "RATE_LIMITED");
  });
});

describe("GET /requests/:id", () => {
  it("does not reveal requests owned by another user", async () => {
    const db = seed({
      page_requests: [
        { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", user_id: OTHER_USER_ID, kind: "open", status: "queued" },
      ],
    });
    const res = await call(depsFor(db), "GET", "/requests/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
      token: await tokenFor(USER_ID),
    });
    assert.equal(res.status, 404);
  });
});

describe("POST /downloads", () => {
  const body = { channelId: CHANNEL_ID, messageId: 10 };

  it("refuses delivery until the user has started the Bale bot", async () => {
    const res = await call(depsFor(seed()), "POST", "/downloads", { token: await tokenFor(USER_ID), body });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, "BALE_CHAT_REQUIRED");
  });

  it("queues a job and hands its id to the worker queue", async () => {
    const db = seed({ users: [{ id: USER_ID, bale_user_id: "42", bale_chat_id: "42" }] });
    const res = await call(depsFor(db), "POST", "/downloads", { token: await tokenFor(USER_ID), body });
    assert.equal(res.status, 202);
    const created = await res.json();
    assert.equal(created.status, "queued");
    assert.equal(created.reused, false);

    const job = db.inserts.find((insert) => insert.table === "download_jobs");
    assert.equal(job?.row.message_id, 10);
    assert.equal(job?.row.status, "queued");
    assert.deepEqual(db.rpcs[0], {
      name: "pgmq_send",
      args: { p_queue: "download_jobs_q", p_msg: { job_id: created.jobId } },
    });
  });

  it("returns the existing job when the same file is requested again", async () => {
    const db = seed({ users: [{ id: USER_ID, bale_user_id: "42", bale_chat_id: "42" }] });
    const deps = depsFor(db);
    const token = await tokenFor(USER_ID);
    const first = await (await call(deps, "POST", "/downloads", { token, body })).json();
    const second = await call(deps, "POST", "/downloads", { token, body });
    assert.equal(second.status, 202);
    const reused = await second.json();
    assert.equal(reused.jobId, first.jobId);
    assert.equal(reused.reused, true);
    assert.equal(db.inserts.filter((insert) => insert.table === "download_jobs").length, 1);
  });

  it("refuses text-only messages", async () => {
    const db = seed({ users: [{ id: USER_ID, bale_user_id: "42", bale_chat_id: "42" }] });
    const res = await call(depsFor(db), "POST", "/downloads", {
      token: await tokenFor(USER_ID),
      body: { channelId: CHANNEL_ID, messageId: 9 },
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "MEDIA_UNAVAILABLE");
  });

  it("rejects non-integer message ids", async () => {
    const res = await call(depsFor(seed()), "POST", "/downloads", {
      token: await tokenFor(USER_ID),
      body: { channelId: CHANNEL_ID, messageId: "10" },
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "INVALID_MESSAGE_ID");
  });
});
