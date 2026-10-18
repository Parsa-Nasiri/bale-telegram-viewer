// PostgREST client for Supabase, using the service role key. Runs only server-side.

import { HttpError } from "./http.ts";

export type Query = Record<string, string>;

/** The subset of the client the routes use. Tests substitute an in-memory fake. */
export type Db = Pick<Rest, "select" | "selectOne" | "insertOne" | "upsert" | "update" | "rpc">;

export class Rest {
  private readonly baseUrl: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, key: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.key = key;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private url(path: string, query?: Query): string {
    const url = new URL(`${this.baseUrl.replace(/\/$/, "")}/rest/v1/${path}`);
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value);
    return url.toString();
  }

  private async send<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; prefer?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      apikey: this.key,
      authorization: `Bearer ${this.key}`,
      accept: "application/json",
      "content-type": "application/json",
    };
    if (options.prefer) headers.prefer = options.prefer;
    const response = await this.fetchImpl(this.url(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok) {
      console.error("database request failed with status", response.status);
      throw new HttpError(502, "DATABASE_ERROR", "database request failed");
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  select<T>(table: string, query: Query): Promise<T[]> {
    return this.send<T[]>("GET", table, { query });
  }

  async selectOne<T>(table: string, query: Query): Promise<T | null> {
    const rows = await this.select<T>(table, query);
    return rows[0] ?? null;
  }

  async insertOne<T>(table: string, row: object): Promise<T> {
    const rows = await this.send<T[]>("POST", table, { body: row, prefer: "return=representation" });
    return rows[0];
  }

  upsert<T>(table: string, rows: object[], onConflict: string): Promise<T[]> {
    return this.send<T[]>("POST", table, {
      query: { on_conflict: onConflict },
      body: rows,
      prefer: "resolution=merge-duplicates,return=representation",
    });
  }

  update<T>(table: string, filters: Query, values: object): Promise<T[]> {
    return this.send<T[]>("PATCH", table, { query: filters, body: values, prefer: "return=representation" });
  }

  rpc<T>(name: string, args: object): Promise<T> {
    return this.send<T>("POST", `rpc/${name}`, { body: args });
  }
}
