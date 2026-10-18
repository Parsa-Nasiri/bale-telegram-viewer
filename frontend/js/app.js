// Page controller: channel lookup, the timeline with older-page loading, and file delivery.

import { ApiError, createApi } from "./api-client.js";
import { readInitData } from "./bale-miniapp.js";
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

/** Loads one page. If the cache is short, the API queues an older fetch; wait for it, then read again. */
async function fetchPage(channelId, before) {
  let page = null;
  for (let round = 0; round < MAX_FETCH_ROUNDS; round++) {
    page = await callApi(() => api.listMessages(channelId, { before, limit: CONFIG.pageSize }));
    if (!page.pendingRequestId) break;
    setStatus("در حال گرفتن پیام‌های بیشتر از کانال…");
    const finished = await waitForRequest(page.pendingRequestId);
    if (finished.status === "failed") throw new ApiError(502, finished.errorCode ?? "FETCH_FAILED");
  }
  return page;
}

async function openChannel(username) {
  setStatus("در حال بررسی کانال…");
  let result = await callApi(() => api.openChannel(username));
  if (result.status === "pending") {
    setStatus("در حال خواندن کانال از تلگرام…");
    const finished = await waitForRequest(result.requestId);
    if (finished.status === "failed") throw new ApiError(502, finished.errorCode ?? "OPEN_FAILED");
    result = await callApi(() => api.openChannel(username));
  }
  if (!result.channel) throw new ApiError(502, "CHANNEL_NOT_READY");
  return result.channel;
}

async function loadChannel(channel) {
  state.generation += 1;
  state.channel = channel;
  state.messages = [];
  state.nextCursor = null;
  state.hasMore = false;
  els.title.textContent = channel.title || `@${channel.username}`;

  const page = await fetchPage(channel.id, undefined);
  state.messages = page.items;
  state.nextCursor = page.nextCursor;
  state.hasMore = page.hasMore;
  messageList.setAll(state.messages);
  els.timeline.scrollTop = els.timeline.scrollHeight;
  setStatus(state.messages.length > 0 ? "" : "پیامی برای نمایش نیست.");
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
    // A failed delivery can be retried. An ambiguous one stays disabled: the file may already be in the chat.
    if (result.status === "failed") button.disabled = false;
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
    const channel = await openChannel(username);
    await loadChannel(channel);
  } catch (err) {
    setStatus(errorLabel(err?.code), true);
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
