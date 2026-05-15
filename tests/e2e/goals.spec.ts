import { createClient } from "@supabase/supabase-js";
import { test, expect } from "./helpers/test-user";
import type { Database } from "../../src/lib/db/types";

// Phase 2.1 — covers the parts of the reverse-planner flow we can drive
// without burning a real Claude API call:
//
//   - /goals empty state for a fresh workspace
//   - /goals/new brief-prereq gate when brand_briefs is missing
//   - /goals/new form renders once a brief exists
//
// The strategy-propose + plan-generation steps would each call Claude with
// real tokens — those are exercised end-to-end manually before promoting
// the preview deploy to main. Mocking Claude here would create test
// fixtures that drift from prod.
test.describe("Goals — Phase 2.1 reverse-planner UI", () => {
  test("empty state on /goals after creating a workspace", async ({ authedContext }) => {
    const { page } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Goals UI Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    await page.goto("/goals");
    await expect(page.getByRole("link", { name: /set your first goal/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /new goal/i })).toBeVisible();
  });

  test("/goals/new gates on missing brief, links back to /settings/brief", async ({
    authedContext,
  }) => {
    const { page } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Brief Gate Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    await page.goto("/goals/new");
    // Brief-prereq gate renders the link rather than the metric questionnaire.
    await expect(page.getByRole("link", { name: /write your brief/i })).toBeVisible();
    await expect(page.getByLabel(/goal text/i)).toHaveCount(0);
  });

  test("/goals/new renders the questionnaire when a brief exists", async ({
    authedContext,
  }) => {
    const { page, user } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Form Renders Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    // Seed a brand_briefs row via service-role so we can drive the form
    // without going through the Phase 1 voice-extraction UI.
    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id")
      .eq("owner_id", user.id);
    const workspaceId = workspaces![0]!.id;
    await admin.from("brand_briefs").insert({
      workspace_id: workspaceId,
      product_description: "E2E test product description for goals form gate.",
      voice: "direct, no-fluff",
      target_audience: "founders shipping social-content tools",
      do_not_say: [],
      reference_links: [],
      reference_posts: [],
    });

    await page.goto("/goals/new");
    // Heading is "State your goal" (page.tsx:50). Form is a metric
    // dropdown + a goal-text textarea + target value/date inputs.
    await expect(page.getByRole("heading", { name: /state your goal/i })).toBeVisible();
    await expect(page.getByRole("combobox").first()).toBeVisible();
    // Brief-prereq gate text should NOT be present once the brief exists.
    await expect(page.getByRole("link", { name: /write your brief/i })).toHaveCount(0);
  });
});
