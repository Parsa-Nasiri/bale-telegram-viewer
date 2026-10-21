// Page controller: channel lookup, the timeline with older-page loading, and file delivery.

import { ApiError, createApi } from "./api-client.js";
import { applyTheme, readInitData } from "./bale-miniapp.js";
import { CONFIG } from "./config.js";
import { deliverMessage } from "./download-actions.js";
import { errorLabel, jobStatusLabel } from "./labels.js";
import { createMockApi } from "./mock-data.js";
import { MessageList } from "./message-list.js";
import { mergeOlder, scrollDeltaAfterPrepend, shouldLoadOlder } from "./pagination.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("channel-form"),
  input: $("channel-input"),
  openButton: $("open-btn"),
  title: $("channel-title"),
  status: $("status"),
  timeline: $("timeline"),
  older: $("older-indicator"),
  list: $("message-list"),
};

const MAX_FETCH_ROUNDS = 3;

// Shown when the page has no initData. Each message points at a different cause.
const NO_AUTH_MESSAGES = {
  "no-sdk": "این صفحه داخل بله باز نشده است، یا SDK بله در آن بارگذاری نشده است.",
  "sdk-without-initdata": "بله اطلاعات ورود را نفرستاده است. صفحه را از داخل ربات بله دوباره باز کنید.",
};
const mock = new URLSearchParams(location.search).get("mock") === "1";
const api = mock ? createMockApi() : createApi();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const state = {
  initData: "",
  channel: null,
  messages: [],
  nextCursor: null,
  hasMore: false,
  loading: false,
  generation: 0, // bumped on every channel switch, so late responses are dropped
};

const messageList = new MessageList(els.list, { onDownload: handleDownload });

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
}

/** Runs an API call; on an expired app token it signs in again once and retries. */
async function callApi(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.code === "TOKEN_EXPIRED" && state.initData) {
      await api.authenticate(state.initData);
      return fn();
    }
    throw err;
  }
}

async function waitForRequest(requestId) {
  for (let attempt = 0; attempt < CONFIG.requestPollAttempts; attempt++) {
    const request = await callApi(() => api.getRequest(requestId));
    if (request.status === "succeeded" || request.status === "failed") return request;
    await sleep(CONFIG.requestPollMs);
  }
  return { status: "failed", errorCode: "TIMEOUT" };
}

/**
 * Loads one page. If the cache is short, the API queues an older fetch; wait for it, then read again.
 * `allowFetch: false` reads the saved messages only.
 */
async function fetchPage(channelId, before, { allowFetch = true } = {}) {
  let page = null;
  for (let round = 0; round < MAX_FETCH_ROUNDS; round++) {
    page = await callApi(() => api.listMessages(channelId, { before, limit: CONFIG.pageSize, allowFetch }));
    if (!page.pendingRequestId) break;
    setStatus("در حال گرفتن پیام‌های بیشتر از کانال…");
    const finished = await waitForRequest(page.pendingRequestId);
    if (finished.status === "failed") throw new ApiError(502, finished.errorCode ?? "FETCH_FAILED");
  }
  return page;
}

/**
 * Asks the worker to read the channel from Telegram again, so the newest posts are always fresh. If that read fails
 * and the channel is already saved, the saved messages are shown for this open only. The next open tries again.
 * Returns the channel and the error code of the failed refresh (null when the refresh worked).
 */
async function openChannel(username) {
  setStatus("در حال خواندن کانال از تلگرام…");
  const started = await callApi(() => api.openChannel(username));
  const finished = await waitForRequest(started.requestId);
  if (finished.status === "succeeded" && finished.channel) {
    return { channel: finished.channel, refreshError: null };
  }
  if (started.channel) {
    return { channel: started.channel, refreshError: finished.errorCode ?? "FETCH_FAILED" };
  }
  throw new ApiError(502, finished.errorCode ?? "OPEN_FAILED");
}

function listStatus(refreshError, count) {
  if (refreshError) return `به‌روزرسانی نشد. ${errorLabel(refreshError)} فعلاً پیام‌های ذخیره‌شده نمایش داده می‌شوند.`;
  return count > 0 ? "" : "پیامی برای نمایش نیست.";
}

