// Reads the signed initData that the Bale Mini App SDK provides, and takes the Bale theme. The API checks the signature.
//
// frontend/index.html loads the SDK (https://tapi.bale.ai/miniapp.js) as Bale's Mini App docs describe. The SDK
// creates window.Bale.WebApp.

// Bale's theme keys (themeParams) mapped to the page's colour tokens. Only the keys listed here are read.
const THEME_TOKENS = Object.freeze({
  bg_color: "--bg",
  secondary_bg_color: "--surface",
  text_color: "--text",
  hint_color: "--muted",
  link_color: "--accent",
  destructive_text_color: "--danger",
  section_separator_color: "--border",
});
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

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

/** Maps Bale's theme colours to CSS custom properties. Anything that is not a plain hex colour is skipped. */
export function themeVariables(themeParams) {
  const variables = {};
  if (typeof themeParams !== "object" || themeParams === null) return variables;
  for (const [key, property] of Object.entries(THEME_TOKENS)) {
    const value = themeParams[key];
    if (typeof value === "string" && HEX_COLOR.test(value)) variables[property] = value;
  }
  return variables;
}

/** Applies Bale's colours and colour scheme to the page. A page without the SDK keeps its own colours. */
export function applyTheme(win = globalThis.window) {
  const app = findWebApp(win);
  const root = win?.document?.documentElement;
  if (!app || !root) return;
  try {
    for (const [property, value] of Object.entries(themeVariables(app.themeParams))) {
      root.style.setProperty(property, value);
    }
    if (app.colorScheme === "dark" || app.colorScheme === "light") root.dataset.theme = app.colorScheme;
  } catch {
    // Theming is cosmetic. A failure here must not stop the page.
  }
}
