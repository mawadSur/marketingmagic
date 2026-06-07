// ─────────────────────────────────────────────────────────────
// Weekly Autonomous Growth Orchestrator — digest composer (Bet 5)
// ─────────────────────────────────────────────────────────────
//
// Bet 5 chains the four shipped bets into ONE self-driving weekly cycle. This
// module is the COMPOSER: per active workspace it assembles a "weekly growth
// digest" — what shipped, what it drove, and where to lean next week — and
// exposes a SINGLE bounded Claude call for the narrative. Delivery (Resend
// send, recipient resolution, CRON_SECRET gate, idempotency record) lives in
// /api/cron/weekly-growth, mirroring the sibling digest crons.
//
// What it chains (READS ONLY — it never re-triggers another bet's cron):
//   • Bet 1 — revenue-by-theme (computeThemeOutcomes) + theme winners
//     (loadThemeWinners). The $/outcome ranking AND the engagement winners.
//   • posts shipped + reach/engagement in the window (one metrics roll-up,
//     same shape as the engagement-report cron — no new aggregation).
//   • Bet 4 — auto_reply_log + dm_capture_log: a SUMMARY of replies/DMs that
//     already fired this week. We do NOT send anything here; poll-interactions
//     owns that. We only count its audit trail.
//   • a recommended FOCUS for next week (which themes to lean into), derived
//     deterministically from the revenue + winner signals.
//
// DRAFT BY DEFAULT: this composer only PREPARES. It returns a recommendation;
// it never publishes, replans, or atomizes. The cron honours
// workspaces.autopilot_mode (default 'draft', migration 047) and the digest
// tells the owner what's recommended vs what shipped.
//
// 429 MITIGATION: exactly ONE Claude call per workspace per cycle
// (generateWeeklyNarrative), reusing the maxRetries:6 + streaming +
// stop_reason guard pattern from src/lib/plan/generate.ts. The narrative is
// optional — if the call fails or the key is unset we ship a deterministic
// fallback summary, so the cycle never blocks on the model.

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import {
  computeThemeOutcomes,
  formatCents,
  type ThemeOutcomeStat,
} from "@/lib/analytics/outcomes";
import { loadThemeWinners, type ThemeWinner } from "@/lib/analytics/themes";

const MODEL = "claude-opus-4-8";

// Trailing window the cycle reports on. A week — the cadence of the cron.
export const WINDOW_DAYS = 7;
// How many recommended-focus themes to surface. Small so the email is a clear
// "lean into these", not a dump.
const MAX_FOCUS_THEMES = 3;
// Cap the theme-outcome rows shown in the email body.
const MAX_OUTCOME_ROWS = 5;

// ─────────────────────────────────────────────────────────────
// Window helper — the Monday (UTC) of the cycle week.
// ─────────────────────────────────────────────────────────────
//
// The idempotency key the cron records is keyed to the Monday of the week the
// cycle runs, so two ticks in the same week resolve to the same window_start
// and the second one is a no-op. Computed from a passed-in `now` so it's
// testable. Returns the ISO date string ("YYYY-MM-DD").
export function cycleWindowStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay: 0=Sun..6=Sat. Shift back to Monday (treat Sunday as +6 back).
  const dow = d.getUTCDay();
  const backToMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - backToMonday);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// Data shapes
// ─────────────────────────────────────────────────────────────

// Posts shipped + reach/engagement for the window. Same metric semantics as
// the engagement-report cron — latest snapshot per post, summed.
export interface ShippedSummary {
  posts: number;
  impressions: number;
  engagements: number; // likes + reposts + replies
}

// Bet 4 community-activity summary, read from the audit logs. Counts only —
// we never re-send. `sent` is what actually went out; `blockedOrFailed` is
// surfaced so the owner can see the guards working.
export interface CommunitySummary {
  autoRepliesSent: number;
  dmsSent: number;
  leadsTagged: number;
  blockedOrFailed: number;
}

// A revenue-ranked theme row for the email body (subset of ThemeOutcomeStat
// the renderer needs).
export interface ThemeRevenueRow {
  tag: string;
  revenueCents: number;
  outcomes: number;
}

// The full per-workspace digest payload the renderer consumes.
export interface WeeklyGrowthDigest {
  workspaceName: string;
  windowStart: string; // Monday ISO date of the cycle week
  dateLabel: string; // human "Mon, Jun 1 – Sun, Jun 7"
  mode: "draft" | "auto";
  shipped: ShippedSummary;
  revenueCents: number; // total self-reported revenue in the window
  themeRevenue: ThemeRevenueRow[]; // revenue-ranked, top N
  winners: ThemeWinner[]; // Bayesian-confident engagement winners
  community: CommunitySummary;
  // The recommended themes to lean into next week (names only). Derived
  // deterministically from revenue + winners; the narrative explains them.
  recommendedThemes: string[];
  // One-paragraph narrative (Claude or deterministic fallback). Never empty.
  narrative: string;
  dashboardUrl: string;
  analyticsUrl: string;
}