async function loadChannel({ channel, refreshError }) {
  state.generation += 1;
  state.channel = channel;
  state.messages = [];
  state.nextCursor = null;
  state.hasMore = false;
  els.title.textContent = channel.title || `@${channel.username}`;
  messageList.showSkeleton();

  // After a failed refresh, the saved messages are read without asking Telegram again.
  const page = await fetchPage(channel.id, undefined, { allowFetch: refreshError === null });
  state.messages = page.items;
  state.nextCursor = page.nextCursor;
  state.hasMore = page.hasMore;
  messageList.setAll(state.messages);
  els.timeline.scrollTop = els.timeline.scrollHeight;
  setStatus(listStatus(refreshError, state.messages.length));
  fillViewportIfNeeded();
}

async function loadOlder() {
  if (!state.channel || state.loading) return;
  const generation = state.generation;
  const channelId = state.channel.id;
  state.loading = true;
  els.older.hidden = false;
  const previousHeight = els.timeline.scrollHeight;
  try {
    const page = await fetchPage(channelId, state.nextCursor);
    if (generation !== state.generation) return;
    state.messages = mergeOlder(state.messages, page.items);
    messageList.prepend(page.items);
    els.timeline.scrollTop += scrollDeltaAfterPrepend(previousHeight, els.timeline.scrollHeight);
    state.nextCursor = page.nextCursor;
    state.hasMore = page.hasMore;
  } catch (err) {
    if (generation === state.generation) setStatus(errorLabel(err?.code), true);
  } finally {
    if (generation === state.generation) {
      state.loading = false;
      els.older.hidden = true;
    }
  }
}

/** If the first page does not fill the screen, the reader cannot scroll up to trigger a load. */
function fillViewportIfNeeded() {
  if (state.hasMore && els.timeline.scrollHeight <= els.timeline.clientHeight) loadOlder();
}

function statusText(snapshot) {
  return snapshot.status === "failed" ? errorLabel(snapshot.errorCode) : jobStatusLabel(snapshot.status);
}

/**
 * Starts a download. The bot then asks the user to accept it in the chat. The button stays disabled while the
 * job is running. It comes back for failed, declined and timed-out jobs. An ambiguous job stays disabled,
 * because the file may already be in the chat.
 */
async function handleDownload(message, button) {
  if (!state.channel) return;
  const channelId = state.channel.id;
  button.disabled = true;
  try {
    const result = await deliverMessage({
      api: {
        createDownload: (channel, id) => callApi(() => api.createDownload(channel, id)),
        getDownload: (jobId) => callApi(() => api.getDownload(jobId)),
      },
      channelId,
      messageId: message.id,
      onStatus: (snapshot) => messageList.setDownloadStatus(message.id, statusText(snapshot)),
      pollMs: CONFIG.downloadPollMs,
      maxAttempts: CONFIG.downloadPollAttempts,
      sleep,
    });
    if (["failed", "declined", "timeout"].includes(result.status)) button.disabled = false;
  } catch (err) {
    messageList.setDownloadStatus(message.id, errorLabel(err?.code));
    button.disabled = false;
  }
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = els.input.value.trim();
  if (!username) return;
  els.openButton.disabled = true;
  try {
    const opened = await openChannel(username);
    await loadChannel(opened);
  } catch (err) {
    setStatus(errorLabel(err?.code), true);
    if (state.messages.length === 0) messageList.setAll([]);
  } finally {
    els.openButton.disabled = false;
  }
});

els.timeline.addEventListener(
  "scroll",
  () => {
    if (shouldLoadOlder({ scrollTop: els.timeline.scrollTop }, state)) loadOlder();
  },
  { passive: true },
);

async function boot() {
  if (mock) {
    setStatus("حالت نمایشی: داده‌ها ساختگی هستند.");
    return;
  }
  const { initData, source } = readInitData();
  applyTheme();
  state.initData = initData;
  if (!initData) {
    console.info("bale auth: no initData, source =", source);
    setStatus(NO_AUTH_MESSAGES[source] ?? NO_AUTH_MESSAGES["no-sdk"], true);
    els.openButton.disabled = true;
    return;
  }
  try {
    await api.authenticate(state.initData);
    setStatus("");
  } catch (err) {
    setStatus(errorLabel(err?.code), true);
    els.openButton.disabled = true;
  }
}

boot();
