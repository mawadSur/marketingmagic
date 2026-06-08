// Dogfood test for recently-shipped features:
// (a) Inbox spam auto-ignore + "auto-ignored as spam" view (migration 056)
// (b) Facebook Group Discovery section at /queue/groups (migration 055)

import { drive, shot, note, BASE } from "./lib.mjs";

await drive("inbox", async (page) => {
  // 1. Verify /inbox renders + check for spam/auto-ignored filter or view
  note("=== INBOX PAGE ===");
  await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "inbox-main");

  // Capture visible tabs/filters/buttons
  const buttons = await page.locator("button").allTextContents();
  const links = await page.locator("a").allTextContents();
  const headings = await page.locator("h1, h2, h3").allTextContents();

  note("Inbox headings:", headings.filter(Boolean));
  note("Inbox buttons:", buttons.filter(Boolean));
  note("Inbox links:", links.filter(Boolean));

  // Check for spam/auto-ignored view indicators
  const pageText = await page.textContent("body");
  const hasSpamView = pageText?.toLowerCase().includes("spam") ||
                      pageText?.toLowerCase().includes("auto-ignored") ||
                      pageText?.toLowerCase().includes("ignored");

  note("Spam/auto-ignored view present:", hasSpamView);

  // Look for specific filter/tab elements
  const tabsOrFilters = await page.locator('[role="tab"], [role="tablist"] button, .tabs button, [data-filter]').allTextContents();
  note("Tab/filter elements:", tabsOrFilters.filter(Boolean));

  // Capture empty state copy if present
  const emptyStateText = await page.locator('[class*="empty"], [data-empty-state], .empty-state, p').allTextContents();
  note("Empty state copy:", emptyStateText.filter(Boolean).slice(0, 5));

  // Check console errors
  await page.waitForTimeout(500);

  // 2. Verify /queue/groups renders + check for Discover section
  note("\n=== GROUPS PAGE ===");
  await page.goto(`${BASE}/queue/groups`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "groups-main");

  const groupsHeadings = await page.locator("h1, h2, h3, h4").allTextContents();
  const groupsButtons = await page.locator("button").allTextContents();
  const groupsText = await page.textContent("body");

  note("Groups headings:", groupsHeadings.filter(Boolean));
  note("Groups buttons:", groupsButtons.filter(Boolean));

  // Check for Discover section
  const hasDiscoverSection = groupsText?.toLowerCase().includes("discover") ||
                             groupsHeadings.some(h => h?.toLowerCase().includes("discover"));

  note("Discover section present:", hasDiscoverSection);

  // Look for discover button or link
  const discoverButton = page.locator('button:has-text("Discover"), a:has-text("Discover")').first();
  const discoverButtonVisible = await discoverButton.isVisible().catch(() => false);
  note("Discover button/link visible:", discoverButtonVisible);

  // 3. Click Discover if safe (doesn't navigate away)
  if (discoverButtonVisible) {
    note("Attempting to click Discover button");
    await discoverButton.click();
    await page.waitForTimeout(1500);
    await shot(page, "groups-discover");

    // Capture what rendered
    const discoverHeadings = await page.locator("h1, h2, h3, h4").allTextContents();
    const discoverContent = await page.locator('p, li, [class*="suggestion"], [class*="archetype"]').allTextContents();

    note("Discover view headings:", discoverHeadings.filter(Boolean));
    note("Discover content (first 10):", discoverContent.filter(Boolean).slice(0, 10));

    // Check for archetype suggestions or facebook search links
    const hasFacebookLinks = await page.locator('a[href*="facebook.com"]').count();
    note("Facebook search links present:", hasFacebookLinks > 0, "count:", hasFacebookLinks);
  }

  // 4. Final check - any console/page errors
  await page.waitForTimeout(500);
  note("\nTest complete");
});
