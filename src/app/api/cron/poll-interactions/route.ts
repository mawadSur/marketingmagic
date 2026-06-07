import { NextResponse, type NextRequest } from "next/server";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { pollX } from "@/lib/interactions/pollers/x";
import { pollBluesky } from "@/lib/interactions/pollers/bluesky";
import { pollLinkedIn } from "@/lib/interactions/pollers/linkedin";
import { pollInstagram, pollThreads } from "@/lib/interactions/pollers/meta-stubs";
import type { PollerResult, PollerInteraction } from "@/lib/interactions/pollers/types";
import { MetaAppReviewPendingError } from "@/lib/interactions/errors";
import { computePriorityScore } from "@/lib/interactions/priority";
import {
  attemptAutoReply,
  type AutoReplyVoiceContext,
} from "@/lib/interactions/auto-reply/send";
import { attemptLeadCaptureDm } from "@/lib/interactions/auto-reply/dm-send";
import { isAutoReplyChannel } from "@/lib/interactions/auto-reply/policy";
import { overLimitAccountIds } from "@/lib/billing/limits";
import { loadFreshXCredentials, type XCredentials } from "@/lib/social/x";
import type { LinkedInCredentials } from "@/lib/social/linkedin";
import type { BlueskyCredentials } from "@/lib/social/bluesky";
import type { Database, InteractionChannel } from "@/lib/db/types";

// Phase 4.5 — unified poll-interactions cron.
//
// Triggered by .github/workflows/cron-poll-interactions.yml. The
// workflow hits this route every 15 minutes; this route in turn does
// per-channel throttling so LinkedIn polls run once an hour while
// X + Bluesky run every quarter hour.
//
// Auth: Bearer CRON_SECRET (same shape as the other cron routes).
//
// Pipeline per active social account:
//   1. Pick the channel-appropriate poller (x / bluesky / linkedin).
//   2. Each poller returns PollerResult { status, interactions[] }.
//      Idempotent on (channel, external_id) — the upsert ignores
//      duplicates via the unique index.
//   3. We resolve parent_post_id for each new row by matching the
//      poller's in_reply_to_external_id against posts.external_id.
//   4. Compute priority_score per row (with workspace context loaded
//      from brand_briefs.reference_links).
//   5. Handle native-reply conflict: if our own author handle has
//      already replied natively in the thread (detected as a sibling
//      with author == workspace handle), demote priority to 0 and
//      mark status=read.
//   6. Bet 4 — AUTONOMOUS AUTO-REPLY (X/Bluesky/LinkedIn only). For each
//      newly-inserted row that is still `unread` on an account that has
//      BOTH the existing publishing trust model (trust_mode) AND its
//      per-account auto_reply_mode ENGAGED ('shadow' or 'live', migration
//      048), with the workspace kill switch OFF and the hourly rate cap not
//      exceeded, we draft a reply in brand voice. In 'live' we SEND it, flip
//      the row, and log outcome='sent'. In 'shadow' we log outcome='shadow'
//      with the would-send text and do NOT post / flip — zero blast radius.
//      Everything is OFF by default; the gate + cap + mode branch live in the
//      pure src/lib/interactions/auto-reply/policy module.
//
// Errors are caught per-account so one failure doesn't kill the run.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-channel cadence in minutes. The route is invoked every 15min
// by GHA; channels with a longer cadence skip when last_polled_at
// is too recent. Tracked in-memory on the social_accounts row via
// the `last_interaction_poll_at` column on a future migration; for
// now we use a tighter algorithm: hourly channels skip 3 of every
// 4 invocations using a deterministic UTC-minute bucket.
const CHANNEL_CADENCE_MIN: Record<InteractionChannel, number> = {
  x: 15,
  bluesky: 15,
  linkedin: 60,
  instagram: 60,
  threads: 60,
};

// Cap the number of accounts processed per run. Large workspaces with
// 50+ social accounts could otherwise time out the GHA job. 200 is
// generous given today's traffic and below the 10-minute Vercel cap.
const ACCOUNTS_PER_RUN_HARD_CAP = 200;

// Look-back window for "our own recent LinkedIn posts" — comments
// older than this aren't worth re-polling.
const LINKEDIN_OWN_POSTS_LOOKBACK_DAYS = 14;

