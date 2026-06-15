// North-Star instrument for marketingmagic.
//
// Answers the questions every growth decision needs and that NOTHING in the app
// currently aggregates: how many workspaces are actively publishing, what % of
// signups ever activate, how long it takes to reach the first published post,
// and whether early cohorts stick. Read-only: SELECTs + auth.admin.listUsers,
// no writes. Mirrors the dogfood harness env loading (.env.local then .env).
//
// Run:  node scripts/metrics/north-star.mjs
// Env:  NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (service role
//       bypasses RLS — this is a founder/operator tool, never shipped to users).
//
// The North Star is WEEKLY ACTIVE PUBLISHING WORKSPACES: distinct workspaces
// with >=1 post.status='posted' in the trailing 7 days. The activation funnel
// is signup -> workspace -> channel connected -> draft -> approved/scheduled ->
// POSTED (see src/app/onboarding/* + the /queue approve flow).

import { config as loadEnv } from "dotenv";
import { createClient } from "@supabase/supabase-js";

loadEnv({ path: ".env.local", override: false });
loadEnv({ path: ".env", override: false });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error(
    "✗ Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "  Add them to .env.local (same vars the dogfood harness uses)."
  );
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const DAY = 86_400_000;
const now = Date.now();
const ago = (d) => new Date(now - d * DAY).toISOString();

// Pull every page of a select so counts are exact, not capped at 1000.
async function selectAll(table, columns, filter = (q) => q) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await filter(
      db.from(table).select(columns).range(from, from + PAGE - 1)
    );
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

