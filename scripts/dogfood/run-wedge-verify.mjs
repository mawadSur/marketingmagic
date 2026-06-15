// Dogfood the wedge batch: public pages in a FRESH context (homepage copy,
// /for/solo-founders), authed pages with the saved session (/sources callout,
// /sources/build-in-public, /settings/referrals share module).
// Assumes bootstrap-session + seed-queue-data already ran.
import { chromium } from "playwright";

const BASE = process.env.DOGFOOD_BASE_URL || "http://localhost:3000";
const OUT = "/tmp/mm-dogfood";
const STATE = `${OUT}/state.json`;
const notes = [];
const note = (...a) => { const s = a.join(" "); notes.push(s); console.log("·", s); };

const browser = await chromium.launch();

// ---- PUBLIC (fresh, unauthenticated) ----
const pub = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const p1 = await pub.newPage();
p1.on("pageerror", (e) => note("PAGEERROR(public):", e.message));

await p1.goto(`${BASE}/`, { waitUntil: "networkidle" });
await p1.screenshot({ path: `${OUT}/wedge-01-home.png`, fullPage: false });
note("home h1:", (await p1.locator("h1").first().innerText().catch(() => "")).replace(/\n/g, " ").slice(0, 90));

await p1.goto(`${BASE}/for/solo-founders`, { waitUntil: "networkidle" });
await p1.screenshot({ path: `${OUT}/wedge-02-founders-landing.png`, fullPage: false });
note("founders-landing h1:", (await p1.locator("h1").first().innerText().catch(() => "")).replace(/\n/g, " ").slice(0, 90));
note("founders-landing /start CTA:", await p1.locator('a[href="/start"]').count());
await pub.close();

// ---- AUTHED (saved session) ----
const ctx = await browser.newContext({ storageState: STATE, viewport: { width: 1280, height: 900 } });
const p2 = await ctx.newPage();
p2.on("pageerror", (e) => note("PAGEERROR(authed):", e.message));

await p2.goto(`${BASE}/sources`, { waitUntil: "networkidle" });
await p2.screenshot({ path: `${OUT}/wedge-03-sources.png`, fullPage: false });
note("sources build-in-public callout:", await p2.locator('a[href="/sources/build-in-public"]').count());

await p2.goto(`${BASE}/sources/build-in-public`, { waitUntil: "networkidle" });
await p2.screenshot({ path: `${OUT}/wedge-04-bip.png`, fullPage: false });
note("bip textarea present:", await p2.locator("textarea").count());
note("bip generate button:", await p2.getByRole("button", { name: /turn my build|generate|week of posts/i }).count());
note("bip body text:", (await p2.locator("body").innerText()).replace(/\n/g, " ").slice(0, 140));

await p2.goto(`${BASE}/settings/referrals`, { waitUntil: "networkidle" });
await p2.screenshot({ path: `${OUT}/wedge-05-referrals.png`, fullPage: false });
note("referrals Share-on-X intent:", await p2.locator('a[href*="intent/tweet"]').count());
note("referrals copy/share buttons:", await p2.getByRole("button", { name: /copy link|copy post|share on x/i }).count());

await ctx.close();
await browser.close();
console.log("\nNOTES:\n" + notes.join("\n"));
