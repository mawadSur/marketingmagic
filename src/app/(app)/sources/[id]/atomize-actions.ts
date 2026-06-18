"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { atomize } from "@/lib/atomize/generate";
import { sourceContextFromRow } from "@/lib/sources/generate-from-source";
import { channelSpec, ENABLED_CHANNELS, type ChannelId } from "@/lib/channels/registry";
import { nextRecommendedSlot } from "@/lib/channels/best-times";
import { assertWithinPostQuota, QuotaExceededError } from "@/lib/billing/limits";
import { incrementPostsGenerated } from "@/lib/billing/usage";
import { dedupePosts } from "@/lib/dedup/gate";
import { hashContent } from "@/lib/dedup/similarity";
import { collectRecentContent } from "@/lib/plan/recent-content";

// /sources/[id] — "Atomize" server action (Bet 2 — Atomization Engine).
//
// Turns ONE source into N channel-native posts and drops them into the
// approval queue as drafts. Distinct from generateClusterAction (which builds
// a multi-week posting *calendar* with scheduled times): atomization is a
// direct 1→N decomposition — each atom becomes per-channel variants, and the
// drafts land UNSCHEDULED in pending_approval (the user reviews/schedules them
// in the queue).
//
// Reuse, not duplicate:
//   - atomize() reuses the planner's Opus 4.8 streaming structured-output
//     pattern (and the SHARED channel-cap + tone guidance module).
//   - The persistence path mirrors generateClusterAction: same idea→variants
//     fan-out, same posts table, same source_id tagging, same theme tags, same
//     low_confidence / trust gate, same billing quota enforcement.
//
// Returns a count of created drafts (unlike the cluster action it does NOT
// redirect — the source page re-renders its "Generated posts" list in place).

const VOICE_SCORE_THRESHOLD = 70;

// Roughly how many atoms to ask Claude for, scaled by how much usable material
// the source extracted. A thin summary shouldn't be stretched into 30 posts; a
// dense transcript with many quotes/facts can support more.
const MIN_ATOMS = 6;
const MAX_ATOMS = 24;

export type AtomizeState = { error: string | null; created: number | null };

const idSchema = z.string().uuid();

