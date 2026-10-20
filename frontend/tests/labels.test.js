import assert from "node:assert/strict";
import { test } from "node:test";
import { errorLabel, formatBytes, jobStatusLabel, mediaLabel, TERMINAL_JOB_STATES } from "../js/labels.js";

test("known error codes get their own message and unknown codes get the default", () => {
  assert.match(errorLabel("BALE_CHAT_REQUIRED"), /ربات بله/);
  assert.equal(errorLabel("SOMETHING_NEW"), "خطایی رخ داد. دوباره تلاش کنید.");
  assert.equal(errorLabel(undefined), "خطایی رخ داد. دوباره تلاش کنید.");
});

test("ambiguous deliveries are terminal and say the file is not re-sent", () => {
  assert.ok(TERMINAL_JOB_STATES.has("ambiguous"));
  assert.match(jobStatusLabel("ambiguous"), /دوباره ارسال نمی‌شود/);
});

test("a waiting card asks for the answer in the bot chat and is not terminal", () => {
  assert.match(jobStatusLabel("awaiting_confirmation"), /چت بله/);
  assert.equal(TERMINAL_JOB_STATES.has("awaiting_confirmation"), false);
});

test("a declined card is terminal and says so", () => {
  assert.ok(TERMINAL_JOB_STATES.has("declined"));
  assert.equal(jobStatusLabel("declined"), "لغو شد.");
});

test("formatBytes picks the unit by size and ignores invalid values", () => {
  assert.equal(formatBytes(500), "500 بایت");
  assert.equal(formatBytes(2048), "2.0 کیلوبایت");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 مگابایت");
  assert.equal(formatBytes(null), "");
  assert.equal(formatBytes(-1), "");
});

test("media kinds have readable labels", () => {
  assert.equal(mediaLabel("photo"), "تصویر");
  assert.equal(mediaLabel("mystery"), "پیوست");
});
