// Reads the signed initData that the Bale Mini App SDK provides. The API checks its signature.
//
// frontend/index.html loads the SDK (https://tapi.bale.ai/miniapp.js) as Bale's Mini App docs describe. The SDK
// creates window.Bale.WebApp.

export function findWebApp(win = globalThis.window) {
  return win?.Bale?.WebApp ?? null;
}

/**
 * Returns { initData, source }. source is "sdk" when initData was found; "sdk-without-initdata" when the SDK is
 * present but sent no data; "no-sdk" when the page is not running inside Bale.
 */
export function readInitData(win = globalThis.window) {
  const app = findWebApp(win);
  try {
    app?.ready?.();
    app?.expand?.();
  } catch {
    // A partly loaded SDK must not stop the page. The checks below decide what to show.
  }
  if (typeof app?.initData === "string" && app.initData) return { initData: app.initData, source: "sdk" };
  return { initData: "", source: app ? "sdk-without-initdata" : "no-sdk" };
}
