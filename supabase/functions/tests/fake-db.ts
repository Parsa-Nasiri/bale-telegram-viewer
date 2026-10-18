// In-memory stand-in for the PostgREST client. It implements only the filter forms the routes use
// (eq., lt., gte., in.(...)) plus order and limit, and records every write so tests can assert on them.

export type Row = Record<string, unknown>;
export type Query = Record<string, string>;

export const FAKE_CLOCK_ISO = new Date(1_800_000_000_000).toISOString();
const CONTROL_KEYS = new Set(["select", "order", "limit"]);

function compare(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export class FakeDb {
  readonly tables: Record<string, Row[]>;
  readonly inserts: { table: string; row: Row }[] = [];
  readonly updates: { table: string; filters: Query; values: Row }[] = [];
  readonly upserts: { table: string; rows: Row[]; onConflict: string }[] = [];
  readonly rpcs: { name: string; args: Row }[] = [];
  private seq = 0;

  constructor(tables: Record<string, Row[]> = {}) {
    this.tables = structuredClone(tables);
  }

  private table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  private matches(row: Row, query: Query): boolean {
    for (const [column, expr] of Object.entries(query)) {
      if (CONTROL_KEYS.has(column)) continue;
      const value = row[column];
      if (expr.startsWith("eq.")) {
        if (String(value) !== expr.slice(3)) return false;
      } else if (expr.startsWith("lt.")) {
        if (!(Number(value) < Number(expr.slice(3)))) return false;
      } else if (expr.startsWith("gte.")) {
        if (!(String(value) >= expr.slice(4))) return false;
      } else if (expr.startsWith("in.(") && expr.endsWith(")")) {
        if (!expr.slice(4, -1).split(",").includes(String(value))) return false;
      } else {
        throw new Error(`fake db does not support filter ${column}=${expr}`);
      }
    }
    return true;
  }

  async select(table: string, query: Query): Promise<Row[]> {
    let rows = this.table(table).filter((row) => this.matches(row, query));
    if (query.order) {
      const [column, direction] = query.order.split(".");
      const sign = direction === "desc" ? -1 : 1;
      rows = [...rows].sort((a, b) => sign * compare(a[column], b[column]));
    }
    if (query.limit !== undefined) rows = rows.slice(0, Number(query.limit));
    return rows.map((row) => ({ ...row }));
  }

  async selectOne(table: string, query: Query): Promise<Row | null> {
    return (await this.select(table, query))[0] ?? null;
  }

  async insertOne(table: string, row: Row): Promise<Row> {
    const full: Row = {
      id: `row-${++this.seq}`,
      status: "queued",
      attempts: 0,
      created_at: FAKE_CLOCK_ISO,
      updated_at: FAKE_CLOCK_ISO,
      ...row,
    };
    this.table(table).push(full);
    this.inserts.push({ table, row: full });
    return { ...full };
  }

  /** Mirrors PostgREST merge-duplicates: only the supplied columns change on an existing row. */
  async upsert(table: string, rows: Row[], onConflict: string): Promise<Row[]> {
    const list = this.table(table);
    this.upserts.push({ table, rows, onConflict });
    const out: Row[] = [];
    for (const row of rows) {
      const existing = list.find((candidate) => candidate[onConflict] === row[onConflict]);
      if (existing) {
        Object.assign(existing, row);
        out.push({ ...existing });
      } else {
        const created: Row = { id: `row-${++this.seq}`, bale_chat_id: null, ...row };
        list.push(created);
        out.push({ ...created });
      }
    }
    return out;
  }

  async update(table: string, filters: Query, values: Row): Promise<Row[]> {
    this.updates.push({ table, filters, values });
    const changed: Row[] = [];
    for (const row of this.table(table)) {
      if (this.matches(row, filters)) {
        Object.assign(row, values);
        changed.push({ ...row });
      }
    }
    return changed;
  }

  async rpc(name: string, args: Row): Promise<number> {
    this.rpcs.push({ name, args });
    return 1000 + this.rpcs.length;
  }
}
