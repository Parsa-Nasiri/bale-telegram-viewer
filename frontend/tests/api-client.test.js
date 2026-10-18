import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, createApi } from "../js/api-client.js";

const BASE = "https://api.test/functions/v1/api";

function recorder(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

test("authenticate stores the token and sends it on later calls only", async () => {
  const { calls, fetchImpl } = recorder([
    { body: { token: "tok-1", expiresAt: 1, hasBaleChat: false } },
    { body: { items: [] } },
  ]);
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.authenticate("signed-init-data");
  await api.listMessages("chan-1", { before: 9, limit: 25 });

  assert.equal(calls[0].url, `${BASE}/auth`);
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.equal(calls[1].init.headers.authorization, "Bearer tok-1");
  assert.equal(calls[1].url, `${BASE}/channels/chan-1/messages?before=9&limit=25`);
});

test("requests made before signing in fail without touching the network", async () => {
  const { calls, fetchImpl } = recorder([]);
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await assert.rejects(api.openChannel("news"), (err) => err instanceof ApiError && err.code === "UNAUTHORIZED");
  assert.equal(calls.length, 0);
});

test("server errors surface as ApiError with the server's code", async () => {
  const { fetchImpl } = recorder([
    { body: { token: "t" } },
    { body: { error: { code: "BALE_CHAT_REQUIRED", message: "x" } }, status: 409 },
  ]);
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.authenticate("init");
  await assert.rejects(api.createDownload("chan-1", 7), (err) => {
    return err instanceof ApiError && err.status === 409 && err.code === "BALE_CHAT_REQUIRED";
  });
});

test("listMessages omits the query string when no options are given", async () => {
  const { calls, fetchImpl } = recorder([{ body: { token: "t" } }, { body: { items: [] } }]);
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.authenticate("init");
  await api.listMessages("chan-1");
  assert.equal(calls[1].url, `${BASE}/channels/chan-1/messages`);
});

test("ids are URL-encoded in path segments", async () => {
  const { calls, fetchImpl } = recorder([{ body: { token: "t" } }, { body: {} }]);
  const api = createApi({ baseUrl: BASE, fetchImpl });
  await api.authenticate("init");
  await api.getDownload("a/b c");
  assert.equal(calls[1].url, `${BASE}/downloads/a%2Fb%20c`);
});
