import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { corsHeaders } from "../_shared/http.ts";

describe("corsHeaders", () => {
  it("allows any origin when the list contains *", () => {
    assert.equal(corsHeaders("https://anything.example", ["*"])["Access-Control-Allow-Origin"], "*");
  });

  it("echoes only listed origins otherwise", () => {
    const allowed = ["https://pages.example"];
    assert.equal(corsHeaders("https://pages.example", allowed)["Access-Control-Allow-Origin"], "https://pages.example");
    assert.equal(corsHeaders("https://evil.example", allowed)["Access-Control-Allow-Origin"], undefined);
  });
});
