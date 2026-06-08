// Seed the throwaway dogfood workspace with ONE connected channel + a couple of
// draft posts so the queue's tag chips + image-prompt UX actually RENDER (a
// fresh workspace shows only empty-state, which blocked live verification).
//
// LinkedIn is chosen because it's a tag-bearing channel (X/Bluesky get 0 tags
// by policy, so they wouldn't show chips). Posts are pending_approval with
// tags[] populated and media[].prompt set so the image-prompt box has a seed.
//
// Idempotent-ish: keys off the dogfood user in /tmp/mm-dogfood/user.json.
// Usage: node scripts/dogfood/seed-queue-data.mjs
import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { workspaceSlug } = JSON.parse(readFileSync("/tmp/mm-dogfood/user.json", "utf8"));

async function main() {
  const { data: ws, error: wsErr } = await admin
    .from("workspaces")
    .select("id")
    .eq("slug", workspaceSlug)
    .single();
  if (wsErr || !ws) throw new Error(`workspace lookup: ${wsErr?.message}`);

  // 1) A connected LinkedIn account (tag-bearing channel). credentials is a
  //    required Json column; a dummy object is fine — we never publish.
  let { data: acct } = await admin
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", ws.id)
    .eq("channel", "linkedin")
    .maybeSingle();
  if (!acct) {
    const { data: created, error: aErr } = await admin
      .from("social_accounts")
      .insert({
        workspace_id: ws.id,
        channel: "linkedin",
        handle: "Dogfood Co.",
        credentials: { dogfood: true },
        status: "connected",
      })
      .select("id")
      .single();
    if (aErr) throw new Error(`social_account insert: ${aErr.message}`);
    acct = created;
  }

  // 2) Two pending_approval drafts: tags populated + media[].prompt set so the
  //    queue shows tag chips AND a seeded image-prompt box.
  const now = new Date();
  const slot1 = new Date(now.getTime() + 3 * 3600_000).toISOString();
  const slot2 = new Date(now.getTime() + 27 * 3600_000).toISOString();

  const drafts = [
    {
      workspace_id: ws.id,
      social_account_id: acct.id,
      channel: "linkedin",
      text: "We shipped a thing this week: the queue now suggests post times automatically, so nothing lands as 'no time set'. Small change, big quality-of-life win. What's the smallest fix that made your week better?",
      theme: "Product update",
      status: "pending_approval",
      scheduled_at: slot1,
      // Normalized per migration 052: lowercase, no leading '#'.
      tags: ["productupdate", "buildinpublic", "saas"],
      media: [
        { prompt: "A clean, on-brand product screenshot of a content queue with a glowing 'auto-scheduled' badge, soft gradient background." },
      ],
      generation_metadata: { source: "dogfood-seed" },
    },
    {
      workspace_id: ws.id,
      social_account_id: acct.id,
      channel: "linkedin",
      text: "Hot take: most teams don't have a content problem, they have a consistency problem. Cadence beats genius. Here's how we keep a weekly rhythm without burning out.",
      theme: "Thought leadership",
      status: "pending_approval",
      scheduled_at: slot2,
      tags: ["contentstrategy", "marketing", "consistency"],
      media: [],
      generation_metadata: { source: "dogfood-seed" },
    },
  ];

  // Avoid duplicate seeds on re-run.
  const { data: existing } = await admin
    .from("posts")
    .select("id")
    .eq("workspace_id", ws.id)
    .contains("generation_metadata", { source: "dogfood-seed" });
  if (existing && existing.length > 0) {
    console.log(JSON.stringify({ ok: true, note: "drafts already seeded", count: existing.length }, null, 2));
    return;
  }

  const { data: ins, error: pErr } = await admin.from("posts").insert(drafts).select("id");
  if (pErr) throw new Error(`posts insert: ${pErr.message}`);

  console.log(JSON.stringify({ ok: true, workspace: ws.id, account: acct.id, drafts: ins?.length }, null, 2));
}

main().catch((e) => {
  console.error("SEED FAILED:", e?.message || e);
  process.exit(1);
});
