// Persian UI strings and status mapping. Pure, so it is covered by Node tests.

export const JOB_STATUS_LABELS = Object.freeze({
  awaiting_confirmation: "منتظر تأیید شما در چت بله. روی «تأیید دانلود» بزنید.",
  declined: "لغو شد.",
  queued: "در صف ارسال",
  processing: "در حال آماده‌سازی",
  downloading: "در حال دریافت از تلگرام",
  uploading: "در حال ارسال به بله",
  succeeded: "ارسال شد؛ در چت بله بررسی کنید",
  failed: "ارسال ناموفق بود",
  ambiguous: "نتیجه نامشخص است؛ در چت بله بررسی کنید. فایل دوباره ارسال نمی‌شود.",
  timeout: "هنوز نتیجه‌ای نیست. بعداً دوباره بررسی کنید.",
});

export const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "ambiguous", "declined"]);

const ERROR_LABELS = Object.freeze({
  BALE_CHAT_REQUIRED: "برای دریافت فایل، ابتدا در ربات بله یک پیام بفرستید.",
  BALE_SEND_FAILED: "کارت تأیید در چت بله فرستاده نشد. دوباره امتحان کنید.",
  CONFIRM_SEND_FAILED: "کارت تأیید در چت بله فرستاده نشد. دوباره امتحان کنید.",
  CONFIRM_EXPIRED: "مهلت تأیید این درخواست گذشت. دوباره درخواست دهید.",
  MESSAGE_NOT_FOUND: "این پیام دیگر در دسترس نیست.",
  MEDIA_UNAVAILABLE: "این پیام فایل قابل دریافت ندارد.",
  FILE_TOO_LARGE: "حجم فایل از حد مجاز بله بیشتر است.",
  TOO_MANY_ACTIVE_JOBS: "تعداد دریافت‌های فعال شما زیاد است. کمی صبر کنید.",
  RATE_LIMITED: "درخواست‌های زیادی ثبت شده است. کمی بعد دوباره تلاش کنید.",
  INVALID_USERNAME: "یوزرنیم کانال معتبر نیست.",
  CHANNEL_NOT_FOUND: "کانال پیدا نشد.",
  CHANNEL_ACCESS_DENIED: "دسترسی به این کانال ممکن نیست.",
  TELEGRAM_RATE_LIMIT: "تلگرام موقتاً محدود کرده است. کمی بعد دوباره تلاش کنید.",
  INIT_DATA_INVALID: "نشست شما معتبر نیست. صفحه را از داخل بله باز کنید.",
  INIT_DATA_EXPIRED: "نشست شما منقضی شده است. صفحه را دوباره باز کنید.",
  UNAUTHORIZED: "نشست شما معتبر نیست. صفحه را دوباره باز کنید.",
  TIMEOUT: "پاسخ سرور دیر رسید. دوباره تلاش کنید.",
});

const DEFAULT_ERROR = "خطایی رخ داد. دوباره تلاش کنید.";

const MEDIA_LABELS = Object.freeze({
  photo: "تصویر",
  video: "ویدیو",
  audio: "فایل صوتی",
  voice: "پیام صوتی",
  animation: "گیف",
  sticker: "استیکر",
  document: "فایل",
});

export function errorLabel(code) {
  return ERROR_LABELS[code] ?? DEFAULT_ERROR;
}

export function jobStatusLabel(status) {
  return JOB_STATUS_LABELS[status] ?? DEFAULT_ERROR;
}

export function mediaLabel(mediaType) {
  return MEDIA_LABELS[mediaType] ?? "پیوست";
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} بایت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} کیلوبایت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} مگابایت`;
}
