import { test, expect } from "./helpers/test-user";

// Renders the two video pages behind an authenticated session and checks the
// "not available" gate. Both /video and /settings/video-keys short-circuit to
// a "Video generation isn't available on this deployment." notice when the
// render worker (MPT_*) or credential encryption (BYO_ENCRYPTION_KEY) is unset
// — the same graceful-degrade shape as the FAL/Stripe pages.
//
// Behaviour branches on env:
//   - feature UNCONFIGURED → assert the gate notice is visible.
//   - feature CONFIGURED   → assert the real page chrome renders instead (the
//     "Video keys" / "New video" headings), proving the gate didn't fire.
// Either way the page must return 200, never 500.

const MPT_CONFIGURED = Boolean(process.env.MPT_BASE_URL && process.env.MPT_API_TOKEN);
const BYO_CONFIGURED = Boolean(process.env.BYO_ENCRYPTION_KEY);
const FEATURE_ON = MPT_CONFIGURED && BYO_CONFIGURED;

const GATE_TEXT = /Video generation isn't available on this deployment/i;

async function bootstrapWorkspace(page: import("@playwright/test").Page) {
  await page.getByLabel(/workspace name/i).fill("Video Gate WS");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });
}

test.describe("video pages gate on MPT/BYO env", () => {
  test("/settings/video-keys renders gate or form depending on env", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);

    const response = await page.goto("/settings/video-keys");
    expect(response?.status(), "video-keys page must return 200").toBe(200);

    test.info().annotations.push({
      type: "video-keys-env",
      description: `mpt=${MPT_CONFIGURED} byo=${BYO_CONFIGURED}`,
    });

    if (FEATURE_ON) {
      // Real page: the LLM provider card heading renders, gate does not.
      await expect(page.getByText(/LLM provider/i)).toBeVisible();
      await expect(page.getByText(GATE_TEXT)).toHaveCount(0);
    } else {
      await expect(page.getByText(GATE_TEXT)).toBeVisible();
    }
  });

  test("/video renders gate or generator depending on env", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);

    const response = await page.goto("/video");
    expect(response?.status(), "video page must return 200").toBe(200);

    if (FEATURE_ON) {
      // Real page: the "New video" card renders, gate does not.
      await expect(page.getByText(/New video/i)).toBeVisible();
      await expect(page.getByText(GATE_TEXT)).toHaveCount(0);
    } else {
      await expect(page.getByText(GATE_TEXT)).toBeVisible();
    }
  });
});
