// Public settings only. This file is served from a public repository, so nothing secret belongs here.
// The API URL is the Supabase Edge Function base: https://<project-ref>.supabase.co/functions/v1/api

export const CONFIG = Object.freeze({
  apiBaseUrl: "https://YOUR-PROJECT-REF.supabase.co/functions/v1/api",
  pageSize: 25,
  requestPollMs: 2000,
  // A refresh reads back up to four pages of a channel, so the wait is about 90 seconds before the saved messages show.
  requestPollAttempts: 45,
  downloadPollMs: 4000,
  // A card waits up to 30 minutes for the user's answer in the bot chat, so polling goes on that long.
  downloadPollAttempts: 450,
});