type SocialAccountRow = Database["public"]["Tables"]["social_accounts"]["Row"];
type InteractionRow = Database["public"]["Tables"]["interactions"]["Row"];

// Per-workspace context loaded once and shared across the workspace's
// accounts during a single cron run.
interface WorkspaceContextCache {
  referenceLinks: string[];
  // Bet 4 — workspace-wide auto-reply hard stop.
  killSwitch: boolean;
  // Bet 4 — voice context the auto-reply drafter needs.
  voice: AutoReplyVoiceContext;
}

interface PerAccountResult {
  socialAccountId: string;
  workspaceId: string;
  channel: string;
  status:
    | "ok"
    | "failed"
    | "skipped"
    | "tier_pending"
    | "throttled";
  inserted?: number;
  fetched?: number;
  // Bet 4 — count of rows we auto-replied to on this account this run.
  autoReplied?: number;
  // Bet 4 — count of comment→DM lead-capture DMs sent on this account this run.
  dmCaptured?: number;
  reason?: string;
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const svc = supabaseService();
  const now = new Date();

  const { data: accounts, error } = await svc
    .from("social_accounts")
    .select("*")
    .eq("status", "connected")
    .order("updated_at", { ascending: true })
    .limit(ACCOUNTS_PER_RUN_HARD_CAP);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (accounts ?? []) as SocialAccountRow[];
  const results: PerAccountResult[] = [];

  // Workspace-level cache. One fetch per workspace, shared across the
  // workspace's accounts:
  //   * referenceLinks  — for priority computation (Phase 4.5).
  //   * killSwitch       — Bet 4 workspace-wide auto-reply hard stop.
  //   * voice            — drafter context for auto-reply (voice profile +
  //                        do-not-say + product description).
  const briefByWs = new Map<string, WorkspaceContextCache>();

  // SOFT channel-cap enforcement (mirrors the post-scheduled cron): a workspace
  // over its plan's connected-channel limit (e.g. after a downgrade) keeps its
  // accounts CONNECTED — we still poll them so the inbox stays current — but its
  // OVER-LIMIT channels must not take autonomous actions (auto-reply or
  // comment→DM), in either shadow or live mode. overLimitAccountIds is the single
  // source of truth for the set (effective plan + oldest-N-kept ordering; see
  // lib/billing/limits.ts). Cache it per workspace so a run spanning many accounts
  // resolves each workspace's set just once. Empty set for unlimited plans → no-op.
  const overLimitByWs = new Map<string, Set<string>>();
  async function overLimitFor(workspaceId: string): Promise<Set<string>> {
    const cached = overLimitByWs.get(workspaceId);
    if (cached) return cached;
    const set = await overLimitAccountIds(workspaceId, svc);
    overLimitByWs.set(workspaceId, set);
    return set;
  }