async function countSignups() {
  let total = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth.listUsers: ${error.message}`);
    total += data.users.length;
    if (data.users.length < 1000) break;
  }
  return total;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function pct(n, d) {
  return d ? `${((n / d) * 100).toFixed(1)}%` : "—";
}
function humanDur(ms) {
  if (ms == null) return "—";
  const m = ms / 60_000;
  if (m < 60) return `${m.toFixed(0)}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

async function main() {
  const [signups, workspaces, accounts, posts] = await Promise.all([
    countSignups(),
    selectAll("workspaces", "id, created_at"),
    selectAll("social_accounts", "workspace_id, status"),
    selectAll("posts", "workspace_id, status, posted_at, created_at"),
  ]);

  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const posted = posts.filter((p) => p.status === "posted" && p.posted_at);

  // ── Activation funnel (distinct workspaces reaching each stage) ──────────
  const wsWithChannel = new Set(
    accounts.filter((a) => a.status === "connected").map((a) => a.workspace_id)
  );
  const wsWithDraft = new Set(posts.map((p) => p.workspace_id));
  const wsApproved = new Set(
    posts
      .filter((p) => ["approved", "scheduled", "posted"].includes(p.status))
      .map((p) => p.workspace_id)
  );
  const wsPosted = new Set(posted.map((p) => p.workspace_id));

  // ── North Star: weekly active publishing workspaces (trailing 7d) ────────
  const wapw = new Set(
    posted.filter((p) => p.posted_at >= ago(7)).map((p) => p.workspace_id)
  ).size;

  // ── Time to first published post (per workspace) ─────────────────────────
  const firstPostByWs = new Map();
  for (const p of posted) {
    const t = new Date(p.posted_at).getTime();
    const cur = firstPostByWs.get(p.workspace_id);
    if (cur == null || t < cur) firstPostByWs.set(p.workspace_id, t);
  }
  const ttfps = [];
  for (const [wsId, firstT] of firstPostByWs) {
    const ws = wsById.get(wsId);
    if (ws) ttfps.push(firstT - new Date(ws.created_at).getTime());
  }

  // ── W4 retention: of workspaces >=28d old, % that posted in their week 4 ─
  const eligible = workspaces.filter(
    (w) => now - new Date(w.created_at).getTime() >= 28 * DAY
  );
  const retainedW4 = eligible.filter((w) => {
    const base = new Date(w.created_at).getTime();
    const lo = base + 21 * DAY;
    const hi = base + 28 * DAY;
    return posted.some(
      (p) =>
        p.workspace_id === w.id &&
        new Date(p.posted_at).getTime() >= lo &&
        new Date(p.posted_at).getTime() < hi
    );
  }).length;

  // ── 8-week WAPW trend ────────────────────────────────────────────────────
  const trend = [];
  for (let wk = 7; wk >= 0; wk--) {
    const hi = now - wk * 7 * DAY;
    const lo = hi - 7 * DAY;
    const n = new Set(
      posted
        .filter((p) => {
          const t = new Date(p.posted_at).getTime();
          return t >= lo && t < hi;
        })
        .map((p) => p.workspace_id)
    ).size;
    trend.push({ label: wk === 0 ? "this wk" : `-${wk}wk`, n });
  }

  // ── Report ───────────────────────────────────────────────────────────────
  const L = (s) => console.log(s);
  L("");
  L("════════════════════════════════════════════════════════════");
  L("  marketingmagic — North Star  (" + new Date(now).toISOString().slice(0, 16).replace("T", " ") + " UTC)");
  L("════════════════════════════════════════════════════════════");
  L("");
  L(`  ★ WEEKLY ACTIVE PUBLISHING WORKSPACES : ${wapw}`);
  L("    (distinct workspaces with >=1 post published in last 7 days)");
  L("");
  L("  ── Activation funnel (all-time, distinct workspaces) ──────");
  const funnel = [
    ["Signups (auth users)", signups, signups],
    ["Created a workspace", workspaces.length, signups],
    ["Connected a channel", wsWithChannel.size, workspaces.length],
    ["Created a draft/post", wsWithDraft.size, workspaces.length],
    ["Approved/scheduled", wsApproved.size, workspaces.length],
    ["★ Published (activated)", wsPosted.size, workspaces.length],
  ];
  for (const [label, n, base] of funnel) {
    L(`    ${label.padEnd(26)} ${String(n).padStart(5)}   ${pct(n, base).padStart(7)}`);
  }
  L("");
  L("  ── Activation quality ─────────────────────────────────────");
  L(`    Activation rate (posted/workspace) : ${pct(wsPosted.size, workspaces.length)}`);
  L(`    Activation rate (posted/signup)    : ${pct(wsPosted.size, signups)}`);
  L(`    TTFP  median                       : ${humanDur(median(ttfps))}`);
  L(`    TTFP  fastest / slowest            : ${humanDur(ttfps.length ? Math.min(...ttfps) : null)} / ${humanDur(ttfps.length ? Math.max(...ttfps) : null)}`);
  L(`    W4 retention (cohorts >=28d old)   : ${pct(retainedW4, eligible.length)}  (${retainedW4}/${eligible.length})`);
  L("");
  L("  ── WAPW trend (last 8 weeks) ──────────────────────────────");
  const max = Math.max(1, ...trend.map((t) => t.n));
  for (const t of trend) {
    const bar = "█".repeat(Math.round((t.n / max) * 24));
    L(`    ${t.label.padEnd(8)} ${String(t.n).padStart(4)} ${bar}`);
  }
  L("");
  L("════════════════════════════════════════════════════════════");
  if (wsPosted.size === 0) {
    L("  READ: no workspace has published yet. The funnel is empty —");
    L("  the binding constraint is getting the first real users IN and");
    L("  through to a first published post, not optimizing rates.");
  } else {
    const worst = funnel
      .slice(1)
      .map(([label, n, base], i) => ({ label, drop: base ? 1 - n / base : 0, prev: funnel[i][0] }))
      .sort((a, b) => b.drop - a.drop)[0];
    L(`  READ: biggest funnel drop is into "${worst.label}". Fix that step.`);
  }
  L("════════════════════════════════════════════════════════════");
  L("");
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
