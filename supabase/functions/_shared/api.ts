// HTTP routes for the Mini App. Routes validate input and check the caller's app token.
// They read the cache, or queue work for the worker. A download is confirmed in the bot chat before it is queued.

import { type BaleApi, sendCard } from "./bale.ts";
import type { ApiConfig } from "./config.ts";
import { type CardInput, buildCaption, cardInputFrom, confirmKeyboard, DOWNLOAD_QUESTION } from "./card.ts";
import { corsHeaders, errorResponse, HttpError, jsonResponse, readJson } from "./http.ts";
import { verifyInitData } from "./initdata.ts";
import {
  buildPageMeta,
  type CachedMessage,
  clampLimit,
  downloadBlocker,
  isLiveJob,
  isUuid,
  LIVE_JOB_STATES,
  MAX_PAGE_REQUESTS_PER_HOUR,
  normalizeUsername,
  parseCursor,
  segmentsAfter,
  validThumb,
} from "./logic.ts";
import { enqueue, PAGE_QUEUE } from "./queue.ts";
import type { Db } from "./rest.ts";
import { signToken, verifyToken } from "./token.ts";

export interface ApiDeps {
  config: ApiConfig;
  db: Db;
  bale: BaleApi;
  now: () => number; // unix seconds
}

const CHANNEL_COLUMNS = "id,username,title";
const MESSAGE_COLUMNS = "message_id,date,text,media_type,group_id,metadata";
const MESSAGE_CARD_COLUMNS = "message_id,date,text,media_type,metadata";
const JOB_COLUMNS = "id,status,attempts,error_code,channel_id,message_id,updated_at,created_at";
const PENDING_REQUEST_STATES = ["queued", "processing"];
const MAX_INIT_DATA_LENGTH = 4096;
// Enough to see every live job of one user (the limit is 5), with room for stale awaiting ones.
const LIVE_JOB_QUERY_LIMIT = 50;

interface UserRow {
  id: string;
  bale_chat_id: string | null;
}

interface ChannelRow {
  id: string;
  username: string | null;
  title: string | null;
}

interface MessageMetadata {
  sender_name?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  available?: boolean;
  thumb?: unknown;
}

interface MessageRow {
  message_id: number;
  date: string;
  text: string | null;
  media_type: string | null;
  group_id: string | null;
  metadata: MessageMetadata | null;
}

interface SyncRow {
  oldest_message_id: number | null;
  history_exhausted: boolean;
}

interface RequestRow {
  id: string;
  status: string;
  error_code: string | null;
  channel_id: string | null;
}

interface JobRow {
  id: string;
  status: string;
  attempts: number;
  error_code: string | null;
  channel_id: string;
  message_id: number;
  updated_at: string;
  created_at?: string | null;
}

type Cors = Record<string, string>;

export async function handleApi(req: Request, deps: ApiDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get("origin"), deps.config.allowedOrigins);
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    return await route(req, url, segmentsAfter(url.pathname), deps, cors);
  } catch (err) {
    return errorResponse(err, cors);
  }
}

async function route(req: Request, url: URL, path: string[], deps: ApiDeps, cors: Cors): Promise<Response> {
  const method = req.method;
  const joined = path.join("/");
  const [head, id, sub] = path;

  if (method === "GET" && joined === "health") return jsonResponse({ ok: true }, 200, cors);
  if (method === "POST" && joined === "auth") return authenticate(req, deps, cors);
  if (method === "POST" && joined === "channels/open") return openChannel(req, deps, cors);
  if (method === "POST" && joined === "downloads") return createDownload(req, deps, cors);
  if (method === "GET" && head === "requests" && path.length === 2) return getRequest(req, id, deps, cors);
  if (method === "GET" && head === "downloads" && path.length === 2) return getDownload(req, id, deps, cors);
  if (method === "GET" && head === "channels" && path.length === 3 && sub === "messages") {
    return listMessages(req, url, id, deps, cors);
  }
  throw new HttpError(404, "NOT_FOUND");
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

async function requireUser(req: Request, deps: ApiDeps): Promise<string> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.headers.get("authorization") ?? "");
  if (!match) throw new HttpError(401, "UNAUTHORIZED");
  const claims = await verifyToken(match[1], deps.config.tokenSecret, deps.now());
  return claims.uid;
}

