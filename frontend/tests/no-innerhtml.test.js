// Guard: message text comes from another person's channel, so the browser code must never parse it as markup.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const jsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "js");

test("browser code never injects HTML strings", () => {
  for (const name of readdirSync(jsDir)) {
    const source = readFileSync(join(jsDir, name), "utf8");
    assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, name);
  }
});
