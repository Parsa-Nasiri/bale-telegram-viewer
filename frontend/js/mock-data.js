// Offline stand-in for the API, used by ?mock=1 and by the tests. It has the same methods as createApi()
// and follows the same paging rules: a page is the newest `limit` messages before `before`, in ascending order.

import { ApiError } from "./api-client.js";

export const MOCK_CHANNEL = Object.freeze({
  id: "00000000-0000-4000-8000-000000000001",
  username: "example_news",
  title: "کانال نمونه",
});

// A 1x1 PNG, so mock thumbnails exercise the same code path as real ones.
const MOCK_THUMB = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const BASE_TIME = Date.UTC(2026, 5, 1, 9, 0, 0);

export function makeMockMessage(id) {
  const kind = id % 9 === 0 ? "document" : id % 13 === 0 ? "photo" : null;
  return {
    id,
    date: new Date(BASE_TIME + id * 15 * 60 * 1000).toISOString(),
    text: kind === "photo" ? null : `پست شماره ${id}. این متن نمونه است و فقط برای نمایش رابط کاربری به کار می‌رود.`,
    mediaType: kind,
    groupId: null,
    senderName: MOCK_CHANNEL.title,
    fileName: kind === "document" ? `گزارش-${id}.pdf` : null,
    mimeType: kind === "document" ? "application/pdf" : kind === "photo" ? "image/jpeg" : null,
    sizeBytes: kind ? 90000 + id * 1200 : null,
    thumb: kind ? MOCK_THUMB : null,
    downloadable: kind !== null,
  };
}

export function createMockApi({ delayMs = 120, total = 240 } = {}) {
  const messages = Array.from({ length: total }, (_, index) => makeMockMessage(index + 1));
  const jobs = new Map();
  let jobSequence = 0;
  const wait = () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve());

  return {
    async authenticate() {
      await wait();
      return { token: "mock", expiresAt: 0, hasBaleChat: true };
    },

    async openChannel(username) {
      await wait();
      const name = String(username).replace(/^@/, "").toLowerCase();
      if (name !== MOCK_CHANNEL.username) throw new ApiError(404, "CHANNEL_NOT_FOUND");
      return { status: "ready", channel: { ...MOCK_CHANNEL } };
    },

    async getRequest(requestId) {
      await wait();
      return { id: requestId, status: "succeeded", errorCode: null, channelId: MOCK_CHANNEL.id };
    },

    async listMessages(_channelId, { before = null, limit = 25 } = {}) {
      await wait();
      const eligible = messages.filter((message) => before === null || message.id < before);
      const page = eligible.slice(-limit);
      const oldest = page.length > 0 ? page[0].id : null;
      return {
        channel: { ...MOCK_CHANNEL },
        items: page,
        nextCursor: oldest,
        hasMore: oldest !== null && oldest > 1,
        pendingRequestId: null,
      };
    },

    // The real API waits for the user's Accept in the bot chat. The mock only shows the first step of that.
    async createDownload(_channelId, messageId) {
      await wait();
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message || !message.downloadable) throw new ApiError(422, "MEDIA_UNAVAILABLE");
      const jobId = `mock-job-${++jobSequence}`;
      jobs.set(jobId, { polls: 0 });
      return { jobId, status: "awaiting_confirmation", reused: false };
    },

    async getDownload(jobId) {
      await wait();
      const job = jobs.get(jobId);
      if (!job) throw new ApiError(404, "DOWNLOAD_NOT_FOUND");
      job.polls += 1;
      const script = ["queued", "downloading", "uploading", "succeeded"];
      const status = script[Math.min(job.polls, script.length - 1)];
      return { id: jobId, status, attempts: 1, errorCode: null, updatedAt: new Date().toISOString() };
    },
  };
}
