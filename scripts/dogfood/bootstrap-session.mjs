// Dogfood bootstrap — creates ONE throwaway authed session with a workspace,
// then saves Playwright storageState so parallel dogfood agents can each load
// it into their own browser context (their own "tab"). Mirrors the e2e helper
// (tests/e2e/helpers/test-user.ts): admin-create a user via the Supabase
// service role, log in through the REAL /login UI so cookies are set exactly
// as a normal user's, seed a workspace so the (app) layout doesn't bounce to
// onboarding. Throwaway: e2e+…@marketingmagic-tests.local convention.
//
// Usage: node scripts/dogfood/bootstrap-session.mjs
// Output: /tmp/mm-dogfood/state.json  (Playwright storageState)
//         /tmp/mm-dogfood/user.json   ({ id, email, workspaceSlug }) for cleanup
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const BASE = process.env.DOGFOOD_BASE_URL || "http://localhost:3000";
const OUT_DIR = "/tmp/mm-dogfood";
const E2E_DOMAIN = "marketingmagic-tests.local";
const PASSWORD = "test-password-Aa1!";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("MISSING NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

const admin = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = Date.now().toString(36);
  const email = `e2e+dogfood-${stamp}@${E2E_DOMAIN}`;

  // 1) Admin-create a confirmed user.
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (cErr || !created?.user) throw new Error(`createUser: ${cErr?.message}`);
  const userId = created.user.id;

  // 2) Seed a workspace directly (owner_id = user) so the (app) layout resolves
  //    workspaces[0] instead of bouncing to /onboarding/workspace.
  const wsName = `Dogfood ${stamp}`;
  const wsSlug = `dogfood-${stamp}`;
  const { error: wErr } = await admin.from("workspaces").insert({
    name: wsName,
    slug: wsSlug,
    owner_id: userId,
  });
  if (wErr) throw new Error(`workspace insert: ${wErr.message}`);

  // 3) Log in through the real UI so cookies match a normal session exactly.
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: /log in/i }).click();
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 60_000 });
  const landedOn = new URL(page.url()).pathname;

  // 4) Persist session for the parallel agents + a sanity screenshot.
  await ctx.storageState({ path: `${OUT_DIR}/state.json` });
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT_DIR}/00-bootstrap-dashboard.png`, fullPage: true });

  writeFileSync(
    `${OUT_DIR}/user.json`,
    JSON.stringify({ id: userId, email, workspaceSlug: wsSlug }, null, 2),
  );

  await browser.close();
  console.log(JSON.stringify({ ok: true, email, userId, wsSlug, landedOn, outDir: OUT_DIR }, null, 2));
}

main().catch((e) => {
  console.error("BOOTSTRAP FAILED:", e?.message || e);
  process.exit(1);
});
