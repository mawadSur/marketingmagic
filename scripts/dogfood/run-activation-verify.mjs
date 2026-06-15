// Verify the activation-gate fix on the real authed onboarding wizard.
//   • step 2 with no channel-bypass skip (the closed funnel leak)
//   • step 4 "publish my first post now" card (needs a plan row + a
//     pending_approval draft, both seeded by seed-queue-data + here).
// Assumes bootstrap-session + seed-queue-data already ran.
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { drive, shot, note, finish, BASE } from "./lib.mjs";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { id: userId } = JSON.parse(readFileSync("/tmp/mm-dogfood/user.json", "utf8"));
const { data: ws } = await admin
  .from("workspaces")
  .select("id, slug")
  .eq("owner_id", userId)
  .limit(1)
  .single();

// step 4 redirects to step 3 unless a posting_plan exists — seed a minimal one.
const { data: existingPlan } = await admin
  .from("posting_plans")
  .select("id")
  .eq("workspace_id", ws.id)
  .limit(1)
  .maybeSingle();
if (!existingPlan) {
  const now = new Date("2026-06-15T00:00:00Z").getTime();
  const { error } = await admin.from("posting_plans").insert({
    workspace_id: ws.id,
    name: "Your first week",
    start_at: new Date(now).toISOString(),
    end_at: new Date(now + 7 * 86400000).toISOString(),
    status: "active",
  });
  if (error) throw new Error(`plan insert: ${error.message}`);
}

await drive("activation", async (page) => {
  // Step 2 — channel gate. No channel connected for THIS check would be ideal,
  // but seed-queue-data connected LinkedIn; the key assertion is that the
  // shell no longer renders a "Skip for now" bypass link on step 2.
  await page.goto(`${BASE}/onboarding/wizard?step=2`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await shot(page, "step2-gate");
  const skipOnStep2 = await page.getByText(/skip for now/i).count();
  note("step2 'Skip for now' links (expect 0):", skipOnStep2);

  // Step 4 — publish first post card.
  await page.goto(`${BASE}/onboarding/wizard?step=4`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  await shot(page, "step4-publish");
  const publishBtn = await page.getByRole("button", { name: /publish my first post now/i }).count();
  const previewVisible = await page.getByText(/your first post ·/i).count();
  note("step4 publish button (expect 1):", publishBtn);
  note("step4 draft preview header (expect 1):", previewVisible);
  note("landed url:", page.url());
});

finish();
