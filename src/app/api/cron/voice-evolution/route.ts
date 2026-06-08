import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/service";
import { voiceProfileDiffSchema } from "@/lib/voice/schema";
import { loadSentExemplars, type SentExemplar } from "@/lib/voice/from-sent";
import type { VoiceProfile, VoiceProfileDiff } from "@/lib/db/types";

// Weekly voice-evolution cron. Runs Monday 13:00 UTC from
// .github/workflows/cron-voice-evolution.yml. Auth: Bearer CRON_SECRET.
//
// For each workspace with a voice_profile we propose a CONSERVATIVE diff to
// the profile from TWO signals (TODO #0, gap 2):
//   1. Rejection feedback — posts the user rejected as off-voice (nudge AWAY
//      from what they don't want). The original signal.
//   2. The user's OWN sent/published text — published posts + manually-sent
//      inbox replies (converge TOWARD how the user actually writes). NEW.
// We run when there is enough of EITHER signal. The diff is persisted to
// brand_briefs.pending_voice_diff; the user accepts (merge) or dismisses
// from /settings/brief.
//
// Service-role client used throughout — RLS would block cross-workspace
// reads. Diffs are NEVER applied automatically: the user always confirms.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODEL = "claude-opus-4-8";
const LOOKBACK_DAYS = 7;
const MIN_REJECTIONS = 3;
const MAX_REJECTIONS_PER_WORKSPACE = 20;
const MAX_WORKSPACES_PER_RUN = 50;
// Minimum genuine-voice exemplars (published posts + manually-sent replies)
// before we'll evolve the profile from sent text alone. Lower than the extract
// floor (3) since this only NUDGES an existing profile, not seeds a new one,
// but we still want a few samples so one stray post can't shift the voice.
const MIN_SENT_EXEMPLARS = 5;

interface PerWorkspaceResult {
  workspaceId: string;
  status: "proposed" | "skipped" | "failed";
  reason?: string;
  diff?: VoiceProfileDiff;
}

let cachedClient: Anthropic | null = null;
function client(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({ apiKey: serverEnv().ANTHROPIC_API_KEY, maxRetries: 6 });
  return cachedClient;
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
  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Find workspaces with a voice_profile AND a recent rejection. Two passes
  // because the JS client doesn't expose a clean HAVING-with-join.
  const { data: briefs, error: briefsErr } = await svc
    .from("brand_briefs")
    .select("id, workspace_id, voice_profile")
    .not("voice_profile", "is", null)
    .limit(MAX_WORKSPACES_PER_RUN);
  if (briefsErr) {
    return NextResponse.json({ error: briefsErr.message }, { status: 500 });
  }

  const results: PerWorkspaceResult[] = [];
  for (const brief of briefs ?? []) {
    try {
      const result = await processBrief(brief.workspace_id, brief.id, brief.voice_profile as VoiceProfile, since);
      results.push(result);
    } catch (err) {
      results.push({
        workspaceId: brief.workspace_id,
        status: "failed",
        reason: err instanceof Error ? err.message : "unknown error",
      });
    }
  }

  return NextResponse.json({
    processed: results.length,
    proposed: results.filter((r) => r.status === "proposed").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
    results,
  });
}