// ─────────────────────────────────────────────────────────────
// Internal reads
// ─────────────────────────────────────────────────────────────

interface PostRow {
  id: string;
  channel: string;
}
interface MetricRow {
  post_id: string;
  fetched_at: string;
  impressions: number | null;
  likes: number | null;
  reposts: number | null;
  replies: number | null;
}

// Posts shipped in the trailing window + latest metric per post, summed.
// Mirrors the engagement-report cron's roll-up so the figures never diverge.
async function loadShipped(workspaceId: string, sinceIso: string): Promise<ShippedSummary> {
  const svc = supabaseService();
  const { data: posts } = await svc
    .from("posts")
    .select("id, channel")
    .eq("workspace_id", workspaceId)
    .eq("status", "posted")
    .gte("posted_at", sinceIso)
    .limit(2000);

  const postRows = (posts ?? []) as PostRow[];
  if (postRows.length === 0) {
    return { posts: 0, impressions: 0, engagements: 0 };
  }

  const ids = postRows.map((p) => p.id);
  const { data: metrics } = await svc
    .from("post_metrics")
    .select("post_id, fetched_at, impressions, likes, reposts, replies")
    .in("post_id", ids)
    .order("fetched_at", { ascending: false });

  // First row per post = newest (desc order).
  const latest = new Map<string, MetricRow>();
  for (const m of (metrics ?? []) as MetricRow[]) {
    if (!latest.has(m.post_id)) latest.set(m.post_id, m);
  }

  let impressions = 0;
  let engagements = 0;
  for (const id of ids) {
    const m = latest.get(id);
    if (!m) continue;
    impressions += m.impressions ?? 0;
    engagements += (m.likes ?? 0) + (m.reposts ?? 0) + (m.replies ?? 0);
  }
  return { posts: postRows.length, impressions, engagements };
}

interface AutoReplyLogRow {
  outcome: "sent" | "blocked" | "failed";
}
interface DmLogRow {
  outcome: "sent" | "blocked" | "failed" | "scope_missing";
  lead_tagged: boolean;
}

// Summarise Bet 4 community activity from the audit logs (READ ONLY). poll-
// interactions owns the actual sending; we count what already fired this week.
async function loadCommunity(workspaceId: string, sinceIso: string): Promise<CommunitySummary> {
  const svc = supabaseService();

  const [{ data: replies }, { data: dms }] = await Promise.all([
    svc
      .from("auto_reply_log")
      .select("outcome")
      .eq("workspace_id", workspaceId)
      .gte("created_at", sinceIso)
      .limit(5000),
    svc
      .from("dm_capture_log")
      .select("outcome, lead_tagged")
      .eq("workspace_id", workspaceId)
      .gte("created_at", sinceIso)
      .limit(5000),
  ]);

  let autoRepliesSent = 0;
  let blockedOrFailed = 0;
  for (const r of (replies ?? []) as AutoReplyLogRow[]) {
    if (r.outcome === "sent") autoRepliesSent += 1;
    else if (r.outcome === "blocked" || r.outcome === "failed") blockedOrFailed += 1;
  }

  let dmsSent = 0;
  let leadsTagged = 0;
  for (const d of (dms ?? []) as DmLogRow[]) {
    if (d.outcome === "sent") {
      dmsSent += 1;
      if (d.lead_tagged) leadsTagged += 1;
    } else if (d.outcome === "blocked" || d.outcome === "failed") {
      // scope_missing is a clean no-op, not a guard block — don't count it.
      blockedOrFailed += 1;
    }
  }

  return { autoRepliesSent, dmsSent, leadsTagged, blockedOrFailed };
}