/** Exchanges signed Mini App initData for a short-lived app token. Stores only the Bale user id. */
async function authenticate(req: Request, deps: ApiDeps, cors: Cors): Promise<Response> {
  const body = await readJson(req);
  const initData = body.initData;
  if (typeof initData !== "string" || initData.length === 0 || initData.length > MAX_INIT_DATA_LENGTH) {
    throw new HttpError(400, "INIT_DATA_REQUIRED");
  }
  const now = deps.now();
  const verified = await verifyInitData(initData, deps.config.botToken, now, deps.config.initDataMaxAgeSeconds);
  const rows = await deps.db.upsert<UserRow>(
    "users",
    [{ bale_user_id: String(verified.user.id), last_seen_at: iso(now) }],
    "bale_user_id",
  );
  const user = rows[0];
  if (!user) throw new HttpError(502, "DATABASE_ERROR", "user upsert returned no row");

  const expiresAt = now + deps.config.tokenTtlSeconds;
  const token = await signToken({ uid: user.id, exp: expiresAt }, deps.config.tokenSecret);
  return jsonResponse({ token, expiresAt, hasBaleChat: user.bale_chat_id !== null }, 200, cors);
}

async function openChannel(req: Request, deps: ApiDeps, cors: Cors): Promise<Response> {
  const uid = await requireUser(req, deps);
  const body = await readJson(req);
  const username = normalizeUsername(body.username);
  if (!username) throw new HttpError(400, "INVALID_USERNAME");

  const channel = await deps.db.selectOne<ChannelRow>("channels", {
    select: CHANNEL_COLUMNS,
    username: `eq.${username}`,
  });
  if (channel) return jsonResponse({ status: "ready", channel: toChannel(channel) }, 200, cors);

  const requestId = await submitPageRequest(deps, uid, { kind: "open", username });
  return jsonResponse({ status: "pending", requestId }, 202, cors);
}

async function getRequest(req: Request, id: string | undefined, deps: ApiDeps, cors: Cors): Promise<Response> {
  const uid = await requireUser(req, deps);
  if (!isUuid(id)) throw new HttpError(400, "INVALID_ID");
  const row = await deps.db.selectOne<RequestRow>("page_requests", {
    select: "id,status,error_code,channel_id",
    id: `eq.${id}`,
    user_id: `eq.${uid}`,
  });
  if (!row) throw new HttpError(404, "REQUEST_NOT_FOUND");
  return jsonResponse(
    { id: row.id, status: row.status, errorCode: row.error_code, channelId: row.channel_id },
    200,
    cors,
  );
}