async function processBrief(
  workspaceId: string,
  briefId: string,
  profile: VoiceProfile,
  since: string,
): Promise<PerWorkspaceResult> {
  const svc = supabaseService();

  // Pull recent rejections joined to post text. We bias toward off_voice
  // since this cron is specifically the voice-evolution sink — wrong_theme
  // and factually_wrong feedback goes into the per-plan rejection-signals
  // injection instead (lib/plan/rejection-signals.ts).
  const { data: rejections, error: rejErr } = await svc
    .from("approvals")
    .select("reason, reason_note, created_at, posts!inner(text, workspace_id)")
    .eq("action", "rejected")
    .not("reason", "is", null)
    .gte("created_at", since)
    .eq("posts.workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(MAX_REJECTIONS_PER_WORKSPACE);

  if (rejErr) {
    return { workspaceId, status: "failed", reason: rejErr.message };
  }

  type RejRow = {
    reason: "off_voice" | "wrong_theme" | "factually_wrong" | "other";
    reason_note: string | null;
    created_at: string;
    posts: { text: string } | { text: string }[] | null;
  };
  const rows = (rejections ?? []) as unknown as RejRow[];

  // Focus the evolution on off_voice signal — that's the only reason class
  // that should mutate the voice profile. We still count "other" with a
  // note as a soft signal, but we don't propose changes from wrong_theme
  // or factually_wrong alone.
  const voiceRelevant = rows.filter(
    (r) => r.reason === "off_voice" || (r.reason === "other" && r.reason_note),
  );

  // TODO #0 (gap 2): also load the user's OWN sent/published text as genuine-
  // voice exemplars. Best-effort — never fails the run.
  const sentExemplars = await loadSentExemplars(svc, workspaceId, since);

  // Run when there is enough of EITHER signal. Rejections nudge AWAY from what
  // the user doesn't want; sent exemplars converge TOWARD how they write.
  const haveRejections = voiceRelevant.length >= MIN_REJECTIONS;
  const haveSent = sentExemplars.length >= MIN_SENT_EXEMPLARS;
  if (!haveRejections && !haveSent) {
    return {
      workspaceId,
      status: "skipped",
      reason:
        `not enough signal — ${voiceRelevant.length} voice rejection(s) (need ${MIN_REJECTIONS}) ` +
        `and ${sentExemplars.length} sent exemplar(s) (need ${MIN_SENT_EXEMPLARS}).`,
    };
  }

  // Build the rejection prompt input. Each item: snippet of rejected text +
  // user note. Empty when we're running on sent-text signal alone.
  const items = voiceRelevant.map((r, i) => {
    const post = Array.isArray(r.posts) ? r.posts[0] : r.posts;
    const text = (post?.text ?? "").slice(0, 280);
    const note = r.reason_note ? `\n  note: ${r.reason_note}` : "";
    return `--- rejection ${i + 1} (${r.reason}) ---\n${text}${note}`;
  });

  const diff = await proposeDiff(
    profile,
    items,
    voiceRelevant.length,
    sentExemplars,
  );
  if (!diff) {
    return { workspaceId, status: "skipped", reason: "no actionable change proposed." };
  }

  const { error: updateErr } = await svc
    .from("brand_briefs")
    .update({
      pending_voice_diff: diff,
      pending_voice_diff_at: diff.proposed_at,
    })
    .eq("id", briefId);
  if (updateErr) {
    return { workspaceId, status: "failed", reason: updateErr.message };
  }

  return { workspaceId, status: "proposed", diff };
}

const DIFF_TOOL = {
  name: "propose_voice_diff",
  description:
    "Propose a minimal, conservative diff to the current voice profile based on the evidence: " +
    "the user's rejection feedback AND the user's own recently-published / sent text. " +
    "Only suggest changes you can defend from the evidence. If nothing actionable, set rationale to " +
    '"no change" and leave every other field empty.',
  input_schema: {
    type: "object",
    required: ["rationale", "source_rejection_count", "proposed_at"],
    properties: {
      rationale: {
        type: "string",
        maxLength: 1000,
        description:
          'Why this diff. Be specific — "users rejected 4 posts for AI-tone, suggest tightening ' +
          'casual register" beats "improve voice".',
      },
      add_do_not_say: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 120 },
      },
      remove_do_not_say: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 120 },
      },
      formality: { type: "string", enum: ["casual", "neutral", "formal"] },
      emoji_usage: { type: "string", enum: ["none", "sparse", "frequent"] },
      add_signature_phrases: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 200 },
      },
      remove_signature_phrases: {
        type: "array",
        maxItems: 20,
        items: { type: "string", maxLength: 200 },
      },
      summary_patch: {
        type: "string",
        maxLength: 800,
        description: "If the summary needs rewriting, the new version.",
      },
      source_rejection_count: {
        type: "integer",
        minimum: 0,
      },
      source_sent_count: {
        type: "integer",
        minimum: 0,
        description:
          "How many of the user's own sent/published exemplars you used as evidence.",
      },
      proposed_at: {
        type: "string",
        description: "ISO 8601 UTC datetime when this diff was proposed.",
      },
    },
    additionalProperties: false,
  },
} as const;

