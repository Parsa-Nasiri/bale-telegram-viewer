// Reads configuration from Deno (Supabase Edge Functions) or Node (tests). Secrets come from `supabase secrets set`.

type DenoLike = { env?: { get(key: string): string | undefined } };

export function readEnv(name: string): string | undefined {
  const deno = (globalThis as { Deno?: DenoLike }).Deno;
  if (deno?.env) return deno.env.get(name);
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export function requireEnv(name: string): string {
  const value = readEnv(name);
  if (!value) throw new Error(`missing environment variable ${name}`);
  return value;
}
