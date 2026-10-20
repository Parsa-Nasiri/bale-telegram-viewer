import assert from "node:assert/strict";
import { test } from "node:test";
import { applyTheme, readInitData, themeVariables } from "../js/bale-miniapp.js";

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

test("maps Bale's theme colors to the page tokens", () => {
  assert.deepEqual(
    themeVariables({ bg_color: "#ffffff", text_color: "#000000", hint_color: "#888888", link_color: "#2481cc" }),
    { "--bg": "#ffffff", "--text": "#000000", "--muted": "#888888", "--accent": "#2481cc" },
  );
});

test("skips values that are not plain hex colors and missing themes", () => {
  assert.deepEqual(themeVariables({ bg_color: "url(javascript:x)", text_color: 5 }), {});
  assert.deepEqual(themeVariables(undefined), {});
  assert.deepEqual(themeVariables(null), {});
});

test("applyTheme sets the colors and the color scheme on the page", () => {
  const set = [];
  const win = {
    Bale: { WebApp: { themeParams: { bg_color: "#101010" }, colorScheme: "dark" } },
    document: { documentElement: { style: { setProperty: (name, value) => set.push([name, value]) }, dataset: {} } },
  };
  applyTheme(win);
  assert.deepEqual(set, [["--bg", "#101010"]]);
  assert.equal(win.document.documentElement.dataset.theme, "dark");
});

test("applyTheme leaves the page alone outside Bale", () => {
  const root = { style: { setProperty() { throw new Error("should not be called"); } }, dataset: {} };
  applyTheme({ document: { documentElement: root } });
  assert.deepEqual(root.dataset, {});
});
