import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── Unit: migration 037 RLS + helper invariants (static SQL assertions) ───────
//
// These pin the SECURITY-CRITICAL properties of the client-account schema at the
// source, so a future edit that widens scope fails CI:
//   • client_memberships has RLS enabled, a SELECT-own-rows-only policy, and NO
//     authenticated INSERT/UPDATE/DELETE policy (writes are service-role only).
//   • user_is_client_of is SECURITY DEFINER, derives from auth.uid() (no user-id
//     parameter), pins search_path, and is revoked-from-public then granted to
//     authenticated + service_role — mirroring the 029/033 helpers.
//   • Migration 037 NEVER touches is_workspace_member (no member-path widening).

const sqlPath = fileURLToPath(
  new URL("../../supabase/migrations/037_client_memberships.sql", import.meta.url),
);
const sql = readFileSync(sqlPath, "utf8");
const lower = sql.toLowerCase();

describe("037 — client_memberships table + RLS", () => {
  it("creates client_memberships with unique(user_id, workspace_id)", () => {
    expect(lower).toContain("create table public.client_memberships");
    expect(lower).toContain("unique (user_id, workspace_id)");
  });

  it("enables row level security on the table", () => {
    expect(lower).toContain("alter table public.client_memberships enable row level security");
  });

  it("SELECT policy scopes to the caller's own rows (user_id = auth.uid())", () => {
    expect(lower).toMatch(/for select[\s\S]*using \(user_id = auth\.uid\(\)\)/);
  });

  it("has NO authenticated write policy (no client self-link / escalation)", () => {
    // The only writer is the service role (RLS-bypassing). There must be no
    // permissive insert/update/delete policy on the table.
    expect(lower).not.toMatch(/create policy[^;]*on public\.client_memberships for insert/);
    expect(lower).not.toMatch(/create policy[^;]*on public\.client_memberships for update/);
    expect(lower).not.toMatch(/create policy[^;]*on public\.client_memberships for delete/);
  });
});

describe("037 — user_is_client_of helper", () => {
  it("is declared with a single ws_id arg — no user-id parameter to spoof", () => {
    expect(lower).toContain("function public.user_is_client_of(ws_id uuid)");
    // The body keys off auth.uid(), never an injected user id.
    expect(lower).toMatch(/cm\.user_id = auth\.uid\(\)/);
  });

  it("is SECURITY DEFINER with a pinned search_path", () => {
    expect(lower).toMatch(/function public\.user_is_client_of[\s\S]*security definer/);
    expect(lower).toMatch(/function public\.user_is_client_of[\s\S]*set search_path = public, pg_temp/);
  });

  it("is revoked from public then granted to authenticated + service_role", () => {
    expect(lower).toContain("revoke all on function public.user_is_client_of(uuid) from public");
    expect(lower).toMatch(
      /grant execute on function public\.user_is_client_of\(uuid\) to authenticated, service_role/,
    );
  });
});

describe("037 — does NOT widen the member path", () => {
  it("never creates/replaces or alters is_workspace_member (comments aside)", () => {
    // Prose comments may explain WHY we leave it alone; what matters is that no
    // DDL touches it. Strip line comments, then assert no definition statement.
    const ddl = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(ddl).not.toMatch(/(create|replace|alter|drop)[\s\S]*is_workspace_member/);
    // And client_memberships must never be referenced from is_workspace_member.
    expect(ddl).not.toContain("is_workspace_member");
  });
});
