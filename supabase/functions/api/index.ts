// Entry point for the Mini App API (deployed as the Supabase Edge Function `api`).
import { handleApi } from "../_shared/api.ts";
import { loadConfig } from "../_shared/config.ts";
import { Rest } from "../_shared/rest.ts";

const config = await loadConfig();
const db = new Rest(config.supabaseUrl, config.serviceKey);

Deno.serve((req) => handleApi(req, { config, db, now: () => Math.floor(Date.now() / 1000) }));