// ─────────────────────────────────────────────────────────────
// Recommended focus — deterministic, the loop-closing decision.
// ─────────────────────────────────────────────────────────────
//
// "Which themes to lean into next week." Revenue is the primary signal (Bet 1's
// whole point): themes that drove $ first. Confident engagement winners fill
// the rest. Deterministic so the recommendation is reproducible and the ONE
// Claude call only NARRATES it — it doesn't decide it (keeps the model in an
// explain role, not a planning role, which is the draft-by-default posture).
function recommendFocus(
  themeOutcomes: ThemeOutcomeStat[],
  winners: ThemeWinner[],
): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();

  const push = (tag: string) => {
    const t = tag.trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    ordered.push(t);
  };

  // 1. Revenue-driving themes first (already revenue-desc sorted).
  for (const t of themeOutcomes) {
    if (t.revenue_cents > 0) push(t.tag);
    if (ordered.length >= MAX_FOCUS_THEMES) break;
  }
  // 2. Confident engagement winners (already lift-desc sorted) fill the rest.
  for (const w of winners) {
    if (ordered.length >= MAX_FOCUS_THEMES) break;
    push(w.tag);
  }
  // 3. If still nothing with $, fall back to outcome-count leaders so a young
  //    workspace with leads-but-no-$ still gets a steer.
  if (ordered.length === 0) {
    for (const t of themeOutcomes) {
      if (ordered.length >= MAX_FOCUS_THEMES) break;
      push(t.tag);
    }
  }

  return ordered.slice(0, MAX_FOCUS_THEMES);
}

// ─────────────────────────────────────────────────────────────
// Assembly — one read pass, no Claude call here.
// ─────────────────────────────────────────────────────────────
//
// Returns null on COLD START — a workspace that shipped nothing, has no
// outcomes/winners, and had no community activity this week. The cron skips
// the send (no empty email), exactly like the learning-digest cron.

export interface AssembleOpts {
  workspaceName: string;
  mode: "draft" | "auto";
  dashboardUrl: string;
  analyticsUrl: string;
  now: Date;
}

// The payload BEFORE the narrative is attached. Splitting assembly from the
// (optional, rate-limited) Claude call keeps the single-call boundary explicit
// and lets the cron decide whether to spend a model call at all.
export type AssembledDigest = Omit<WeeklyGrowthDigest, "narrative">;

