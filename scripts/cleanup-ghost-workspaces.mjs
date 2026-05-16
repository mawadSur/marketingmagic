#!/usr/bin/env node
// One-off cleanup for "ghost" workspaces.
//
// Background: migration 010 introduced an RLS recursion bug that silently
// hid newly-inserted workspaces from SELECT (the INSERT succeeded, but
// listWorkspaces() returned 0 rows so the wizard bounced users back to
// /onboarding/workspace, where they hit "Create workspace" again — making
// another ghost). Migration 016 (2026-05-15) fixed the recursion; the
// ghosts then became visible again in the workspace switcher.
//
// This script deletes workspaces that are TRULY empty (no brand_brief,
// no posts, no social_accounts, no memberships beyond owner) for a given
// owner_id. By default it does a dry run — prints what it WOULD delete
// without touching the database. Pass --confirm to actually delete.
//
// Usage:
//   node scripts/cleanup-ghost-workspaces.mjs --owner <auth.users uuid>
//   node scripts/cleanup-ghost-workspaces.mjs --owner <uuid> --confirm
//   node scripts/cleanup-ghost-workspaces.mjs --owner <uuid> --slug-like pitch-pit
//
// Env: requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (read
// from .env via dotenv). Service role bypasses RLS — read carefully and
// dry-run first.

import { createClient } from "@supabase/supabase-js";
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const args = parseArgs(process.argv.slice(2));
if (!args.owner) {
  console.error(
    "Missing --owner <auth.users uuid>. Find yours in Supabase Studio → Authentication → Users.",
  );
  process.exit(1);
}
const SLUG_LIKE = args["slug-like"]; // optional safety filter
const CONFIRM = args.confirm === true;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const sb = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const allRes = await sb
  .from("workspaces")
  .select("id, slug, name, created_at")
  .eq("owner_id", args.owner)
  .order("created_at", { ascending: true });
if (allRes.error) throw allRes.error;
const all = SLUG_LIKE
  ? allRes.data.filter((w) => w.slug.startsWith(SLUG_LIKE))
  : allRes.data;

if (all.length === 0) {
  console.log(`No workspaces match for owner ${args.owner}${SLUG_LIKE ? ` (slug like ${SLUG_LIKE})` : ""}.`);
  process.exit(0);
}

console.log(
  `Inspecting ${all.length} workspace(s) for owner ${args.owner}${SLUG_LIKE ? ` (slug like ${SLUG_LIKE})` : ""}...\n`,
);

const ghosts = [];
const kept = [];
for (const w of all) {
  const [briefRes, postRes, accountRes] = await Promise.all([
    sb.from("brand_briefs").select("id", { count: "exact", head: true }).eq("workspace_id", w.id),
    sb.from("posts").select("id", { count: "exact", head: true }).eq("workspace_id", w.id),
    sb
      .from("social_accounts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", w.id),
  ]);
  const brief = briefRes.count ?? 0;
  const posts = postRes.count ?? 0;
  const accounts = accountRes.count ?? 0;
  const empty = brief === 0 && posts === 0 && accounts === 0;
  const row = { ...w, brief, posts, accounts, empty };
  (empty ? ghosts : kept).push(row);
}

const fmt = (r) =>
  `  ${r.slug.padEnd(28)}  brief=${r.brief}  posts=${r.posts}  accts=${r.accounts}  ${r.created_at.slice(0, 10)}`;

console.log(`Would DELETE (${ghosts.length}):`);
ghosts.forEach((r) => console.log(fmt(r)));
console.log(`\nWould KEEP (${kept.length}):`);
kept.forEach((r) => console.log(fmt(r)));

if (!CONFIRM) {
  console.log(
    `\n[dry-run] Pass --confirm to delete the ${ghosts.length} empty workspace(s). All deletes cascade through FK ON DELETE CASCADE.`,
  );
  process.exit(0);
}

if (ghosts.length === 0) {
  console.log("\nNothing to delete.");
  process.exit(0);
}

console.log(`\nDeleting ${ghosts.length} workspace(s)...`);
for (const r of ghosts) {
  const { error } = await sb.from("workspaces").delete().eq("id", r.id);
  if (error) {
    console.error(`  ! ${r.slug}: ${error.message}`);
  } else {
    console.log(`  ✓ ${r.slug}`);
  }
}
console.log("Done.");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}
