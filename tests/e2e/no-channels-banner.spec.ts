import { test, expect } from "./helpers/test-user";

// Banner contract: visible on app pages when 0 channels connected,
// suppressed on the channel-setup pages themselves. We don't connect a
// real social account in e2e (that would require burning OAuth credits)
// — instead we assert the suppression rules, since "0 connected" is the
// default state for every fresh test user.
test.describe("no-channels warning banner", () => {
  async function bootstrapWorkspace(page: import("@playwright/test").Page) {
    await page.getByLabel(/workspace name/i).fill("Banner Test WS");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });
  }

  // The banner is a top-level role="status" region. Several pages (e.g.
  // /dashboard, /settings/channels) carry their own "no channels" empty
  // states with similar copy, so target the banner by role, not text.
  const banner = (page: import("@playwright/test").Page) =>
    page.getByRole("status").filter({ hasText: /no channels connected yet/i });

  test("shows on /dashboard when no channels connected", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await page.goto("/dashboard");
    await expect(banner(page)).toBeVisible();
    await expect(
      banner(page).getByRole("link", { name: /connect a channel/i }),
    ).toBeVisible();
  });

  test("hidden on /settings/channels", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await page.goto("/settings/channels");
    await expect(banner(page)).toHaveCount(0);
  });

  test("hidden on /onboarding/wizard", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    // Already on the wizard after bootstrap — assert directly.
    await expect(banner(page)).toHaveCount(0);
  });
});
