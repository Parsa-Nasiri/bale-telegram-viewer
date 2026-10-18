// Access to the Bale Mini App SDK. The SDK's script URL and global object name are NOT confirmed:
// docs.bale.ai/miniapp could not be read during the build. Only this file depends on them, so once the
// SDK is confirmed, change getWebApp() and nothing else.

export function getWebApp() {
  return window.Bale?.WebApp ?? null;
}

/** Returns the signed initData string the API verifies, or "" when the page is not opened inside Bale. */
export function getInitData() {
  const app = getWebApp();
  try {
    app?.ready?.();
    app?.expand?.();
  } catch {
    // A partially loaded SDK must not stop the page; the empty initData below is handled by the caller.
  }
  return typeof app?.initData === "string" ? app.initData : "";
}
