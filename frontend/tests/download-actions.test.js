import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverMessage } from "../js/download-actions.js";

const noSleep = async () => {};

function fakeApi(statuses) {
  let polls = 0;
  const calls = { create: 0 };
  return {
    calls,
    api: {
      async createDownload() {
        calls.create += 1;
        return { jobId: "job-1", status: "queued", reused: false };
      },
      async getDownload() {
        const status = statuses[Math.min(polls, statuses.length - 1)];
        polls += 1;
        return { status, errorCode: status === "failed" ? "BALE_SEND_FAILED" : null };
      },
    },
  };
}

test("reports each status until the job succeeds", async () => {
  const { api } = fakeApi(["queued", "uploading", "succeeded"]);
  const seen = [];
  const result = await deliverMessage({
    api,
    channelId: "channel-1",
    messageId: 7,
    onStatus: (snapshot) => seen.push(snapshot.status),
    sleep: noSleep,
  });
  assert.deepEqual(seen, ["queued", "queued", "uploading", "succeeded"]);
  assert.equal(result.status, "succeeded");
});

test("an ambiguous result stops polling and never creates a second job", async () => {
  const { api, calls } = fakeApi(["uploading", "ambiguous"]);
  const result = await deliverMessage({ api, channelId: "c", messageId: 7, onStatus() {}, sleep: noSleep });
  assert.equal(result.status, "ambiguous");
  assert.equal(calls.create, 1);
});

test("a failed job returns its error code so the UI can explain it", async () => {
  const { api } = fakeApi(["failed"]);
  const result = await deliverMessage({ api, channelId: "c", messageId: 7, onStatus() {}, sleep: noSleep });
  assert.deepEqual(result, { status: "failed", errorCode: "BALE_SEND_FAILED" });
});

test("gives up with a timeout status after the poll budget", async () => {
  const { api } = fakeApi(["queued"]);
  const result = await deliverMessage({
    api,
    channelId: "c",
    messageId: 7,
    onStatus() {},
    maxAttempts: 3,
    sleep: noSleep,
  });
  assert.equal(result.status, "timeout");
});
