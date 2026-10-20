import assert from "node:assert/strict";
import { test } from "node:test";
import { safeThumbSource } from "../js/thumbnail.js";

test("accepts plain JPEG and PNG data URLs", () => {
  assert.equal(safeThumbSource("data:image/jpeg;base64,AAAA"), "data:image/jpeg;base64,AAAA");
  assert.equal(safeThumbSource("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
});

test("rejects links, other image types, markup and non-strings", () => {
  assert.equal(safeThumbSource("https://example.com/x.jpg"), null);
  assert.equal(safeThumbSource("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(safeThumbSource("data:image/jpeg;base64,AA AA"), null);
  assert.equal(safeThumbSource('data:image/png;base64,AAAA" onerror="x'), null);
  assert.equal(safeThumbSource(null), null);
  assert.equal(safeThumbSource(5), null);
});
