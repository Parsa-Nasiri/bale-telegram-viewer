import assert from "node:assert/strict";
import { test } from "node:test";
import { createMockApi } from "../js/mock-data.js";

test("the mock API pages newest first and returns each page in ascending order", async () => {
  const api = createMockApi({ delayMs: 0, total: 240 });
  const first = await api.listMessages("ignored", { limit: 25 });
  assert.equal(first.items.length, 25);
  assert.equal(first.items[0].id, 216);
  assert.equal(first.items.at(-1).id, 240);
  assert.equal(first.nextCursor, 216);
  assert.equal(first.hasMore, true);

  const second = await api.listMessages("ignored", { before: first.nextCursor, limit: 25 });
  assert.equal(second.items.at(-1).id, 215);
  assert.equal(second.nextCursor, 191);
});

test("the last mock page reports that history is exhausted", async () => {
  const api = createMockApi({ delayMs: 0, total: 240 });
  const last = await api.listMessages("ignored", { before: 26, limit: 25 });
  assert.equal(last.items[0].id, 1);
  assert.equal(last.hasMore, false);
});

test("the mock download only accepts downloadable messages and walks through statuses", async () => {
  const api = createMockApi({ delayMs: 0, total: 240 });
  await assert.rejects(api.createDownload("ignored", 1), { code: "MEDIA_UNAVAILABLE" });

  const { jobId } = await api.createDownload("ignored", 9);
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await api.getDownload(jobId)).status);
  assert.deepEqual(statuses, ["downloading", "uploading", "succeeded", "succeeded"]);
});
