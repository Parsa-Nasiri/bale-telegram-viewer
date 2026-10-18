import assert from "node:assert/strict";
import { test } from "node:test";
import { readInitData } from "../js/bale-miniapp.js";

test("uses initData from window.Bale.WebApp when present", () => {
  const win = { Bale: { WebApp: { initData: "signed-data", ready() {}, expand() {} } } };
  assert.deepEqual(readInitData(win), { initData: "signed-data", source: "sdk" });
});

test("reports an SDK that is present but sent no initData", () => {
  const win = { Bale: { WebApp: { initData: "" } } };
  assert.deepEqual(readInitData(win), { initData: "", source: "sdk-without-initdata" });
});

test("reports that the page is not running inside Bale", () => {
  assert.deepEqual(readInitData({}), { initData: "", source: "no-sdk" });
});

test("does not crash when ready() throws", () => {
  const win = {
    Bale: {
      WebApp: {
        initData: "x",
        ready() {
          throw new Error("boom");
        },
        expand() {},
      },
    },
  };
  assert.deepEqual(readInitData(win), { initData: "x", source: "sdk" });
});

test("treats a non-string initData as missing", () => {
  const win = { Bale: { WebApp: { initData: 5 } } };
  assert.deepEqual(readInitData(win), { initData: "", source: "sdk-without-initdata" });
});
