// Pure rules for the API: routing, input validation, pagination and download eligibility.
// No I/O, so these are covered by unit tests.

import { HttpError } from "./http.ts";

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 50;
export const MAX_ACTIVE_JOBS = 5;
export const MAX_PAGE_REQUESTS_PER_HOUR = 60;

const USERNAME_PATTERN = /^[a-z][a-z0-9_]{4,31}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export interface CachedMessage {
  message_id: number;
  media_type: string | null;
  metadata: { size_bytes?: number | null; available?: boolean } | null;
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
