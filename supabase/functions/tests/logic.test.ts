import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPageMeta,
  clampLimit,
  downloadBlocker,
  normalizeUsername,
  parseCursor,
  segmentsAfter,
} from "../_shared/logic.ts";

describe("normalizeUsername", () => {
  it("accepts @name, bare name and t.me links, lowercased", () => {
    assert.equal(normalizeUsername("@News_Channel"), "news_channel");
    assert.equal(normalizeUsername("  news_channel "), "news_channel");
    assert.equal(normalizeUsername("https://t.me/News_Channel/"), "news_channel");
  });

  it("rejects names that are too short, too long, or contain other characters", () => {
    assert.equal(normalizeUsername("abc"), null);
    assert.equal(normalizeUsername("a".repeat(33)), null);
    assert.equal(normalizeUsername("bad name!"), null);
    assert.equal(normalizeUsername("1starts_with_digit"), null);
    assert.equal(normalizeUsername(42), null);
  });
});

describe("clampLimit and parseCursor", () => {
  it("uses the default for missing or invalid limits and caps large ones", () => {
    assert.equal(clampLimit(null), 25);
    assert.equal(clampLimit("0"), 25);
    assert.equal(clampLimit("abc"), 25);
    assert.equal(clampLimit("10"), 10);
    assert.equal(clampLimit("999"), 50);
  });

  it("treats an absent cursor as null and rejects malformed ones", () => {
    assert.equal(parseCursor(null), null);
    assert.equal(parseCursor(""), null);
    assert.equal(parseCursor("12"), 12);
    assert.throws(() => parseCursor("-1"), { code: "INVALID_CURSOR" });
    assert.throws(() => parseCursor("abc"), { code: "INVALID_CURSOR" });
  });
});

describe("buildPageMeta", () => {
  it("a full page with more history returns a cursor and no fetch", () => {
    const ids = Array.from({ length: 25 }, (_, i) => 30 - i);
    const meta = buildPageMeta(ids, 25, false, null);
    assert.deepEqual(meta, { nextCursor: 6, hasMore: true, needsOlderFetch: false, cursorForFetch: 6 });
  });

  it("a short page with more history asks for an older fetch from the oldest cached id", () => {
    const meta = buildPageMeta([5, 4], 25, false, null);
    assert.equal(meta.needsOlderFetch, true);
    assert.equal(meta.cursorForFetch, 4);
    assert.equal(meta.nextCursor, 4);
    assert.equal(meta.hasMore, true);
  });

  it("an exhausted history never asks for more", () => {
    const meta = buildPageMeta([3, 2, 1], 25, true, null);
    assert.deepEqual(meta, { nextCursor: null, hasMore: false, needsOlderFetch: false, cursorForFetch: null });
  });

  it("an empty page uses the fallback cursor when there is one", () => {
    const meta = buildPageMeta([], 25, false, 100);
    assert.equal(meta.needsOlderFetch, true);
    assert.equal(meta.cursorForFetch, 100);
    assert.equal(meta.hasMore, true);
  });

  it("an empty page without any cursor reports no more history instead of looping", () => {
    const meta = buildPageMeta([], 25, false, null);
    assert.equal(meta.hasMore, false);
    assert.equal(meta.needsOlderFetch, false);
    assert.equal(meta.nextCursor, null);
  });
});

describe("downloadBlocker", () => {
  const available = { message_id: 7, media_type: "document", metadata: { available: true, size_bytes: 1000 } };
  const base = { hasBaleChat: true, message: available, activeJobs: 0, maxBytes: 50 * 1024 * 1024 };

  it("returns null when the file can be delivered", () => {
    assert.equal(downloadBlocker(base), null);
  });

  it("refuses when the user has not started the Bale bot", () => {
    assert.deepEqual(downloadBlocker({ ...base, hasBaleChat: false }), { status: 409, code: "BALE_CHAT_REQUIRED" });
  });

  it("refuses unknown messages", () => {
    assert.deepEqual(downloadBlocker({ ...base, message: null }), { status: 404, code: "MESSAGE_NOT_FOUND" });
  });

  it("refuses text-only or unsupported messages", () => {
    const text = { message_id: 8, media_type: null, metadata: { available: false } };
    assert.deepEqual(downloadBlocker({ ...base, message: text }), { status: 422, code: "MEDIA_UNAVAILABLE" });
  });

  it("refuses files over the Bale limit", () => {
    const big = { ...available, metadata: { available: true, size_bytes: 60 * 1024 * 1024 } };
    assert.deepEqual(downloadBlocker({ ...base, message: big }), { status: 413, code: "FILE_TOO_LARGE" });
  });

  it("refuses when the user already has the maximum number of active jobs", () => {
    assert.deepEqual(downloadBlocker({ ...base, activeJobs: 5 }), { status: 429, code: "TOO_MANY_ACTIVE_JOBS" });
  });
});

describe("segmentsAfter", () => {
  it("returns the path after the marker segment", () => {
    assert.deepEqual(segmentsAfter("/functions/v1/api/channels/open"), ["channels", "open"]);
    assert.deepEqual(segmentsAfter("/functions/v1/bale-webhook/abc123", "bale-webhook"), ["abc123"]);
  });
});
