// PGMQ helpers for the Edge Functions. A queue message carries only a row id. The row's status says what to do.

import type { Db } from "./rest.ts";

export const PAGE_QUEUE = "page_requests_q";
export const JOB_QUEUE = "download_jobs_q";
export const LOOKUP_QUEUE = "lookup_requests_q";

export type QueueTable = "page_requests" | "download_jobs" | "lookup_requests";

/** Sends the payload to the queue, then records the queue message id on the row. Status stays in the row. */
export async function enqueue(
  db: Pick<Db, "rpc" | "update">,
  queue: string,
  table: QueueTable,
  rowId: string,
  payload: Record<string, string>,
): Promise<void> {
  const msgId = await db.rpc<number>("pgmq_send", { p_queue: queue, p_msg: payload });
  await db.update(table, { id: `eq.${rowId}` }, { queue_msg_id: msgId });
}
