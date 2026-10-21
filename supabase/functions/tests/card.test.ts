import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCEPT_LABEL,
  CAPTION_LIMIT,
  DECLINE_LABEL,
  DOWNLOAD_QUESTION,
  buildCaption,
  confirmKeyboard,
  excerpt,
  formatSize,
  formatTehran,
  truncate,
} from "../_shared/card.ts";
import {
  CONFIRM_TTL_SECONDS,
  isAwaitingExpired,
  isLiveJob,
  parseConfirmData,
  parseMessageLink,
  thumbUrl,
} from "../_shared/logic.ts";

const NOW = 1_800_000_000;
const JOB = "44444444-4444-4444-8444-444444444444";
const at = (seconds: number): string => new Date(seconds * 1000).toISOString();

describe("parseMessageLink", () => {
  it("reads links and identifiers and lowercases the channel name", () => {
    assert.deepEqual(parseMessageLink("https://t.me/News_Channel/123"), { username: "news_channel", messageId: 123 });
    assert.deepEqual(parseMessageLink("t.me/s/news_channel/5/"), { username: "news_channel", messageId: 5 });
    assert.deepEqual(parseMessageLink("@News_Channel/42"), { username: "news_channel", messageId: 42 });
    assert.deepEqual(parseMessageLink("  news_channel/42  "), { username: "news_channel", messageId: 42 });
  });

  it("rejects anything else", () => {
    for (const input of [
      "https://t.me/c/1234567890/9",
      "https://t.me/news_channel",
      "news_channel/0",
      "https://example.com/news_channel/5",
      "not a link",
      42,
      null,
    ]) {
      assert.equal(parseMessageLink(input), null, String(input));
    }
  });
});

describe("parseConfirmData", () => {
  it("reads the Accept and Decline callback data", () => {
    assert.deepEqual(parseConfirmData(`dl:y:${JOB}`), { accept: true, jobId: JOB });
    assert.deepEqual(parseConfirmData(`dl:n:${JOB}`), { accept: false, jobId: JOB });
  });

  it("rejects other prefixes, bad ids and non-strings", () => {
    assert.equal(parseConfirmData(`dl:x:${JOB}`), null);
    assert.equal(parseConfirmData("dl:y:not-a-uuid"), null);
    assert.equal(parseConfirmData(5), null);
  });
});

describe("download slots and confirmation expiry", () => {
  it("an awaiting card holds a slot until it expires", () => {
    assert.equal(isLiveJob({ status: "awaiting_confirmation", created_at: at(NOW - 60) }, NOW), true);
    assert.equal(isLiveJob({ status: "awaiting_confirmation", created_at: at(NOW - CONFIRM_TTL_SECONDS - 1) }, NOW), false);
  });

  it("queued and working jobs hold a slot; finished and declined ones do not", () => {
    assert.equal(isLiveJob({ status: "queued" }, NOW), true);
    assert.equal(isLiveJob({ status: "uploading" }, NOW), true);
    assert.equal(isLiveJob({ status: "succeeded" }, NOW), false);
    assert.equal(isLiveJob({ status: "declined" }, NOW), false);
  });

  it("expiry is strict at the window's edge", () => {
    assert.equal(isAwaitingExpired({ status: "awaiting_confirmation", created_at: at(NOW - CONFIRM_TTL_SECONDS) }, NOW), false);
    assert.equal(isAwaitingExpired({ status: "awaiting_confirmation", created_at: "not a date" }, NOW), true);
  });
});

describe("thumbnails", () => {
  const base = "https://project.example.supabase.co";
  const path = "11111111-1111-4111-8111-111111111111/10.jpg";

  it("builds the public URL of a stored thumbnail", () => {
    assert.equal(thumbUrl(base, path), `${base}/storage/v1/object/public/thumbs/${path}`);
  });

  it("accepts only the paths the worker writes", () => {
    assert.equal(thumbUrl(base, "https://example.com/x.jpg"), null);
    assert.equal(thumbUrl(base, "data:image/png;base64,AAAA"), null);
    assert.equal(thumbUrl(base, "not-a-uuid/10.jpg"), null);
    assert.equal(thumbUrl(base, "11111111-1111-4111-8111-111111111111/10.gif"), null);
    assert.equal(thumbUrl(base, "11111111-1111-4111-8111-111111111111/../10.jpg"), null);
    assert.equal(thumbUrl(base, 5), null);
  });
});

describe("card text", () => {
  it("formats sizes in bytes, kilobytes or megabytes", () => {
    assert.equal(formatSize(null), null);
    assert.equal(formatSize(-1), null);
    assert.equal(formatSize(512), "512 بایت");
    assert.equal(formatSize(2048), "2.0 کیلوبایت");
    assert.equal(formatSize(5 * 1024 * 1024), "5.0 مگابایت");
  });

  it("formats dates in Tehran time", () => {
    assert.equal(formatTehran(null), null);
    assert.equal(formatTehran("2026-10-19T00:00:00Z"), "2026-10-19 03:30");
    assert.equal(formatTehran("2026-10-19T21:00:00Z"), "2026-10-20 00:30");
  });

  it("collapses whitespace in the text excerpt and cuts long text", () => {
    assert.equal(excerpt("  سلام\n\n دنیا  "), "سلام دنیا");
    assert.equal(excerpt(""), null);
    assert.equal(Array.from(excerpt("a".repeat(400)) ?? "").length, 301);
  });

  it("truncates by code points", () => {
    assert.equal(truncate("abc", 5), "abc");
    assert.equal(truncate("abcdef", 4), "abc…");
  });

  it("builds the caption with the channel, the message and the question", () => {
    const caption = buildCaption(
      {
        channelTitle: "News",
        channelUsername: "news_channel",
        messageId: 10,
        date: "2026-10-19T00:00:00Z",
        mediaType: "document",
        fileName: "a.pdf",
        sizeBytes: 2048,
        senderName: "Ali",
        text: "hello   world",
      },
      DOWNLOAD_QUESTION,
    );
    assert.equal(
      caption,
      [
        "کانال: News",
        "شناسه پیام: 10",
        "تاریخ: 2026-10-19 03:30",
        "نوع: فایل",
        "نام فایل: a.pdf",
        "حجم: 2.0 کیلوبایت",
        "فرستنده: Ali",
        "متن: hello world",
        "",
        "آیا این فایل برای شما ارسال شود؟",
      ].join("\n"),
    );
  });

  it("keeps the caption within Bale's limit and keeps the question at the end", () => {
    const caption = buildCaption(
      {
        channelTitle: null,
        channelUsername: "news_channel",
        messageId: 10,
        date: null,
        mediaType: "document",
        fileName: "x".repeat(2000),
        sizeBytes: null,
        senderName: null,
        text: null,
      },
      DOWNLOAD_QUESTION,
    );
    assert.ok(Array.from(caption).length <= CAPTION_LIMIT);
    assert.ok(caption.startsWith("کانال: @news_channel"));
    assert.ok(caption.endsWith(DOWNLOAD_QUESTION));
  });

  it("builds Accept and Decline buttons that carry the job id", () => {
    const keyboard = confirmKeyboard(JOB);
    const [[accept, decline]] = keyboard.inline_keyboard;
    assert.deepEqual(accept, { text: ACCEPT_LABEL, callback_data: `dl:y:${JOB}` });
    assert.deepEqual(decline, { text: DECLINE_LABEL, callback_data: `dl:n:${JOB}` });
    assert.ok(accept.callback_data.length <= 64);
  });
});