async function listMessages(
  req: Request,
  url: URL,
  channelId: string | undefined,
  deps: ApiDeps,
  cors: Cors,
): Promise<Response> {
  const uid = await requireUser(req, deps);
  if (!isUuid(channelId)) throw new HttpError(400, "INVALID_ID");

  const channel = await deps.db.selectOne<ChannelRow>("channels", {
    select: CHANNEL_COLUMNS,
    id: `eq.${channelId}`,
  });
  if (!channel) throw new HttpError(404, "CHANNEL_NOT_FOUND");

  const limit = clampLimit(url.searchParams.get("limit"));
  const before = parseCursor(url.searchParams.get("before"));
  const sync = await deps.db.selectOne<SyncRow>("channel_sync", {
    select: "oldest_message_id,history_exhausted",
    channel_id: `eq.${channelId}`,
  });

  // The cache is read newest first, so `before` is an exclusive upper bound and the page is contiguous.
  const query: Record<string, string> = {
    select: MESSAGE_COLUMNS,
    channel_id: `eq.${channelId}`,
    order: "message_id.desc",
    limit: String(limit),
  };
  if (before !== null) query.message_id = `lt.${before}`;
  const rows = await deps.db.select<MessageRow>("messages", query);

  const meta = buildPageMeta(
    rows.map((row) => row.message_id),
    limit,
    sync?.history_exhausted ?? false,
    before ?? sync?.oldest_message_id ?? null,
  );

  let pendingRequestId: string | null = null;
  if (meta.needsOlderFetch && meta.cursorForFetch !== null) {
    pendingRequestId = await submitPageRequest(deps, uid, {
      kind: "older",
      channelId,
      beforeMessageId: meta.cursorForFetch,
    });
  }

  return jsonResponse(
    {
      channel: toChannel(channel),
      // Chronological order for display: oldest at the top, newest at the bottom.
      items: rows.slice().reverse().map(toMessage),
      nextCursor: meta.nextCursor,
      hasMore: meta.hasMore,
      pendingRequestId,
    },
    200,
    cors,
  );
}

/**
 * Starts a download. The job waits in `awaiting_confirmation` and the bot sends the user a card with Accept and
 * Decline. Nothing is queued for the worker until the user taps Accept (see webhook.ts).
 */
async function createDownload(req: Request, deps: ApiDeps, cors: Cors): Promise<Response> {
  const uid = await requireUser(req, deps);
  const body = await readJson(req);
  const channelId = body.channelId;
  const messageId = body.messageId;
  if (typeof channelId !== "string" || !isUuid(channelId)) throw new HttpError(400, "INVALID_ID");
  if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new HttpError(400, "INVALID_MESSAGE_ID");
  }

  const now = deps.now();
  const user = await deps.db.selectOne<UserRow>("users", { select: "id,bale_chat_id", id: `eq.${uid}` });
  if (!user) throw new HttpError(401, "UNAUTHORIZED");

  const live = (
    await deps.db.select<JobRow>("download_jobs", {
      select: JOB_COLUMNS,
      user_id: `eq.${uid}`,
      status: `in.(${LIVE_JOB_STATES.join(",")})`,
      limit: String(LIVE_JOB_QUERY_LIMIT),
    })
  ).filter((job) => isLiveJob(job, now));

  // The same file requested twice returns the existing job instead of a second card.
  const same = live.find((job) => job.channel_id === channelId && job.message_id === messageId);
  if (same) return jsonResponse({ jobId: same.id, status: same.status, reused: true }, 202, cors);

  const message = await deps.db.selectOne<CachedMessage>("messages", {
    select: MESSAGE_CARD_COLUMNS,
    channel_id: `eq.${channelId}`,
    message_id: `eq.${messageId}`,
  });
  const blocker = downloadBlocker({
    hasBaleChat: user.bale_chat_id !== null,
    message,
    activeJobs: live.length,
    maxBytes: deps.config.maxDownloadBytes,
  });
  if (blocker) throw new HttpError(blocker.status, blocker.code);
  if (!message || user.bale_chat_id === null) throw new HttpError(500, "INTERNAL_ERROR");

  const channel = await deps.db.selectOne<ChannelRow>("channels", { select: CHANNEL_COLUMNS, id: `eq.${channelId}` });
  if (!channel) throw new HttpError(404, "CHANNEL_NOT_FOUND");

  const job = await deps.db.insertOne<JobRow>("download_jobs", {
    user_id: uid,
    channel_id: channelId,
    message_id: messageId,
    status: "awaiting_confirmation",
  });

  const card: CardInput = cardInputFrom(channel, message);
  let confirmMessageId: number | null;
  try {
    confirmMessageId = await sendCard(deps.bale, {
      chatId: Number(user.bale_chat_id),
      caption: buildCaption(card, DOWNLOAD_QUESTION),
      replyMarkup: confirmKeyboard(job.id),
      thumb: validThumb(message.metadata?.thumb),
    });
  } catch {
    await deps.db.update(
      "download_jobs",
      { id: `eq.${job.id}` },
      { status: "failed", error_code: "CONFIRM_SEND_FAILED" },
    );
    throw new HttpError(502, "BALE_SEND_FAILED", "could not send the confirmation to the bot chat");
  }
  if (confirmMessageId !== null) {
    await deps.db.update("download_jobs", { id: `eq.${job.id}` }, { confirm_message_id: String(confirmMessageId) });
  }
  return jsonResponse({ jobId: job.id, status: "awaiting_confirmation", reused: false }, 202, cors);
}