async function proposeDiff(
  profile: VoiceProfile,
  items: string[],
  count: number,
  sentExemplars: SentExemplar[],
): Promise<VoiceProfileDiff | null> {
  const system = [
    "You are tuning a brand's voice profile from two evidence sources.",
    "You will see (1) the current voice profile, (2) recent posts the user REJECTED",
    "as off-voice (nudge the profile AWAY from these), and (3) the user's OWN recently",
    "PUBLISHED posts and manually-SENT replies (their genuine voice — converge the",
    "profile TOWARD how they actually write).",
    "",
    "Propose a CONSERVATIVE diff:",
    "- Only suggest changes you can defend from the evidence shown.",
    "- From REJECTIONS: prefer adding do_not_say entries; nudge formality/emoji only on",
    "  clear, repeated signal.",
    "- From SENT TEXT: capture recurring genuine signature phrases the user actually uses,",
    "  and align formality/emoji_usage with how they really write. Do NOT add a phrase",
    "  unless it appears across multiple sent samples — one-off phrasing is not a pattern.",
    "- Prefer small, evidence-backed edits over rewriting the summary wholesale.",
    "- Empty / unset every field if no change is warranted; set rationale to 'no change'.",
    "- Never invent evidence — if you cannot defend a change, do not propose it.",
    "",
    "Call propose_voice_diff exactly once. Do not respond with prose.",
  ].join("\n");

  const sentBlock =
    sentExemplars.length > 0
      ? sentExemplars.map(
          (e, i) => `--- ${e.source} ${i + 1} ---\n${e.text}`,
        )
      : ["(no sent/published exemplars this period)"];

  const user = [
    "## Current voice profile",
    `Summary: ${profile.summary}`,
    `Formality: ${profile.formality}`,
    `Emoji usage: ${profile.emoji_usage}`,
    `Avg sentence length: ${profile.sentence_length_avg}`,
    profile.signature_phrases.length > 0
      ? `Signature phrases: ${profile.signature_phrases.join(", ")}`
      : "Signature phrases: (none)",
    profile.do_not_say.length > 0
      ? `Do not say: ${profile.do_not_say.join(", ")}`
      : "Do not say: (none)",
    "",
    "## Recent rejections (voice-relevant only — nudge AWAY)",
    ...(items.length > 0 ? items : ["(no voice-relevant rejections this period)"]),
    "",
    "## The user's own sent/published text (genuine voice — converge TOWARD)",
    ...sentBlock,
  ].join("\n");

  const resp = await client().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    tools: [DIFF_TOOL],
    tool_choice: { type: "tool", name: "propose_voice_diff" },
    messages: [{ role: "user", content: user }],
  });

  const toolUse = resp.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use" || toolUse.name !== "propose_voice_diff") {
    return null;
  }

  const raw = toolUse.input as Record<string, unknown>;
  // Force-correct fields we own ground truth for, same pattern as
  // extract.ts.
  const fixed = {
    ...raw,
    source_rejection_count: count,
    source_sent_count: sentExemplars.length,
    proposed_at: new Date().toISOString(),
  };
  const parsed = voiceProfileDiffSchema.safeParse(fixed);
  if (!parsed.success) return null;

  // No-change guard: drop diffs where Claude said "no change" or
  // populated only the required scaffold fields. We don't want to
  // surface a banner that says nothing.
  const d = parsed.data;
  const hasContent =
    !!d.summary_patch ||
    d.formality !== undefined ||
    d.emoji_usage !== undefined ||
    (d.add_do_not_say?.length ?? 0) > 0 ||
    (d.remove_do_not_say?.length ?? 0) > 0 ||
    (d.add_signature_phrases?.length ?? 0) > 0 ||
    (d.remove_signature_phrases?.length ?? 0) > 0;
  if (!hasContent) return null;

  return d;
}

function authorized(req: NextRequest): boolean {
  const env = serverEnv();
  const header = req.headers.get("authorization") ?? "";
  if (header === `Bearer ${env.CRON_SECRET}`) return true;
  const qs = req.nextUrl.searchParams.get("secret");
  return qs === env.CRON_SECRET;
}
