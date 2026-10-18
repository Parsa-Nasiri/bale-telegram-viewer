// Starts a file delivery and polls until the job reaches a final state.
// It never re-sends on its own: "ambiguous" is final, because the file may already be in the Bale chat.

import { TERMINAL_JOB_STATES } from "./labels.js";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ createDownload: Function, getDownload: Function }} api
 * @param {(snapshot: {status: string, errorCode: string|null}) => void} onStatus
 * @returns {Promise<{status: string, errorCode: string|null}>} the final snapshot
 */
export async function deliverMessage({
  api,
  channelId,
  messageId,
  onStatus,
  pollMs = 4000,
  maxAttempts = 60,
  sleep = defaultSleep,
}) {
  const created = await api.createDownload(channelId, messageId);
  let snapshot = { status: created.status, errorCode: null };
  onStatus(snapshot);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (TERMINAL_JOB_STATES.has(snapshot.status)) return snapshot;
    await sleep(pollMs);
    const job = await api.getDownload(created.jobId);
    snapshot = { status: job.status, errorCode: job.errorCode ?? null };
    onStatus(snapshot);
  }
  return { status: "timeout", errorCode: null };
}