export async function assembleWeeklyDigest(
  workspaceId: string,
  opts: AssembleOpts,
): Promise<AssembledDigest | null> {
  const sinceIso = new Date(opts.now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Pull every signal in parallel. Each is independently resilient — a failure
  // in one (e.g. themes db hiccup) degrades to empty rather than killing the
  // whole digest, matching the learning-digest resilience posture.
  const [shipped, outcomeReport, winners, community] = await Promise.all([
    loadShipped(workspaceId, sinceIso).catch((err) => {
      console.warn(`[weekly-growth] shipped load failed for ${workspaceId}:`, err);
      return { posts: 0, impressions: 0, engagements: 0 } satisfies ShippedSummary;
    }),
    computeThemeOutcomes(workspaceId).catch((err) => {
      console.warn(`[weekly-growth] theme outcomes failed for ${workspaceId}:`, err);
      return { hasOutcomes: false, themes: [], totalOutcomes: 0, totalRevenueCents: 0 };
    }),
    loadThemeWinners(workspaceId, MAX_FOCUS_THEMES).catch((err) => {
      console.warn(`[weekly-growth] winners failed for ${workspaceId}:`, err);
      return [] as ThemeWinner[];
    }),
    loadCommunity(workspaceId, sinceIso).catch((err) => {
      console.warn(`[weekly-growth] community summary failed for ${workspaceId}:`, err);
      return {
        autoRepliesSent: 0,
        dmsSent: 0,
        leadsTagged: 0,
        blockedOrFailed: 0,
      } satisfies CommunitySummary;
    }),
  ]);

  const themeRevenue: ThemeRevenueRow[] = outcomeReport.themes
    .slice(0, MAX_OUTCOME_ROWS)
    .map((t) => ({ tag: t.tag, revenueCents: t.revenue_cents, outcomes: t.outcomes }));

  const recommendedThemes = recommendFocus(outcomeReport.themes, winners);

  // COLD START — nothing happened this week and nothing to recommend. Skip.
  const hadActivity =
    shipped.posts > 0 ||
    community.autoRepliesSent > 0 ||
    community.dmsSent > 0 ||
    outcomeReport.totalOutcomes > 0 ||
    winners.length > 0;
  if (!hadActivity) return null;

  return {
    workspaceName: opts.workspaceName,
    windowStart: cycleWindowStart(opts.now),
    dateLabel: windowLabel(opts.now),
    mode: opts.mode,
    shipped,
    revenueCents: outcomeReport.totalRevenueCents,
    themeRevenue,
    winners,
    community,
    recommendedThemes,
    dashboardUrl: opts.dashboardUrl,
    analyticsUrl: opts.analyticsUrl,
  };
}

// Human "Mon, Jun 1 – Sun, Jun 7" for the window ending at `now`.
function windowLabel(now: Date): string {
  const end = new Date(now);
  const start = new Date(now.getTime() - (WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return `${fmt(start)} – ${fmt(end)}`;
}

// ─────────────────────────────────────────────────────────────
// The ONE Claude call — narrative only (429-bounded).
// ─────────────────────────────────────────────────────────────
//
// Exactly one streamed call per workspace per cycle, maxRetries:6, with the
// max_tokens stop_reason guard from plan/generate.ts. The model NARRATES the
// already-decided numbers + recommendation; it does not decide anything, so a
// failure is non-fatal — the caller falls back to deterministicNarrative.

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
}

// Deterministic, always-available summary. Used when ANTHROPIC_API_KEY is
// unset OR the single Claude call fails — the cycle never blocks on the model.
export function deterministicNarrative(d: AssembledDigest): string {
  const parts: string[] = [];
  parts.push(
    `This week you shipped ${d.shipped.posts} post${d.shipped.posts === 1 ? "" : "s"}` +
      ` reaching ${d.shipped.impressions.toLocaleString("en-US")} impressions` +
      ` and ${d.shipped.engagements.toLocaleString("en-US")} engagements.`,
  );
  if (d.revenueCents > 0) {
    parts.push(`Self-reported outcomes drove ${formatCents(d.revenueCents)} in attributed value.`);
  }
  if (d.community.autoRepliesSent > 0 || d.community.dmsSent > 0) {
    parts.push(
      `Community autopilot sent ${d.community.autoRepliesSent} repl${d.community.autoRepliesSent === 1 ? "y" : "ies"}` +
        ` and ${d.community.dmsSent} DM${d.community.dmsSent === 1 ? "" : "s"}` +
        (d.community.leadsTagged > 0 ? `, capturing ${d.community.leadsTagged} lead${d.community.leadsTagged === 1 ? "" : "s"}.` : "."),
    );
  }
  if (d.recommendedThemes.length > 0) {
    parts.push(`Recommended focus next week: ${humanList(d.recommendedThemes)}.`);
  }
  return parts.join(" ");
}

export async function generateWeeklyNarrative(d: AssembledDigest): Promise<string> {
  // No key → deterministic. Never throw; the cycle is resilient by design.
  if (!serverEnv().ANTHROPIC_API_KEY) return deterministicNarrative(d);

  const context = JSON.stringify({
    posts_shipped: d.shipped.posts,
    impressions: d.shipped.impressions,
    engagements: d.shipped.engagements,
    revenue_dollars: Math.round(d.revenueCents) / 100,
    theme_revenue: d.themeRevenue.map((t) => ({
      theme: t.tag,
      revenue_dollars: Math.round(t.revenueCents) / 100,
      outcomes: t.outcomes,
    })),
    confident_winners: d.winners.map((w) => ({ theme: w.tag, lift: Math.round((w.lift - 1) * 100) })),
    auto_replies_sent: d.community.autoRepliesSent,
    dms_sent: d.community.dmsSent,
    leads_tagged: d.community.leadsTagged,
    recommended_focus: d.recommendedThemes,
  });

  const system = [
    "You write a SHORT weekly growth recap for the owner of a small marketing workspace.",
    "You are given the already-computed numbers and an already-chosen recommended focus.",
    "Write ONE plain-language paragraph (3-5 sentences, no markdown, no lists, no headings):",
    "what shipped, what it drove ($/engagement), what the community autopilot did, and why the",
    "recommended focus makes sense. Do NOT invent numbers — use only what's provided. Do NOT",
    "tell the user to take an action that isn't 'lean into these themes'; this is a recommendation,",
    "the owner decides. Be concrete and concise.",
  ].join(" ");

  try {
    // Stream + finalMessage + max_tokens guard — the plan/generate.ts pattern.
    // Narrative is tiny, but streaming keeps us consistent with the 429-hardened
    // call sites and avoids any HTTP-timeout edge.
    const stream = client().messages.stream({
      model: MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: `This week's data:\n\n${context}` }],
    });
    const resp = await stream.finalMessage();
    if (resp.stop_reason === "max_tokens") {
      // Ran out of budget mid-paragraph — fall back rather than ship a cut-off line.
      return deterministicNarrative(d);
    }
    const textBlock = resp.content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text.trim() : "";
    return text.length > 0 ? text : deterministicNarrative(d);
  } catch (err) {
    console.warn(`[weekly-growth] narrative call failed for ${d.workspaceName}:`, err);
    return deterministicNarrative(d);
  }
}

// "a, b and c" — shared with the renderer's focus line.
export function humanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]!}`;
}