export async function atomizeSourceAction(
  _prev: AtomizeState,
  formData: FormData,
): Promise<AtomizeState> {
  const ws = await getActiveWorkspaceOrRedirect();
  const sourceId = formData.get("source_id");
  if (typeof sourceId !== "string" || !idSchema.safeParse(sourceId).success) {
    return { error: "Bad source id.", created: null };
  }

  const supabase = await supabaseServer();

  const [sourceRes, briefRes, accountsRes] = await Promise.all([
    supabase.from("sources").select("*").eq("id", sourceId).eq("workspace_id", ws.id).maybeSingle(),
    supabase.from("brand_briefs").select("*").eq("workspace_id", ws.id).maybeSingle(),
    supabase
      .from("social_accounts_safe")
      .select("id, channel, handle, trust_mode")
      .eq("workspace_id", ws.id)
      .eq("status", "connected"),
  ]);

  if (!sourceRes.data) return { error: "Source not found.", created: null };
  if (!briefRes.data) return { error: "Workspace has no brand brief.", created: null };

  const accounts = (accountsRes.data ?? []).filter((a) =>
    ENABLED_CHANNELS.includes(a.channel as ChannelId),
  );
  if (accounts.length === 0) {
    return { error: "Connect at least one channel before atomizing.", created: null };
  }

  const channels = Array.from(new Set(accounts.map((a) => a.channel as ChannelId)));
  const source = sourceContextFromRow(sourceRes.data);

  // Scale the atom target by the source's material density: more
  // quotes/facts/themes → more atoms, clamped to [MIN_ATOMS, MAX_ATOMS].
  const material = source.quotes.length + source.facts.length + source.themes.length;
  const atomTarget = Math.min(MAX_ATOMS, Math.max(MIN_ATOMS, material));

  // Quota check BEFORE the Claude call so we never burn tokens for an
  // over-quota workspace. Mirrors generatePlanAction: estimate an upper bound
  // (atoms × channels) — we charge for what actually inserts below.
  const estimatedPosts = atomTarget * channels.length;
  try {
    await assertWithinPostQuota(ws.id, estimatedPosts);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      return { error: err.message, created: null };
    }
    throw err;
  }

  // Best-effort: tell the atomizer what's already queued / recently posted so it
  // steers AWAY from angles we already cover, BEFORE its output ever reaches the
  // dedup gate below. Purely advisory — a read failure here must never block
  // atomization, so we swallow errors and fall back to an empty list (the prompt
  // block then renders nothing). The gate is the real guarantee; this just
  // reduces how often it has to fire.
  let avoidRecent: string[] = [];
  try {
    const recent = await collectRecentContent(ws.id);
    avoidRecent = recent.map((r) => r.snippet);
  } catch (err) {
    console.warn("Atomize: failed to load recent-content context (continuing):", err);
  }

  let result;
  try {
    result = await atomize({ brief: briefRes.data, source, channels, atomTarget, avoidRecent });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Atomization failed.", created: null };
  }

  // Persist. We mint a posting_plans row to satisfy the posts.plan_id FK and
  // group the batch (same as the cluster path), then fan out each atom's
  // variants into draft posts tagged with source_id + theme.
  const svc = supabaseService();
  const now = new Date();
  const { data: planRow, error: planErr } = await svc
    .from("posting_plans")
    .insert({
      workspace_id: ws.id,
      name: `Atomized: ${source.title}`.slice(0, 120),
      start_at: now.toISOString(),
      // Atomized drafts are unscheduled; the plan window is nominal (1 week)
      // purely so the row satisfies the NOT NULL end_at constraint.
      end_at: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      status: "active",
      generation_prompt: result.atomization.overview,
      generation_response: result.atomization as unknown as import("@/lib/db/types").Json,
    })
    .select("id")
    .single();
  if (planErr || !planRow) {
    return { error: planErr?.message ?? "Failed to save atomization.", created: null };
  }

  const accountByChannel = new Map<string, (typeof accounts)[number]>();
  for (const a of accounts) accountByChannel.set(a.channel, a);
  const hasVoiceProfile = briefRes.data.voice_profile != null;

  // Flatten atoms → variants. Each atom mints a UUID idea_id so the queue can
  // group an atom's channel variants together (same grouping the planner uses).
  type FlatVariant = {
    channel: string;
    text: string;
    theme: string;
    rationale: string;
    image_prompt?: string;
    idea_id: string;
    idea_label: string;
    voice_score?: number;
  };
  const flatVariants: FlatVariant[] = result.atomization.atoms.flatMap((atom) => {
    const ideaId = crypto.randomUUID();
    return atom.variants
      .filter((v) => !v.skip)
      .map((v) => ({
        channel: v.channel,
        text: v.text,
        theme: atom.theme,
        rationale: v.rationale,
        image_prompt: v.image_prompt,
        idea_id: ideaId,
        idea_label: atom.atom_label,
        voice_score: v.voice_score,
      }));
  });

  const skipped: string[] = [];
  // Stagger suggested slots so a burst of atomized drafts doesn't all land at
  // the same timestamp. Each successfully-mapped variant advances the search
  // origin by ~1 day, so nextRecommendedSlot spreads them across upcoming
  // recommended windows. The user still reviews + can retime in the queue.
  let slotCursor = new Date();
  // Annotate the element type as the posts Insert row so the dedup gate below
  // can mutate status / low_confidence / generation_metadata / content_hash with
  // the correct (wide) field types rather than the narrow shapes inferred from
  // the object literal. (Inline import() type — this is a "use server" file, so
  // we avoid introducing a top-level exported type alias.)
  type PostInsert = import("@/lib/db/types").Database["public"]["Tables"]["posts"]["Insert"];
  const postsPayload = flatVariants.flatMap((p): PostInsert[] => {
    const acct = accountByChannel.get(p.channel);
    if (!acct) {
      skipped.push(p.channel);
      return [];
    }
    // Every queued card gets a sensible default time — never "no time set".
    // Fall back to the cursor itself if the channel has no recommended windows.
    const suggestedSlot =
      nextRecommendedSlot(acct.channel, slotCursor) ?? slotCursor.toISOString();
    slotCursor = new Date(new Date(suggestedSlot).getTime() + 24 * 60 * 60 * 1000);
    const voiceScore = typeof p.voice_score === "number" ? p.voice_score : null;
    const lowConfidence =
      hasVoiceProfile && voiceScore !== null && voiceScore < VOICE_SCORE_THRESHOLD;
    // Truncate rather than reject if Claude overran the cap — losing one line
    // beats throwing the draft away.
    const max = channelSpec(acct.channel)?.maxChars ?? 280;
    const text = p.text.length > max ? p.text.slice(0, max - 1) + "…" : p.text;

    return [
      {
        workspace_id: ws.id,
        plan_id: planRow.id,
        social_account_id: acct.id,
        channel: acct.channel,
        text,
        theme: p.theme,
        // Atomized drafts get a SUGGESTED recommended-window slot (staggered
        // above) so every queued card shows a time the user can adjust —
        // rather than landing as "no time set". They still always land in
        // pending_approval (never auto-scheduled): trust mode auto-publishes a
        // continuous calendar, but a one-shot atomization is an exploratory
        // burst the user should eyeball before it ships.
        scheduled_at: suggestedSlot,
        status: "pending_approval",
        // ALWAYS stamp a stable content hash on every inserted row (all paths),
        // so future dedup reads can hash-match this post directly. The dedup
        // gate below may additionally flag this row, but the hash is written
        // unconditionally.
        content_hash: hashContent(text),
        voice_score: voiceScore,
        low_confidence: lowConfidence,
        idea_id: p.idea_id,
        source_id: sourceId,
        generation_metadata: {
          rationale: p.rationale,
          cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
          auto_scheduled: false,
          image_prompt: p.image_prompt ?? null,
          idea_label: p.idea_label,
          source_id: sourceId,
          source: "atomize",
        },
      },
    ];
  });

  if (postsPayload.length === 0) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return {
      error: "Claude produced only posts for channels you haven't connected.",
      created: null,
    };
  }

  // ── Content dedup gate ────────────────────────────────────────────────────
  // Before these atoms hit the posts table, run the whole batch through the
  // dedup gate. One DB read loads the workspace's recent+queued corpus; the gate
  // judges each row against it AND against earlier-accepted rows in this same
  // batch — so two atoms decomposed from ONE source that duplicate each other
  // (or that re-state something already queued) are both caught. The gate is
  // channel-agnostic: the same caption on X and Instagram is still a dup.
  //
  // We dedup on the FINAL text that will actually be written (post-truncation),
  // and always stamp content_hash on every row. On any "exact"/"near" hit we
  // apply the uniform DEDUP-ON-HIT POLICY: a duplicate can never auto-publish
  // (these are already pending_approval, but we re-assert it), it's flagged
  // low_confidence so the queue surfaces it, and we record what it collided with
  // in generation_metadata.dedup so a reviewer can see why.
  //
  // Fail-open: dedupePosts already returns [] on a read error. If for any reason
  // the verdict count doesn't line up with the payload, we skip the gate rather
  // than mis-flag rows — content_hash is still written below regardless.
  let dedupResults: Awaited<ReturnType<typeof dedupePosts>> = [];
  try {
    dedupResults = await dedupePosts(
      ws.id,
      postsPayload.map((p) => ({ text: p.text, channel: p.channel as ChannelId })),
    );
  } catch (err) {
    console.warn("Atomize: dedup gate failed (writing without dedup flags):", err);
    dedupResults = [];
  }
  const dedupByIndex = new Map(dedupResults.map((r) => [r.index, r]));

  // content_hash is already stamped on every row when the payload is built
  // above (always, per policy). Here we only layer the DEDUP-ON-HIT flags on the
  // rows the gate flagged.
  let dedupFlagged = 0;
  for (let i = 0; i < postsPayload.length; i++) {
    const row = postsPayload[i]!;
    const verdict = dedupByIndex.get(i);
    if (verdict && (verdict.verdict === "exact" || verdict.verdict === "near")) {
      dedupFlagged += 1;
      // A duplicate can NEVER auto-publish. Atomized drafts are already
      // pending_approval, but re-assert it so the policy holds even if that
      // upstream default ever changes.
      row.status = "pending_approval";
      row.low_confidence = true;
      // Preserve the existing rationale/source metadata and add the dedup
      // provenance. We built generation_metadata as a plain object above, but the
      // column is typed as the broad Json union, so guard the spread to object
      // values only (never spread a primitive Json).
      const existingMeta =
        row.generation_metadata && typeof row.generation_metadata === "object" && !Array.isArray(row.generation_metadata)
          ? row.generation_metadata
          : {};
      row.generation_metadata = {
        ...existingMeta,
        dedup: {
          kind: verdict.verdict,
          score: verdict.match?.score ?? null,
          match_id: verdict.match?.existingId ?? null,
          match_snippet: verdict.match?.existingText
            ? verdict.match.existingText.replace(/\s+/g, " ").trim().slice(0, 140)
            : null,
        },
      };
    }
  }
  if (dedupFlagged > 0) {
    console.warn(`Atomize: ${dedupFlagged} of ${postsPayload.length} drafts flagged as duplicates.`);
  }

  const { error: postsErr } = await svc.from("posts").insert(postsPayload);
  if (postsErr) {
    await svc.from("posting_plans").delete().eq("id", planRow.id);
    return { error: postsErr.message, created: null };
  }

  // Charge for the actual number of drafts inserted (we may have dropped some
  // for unconnected channels). Best-effort — a counter failure shouldn't hide
  // the drafts from the user.
  try {
    await incrementPostsGenerated(ws.id, postsPayload.length);
  } catch (err) {
    console.warn("Failed to increment posts usage counter:", err);
  }

  revalidatePath("/queue");
  revalidatePath(`/sources/${sourceId}`);
  if (skipped.length > 0) {
    console.warn("Atomization dropped posts for unconnected channels:", skipped);
  }
  return { error: null, created: postsPayload.length };
}
