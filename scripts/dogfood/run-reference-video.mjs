// Dogfood — verify the FAL reference-image video feature surface is LIVE.
//
// Loads /settings/reference-video in an authed context and asserts the page
// rendered its ENABLED state, NOT one of the two dark/gated fallbacks:
//   • amber "This feature isn't enabled yet" → REFERENCE_VIDEO_ENABLED off
//   • "Credential encryption isn't configured" → BYO_ENCRYPTION_KEY missing
// A pass proves the live app reads both env flags correctly and the fal-key
// card + Generate form render. It does NOT start a render (no paid fal call).
//
// Usage: DOGFOOD_BASE_URL=https://marketingmagic.vercel.app node scripts/dogfood/run-reference-video.mjs
import { drive, shot, note, BASE } from "./lib.mjs";

await drive("reference-video", async (page) => {
  await page.goto(`${BASE}/settings/reference-video`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await shot(page, "reference-video");

  const bodyText = await page.locator("body").innerText();

  // The two dark/gated fallbacks we must NOT see.
  const flagOff = bodyText.includes("isn't enabled yet") || bodyText.includes("REFERENCE_VIDEO_ENABLED");
  const noEncryption = bodyText.includes("Credential encryption isn't configured");

  // Enabled-state markers (the page header + the fal-key card + the Generate
  // card all render only past both gates).
  const hasHeader = bodyText.includes("Reference-image video");
  const hasFalCard = bodyText.includes("fal video key");
  const hasGenerate = bodyText.includes("Animate a photo") || bodyText.includes("make it talk");

  note("flag OFF banner present:", flagOff);
  note("encryption-missing banner present:", noEncryption);
  note("header present:", hasHeader);
  note("fal-key card present:", hasFalCard);
  note("generate form present:", hasGenerate);

  // Is a fal key already configured on THIS (throwaway) workspace? Expected
  // false — keys are per-workspace BYO; a fresh workspace has none. The "Add"
  // vs "Replace" affordance is what we read.
  const falConfigured = bodyText.includes("fal video key") && /\bReplace\b/.test(bodyText);
  note("fal key configured on this workspace:", falConfigured);

  const live = !flagOff && !noEncryption && hasHeader && hasFalCard && hasGenerate;
  note("VERDICT — FAL reference-video surface LIVE:", live);
  if (!live) {
    throw new Error(
      `FAL surface NOT live (flagOff=${flagOff} noEncryption=${noEncryption} header=${hasHeader} falCard=${hasFalCard} generate=${hasGenerate})`,
    );
  }
});
