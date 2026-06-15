// North-Star metric computation — the single source of truth for the founder
// dashboard (/admin/metrics). The CLI variant lives at scripts/metrics/
// north-star.mjs (plain .mjs so it runs under bare node without a build step);
// keep the formulas here and there in sync — this module is canonical.
//
// All reads use the SERVICE client (RLS-bypassing) and are read-only. The North
// Star is WEEKLY ACTIVE PUBLISHING WORKSPACES: distinct workspaces with >=1
// post.status='posted' in the trailing 7 days. The activation funnel is
// signup -> workspace -> channel connected -> draft -> approved -> POSTED.

import type { supabaseService } from "@/lib/supabase/service";

type ServiceClient = ReturnType<typeof supabaseService>;

const DAY = 86_400_000;

export interface FunnelStage {
  label: string;
  count: number;
  /** Denominator for the conversion % shown next to this stage. */
  base: number;
}

export interface NorthStar {
  generatedAt: string;
  wapw: number;
  signups: number;
  workspaces: number;
  funnel: FunnelStage[];
  /** Fractions in [0,1], or null when the denominator is 0. */
  activationByWorkspace: number | null;
  activationBySignup: number | null;
  ttfp: { medianMs: number | null; minMs: number | null; maxMs: number | null };
  w4: { retained: number; eligible: number };
  trend: { label: string; count: number }[];
  /** One-line operator read of the biggest leak / state. */
  read: string;
}

// The typed client constrains .from() to known table-name literals; this helper
// is generic over tables, so query through a structurally-typed loose view.
type LooseDb = {
  from: (t: string) => {
    select: (c: string) => {
      range: (
        a: number,
        b: number,
      ) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
    };
  };
};

async function selectAll<T>(
  db: ServiceClient,
  table: string,
  columns: string,
): Promise<T[]> {
  const loose = db as unknown as LooseDb;
  const rows: T[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await loose
      .from(table)
      .select(columns)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as unknown as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

async function countSignups(db: ServiceClient): Promise<number> {
  let total = 0;
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth.listUsers: ${error.message}`);
    total += data.users.length;
    if (data.users.length < 1000) break;
  }
  return total;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export async function computeNorthStar(
  db: ServiceClient,
  nowMs: number = Date.now(),
): Promise<NorthStar> {
  const ago = (d: number) => new Date(nowMs - d * DAY).toISOString();

  const [signups, workspaces, accounts, posts] = await Promise.all([
    countSignups(db),
    selectAll<{ id: string; created_at: string }>(db, "workspaces", "id, created_at"),
    selectAll<{ workspace_id: string; status: string }>(db, "social_accounts", "workspace_id, status"),
    selectAll<{ workspace_id: string; status: string; posted_at: string | null }>(
      db,
      "posts",
      "workspace_id, status, posted_at",
    ),
  ]);

  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const posted = posts.filter((p) => p.status === "posted" && p.posted_at);

  const wsWithChannel = new Set(
    accounts.filter((a) => a.status === "connected").map((a) => a.workspace_id),
  );
  const wsWithDraft = new Set(posts.map((p) => p.workspace_id));
  const wsApproved = new Set(
    posts
      .filter((p) => ["approved", "scheduled", "posted"].includes(p.status))
      .map((p) => p.workspace_id),
  );
  const wsPosted = new Set(posted.map((p) => p.workspace_id));

  const wapw = new Set(
    posted.filter((p) => p.posted_at! >= ago(7)).map((p) => p.workspace_id),
  ).size;

  // Time to first published post, per workspace.
  const firstPostByWs = new Map<string, number>();
  for (const p of posted) {
    const t = new Date(p.posted_at!).getTime();
    const cur = firstPostByWs.get(p.workspace_id);
    if (cur == null || t < cur) firstPostByWs.set(p.workspace_id, t);
  }
  const ttfps: number[] = [];
  for (const [wsId, firstT] of firstPostByWs) {
    const ws = wsById.get(wsId);
    if (ws) ttfps.push(firstT - new Date(ws.created_at).getTime());
  }

  // W4 retention: of workspaces >=28d old, the share that posted in their week 4.
  const eligible = workspaces.filter(
    (w) => nowMs - new Date(w.created_at).getTime() >= 28 * DAY,
  );
  const retainedW4 = eligible.filter((w) => {
    const base = new Date(w.created_at).getTime();
    const lo = base + 21 * DAY;
    const hi = base + 28 * DAY;
    return posted.some(
      (p) =>
        p.workspace_id === w.id &&
        new Date(p.posted_at!).getTime() >= lo &&
        new Date(p.posted_at!).getTime() < hi,
    );
  }).length;

  // 8-week WAPW trend.
  const trend: { label: string; count: number }[] = [];
  for (let wk = 7; wk >= 0; wk--) {
    const hi = nowMs - wk * 7 * DAY;
    const lo = hi - 7 * DAY;
    const n = new Set(
      posted
        .filter((p) => {
          const t = new Date(p.posted_at!).getTime();
          return t >= lo && t < hi;
        })
        .map((p) => p.workspace_id),
    ).size;
    trend.push({ label: wk === 0 ? "now" : `-${wk}w`, count: n });
  }

  const funnel: FunnelStage[] = [
    { label: "Signups", count: signups, base: signups },
    { label: "Created a workspace", count: workspaces.length, base: signups },
    { label: "Connected a channel", count: wsWithChannel.size, base: workspaces.length },
    { label: "Created a draft", count: wsWithDraft.size, base: workspaces.length },
    { label: "Approved / scheduled", count: wsApproved.size, base: workspaces.length },
    { label: "Published (activated)", count: wsPosted.size, base: workspaces.length },
  ];

  let read: string;
  if (wsPosted.size === 0) {
    read =
      "No workspace has published yet — the binding constraint is getting the first real users through to a first published post, not optimizing rates.";
  } else {
    const worst = funnel
      .slice(1)
      .map((s) => ({ label: s.label, drop: s.base ? 1 - s.count / s.base : 0 }))
      .sort((a, b) => b.drop - a.drop)[0];
    read = `Biggest funnel drop is into "${worst.label}" (${Math.round(worst.drop * 100)}% lost). Fix that step.`;
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    wapw,
    signups,
    workspaces: workspaces.length,
    funnel,
    activationByWorkspace: workspaces.length ? wsPosted.size / workspaces.length : null,
    activationBySignup: signups ? wsPosted.size / signups : null,
    ttfp: {
      medianMs: median(ttfps),
      minMs: ttfps.length ? Math.min(...ttfps) : null,
      maxMs: ttfps.length ? Math.max(...ttfps) : null,
    },
    w4: { retained: retainedW4, eligible: eligible.length },
    trend,
    read,
  };
}
