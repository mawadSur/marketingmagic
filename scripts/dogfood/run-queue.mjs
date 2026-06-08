// Queue dogfood script: verify (a) auto-tags, (b) image-prompt UX rework,
// (c) suggested-time fix. Fresh workspace = likely empty queue; test the
// compose entry points and UI if reachable.
import { drive, shot, note, BASE } from "./lib.mjs";

await drive("queue", async (page) => {
  // 1. Navigate to queue
  await page.goto(`${BASE}/queue`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "queue-main");

  // 2. Determine if queue is empty or has cards
  const emptyStateVisible = await page.locator('[data-testid="empty-state"], .empty-state, text=/no posts/i').isVisible().catch(() => false);
  const cardCount = await page.locator('[data-testid*="post-card"], [data-testid*="queue-card"], .queue-card, .post-card').count();

  note(`Queue state: ${emptyStateVisible ? 'EMPTY-STATE' : cardCount > 0 ? `${cardCount} cards` : 'UNKNOWN'}`);

  if (emptyStateVisible) {
    const emptyText = await page.locator('[data-testid="empty-state"], .empty-state').first().innerText().catch(() => '');
    note('Empty-state copy:', emptyText.slice(0, 200));
  }

  // Check for tags on any visible cards
  if (cardCount > 0) {
    const tagChipCount = await page.locator('[data-tag], .tag-chip, [class*="tag"]').count();
    note(`Tag chips visible: ${tagChipCount}`);
    if (tagChipCount > 0) {
      const firstTagText = await page.locator('[data-tag], .tag-chip, [class*="tag"]').first().innerText().catch(() => '');
      note(`First tag text: "${firstTagText}"`);
    }
  }

  // 3. Look for compose / new post / generate entry points
  const allButtons = await page.locator('button, a[href*="compose"], a[href*="create"], a[href*="new"]').allInnerTexts();
  note('Visible buttons/links (first 30):', allButtons.slice(0, 30));

  // Navigate to /queue/new to check if compose UI is accessible
  note('Navigating to /queue/new');
  await page.goto(`${BASE}/queue/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "compose-page");

  // Check if blocked by "no channels" gate
  const noChannelsCard = await page.locator('text=No channels connected').isVisible().catch(() => false);
  note(`"No channels connected" blocker: ${noChannelsCard}`);

  // Since we can't compose without channels, check the queue itself for existing drafts
  // that might show tags/image-UX. Or look at Plans -> generate flow.
  note('Cannot test compose form without channels; checking if Plans flow reveals atomize UI');

  await page.goto(`${BASE}/plans`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "plans-page");

  const plansPageTitle = await page.locator('h1, h2').first().innerText().catch(() => '');
  note(`Plans page title: "${plansPageTitle}"`);

  // Look for a way to create or view drafts from Plans
  const generatePlanButton = page.locator('button:has-text("Generate"), a[href*="new"]').first();
  const generateVisible = await generatePlanButton.isVisible().catch(() => false);
  note(`Generate/New plan button visible: ${generateVisible}`);

  // ALTERNATIVE: check the /video page which has atomize workflow and image generation
  note('Checking /video page for atomize + image-prompt UI');
  await page.goto(`${BASE}/video`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await shot(page, "video-page");

  // Check for atomize tab or image generation UI
  const atomizeTab = page.locator('button:has-text("Atomize"), [role="tab"]:has-text("Atomize")');
  const atomizeVisible = await atomizeTab.isVisible().catch(() => false);
  note(`Atomize tab visible: ${atomizeVisible}`);

  if (atomizeVisible) {
    note('Clicking Atomize tab');
    await atomizeTab.click();
    await page.waitForTimeout(1000);
    await shot(page, "atomize-tab");

    // NOW check for the fixes:
    // (a) Tags - look for tag chips
    const tagChips = await page.locator('[data-tag], .tag-chip, [class*="tag"]').count();
    note(`Tag chips in atomize: ${tagChips}`);

    // (b) Image prompt UX - look for input + suggest button + fixed 16:9 box
    const imagePromptInput = page.locator('input[name*="image"], input[placeholder*="image"], textarea[placeholder*="image"]');
    const imagePromptVisible = await imagePromptInput.isVisible().catch(() => false);
    note(`Image prompt input visible: ${imagePromptVisible}`);

    if (imagePromptVisible) {
      const placeholder = await imagePromptInput.getAttribute('placeholder').catch(() => '');
      note(`Image prompt placeholder: "${placeholder}"`);
    }

    const suggestButton = page.locator('button:has-text("Suggest")');
    const suggestVisible = await suggestButton.isVisible().catch(() => false);
    note(`"Suggest a prompt" helper visible: ${suggestVisible}`);

    const imageBoxes = await page.locator('[class*="aspect-video"], [style*="aspect-ratio"]').count();
    note(`Fixed aspect-ratio image boxes: ${imageBoxes}`);

    // (c) Time picker - suggested time
    const timeInputs = await page.locator('input[type="time"], input[type="datetime-local"], [placeholder*="time"]').count();
    note(`Time input fields: ${timeInputs}`);
  } else {
    note('Atomize tab not found; checking for image generation UI on this page');
    const imagePromptInput = page.locator('input[name*="image"], input[placeholder*="image"], textarea[placeholder*="image"]');
    const imagePromptVisible = await imagePromptInput.isVisible().catch(() => false);
    note(`Image prompt input on /video: ${imagePromptVisible}`);
  }

  // 5. Check for console errors and layout issues
  await page.waitForTimeout(500);
  const layoutShiftWarnings = await page.locator('[data-testid*="cls"], [class*="layout-shift"]').count();
  note(`Layout shift indicators: ${layoutShiftWarnings}`);
});
