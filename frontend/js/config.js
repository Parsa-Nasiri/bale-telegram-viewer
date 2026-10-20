// Public settings only. This file is served from a public repository, so nothing secret belongs here.
// The API URL is the Supabase Edge Function base: https://<project-ref>.supabase.co/functions/v1/api

export const CONFIG = Object.freeze({
  apiBaseUrl: "https://YOUR-PROJECT-REF.supabase.co/functions/v1/api",
  pageSize: 25,
  requestPollMs: 2000,
  requestPollAttempts: 30,
  downloadPollMs: 4000,
  // A card waits up to 30 minutes for the user's answer in the bot chat, so polling goes on that long.
  downloadPollAttempts: 450,
});