async function getDownload(req: Request, id: string | undefined, deps: ApiDeps, cors: Cors): Promise<Response> {
  const uid = await requireUser(req, deps);
  if (!isUuid(id)) throw new HttpError(400, "INVALID_ID");
  const row = await deps.db.selectOne<JobRow>("download_jobs", {
    select: JOB_COLUMNS,
    id: `eq.${id}`,
    user_id: `eq.${uid}`,
  });
  if (!row) throw new HttpError(404, "DOWNLOAD_NOT_FOUND");
  return jsonResponse(
    {
      id: row.id,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.error_code,
      updatedAt: row.updated_at,
    },
    200,
    cors,
  );
}

type PageRequest = { kind: "open"; username: string } | { kind: "older"; channelId: string; beforeMessageId: number };

/**
 * Creates a page request and queues its id. Duplicate pending requests from the same user are reused,
 * and the hourly limit applies only to new requests.
 */
async function submitPageRequest(deps: ApiDeps, uid: string, request: PageRequest): Promise<string> {
  const dedupe: Record<string, string> = {
    select: "id,status",
    user_id: `eq.${uid}`,
    kind: `eq.${request.kind}`,
    status: `in.(${PENDING_REQUEST_STATES.join(",")})`,
    order: "created_at.desc",
    limit: "1",
  };
  if (request.kind === "open") {
    dedupe.username = `eq.${request.username}`;
  } else {
    dedupe.channel_id = `eq.${request.channelId}`;
    dedupe.before_message_id = `eq.${request.beforeMessageId}`;
  }
  const existing = await deps.db.selectOne<RequestRow>("page_requests", dedupe);
  if (existing) return existing.id;

  const recent = await deps.db.select<{ id: string }>("page_requests", {
    select: "id",
    user_id: `eq.${uid}`,
    created_at: `gte.${iso(deps.now() - 3600)}`,
    limit: String(MAX_PAGE_REQUESTS_PER_HOUR),
  });
  if (recent.length >= MAX_PAGE_REQUESTS_PER_HOUR) {
    throw new HttpError(429, "RATE_LIMITED", "too many channel requests; try again later");
  }

  const row =
    request.kind === "open"
      ? { user_id: uid, kind: "open", username: request.username, status: "queued" }
      : {
          user_id: uid,
          kind: "older",
          channel_id: request.channelId,
          before_message_id: request.beforeMessageId,
          status: "queued",
        };
  const created = await deps.db.insertOne<RequestRow>("page_requests", row);
  await enqueue(deps.db, PAGE_QUEUE, "page_requests", created.id, { request_id: created.id });
  return created.id;
}

function toChannel(row: ChannelRow) {
  return { id: row.id, username: row.username, title: row.title };
}

function toMessage(row: MessageRow) {
  const meta = row.metadata ?? {};
  return {
    id: row.message_id,
    date: row.date,
    text: row.text,
    mediaType: row.media_type,
    groupId: row.group_id,
    senderName: meta.sender_name ?? null,
    fileName: meta.file_name ?? null,
    mimeType: meta.mime_type ?? null,
    sizeBytes: meta.size_bytes ?? null,
    thumb: validThumb(meta.thumb),
    downloadable: meta.available === true && row.media_type !== null,
  };
}
