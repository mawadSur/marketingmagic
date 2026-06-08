// QA: Verify YouTube is the 8th channel on /settings/channels
import { drive, shot, note, BASE } from "./lib.mjs";

const EXPECTED_CHANNELS = [
  "X",
  "Bluesky",
  "Facebook",
  "Instagram",
  "Threads",
  "LinkedIn",
  "TikTok",
  "YouTube"
];

await drive("channels", async (page) => {
  // 1. Load channels page
  await page.goto(`${BASE}/settings/channels`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await shot(page, "channels-main");

  // 2. Get full body text and check for each channel
  const bodyText = await page.locator('body').innerText();
  note("=== Channel Presence Check ===");
  const present = [];
  const missing = [];

  for (const channel of EXPECTED_CHANNELS) {
    if (bodyText.includes(channel)) {
      present.push(channel);
      note(`✓ ${channel}: PRESENT`);
    } else {
      missing.push(channel);
      note(`✗ ${channel}: MISSING`);
    }
  }

  note(`Present: ${present.length}/8 - ${present.join(", ")}`);
  if (missing.length > 0) {
    note(`Missing: ${missing.length}/8 - ${missing.join(", ")}`);
  }

  // 3. Find YouTube tile specifically
  note("=== YouTube Tile Details ===");
  try {
    // Try multiple selectors to find YouTube
    const youtubeSelectors = [
      'text="YouTube"',
      '[data-channel="youtube"]',
      '[data-testid*="youtube"]',
      'div:has-text("YouTube")'
    ];

    let youtubeElement = null;
    for (const selector of youtubeSelectors) {
      try {
        youtubeElement = page.locator(selector).first();
        const count = await youtubeElement.count();
        if (count > 0) {
          note(`YouTube element found with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (youtubeElement && await youtubeElement.count() > 0) {
      // Scroll into view
      await youtubeElement.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);

      // Get parent card/tile
      const card = youtubeElement.locator('..').locator('..').first();
      const cardText = await card.innerText().catch(() => "");
      note(`YouTube tile text: ${cardText}`);

      // Look for connect button
      const connectButton = card.locator('button:has-text("Connect"), a:has-text("Connect")').first();
      const buttonCount = await connectButton.count();
      if (buttonCount > 0) {
        const buttonText = await connectButton.innerText();
        note(`Connect button text: "${buttonText}"`);
      } else {
        note("Connect button: NOT FOUND");
      }

      // Look for video-only or private hints
      const videoHints = ["video only", "video-only", "private", "forced private"];
      for (const hint of videoHints) {
        if (cardText.toLowerCase().includes(hint.toLowerCase())) {
          note(`Found hint: "${hint}"`);
        }
      }

      await shot(page, "youtube-tile");
    } else {
      note("YouTube element: NOT FOUND with any selector");
    }
  } catch (e) {
    note(`YouTube tile check error: ${e.message}`);
  }

  // 4. Count total channel tiles
  note("=== Channel Tile Count ===");
  const tileSelectors = [
    '[data-channel]',
    '[data-testid*="channel"]',
    'div[class*="channel"]',
    // Fallback: count cards in the channels grid
    'main div[class*="grid"] > div'
  ];

  let tileCount = 0;
  for (const selector of tileSelectors) {
    try {
      const count = await page.locator(selector).count();
      if (count >= 7 && count <= 10) { // Reasonable range for channel tiles
        tileCount = count;
        note(`Tiles counted with ${selector}: ${count}`);
        break;
      }
    } catch (e) {
      // Continue to next selector
    }
  }

  if (tileCount === 0) {
    note("Could not reliably count channel tiles");
  }
  note(`Total channel tiles: ${tileCount}`);

  // 5. Console errors summary
  note("=== Summary ===");
  note(`Channels present: ${present.length}/8`);
  note(`Channels missing: ${missing.length}/8`);
  note(`YouTube presence: ${present.includes("YouTube") ? "CONFIRMED" : "MISSING"}`);
  note(`Expected tile count: 8, Actual: ${tileCount || "UNKNOWN"}`);
});
