// Dogfood the activation-batch UI changes on the real authed app:
//   A — settings/channels "fill your queue" CTA (connected + 0 plans)
//   B — onboarding wizard step-3 skip gate
//   D — dashboard "next best action" activation card
// Run it twice against the same session: PHASE=pre (fresh user, no channel) and
// PHASE=post (after seed-queue-data: 1 channel + drafts, 0 plans). Assumes
// bootstrap-session already ran. Tag screenshots by phase.
import { drive, shot, note, finish, BASE } from "./lib.mjs";

const PHASE = process.env.PHASE || "pre";

await drive(`batch-${PHASE}`, async (page) => {
  // D — dashboard activation card
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await shot(page, "dashboard");
  for (const [label, re] of [
    ["Connect your first channel", /connect your first channel/i],
    ["Generate your first week", /generate your first week/i],
    ["Publish your first post", /publish your first post/i],
  ]) {
    const n = await page.getByText(re).count();
    if (n > 0) note(`dashboard card → "${label}"`, "VISIBLE");
  }

  // A — settings/channels CTA
  await page.goto(`${BASE}/settings/channels`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await shot(page, "channels");
  note("channels 'fill your queue' CTA:", await page.getByText(/fill your queue/i).count());
  note("channels 'now fill your queue' headline:", await page.getByText(/now fill your queue/i).count());

  // B — wizard step 3 skip gate
  await page.goto(`${BASE}/onboarding/wizard?step=3`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await shot(page, "wizard-step3");
  const skipToDash = await page.locator('a[href="/dashboard"]').count();
  const skipLater = await page.getByText(/skip — i'll plan later|i'll do this later/i).count();
  note("wizard step3 links to /dashboard (expect 0):", skipToDash);
  note("wizard step3 'skip/later' links:", skipLater);
  // capture any skip link target for the nudge variants
  const skipHrefs = await page.locator('a:has-text("later"), a:has-text("Skip")').evaluateAll(
    (els) => els.map((e) => e.getAttribute("href")),
  );
  note("wizard step3 skip hrefs:", JSON.stringify(skipHrefs));
});

finish();
