import { vi } from "vitest";

// ── Stateful in-memory fake of the Supabase service client ────────────────────
//
// Built specifically for the public-API tests: the API path uses the SERVICE
// client (RLS bypassed), so isolation must be enforced in OUR code. A shape-only
// mock can't prove that — this fake actually stores rows and honours .eq() chains,
// so a cross-tenant read genuinely returns nothing unless the code under test
// forgot a workspace_id filter (in which case the test catches it).
//
// Supports the subset of the query builder the API lib uses: from().select()
// .eq().is().order().range().limit().maybeSingle().single(), insert().select()
// .single(), and update().eq().

export interface Row {
  [k: string]: unknown;
}

type Tables = Record<string, Row[]>;

interface Filter {
  col: string;
  val: unknown;
  op: "eq" | "is";
}

// Parse a PostgREST-style column list ("a, b, c") into field names. "*" or empty
// → null (no projection). Mirrors enough of .select() for these tests.
function parseCols(spec?: string | null): string[] | null {
  if (!spec || spec.trim() === "*") return null;
  return spec
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

class Query {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private limitN: number | null = null;
  // Column projection — mirrors PostgREST: .select("a, b") returns only a + b.
  // null = no projection set yet (return whole row).
  private cols: string[] | null = null;

  constructor(
    private rows: () => Row[],
    private onInsert?: (r: Row) => Row,
    private onUpdate?: (patch: Row, filters: Filter[]) => void,
    private mode: "select" | "insert" | "update" = "select",
    private pending?: Row | Row[],
    initialCols?: string | null,
  ) {
    this.cols = parseCols(initialCols);
  }

  private project(rows: Row[]): Row[] {
    if (!this.cols) return rows;
    const cols = this.cols;
    return rows.map((r) => {
      const out: Row = {};
      for (const c of cols) out[c] = r[c];
      return out;
    });
  }

  eq(col: string, val: unknown) {
    this.filters.push({ col, val, op: "eq" });
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push({ col, val, op: "is" });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts?.ascending ?? true;
    return this;
  }
  range(from: number, to: number) {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }

  private apply(): Row[] {
    let out = this.rows().filter((r) =>
      this.filters.every((f) =>
        f.op === "is" ? (r[f.col] ?? null) === f.val : r[f.col] === f.val,
      ),
    );
    if (this.orderCol) {
      const c = this.orderCol;
      out = [...out].sort((a, b) => {
        const av = String(a[c] ?? "");
        const bv = String(b[c] ?? "");
        return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      out = out.slice(this.rangeFrom, this.rangeTo + 1);
    }
    if (this.limitN !== null) out = out.slice(0, this.limitN);
    return out;
  }

  // select() after insert resolves to the inserted row; after update it returns
  // the (chainable) query whose await yields the updated rows (.select("id")).
  select(cols?: string) {
    this.cols = parseCols(cols);
    if (this.mode === "insert") {
      const inserted = this.onInsert!(this.pending as Row);
      const projected = this.project([inserted])[0]!;
      return {
        single: async () => ({ data: projected, error: null }),
        maybeSingle: async () => ({ data: projected, error: null }),
      };
    }
    return this;
  }

  async maybeSingle() {
    const out = this.project(this.apply());
    return { data: out[0] ?? null, error: null };
  }
  async single() {
    const out = this.project(this.apply());
    return out[0]
      ? { data: out[0], error: null }
      : { data: null, error: { message: "no rows" } };
  }

  // Awaiting a plain select/update query resolves to the row list (or applies
  // the update side effect). Implemented as a proper thenable so callers like
  // `.then(undefined, onReject)` (fire-and-forget updates) work correctly.
  then(
    onFulfilled?: ((v: { data: Row[] | null; error: null }) => unknown) | null,
    onRejected?: ((reason: unknown) => unknown) | null,
  ) {
    const exec = () => {
      if (this.mode === "update") {
        // Capture which rows match BEFORE mutating (so .select() after update
        // can return them), then apply the patch.
        const matched = this.project(this.apply());
        this.onUpdate!(this.pending as Row, this.filters);
        return { data: matched as Row[] | null, error: null as null };
      }
      return { data: this.project(this.apply()) as Row[] | null, error: null as null };
    };
    return Promise.resolve()
      .then(exec)
      .then(onFulfilled ?? undefined, onRejected ?? undefined);
  }
}

export function makeFakeService(seed: Tables) {
  const db: Tables = JSON.parse(JSON.stringify(seed));

  return {
    _db: db,
    from(table: string) {
      db[table] ??= [];
      return {
        select: (cols?: string) =>
          new Query(() => db[table]!, undefined, undefined, "select", undefined, cols),
        insert: (row: Row) =>
          new Query(
            () => db[table]!,
            (r) => {
              const withId: Row = { id: r.id ?? `${table}-${db[table]!.length + 1}`, created_at: new Date(0).toISOString(), ...r };
              db[table]!.push(withId);
              return withId;
            },
            undefined,
            "insert",
            row,
          ),
        update: (patch: Row) =>
          new Query(
            () => db[table]!,
            undefined,
            (p, filters) => {
              for (const r of db[table]!) {
                const match = filters.every((f) =>
                  f.op === "is" ? (r[f.col] ?? null) === f.val : r[f.col] === f.val,
                );
                if (match) Object.assign(r, p);
              }
            },
            "update",
            patch,
          ),
      };
    },
  };
}

/** Convenience: vi.mock the service module with a fake seeded from `seed`. */
export function mockServiceWith(seed: Tables) {
  const fake = makeFakeService(seed);
  return { fake, factory: vi.fn(() => fake) };
}
