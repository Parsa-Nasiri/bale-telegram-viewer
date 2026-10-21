import assert from "node:assert/strict";
import { test } from "node:test";
import { safeThumbSource } from "../js/thumbnail.js";

test("accepts plain JPEG and PNG data URLs", () => {
  assert.equal(safeThumbSource("data:image/jpeg;base64,AAAA"), "data:image/jpeg;base64,AAAA");
  assert.equal(safeThumbSource("data:image/png;base64,iVBORw0KGgo="), "data:image/png;base64,iVBORw0KGgo=");
});

const STORED = "https://project.supabase.co/storage/v1/object/public/thumbs/11111111-1111-4111-8111-111111111111/10.jpg";

test("accepts the public Storage URL of a stored thumbnail", () => {
  assert.equal(safeThumbSource(STORED), STORED);
});

test("rejects other hosts, other storage paths and unsafe names", () => {
  assert.equal(safeThumbSource("https://example.com/x.jpg"), null);
  assert.equal(safeThumbSource(STORED.replace("project.supabase.co", "evil.example")), null);
  assert.equal(safeThumbSource(STORED.replace("/thumbs/", "/private/")), null);
  assert.equal(safeThumbSource(STORED.replace("10.jpg", "10.jpg?x=1")), null);
  assert.equal(safeThumbSource(STORED.replace("10.jpg", "10.gif")), null);
  assert.equal(safeThumbSource(STORED.replace("10.jpg", "../10.jpg")), null);
  assert.equal(safeThumbSource("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(safeThumbSource("data:image/jpeg;base64,AA AA"), null);
  assert.equal(safeThumbSource('data:image/png;base64,AAAA" onerror="x'), null);
  assert.equal(safeThumbSource(null), null);
  assert.equal(safeThumbSource(5), null);
});
