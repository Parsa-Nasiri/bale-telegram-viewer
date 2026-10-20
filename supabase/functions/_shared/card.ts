// The text of the info card the bot sends: a download request from the Mini App, and a lookup of a Telegram link
// typed in the bot chat. The Python worker builds the same card for lookups with the same rules
// (worker/bale_viewer_worker/card.py). Keep the two in step; both test suites pin the same output.

import type { CachedMessage } from "./logic.ts";

export const CAPTION_LIMIT = 1024;
export const EXCERPT_LIMIT = 300;
export const DOWNLOAD_QUESTION = "آیا این فایل برای شما ارسال شود؟";
export const ACCEPT_LABEL = "تأیید دانلود";
export const DECLINE_LABEL = "لغو";

// Iran has had no daylight saving time since 2022, so a fixed offset is exact.
const TEHRAN_OFFSET_MINUTES = 210;

export const MEDIA_LABELS: Readonly<Record<string, string>> = {
  photo: "تصویر",
  video: "ویدیو",
  audio: "فایل صوتی",
  voice: "پیام صوتی",
  animation: "گیف",
  sticker: "استیکر",
  document: "فایل",
};

export interface CardInput {
  channelTitle: string | null;
  channelUsername: string | null;
  messageId: number;
  date: string | null;
  mediaType: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  senderName: string | null;
  text: string | null;
}

export function cardInputFrom(channel: { title: string | null; username: string | null }, message: CachedMessage): CardInput {
  const meta = message.metadata ?? {};
  return {
    channelTitle: channel.title,
    channelUsername: channel.username,
    messageId: message.message_id,
    date: message.date ?? null,
    mediaType: message.media_type,
    fileName: meta.file_name ?? null,
    sizeBytes: typeof meta.size_bytes === "number" ? meta.size_bytes : null,
    senderName: meta.sender_name ?? null,
    text: message.text ?? null,
  };
}

export function formatSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}

/** "YYYY-MM-DD HH:MM" in Tehran time. */
export function formatTehran(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const local = new Date(ms + TEHRAN_OFFSET_MINUTES * 60_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`
  );
}

/** Collapses whitespace and keeps the first EXCERPT_LIMIT code points. */
export function excerpt(text: string | null, limit = EXCERPT_LIMIT): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  const chars = Array.from(collapsed);
  return chars.length <= limit ? collapsed : `${chars.slice(0, limit).join("")}…`;
}

export function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

/** The card text. The question, when given, is kept at the end even when the rest has to be cut. */
export function buildCaption(input: CardInput, question: string | null): string {
  const lines: string[] = [];
  const channel = input.channelTitle ?? (input.channelUsername ? `@${input.channelUsername}` : "کانال");
  lines.push(`کانال: ${channel}`);
  lines.push(`شناسه پیام: ${input.messageId}`);
  const date = formatTehran(input.date);
  if (date) lines.push(`تاریخ: ${date}`);
  const kind = input.mediaType ? (MEDIA_LABELS[input.mediaType] ?? "فایل") : null;
  if (kind) lines.push(`نوع: ${kind}`);
  if (input.fileName) lines.push(`نام فایل: ${input.fileName}`);
  const size = formatSize(input.sizeBytes);
  if (size) lines.push(`حجم: ${size}`);
  if (input.senderName) lines.push(`فرستنده: ${input.senderName}`);
  const body = excerpt(input.text);
  if (body) lines.push(`متن: ${body}`);

  const tail = question ? `\n\n${question}` : "";
  return truncate(lines.join("\n"), CAPTION_LIMIT - Array.from(tail).length) + tail;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

/** Accept and Decline under a card. The job id travels in the callback data. */
export function confirmKeyboard(jobId: string): { inline_keyboard: InlineButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: ACCEPT_LABEL, callback_data: `dl:y:${jobId}` },
        { text: DECLINE_LABEL, callback_data: `dl:n:${jobId}` },
      ],
    ],
  };
}
