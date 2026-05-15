import { test, expect } from "./helpers/test-user";

// Locks the happy-path onboarding flow that broke earlier (workspace
// creation → channels step). Any regression in the RLS recursion that
// silenced the create-workspace flow would land here.
test.describe("onboarding flow", () => {
  test("new user: signup → workspace → channels (step 2) first", async ({
    authedContext,
  }) => {
    const { page } = authedContext;

    // Brand-new account starts here — getActiveWorkspaceOrRedirect bounces
    // here when no workspace exists.
    await expect(page).toHaveURL(/\/onboarding\/workspace/);
    await expect(page.getByRole("heading", { name: /create your workspace/i })).toBeVisible();

    await page.getByLabel(/workspace name/i).fill("E2E Test Workspace");
    await page.getByRole("button", { name: /create workspace/i }).click();

    // The fix in createWorkspaceAction sends users to channels first, not
    // brief. If this assertion ever flips back to step=1, we lost the
    // "you need somewhere to publish before anything else matters" UX.
    await page.waitForURL(/\/onboarding\/wizard\?step=2/, { timeout: 45_000 });
    await expect(
      page.getByRole("heading", { name: /where do you want to post/i }),
    ).toBeVisible();
  });

  test("workspace appears in listWorkspaces after creation (RLS regression)", async ({
    authedContext,
  }) => {
    const { page } = authedContext;
    await expect(page).toHaveURL(/\/onboarding\/workspace/);

    await page.getByLabel(/workspace name/i).fill("RLS Probe");
    await page.getByRole("button", { name: /create workspace/i }).click();

    // If the workspaces ↔ memberships RLS recursion comes back, this
    // navigation either hangs on /onboarding/workspace forever or surfaces
    // the "infinite recursion" error. Either way, the URL never reaches
    // a wizard step.
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    // Belt-and-suspenders: hit the dashboard directly to prove the
    // workspace is selectable post-insert.
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
