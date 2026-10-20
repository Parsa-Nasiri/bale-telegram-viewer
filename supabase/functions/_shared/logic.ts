// Pure rules for the API and the bot: routing, input validation, pagination, download eligibility, message links
// and confirmation timing. No I/O, so these are covered by unit tests.

import { HttpError } from "./http.ts";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 50;
export const MAX_ACTIVE_JOBS = 5;
export const MAX_PAGE_REQUESTS_PER_HOUR = 60;
export const MAX_LOOKUPS_PER_HOUR = 30;
/** A download card the user has not answered expires after this many seconds. */
export const CONFIRM_TTL_SECONDS = 30 * 60;
/** Thumbnails are stored as data URLs in message metadata. Larger ones are not used (about 30 KB of image). */
export const MAX_THUMB_CHARS = 40_000;

export const AWAITING_STATE = "awaiting_confirmation";
export const ACTIVE_JOB_STATES = ["queued", "processing", "downloading", "uploading"];
/** Every state that holds one of a user's download slots. */
export const LIVE_JOB_STATES = [AWAITING_STATE, ...ACTIVE_JOB_STATES];

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{4,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// https://t.me/name/123, https://t.me/s/name/123, or an identifier such as @name/123 or name/123.
const LINK_PATTERN = /^(?:https?:\/\/)?t\.me\/(?:s\/)?([a-z][a-z0-9_]{4,31})\/(\d{1,12})\/?(?:\?\S*)?$/i;
const IDENTIFIER_PATTERN = /^@?([a-z][a-z0-9_]{4,31})\/(\d{1,12})$/i;
// Callback data of the Accept and Decline buttons: "dl:y:<job id>" or "dl:n:<job id>" (41 bytes, under Bale's 64).
const CONFIRM_PATTERN = /^dl:([yn]):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Returns the path segments after the first `api` (or `marker`) segment. */
export function segmentsAfter(pathname: string, marker = "api"): string[] {
  const parts = pathname.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf(marker);
  return index === -1 ? parts : parts.slice(index + 1);
}

/** Accepts "@name", "name", or "https://t.me/name". Returns the lowercase name or null. */
export function normalizeUsername(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const value = input
    .trim()
    .replace(/^https?:\/\/t\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return USERNAME_PATTERN.test(value) ? value : null;
}

export function isUuid(value: string | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function clampLimit(raw: string | null, fallback = DEFAULT_PAGE_LIMIT, max = MAX_PAGE_LIMIT): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function parseCursor(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new HttpError(400, "INVALID_CURSOR");
  return value;
}

export interface PageMeta {
  nextCursor: number | null;
  hasMore: boolean;
  needsOlderFetch: boolean;
  cursorForFetch: number | null;
}

/**
 * `itemIds` are newest first. `fallbackCursor` is the `before` the client sent, or the channel's
 * oldest known id on the first page; it is used only when the page is empty.
 * A short page with history not exhausted means the cache may lack older posts, so an older fetch
 * is needed from the cursor.
 */
export function buildPageMeta(
  itemIds: number[],
  limit: number,
  historyExhausted: boolean,
  fallbackCursor: number | null,
): PageMeta {
  const cursor = itemIds.length > 0 ? itemIds[itemIds.length - 1] : fallbackCursor;
  const hasMore = !historyExhausted && cursor !== null;
  return {
    nextCursor: hasMore ? cursor : null,
    hasMore,
    needsOlderFetch: hasMore && itemIds.length < limit,
    cursorForFetch: hasMore ? cursor : null,
  };
}

export interface CachedMetadata {
  sender_name?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  available?: boolean;
  thumb?: unknown;
}

export interface CachedMessage {
  message_id: number;
  date?: string | null;
  text?: string | null;
  media_type: string | null;
  metadata: CachedMetadata | null;
}

export interface DownloadCheck {
  hasBaleChat: boolean;
  message: CachedMessage | null;
  activeJobs: number;
  maxBytes: number;
}

/** Returns the first reason a download must be refused, or null when it may proceed. */
export function downloadBlocker(check: DownloadCheck): { status: number; code: string } | null {
  if (!check.hasBaleChat) return { status: 409, code: "BALE_CHAT_REQUIRED" };
  if (!check.message) return { status: 404, code: "MESSAGE_NOT_FOUND" };
  if (!check.message.metadata?.available || !check.message.media_type) {
    return { status: 422, code: "MEDIA_UNAVAILABLE" };
  }
  const size = check.message.metadata.size_bytes;
  if (typeof size === "number" && size > check.maxBytes) return { status: 413, code: "FILE_TOO_LARGE" };
  if (check.activeJobs >= MAX_ACTIVE_JOBS) return { status: 429, code: "TOO_MANY_ACTIVE_JOBS" };
  return null;
}

export interface MessageLink {
  username: string;
  messageId: number;
}

/** Accepts a Telegram message link or an identifier. Returns the lowercase channel name and the message id. */
export function parseMessageLink(input: unknown): MessageLink | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  const match = LINK_PATTERN.exec(value) ?? IDENTIFIER_PATTERN.exec(value);
  if (!match) return null;
  const messageId = Number(match[2]);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return null;
  const username = normalizeUsername(match[1]);
  return username ? { username, messageId } : null;
}

export interface ConfirmAction {
  accept: boolean;
  jobId: string;
}

/** Reads the callback data of an Accept or Decline button. Anything else returns null. */
export function parseConfirmData(data: unknown): ConfirmAction | null {
  if (typeof data !== "string") return null;
  const match = CONFIRM_PATTERN.exec(data);
  if (!match) return null;
  return { accept: match[1].toLowerCase() === "y", jobId: match[2] };
}

export interface JobState {
  status: string;
  created_at?: string | null;
}

/** An awaiting download whose card is older than the confirmation window can no longer be accepted. */
export function isAwaitingExpired(job: JobState, now: number): boolean {
  if (job.status !== AWAITING_STATE) return false;
  const created = Date.parse(job.created_at ?? "");
  return !Number.isFinite(created) || now - created / 1000 > CONFIRM_TTL_SECONDS;
}

/** True when the job still holds one of the user's download slots. */
export function isLiveJob(job: JobState, now: number): boolean {
  if (job.status === AWAITING_STATE) return !isAwaitingExpired(job, now);
  return ACTIVE_JOB_STATES.includes(job.status);
}

/** Returns the thumbnail data URL when it is an image and small enough to store and send; otherwise null. */
export function validThumb(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("data:image/") || value.length > MAX_THUMB_CHARS) return null;
  return value;
}
