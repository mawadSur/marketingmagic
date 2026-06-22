// Capture launch/gallery assets for the GTM kit. Public pages in a fresh
// context (clean, no app chrome), the build-in-public feature with the authed
// session. Retina (deviceScaleFactor 2). Writes to docs/launch/assets/.
import { chromium } from "playwright";

const BASE = process.env.DOGFOOD_BASE_URL || "http://localhost:3000";
const OUT = "docs/launch/assets";
const STATE = "/tmp/mm-dogfood/state.json";
const browser = await chromium.launch();
const log = [];

async function shot(page, name, full = false) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  log.push(`${name}.png`);
}

// ---- public (fresh, retina) ----
const pub = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const p = await pub.newPage();
await p.goto(`${BASE}/`, { waitUntil: "networkidle" });
await shot(p, "01-home-hero");
await p.goto(`${BASE}/for/solo-founders`, { waitUntil: "networkidle" });
await shot(p, "02-founders-hero");
await p.goto(`${BASE}/tools/handle-checker`, { waitUntil: "networkidle" });
try {
  await p.getByRole("textbox").first().fill("loopline");
  await p.getByRole("button", { name: /check/i }).first().click();
  await p.waitForTimeout(6000);
} catch {}
await shot(p, "03-handle-checker", true);
await p.goto(`${BASE}/tools/best-time-to-post/x`, { waitUntil: "networkidle" });
await shot(p, "04-best-time-x", true);
await pub.close();

// ---- authed build-in-public feature ----
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
const a = await ctx.newPage();
await a.goto(`${BASE}/sources/build-in-public`, { waitUntil: "networkidle" });
try {
  await a.locator("textarea").fill(
    "- Shipped the feedback inbox v1 — founders can triage in one screen\n- Cut onboarding from 6 steps to 2\n- Fixed the email-digest race condition that double-sent\n- First 30 signups from the build-in-public thread, zero ad spend",
  );
} catch {}
await shot(a, "05-build-in-public");
await ctx.close();
await browser.close();
console.log("WROTE:\n" + log.map((l) => `  ${OUT}/${l}`).join("\n"));
