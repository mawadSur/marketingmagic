// Shared dogfood helper. Each parallel agent imports this so auth is solved
// ONCE (in bootstrap-session.mjs) and never reinvented. Loads the saved
// storageState into a fresh browser context (each agent = its own "tab"),
// captures console errors + page errors automatically, and gives a screenshot
// + findings writer.
//
// Typical agent script:
//   import { drive, shot, note, finish } from "./lib.mjs";
//   await drive("queue", async (page) => {
//     await page.goto(`${BASE}/queue`, { waitUntil: "domcontentloaded" });
//     await shot(page, "queue-main");
//     note("tags chips visible:", await page.locator('[data-tag]').count());
//   });
import { config as loadEnv } from "dotenv";
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

export const BASE = process.env.DOGFOOD_BASE_URL || "http://localhost:3000";
const STATE = "/tmp/mm-dogfood/state.json";

let _area = "area";
let _shotN = 0;
const _findings = { area: _area, consoleErrors: [], pageErrors: [], notes: [], shots: [] };

export function note(...args) {
  const line = args
    .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
    .join(" ");
  _findings.notes.push(line);
  console.log("·", line);
}

let _page = null;
export async function shot(page, label) {
  _shotN += 1;
  const file = `/tmp/mm-dogfood/${_area}-${String(_shotN).padStart(2, "0")}-${label}.png`;
  await page.screenshot({ path: file, fullPage: true });
  _findings.shots.push(file);
  console.log("📸", file);
  return file;
}

// drive(area, fn): opens an authed context, runs fn(page), records console +
// page errors, always writes findings JSON even if fn throws.
export async function drive(area, fn) {
  _area = area;
  _findings.area = area;
  mkdirSync("/tmp/mm-dogfood", { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ storageState: STATE });
  const page = await ctx.newPage();
  _page = page;
  page.on("console", (msg) => {
    if (msg.type() === "error") _findings.consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => _findings.pageErrors.push(String(err?.message || err)));
  let failed = null;
  try {
    await fn(page);
  } catch (e) {
    failed = e?.message || String(e);
    _findings.notes.push(`SCRIPT ERROR: ${failed}`);
    console.error("SCRIPT ERROR:", failed);
    try {
      await shot(page, "error-state");
    } catch {}
  } finally {
    await browser.close();
    finish();
  }
  if (failed) process.exitCode = 1;
}

export function finish() {
  const out = `/tmp/mm-dogfood/findings-${_area}.json`;
  writeFileSync(out, JSON.stringify(_findings, null, 2));
  console.log("\n=== FINDINGS", _area, "===");
  console.log(JSON.stringify(_findings, null, 2));
  console.log("written:", out);
}