  for (const acct of rows) {
    const channel = acct.channel as InteractionChannel;
    if (!CHANNEL_CADENCE_MIN[channel]) {
      // Unknown channel value (Channel union has facebook which isn't
      // in our interaction set). Skip silently.
      results.push({
        socialAccountId: acct.id,
        workspaceId: acct.workspace_id,
        channel: acct.channel,
        status: "skipped",
        reason: "channel_not_in_inbox_set",
      });
      continue;
    }

    // Channel-level throttle. The route runs every 15min; channels
    // with a 60min cadence run only when the UTC minute mod 60 is
    // within [0, 14]. Cheap deterministic gate that doesn't need a
    // DB column.
    if (CHANNEL_CADENCE_MIN[channel] >= 60) {
      const utcMin = now.getUTCMinutes();
      if (utcMin >= 15) {
        results.push({
          socialAccountId: acct.id,
          workspaceId: acct.workspace_id,
          channel,
          status: "throttled",
          reason: "hourly_window_passed",
        });
        continue;
      }
    }

    // Workspace-context fetch (once per workspace).
    if (!briefByWs.has(acct.workspace_id)) {
      briefByWs.set(
        acct.workspace_id,
        await loadWorkspaceContext(acct.workspace_id),
      );
    }
    const briefCtx = briefByWs.get(acct.workspace_id)!;

    try {
      const result = await runPoller(acct, now);
      if (result.status === "skipped" || result.status === "failed") {
        results.push({
          socialAccountId: acct.id,
          workspaceId: acct.workspace_id,
          channel,
          status: result.status,
          reason: result.reason,
        });
        continue;
      }

      const insertedIds = await persistInteractions(
        acct,
        result.interactions,
        briefCtx.referenceLinks,
        now,
      );

      // Bet 4 — comment→DM lead-capture pass, then auto-reply. Both only on
      // shippable channels (X/Bluesky/LinkedIn).
      //
      // ORDER MATTERS: the DM pass runs FIRST. It fires only on keyword
      // matches (the more specific, higher-value action) and flips matched
      // rows to status='read'. The auto-reply pass that follows reloads only
      // still-`unread` rows, so a comment captured as a lead is never ALSO
      // auto-replied to — we never both DM and publicly reply to one person.
      //
      // SOFT channel-cap gate: skip BOTH autonomous passes (shadow and live)
      // when this account is over the workspace's connected-channel limit. We
      // still poll + persist above so the inbox stays populated and the operator
      // can act manually; only the autonomous actions are withheld until the user
      // upgrades or disconnects. Same over-limit set the publish cron uses.
      let dmCaptured = 0;
      let autoReplied = 0;
      const overLimit = (await overLimitFor(acct.workspace_id)).has(acct.id);
      if (insertedIds.length > 0 && isAutoReplyChannel(acct.channel) && !overLimit) {
        dmCaptured = await runLeadCaptureDms(acct, insertedIds, briefCtx, now);
        autoReplied = await runAutoReplies(acct, insertedIds, briefCtx, now);
      }

      results.push({
        socialAccountId: acct.id,
        workspaceId: acct.workspace_id,
        channel,
        status: "ok",
        fetched: result.interactions.length,
        inserted: insertedIds.length,
        autoReplied,
        dmCaptured,
        // Polling still ran; only the autonomous actions were withheld.
        reason: overLimit ? "auto_actions_held_over_channel_limit" : undefined,
      });
    } catch (err) {
      // Special-case the Meta-App-Review-pending error so the response
      // payload distinguishes "scope not approved yet" from "real
      // failure." Both keep going.
      if (err instanceof MetaAppReviewPendingError) {
        results.push({
          socialAccountId: acct.id,
          workspaceId: acct.workspace_id,
          channel,
          status: "tier_pending",
          reason: err.scope,
        });
        continue;
      }
      results.push({
        socialAccountId: acct.id,
        workspaceId: acct.workspace_id,
        channel,
        status: "failed",
        reason: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return NextResponse.json({
    accountsChecked: rows.length,
    ok: results.filter((r) => r.status === "ok").length,
    failed: results.filter((r) => r.status === "failed").length,
    throttled: results.filter((r) => r.status === "throttled").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    tierPending: results.filter((r) => r.status === "tier_pending").length,
    autoReplied: results.reduce((sum, r) => sum + (r.autoReplied ?? 0), 0),
    dmCaptured: results.reduce((sum, r) => sum + (r.dmCaptured ?? 0), 0),
    results,
    at: now.toISOString(),
  });
}

// Load the once-per-workspace context: brand-brief reference links +
// voice for drafting, plus the Bet 4 auto-reply kill switch.
async function loadWorkspaceContext(
  workspaceId: string,
): Promise<WorkspaceContextCache> {
  const svc = supabaseService();
  const [{ data: brief }, { data: ws }] = await Promise.all([
    svc
      .from("brand_briefs")
      .select("reference_links, voice, voice_profile, do_not_say, product_description")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    svc
      .from("workspaces")
      .select("auto_reply_kill_switch")
      .eq("id", workspaceId)
      .maybeSingle(),
  ]);
  return {
    referenceLinks: brief?.reference_links ?? [],
    // Default-closed: if the column read fails for any reason, treat the
    // kill switch as ENGAGED rather than risk an unwanted auto-send.
    killSwitch: ws?.auto_reply_kill_switch ?? true,
    voice: {
      voiceProfile: brief?.voice_profile ?? null,
      voice: brief?.voice ?? "",
      doNotSay: brief?.do_not_say ?? [],
      productDescription: brief?.product_description ?? "",
    },
  };
}

// Bet 4 — run the autonomous auto-reply pass for one account over the
// newly-inserted, still-unread interaction rows. Returns the count sent.
// Each attempt is independently guarded + audited inside attemptAutoReply;
// a single failure never poisons the rest.
async function runAutoReplies(
  acct: SocialAccountRow,
  insertedIds: string[],
  ctx: WorkspaceContextCache,
  now: Date,
): Promise<number> {
  const svc = supabaseService();
  // Re-load the rows: the native-reply conflict pass may have flipped some
  // to status='read', and we only auto-reply to ones still 'unread'.
  const { data: freshRows } = await svc
    .from("interactions")
    .select("*")
    .in("id", insertedIds)
    .eq("status", "unread");
  const rows = (freshRows ?? []) as InteractionRow[];
  let sent = 0;
  for (const row of rows) {
    const result = await attemptAutoReply(
      svc,
      acct,
      row,
      ctx.killSwitch,
      ctx.voice,
      now,
    );
    if (result.outcome === "sent") sent += 1;
  }
  return sent;
}

// Bet 4 — run the comment→DM lead-capture pass for one account over the
// newly-inserted, still-unread rows. Returns the count of DMs SENT. Each
// attempt is independently gated (rule + keyword + trust + opt-in + kill
// switch + rate cap), capability-guarded, and audited inside
// attemptLeadCaptureDm; a single failure / scope-miss never poisons the rest.
// Runs BEFORE runAutoReplies so a captured lead (flipped to status='read')
// is never also auto-replied to.
async function runLeadCaptureDms(
  acct: SocialAccountRow,
  insertedIds: string[],
  ctx: WorkspaceContextCache,
  now: Date,
): Promise<number> {
  const svc = supabaseService();
  const { data: freshRows } = await svc
    .from("interactions")
    .select("*")
    .in("id", insertedIds)
    .eq("status", "unread");
  const rows = (freshRows ?? []) as InteractionRow[];
  let sent = 0;
  for (const row of rows) {
    const result = await attemptLeadCaptureDm(
      svc,
      acct,
      row,
      ctx.killSwitch,
      now,
    );
    if (result.outcome === "sent") sent += 1;
  }
  return sent;
}

// Dispatch to the channel-specific poller.
async function runPoller(
  acct: SocialAccountRow,
  now: Date,
): Promise<PollerResult> {
  const channel = acct.channel as InteractionChannel;
  switch (channel) {
    case "x": {
      const rawCreds = acct.credentials as unknown as XCredentials;
      // Refresh proactively — this cron runs every 30min and X tokens last
      // 2h, so without refresh the poll would 401 by the 4th run.
      const svc = supabaseService();
      const creds = await loadFreshXCredentials(svc, acct.id, rawCreds);
      return pollX(creds);
    }
    case "bluesky": {
      const creds = acct.credentials as unknown as BlueskyCredentials;
      return pollBluesky(creds);
    }
    case "linkedin": {
      const creds = acct.credentials as unknown as LinkedInCredentials;
      // Pull recent own LinkedIn posts so the poller can walk
      // comments on each. Scoped to LOOKBACK_DAYS.
      const since = new Date(
        now.valueOf() - LINKEDIN_OWN_POSTS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      const svc = supabaseService();
      const { data: ownPosts } = await svc
        .from("posts")
        .select("id, external_id")
        .eq("workspace_id", acct.workspace_id)
        .eq("channel", "linkedin")
        .eq("status", "posted")
        .gte("posted_at", since)
        .not("external_id", "is", null)
        .order("posted_at", { ascending: false })
        .limit(25);
      const ctx = {
        ownPosts: (ownPosts ?? [])
          .filter((p): p is { id: string; external_id: string } =>
            typeof p.external_id === "string",
          )
          .map((p) => ({ id: p.id, external_id: p.external_id })),
      };
      return pollLinkedIn(creds, ctx);
    }
    case "instagram":
      return pollInstagram();
    case "threads":
      return pollThreads();
    default:
      return { status: "skipped", reason: "unsupported_channel" };
  }
}

// Insert new interactions + recompute priority + handle native-reply
// conflict. Returns the ids of the NEW rows inserted (excludes dedup hits)
// so the caller can run the Bet 4 auto-reply pass over them.
async function persistInteractions(
  acct: SocialAccountRow,
  items: PollerInteraction[],
  referenceLinks: string[],
  now: Date,
): Promise<string[]> {
  if (items.length === 0) return [];
  const svc = supabaseService();

  // Pre-resolve parent_post_id by matching in_reply_to_external_id
  // against posts.external_id within this workspace.
  const replyToIds = Array.from(
    new Set(
      items
        .map((i) => i.in_reply_to_external_id)
        .filter((s): s is string => typeof s === "string" && s.length > 0),
    ),
  );
  const parentByExternalId = new Map<string, string>();
  if (replyToIds.length > 0) {
    const { data: parentPosts } = await svc
      .from("posts")
      .select("id, external_id")
      .eq("workspace_id", acct.workspace_id)
      .in("external_id", replyToIds);
    for (const p of parentPosts ?? []) {
      if (p.external_id) parentByExternalId.set(p.external_id, p.id);
    }
  }

  // Build rows and compute priority. We use INSERT ... ON CONFLICT DO
  // NOTHING via upsert(ignoreDuplicates) so replays don't re-write
  // priority_score on existing rows; the cron-time recompute could
  // be added later if we want priority to age in place.
  const rows: Database["public"]["Tables"]["interactions"]["Insert"][] =
    items.map((i) => {
      const score = computePriorityScore(
        {
          body: i.body,
          received_at: i.received_at,
          author_handle: i.author_handle,
          channel: i.channel,
        },
        {
          verifiedAuthor: i.verifiedAuthor,
          followerCount: i.followerCount ?? null,
          referenceLinks,
        },
        now,
      );
      return {
        workspace_id: acct.workspace_id,
        social_account_id: acct.id,
        channel: i.channel,
        external_id: i.external_id,
        parent_post_id: i.in_reply_to_external_id
          ? parentByExternalId.get(i.in_reply_to_external_id) ?? null
          : null,
        author_handle: i.author_handle,
        author_display_name: i.author_display_name,
        body: i.body,
        received_at: i.received_at,
        priority_score: score,
      };
    });

  const { data: insertedRows, error: insErr } = await svc
    .from("interactions")
    .upsert(rows, {
      onConflict: "channel,external_id",
      ignoreDuplicates: true,
    })
    .select("id, parent_post_id, author_handle, status");
  if (insErr) {
    throw new Error(`interactions upsert failed: ${insErr.message}`);
  }
  const inserted = (insertedRows ?? []) as Pick<
    InteractionRow,
    "id" | "parent_post_id" | "author_handle" | "status"
  >[];

  // ── Native-reply conflict pass ────────────────────────────────────
  //
  // For each newly-inserted interaction that has a parent_post_id we
  // own, check whether we already replied natively (the workspace's
  // own handle appears as the author of a sibling interaction with
  // status='replied' OR with received_at AFTER our posted_at). When
  // detected, demote priority_score to 0 and flip status=read with a
  // note in the body... wait, we can't add a note column.
  //
  // We mark priority_score=0 and status='read'. The UI shows a banner
  // "user already replied natively" by computing this state from the
  // sibling lookup on detail-view render — we don't need a separate
  // column.
  const ourHandle = acct.handle.toLowerCase().replace(/^@/, "");
  for (const row of inserted) {
    if (!row.parent_post_id) continue;
    if (row.status !== "unread") continue;
    // Look for any sibling interaction on the same parent with our
    // own handle as author OR any interactions.status='replied'.
    const { data: siblings } = await svc
      .from("interactions")
      .select("id, author_handle, status")
      .eq("workspace_id", acct.workspace_id)
      .eq("parent_post_id", row.parent_post_id)
      .neq("id", row.id)
      .limit(50);
    const repliedNatively = (siblings ?? []).some((s) => {
      const handle = (s.author_handle ?? "").toLowerCase().replace(/^@/, "");
      if (handle === ourHandle) return true;
      if (s.status === "replied") return true;
      return false;
    });
    if (repliedNatively) {
      await svc
        .from("interactions")
        .update({ status: "read", priority_score: 0 })
        .eq("id", row.id);
    }
  }

  return inserted.map((r) => r.id);
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}
