import { drive, shot, note, BASE } from "./lib.mjs";

await drive("billing", async (page) => {
  // 1. Navigate to billing page
  await page.goto(`${BASE}/settings/billing`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500); // Wait for hydration

  // 2. Take main screenshot
  await shot(page, "billing-main");

  // 3. Assert paid prices render correctly
  const bodyText = await page.textContent("body");
  const has29 = bodyText.includes("$29");
  const has97 = bodyText.includes("$97");
  const has499 = bodyText.includes("$499");

  note("Price $29:", has29 ? "PRESENT" : "MISSING");
  note("Price $97:", has97 ? "PRESENT" : "MISSING");
  note("Price $499:", has499 ? "PRESENT" : "MISSING");

  // 4. Assert display names present
  const hasSolo = bodyText.includes("Solo");
  const hasCreator = bodyText.includes("Creator");
  const hasAgency = bodyText.includes("Agency");
  const hasFree = bodyText.includes("Free");

  note("Plan 'Solo':", hasSolo ? "PRESENT" : "MISSING");
  note("Plan 'Creator':", hasCreator ? "PRESENT" : "MISSING");
  note("Plan 'Agency':", hasAgency ? "PRESENT" : "MISSING");
  note("Plan 'Free':", hasFree ? "PRESENT" : "MISSING");

  // 5. Assert grandfather notice is GONE
  const hasMovesTo = bodyText.includes("moves to $");
  const hasOriginalPrice = bodyText.includes("your original price");
  const grandfatherAbsent = !hasMovesTo && !hasOriginalPrice;

  note("Grandfather notice:", grandfatherAbsent ? "PASS (absent)" : "FAIL (present)");
  if (hasMovesTo) note("  - Found: 'moves to $'");
  if (hasOriginalPrice) note("  - Found: 'your original price'");

  // 6. Check AI credits headline numbers
  const has1250 = bodyText.includes("1,250");
  const has5000 = bodyText.includes("5,000");
  const has28000 = bodyText.includes("28,000");
  const hasUnlimited = bodyText.includes("Unlimited AI writing");

  note("Solo credits (1,250):", has1250 ? "PRESENT" : "MISSING");
  note("Creator credits (5,000):", has5000 ? "PRESENT" : "MISSING");
  note("Agency credits (28,000):", has28000 ? "PRESENT" : "MISSING");
  note("Unlimited AI writing:", hasUnlimited ? "PRESENT" : "MISSING");

  // 7. Scroll to Free card and screenshot
  const freeCard = page.locator('text="Free"').first();
  if (await freeCard.count() > 0) {
    await freeCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
  }
  await shot(page, "billing-free-card");

  // 8. Check for layout issues
  const layoutNote = [];

  // Check if all plan cards are visible
  const planCards = await page.locator('[class*="card"], [class*="Card"]').count();
  layoutNote.push(`Found ${planCards} card elements`);

  note("Layout observations:", layoutNote.join(", "));
});
