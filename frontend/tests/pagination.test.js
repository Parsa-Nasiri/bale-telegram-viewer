import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeOlder, scrollDeltaAfterPrepend, shouldLoadOlder } from "../js/pagination.js";

test("mergeOlder keeps ascending order and drops duplicates", () => {
  const existing = [{ id: 5 }, { id: 6 }];
  const older = [{ id: 3 }, { id: 4 }, { id: 5 }];
  assert.deepEqual(
    mergeOlder(existing, older).map((message) => message.id),
    [3, 4, 5, 6],
  );
});

test("shouldLoadOlder needs top position, more history, a cursor, and no load in progress", () => {
  const ready = { hasMore: true, loading: false, nextCursor: 40 };
  assert.equal(shouldLoadOlder({ scrollTop: 0 }, ready), true);
  assert.equal(shouldLoadOlder({ scrollTop: 500 }, ready), false);
  assert.equal(shouldLoadOlder({ scrollTop: 0 }, { ...ready, hasMore: false }), false);
  assert.equal(shouldLoadOlder({ scrollTop: 0 }, { ...ready, loading: true }), false);
  assert.equal(shouldLoadOlder({ scrollTop: 0 }, { ...ready, nextCursor: null }), false);
});

test("scrollDeltaAfterPrepend moves the view by the height that was added", () => {
  assert.equal(scrollDeltaAfterPrepend(1000, 1450), 450);
  assert.equal(scrollDeltaAfterPrepend(1000, 900), 0);
});
