import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";
import type { Database } from "../../src/lib/db/types";
import { createTestUser, deleteTestUser } from "./helpers/test-user";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

// Direct-DB regression test for the workspaces ↔ memberships ↔
// workspace_invitations RLS recursion fixed in migration 016. Bypasses
// the UI entirely: signs in as a normal authenticated user and runs
// the exact query that previously failed.
test.describe("RLS: workspaces select for an authenticated user", () => {
  test("does not throw infinite-recursion", async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    const user = await createTestUser();
    try {
      const anon = createClient<Database>(url, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInError } = await anon.auth.signInWithPassword({
        email: user.email,
        password: user.password,
      });
      expect(signInError, "sign-in should succeed").toBeNull();

      // The exact query listWorkspaces() runs. Pre-fix this returned
      // PG error "infinite recursion detected in policy for relation
      // \"workspaces\"". Post-fix: empty list, no error.
      const { data, error } = await anon
        .from("workspaces")
        .select("*")
        .order("created_at", { ascending: true });

      expect(error?.message ?? "", "workspaces SELECT should not error").not.toContain(
        "infinite recursion",
      );
      expect(error, "workspaces SELECT should not error at all").toBeNull();
      expect(Array.isArray(data)).toBe(true);
    } finally {
      await deleteTestUser(user.id);
    }
  });
});
