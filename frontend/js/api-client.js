// Client for the Edge Function API. The app token lives in memory only: a fresh sign-in per visit is cheap,
// and it avoids storing credentials in the browser.

import { CONFIG } from "./config.js";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export function createApi({ baseUrl = CONFIG.apiBaseUrl, fetchImpl = (input, init) => fetch(input, init) } = {}) {
  let token = null;

  async function request(method, path, { body, auth = true } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth) {
      if (!token) throw new ApiError(401, "UNAUTHORIZED", "not signed in");
      headers.authorization = `Bearer ${token}`;
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = data?.error ?? {};
      throw new ApiError(response.status, error.code ?? "HTTP_ERROR", error.message);
    }
    return data;
  }

  return {
    async authenticate(initData) {
      const data = await request("POST", "/auth", { body: { initData }, auth: false });
      token = data.token;
      return data;
    },
    openChannel(username) {
      return request("POST", "/channels/open", { body: { username } });
    },
    getRequest(requestId) {
      return request("GET", `/requests/${encodeURIComponent(requestId)}`);
    },
    listMessages(channelId, { before, limit, allowFetch = true } = {}) {
      const params = new URLSearchParams();
      if (before !== undefined && before !== null) params.set("before", String(before));
      if (limit) params.set("limit", String(limit));
      // Reads the saved messages only. Used when the refresh of the channel failed.
      if (allowFetch === false) params.set("fetch", "0");
      const query = params.toString();
      return request("GET", `/channels/${encodeURIComponent(channelId)}/messages${query ? `?${query}` : ""}`);
    },
    createDownload(channelId, messageId) {
      return request("POST", "/downloads", { body: { channelId, messageId } });
    },
    getDownload(jobId) {
      return request("GET", `/downloads/${encodeURIComponent(jobId)}`);
    },
  };
}
