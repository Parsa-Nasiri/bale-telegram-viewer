// Pure timeline rules. Messages are kept oldest first, which is also the display order.

/** Merges an older page into the timeline: duplicates are dropped and the result stays ascending by id. */
export function mergeOlder(existing, older) {
  const known = new Set(existing.map((message) => message.id));
  const fresh = older.filter((message) => !known.has(message.id));
  return [...fresh, ...existing].sort((a, b) => a.id - b.id);
}

/** True when the reader is near the top, more history exists, and no load is already running. */
export function shouldLoadOlder({ scrollTop, threshold = 120 }, state) {
  return scrollTop <= threshold && state.hasMore && !state.loading && state.nextCursor !== null;
}

/**
 * Prepending older messages pushes the content down. Moving scrollTop by the added height keeps the
 * reader on the same message instead of jumping to the new top.
 */
export function scrollDeltaAfterPrepend(previousHeight, currentHeight) {
  return Math.max(0, currentHeight - previousHeight);
}
