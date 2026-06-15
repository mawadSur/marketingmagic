// Dogfood the PUBLIC acquisition tool pages (no auth): /tools hub,
// /tools/handle-checker (with a live check), /tools/best-time-to-post + a
// platform page. Standalone Playwright (fresh context, no session).
import { chromium } from "playwright";

const BASE = process.env.DOGFOOD_BASE_URL || "http://localhost:3000";
const OUT = "/tmp/mm-dogfood";
const notes = [];
const note = (...a) => { const s = a.join(" "); notes.push(s); console.log("·", s); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => note("PAGEERROR:", e.message));

async function shot(name) { await page.screenshot({ path: `${OUT}/tools-${name}.png`, fullPage: true }); }

// 1. hub
await page.goto(`${BASE}/tools`, { waitUntil: "networkidle" });
await shot("01-hub");
note("hub h1:", (await page.locator("h1").first().innerText().catch(() => "")).slice(0, 60));
note("hub links handle-checker:", await page.locator('a[href="/tools/handle-checker"]').count());
note("hub links best-time:", await page.locator('a[href="/tools/best-time-to-post"]').count());

// 2. handle checker — idle + a live check
await page.goto(`${BASE}/tools/handle-checker`, { waitUntil: "networkidle" });
await shot("02-handle-idle");
try {
  await page.getByRole("textbox").first().fill("nike");
  await page.getByRole("button", { name: /check/i }).first().click();
  await page.waitForTimeout(6000);
  await shot("03-handle-result");
  note("handle result rows (cells w/ platform text):", await page.getByText(/available|taken|check/i).count());
  note("AI-ideas tease present:", await page.getByText(/ai name ideas|locked/i).count());
} catch (e) { note("handle-check interaction failed:", e.message); }

// 3. best-time hub + a platform page
await page.goto(`${BASE}/tools/best-time-to-post`, { waitUntil: "networkidle" });
await shot("04-besttime-hub");
note("besttime platform links:", await page.locator('a[href^="/tools/best-time-to-post/"]').count());
await page.goto(`${BASE}/tools/best-time-to-post/instagram`, { waitUntil: "networkidle" });
await shot("05-besttime-instagram");
note("instagram h1:", (await page.locator("h1").first().innerText().catch(() => "")).slice(0, 70));
note("start CTA present:", await page.locator('a[href="/start"]').count());

await browser.close();
console.log("\nNOTES:\n" + notes.join("\n"));
