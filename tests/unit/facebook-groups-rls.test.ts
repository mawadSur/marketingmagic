import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ── Unit: migration 040/041 RLS + cross-tenant invariants (static SQL) ────────
//
// The Facebook Group module lives in its OWN tables (facebook_groups +
// facebook_group_drafts) precisely BECAUSE its safety properties are subtle: it
// is a normal user CRUD surface, so members get full read/write — which means
// the ONLY thing standing between two tenants is the RLS member gate plus the
// composite FK that proves a draft's workspace equals its group's workspace.
//
// These tests pin those SECURITY-CRITICAL properties at the source, so a future
// migration edit that disables RLS, drops the WITH CHECK clause, swaps the gate
// for an unscoped `using (true)`, or weakens the composite FK back to a
// single-column one fails CI instead of silently opening a cross-tenant hole:
//   • Both tables enable RLS, expose a member-gated SELECT policy, and a
//     member-gated `for all` write policy with BOTH using() AND with check()
//     (without WITH CHECK a member of workspace A could write a row stamped
//     workspace_id = B).
//   • Neither table has any unscoped/public policy (no `using (true)`).
//   • 041 enforces the cross-tenant invariant as a DB constraint: a unique
//     (id, workspace_id) on facebook_groups so it can be a composite FK target,
//     and a composite FK (group_id, workspace_id) on facebook_group_drafts —
//     making a draft's workspace provably equal to its group's workspace.

const groupsSqlPath = fileURLToPath(
  new URL("../../supabase/migrations/040_facebook_groups.sql", import.meta.url),
);
const groupsSql = readFileSync(groupsSqlPath, "utf8");
const groups = groupsSql.toLowerCase();

const fkSqlPath = fileURLToPath(
  new URL(
    "../../supabase/migrations/041_facebook_group_drafts_workspace_fk.sql",
    import.meta.url,
  ),
);
const fkSql = readFileSync(fkSqlPath, "utf8");
const fk = fkSql.toLowerCase();

describe("040 — facebook_groups table + RLS", () => {
  it("creates the facebook_groups table", () => {
    // The whole safety story relies on group drafts living OUTSIDE `posts`, in
    // these dedicated tables, so they never touch the auto-publish cron.
    expect(groups).toContain("create table if not exists public.facebook_groups");
  });

  it("enables row level security on facebook_groups", () => {
    // Without this line the table is world-readable to any authenticated user
    // (RLS is opt-in in Postgres). This is the single most important assertion.
    expect(groups).toContain(
      "alter table public.facebook_groups enable row level security",
    );
  });

  it("gates the SELECT policy on is_workspace_member(workspace_id)", () => {
    // Reads are scoped to members of the owning workspace — not all tenants.
    expect(groups).toMatch(
      /for select[\s\S]*using \(public\.is_workspace_member\(workspace_id\)\)/,
    );
  });

  it("gates the `for all` write policy on member with BOTH using + with check", () => {
    // `for all` covers INSERT/UPDATE/DELETE. USING gates which rows you may
    // touch; WITH CHECK gates the row you END UP with. Both must reference the
    // member gate — otherwise a member of workspace A could INSERT/UPDATE a row
    // stamped workspace_id = B (USING alone never inspects the new row).
    expect(groups).toMatch(
      /for all[\s\S]*using \(public\.is_workspace_member\(workspace_id\)\)[\s\S]*with check \(public\.is_workspace_member\(workspace_id\)\)/,
    );
  });

  it("never exposes an unscoped/public policy on facebook_groups", () => {
    // A stray `using (true)` would defeat every gate above. The facebook_groups
    // policies must always be member-gated, never universally permissive.
    const groupsPolicies = groups.match(
      /create policy[^;]*on public\.facebook_groups[^;]*;/g,
    );
    expect(groupsPolicies).not.toBeNull();
    for (const policy of groupsPolicies ?? []) {
      expect(policy).not.toContain("using (true)");
    }
  });
});

describe("040 — facebook_group_drafts table + RLS", () => {
  it("creates the facebook_group_drafts table", () => {
    expect(groups).toContain(
      "create table if not exists public.facebook_group_drafts",
    );
  });

  it("enables row level security on facebook_group_drafts", () => {
    expect(groups).toContain(
      "alter table public.facebook_group_drafts enable row level security",
    );
  });

  it("gates the SELECT policy on is_workspace_member(workspace_id)", () => {
    // Drafts contain tenant copy; reads must be confined to the owning members.
    // Anchor on the drafts policy name so we don't match the groups SELECT above.
    expect(groups).toMatch(
      /facebook_group_drafts: members read own workspace[\s\S]*for select[\s\S]*using \(public\.is_workspace_member\(workspace_id\)\)/,
    );
  });

  it("gates the `for all` write policy on member with BOTH using + with check", () => {
    // Same reasoning as facebook_groups: WITH CHECK is what stops a member from
    // writing a draft stamped with another workspace's id.
    expect(groups).toMatch(
      /facebook_group_drafts: members write own workspace[\s\S]*for all[\s\S]*using \(public\.is_workspace_member\(workspace_id\)\)[\s\S]*with check \(public\.is_workspace_member\(workspace_id\)\)/,
    );
  });

  it("never exposes an unscoped/public policy on facebook_group_drafts", () => {
    const draftPolicies = groups.match(
      /create policy[^;]*on public\.facebook_group_drafts[^;]*;/g,
    );
    expect(draftPolicies).not.toBeNull();
    for (const policy of draftPolicies ?? []) {
      expect(policy).not.toContain("using (true)");
    }
  });
});

describe("041 — composite FK enforces the cross-tenant invariant", () => {
  it("adds a unique (id, workspace_id) on facebook_groups", () => {
    // The composite FK target must be a unique key; this constraint lets
    // (id, workspace_id) be referenced. Drop it and the composite FK can't exist.
    expect(fk).toMatch(
      /alter table public\.facebook_groups[\s\S]*unique \(id, workspace_id\)/,
    );
  });

  it("adds a composite FK (group_id, workspace_id) -> facebook_groups (id, workspace_id)", () => {
    // This is the load-bearing invariant: a draft's workspace_id is provably
    // equal to its group's workspace_id, so the draft RLS gate on the draft's
    // own workspace_id can never be tricked into pointing at another tenant's
    // group. A single-column FK (the thing 040 originally had) would NOT enforce
    // this — only the composite (group_id, workspace_id) tuple does.
    expect(fk).toMatch(
      /foreign key \(group_id, workspace_id\)[\s\S]*references public\.facebook_groups \(id, workspace_id\)/,
    );
  });
});
