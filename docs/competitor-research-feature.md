# Live Competitor Research — Plan-Generation Feature

**Status:** Design ready · **Author:** architect agent · **Date:** 2026-05-25

A user-opt-in toggle on the plan-generation flows that, when enabled, runs a
live research pass over each channel's competitors and feeds the findings into
the plan-generation LLM call. If the workspace has no watched handles, the
agent auto-discovers them via Anthropic's web_search tool and persists the
finds back into `watch_handles` so the daily cron picks them up next.

---

## 1. `CompetitorInsight` type

Lives in `src/lib/plan/competitor-research.ts` (new file). One object per
channel in the plan's channel mix.

```ts
import type { ChannelId } from "@/lib/channels/registry";

export interface CompetitorInsight {
  // Channel this insight set is for. Mirrors the channel field on
  // ChannelMix entries so the prompt block can render per-channel sections.
  channel: ChannelId;

  // Up to 5 short structural patterns Claude observed across the top
  // performers (e.g. "opens with a personal stat", "two-line punchline +
  // proof", "single-image quote card"). Free-form sentences, ≤140 chars
  // each. We do NOT constrain to COMPETITOR_PATTERN_TAGS here — that
  // vocabulary is too narrow for cross-channel research where we want
  // qualitative observations, not classification tags.
  topPatterns: string[];

  // Up to 5 representative snippets — anonymised. Each sample carries the
  // verbatim text and a one-line note on what made it work. We deliberately
  // do NOT pass handle/URL into the planner prompt — the planner job is
  // "learn from", not "reference". (Sources are persisted separately for
  // the user-facing /competitors view, not for the planner.)
  samplePosts: Array<{
    text: string;          // verbatim, ≤500 chars (truncate before prompt)
    why_it_worked: string; // one sentence, ≤200 chars, hedged ("Possibly…")
  }>;

  // Up to 5 theme labels the planner should consider — phrased the way the
  // existing themeWinnersBlock expects (short kebab-case-ish tags). These
  // bias planner theme tags toward what's working on this channel right
  // now, distinct from the workspace's own historical winners.
  recommendedThemes: string[];

  // One-paragraph synthesis (≤600 chars). Plain prose. What does this
  // channel's top quartile look like *right now* for this brand's niche?
  // This is the only block the planner reads end-to-end; the rest is
  // bullet-grade hints.
  reasoning: string;

  // Handles the research pass actually looked at (whether pre-existing
  // watch_handles or freshly discovered). Used by the server action to
  // upsert any new finds into watch_handles.
  discoveredHandles: Array<{
    handle: string;            // normalised — lowercase, no leading @
    display_name: string | null;
    // "existing" = pulled from watch_handles cache, "discovered" = fresh
    // from web_search. Drives whether we upsert.
    source: "existing" | "discovered";
    // Free-form one-line "why this account is relevant" — surfaced in the
    // /competitors UI when we autopopulate. Null for "existing" entries
    // (they already have user context).
    rationale: string | null;
  }>;
}
```

Notes:

- We rely on Anthropic tool_use forcing + Zod validation, same pattern as
  `src/lib/competitors/extract-pattern.ts:34` and `src/lib/plan/generate.ts:30`.
- The Zod schema lives next to the type in `competitor-research.ts`; not
  exported from `src/lib/competitors/schema.ts` because the shape is
  plan-specific, not competitor-domain.

---

## 2. `researchCompetitorsLive()` — function signature & flow

```ts
// src/lib/plan/competitor-research.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Brief } from "@/lib/db/types";
import type { ChannelId } from "@/lib/channels/registry";

export interface ResearchInputs {
  workspaceId: string;
  brief: Brief; // brand_briefs row — passes product/audience/voice context
  channels: ChannelId[]; // the active channel mix (deduped)
  // Service-role client. We need RLS-bypass to insert auto-discovered
  // watch_handles attributed to no user (added_by stays NULL).
  supabase: SupabaseClient<Database>;
}

export async function researchCompetitorsLive(
  inputs: ResearchInputs,
): Promise<CompetitorInsight[]>;
```

### Algorithmic flow (per channel, in parallel via `Promise.all`)

```
for each channel in inputs.channels (parallel):
  1. Query watch_handles for (workspace_id, channel, status='active').
  2. If watch_handles exist for this channel:
       a. Pull top-N (N=10) winning competitor_posts:
            select text, pattern_tags, pattern_reason, posted_at, post_url
            from competitor_posts
            where workspace_id = $1
              and watch_handle_id in (<handle ids>)
              and is_winner = true
              and posted_at > now() - interval '60 days'
            order by engagement_rate desc nulls last, posted_at desc
            limit 10;
       b. Call Claude (claude-sonnet-4-6) WITHOUT web_search, forcing
          `submit_competitor_insight` tool. System prompt summarises the
          brand brief + channel; user prompt is the 10 sample posts.
          Output: CompetitorInsight (sans discoveredHandles).
       c. discoveredHandles = the existing handles, marked source:"existing".
     Else (no watch_handles for this channel):
       a. Call Claude with web_search tool enabled (max_uses: 5) AND the
          same submit_competitor_insight tool. Single multi-step turn —
          Claude searches, reads results, then calls the submit tool.
       b. System prompt describes the brand niche and tells Claude to:
            - Find 3–7 top creators in this niche on this specific channel
            - For each, identify 2–4 recent high-engagement posts
            - Synthesize patterns, themes, and a paragraph of reasoning
            - Populate discoveredHandles with rationales
       c. After the call: upsert each discoveredHandles[] entry into
          watch_handles via the service client. Conflict on
          (workspace_id, channel, handle) → do nothing. added_by = NULL.
          (Daily cron will start pulling these on its next run.)
  3. Return the CompetitorInsight for this channel.

return Promise.all(...) — channel order preserved.
```

### Channel-by-channel parallelism + cost guardrail

- Each channel = 1 Anthropic call. Max 5 channels → 5 calls.
- For discovery branch, `max_uses: 5` per web_search caps tool turns.
- Total wall-clock budget: research adds ~15–25s on top of plan generation.
- Hard timeout: 30s per channel via `Promise.race` with an `AbortController`.

### Anthropic call shape (discovery branch)

```ts
await client().messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 4096,
  system: [{ type: "text", text: discoverySystem, cache_control: { type: "ephemeral" } }],
  tools: [
    { type: "web_search_20250305", name: "web_search", max_uses: 5 },
    SUBMIT_COMPETITOR_INSIGHT_TOOL,
  ],
  // Soft choice: let the model use web_search first, then call the submit
  // tool. We can't `tool_choice: tool` here because that would force the
  // submit tool *first*, before any search.
  tool_choice: { type: "auto" },
  messages: [{ role: "user", content: discoveryUser }],
});
```

The summarise branch (when watch_handles exist) uses
`tool_choice: { type: "tool", name: "submit_competitor_insight" }` — same
pattern as `src/lib/competitors/extract-pattern.ts:113`.

---

## 3. `PlanGenInputs` extension

In `src/lib/plan/prompt.ts:41`, add ONE optional field at the end of the
interface (preserves all existing call sites):

```ts
  // Phase 7: live competitor research. One entry per active channel.
  // Set when the user ticked "Compare what competitors are doing" on the
  // plan-generation form. When undefined or empty, the system prompt is
  // unchanged from current behaviour. The research pass is best-effort —
  // failure produces undefined here, never throws into the planner.
  competitorInsights?: CompetitorInsight[];
```

Add the import at the top of `prompt.ts`:

```ts
import type { CompetitorInsight } from "@/lib/plan/competitor-research";
```

No schema changes elsewhere — `PlanGenResult`, `planSchema`, `PLAN_TOOL`, and
the persisted columns stay untouched.

---

## 4. `competitorInsightsBlock(insights)` — prompt helper

Pattern-matched against `sourceBlock()` (`src/lib/plan/prompt.ts:141`) and
`themeWinnersBlock()` (`src/lib/plan/prompt.ts:121`). Mounted in
`planSystemPrompt` right after `themeWinnersBlock(inputs.themeWinners)`
at `src/lib/plan/prompt.ts:320` — same "weight your themes" neighbourhood,
distinct signal source (their data, not yours).

```ts
function competitorInsightsBlock(insights: CompetitorInsight[] | undefined): string {
  if (!insights || insights.length === 0) return "";
  const lines: string[] = ["## What's working for competitors right now"];
  lines.push(
    "Live research on top performers in each channel. Treat these as " +
      "directional hints — patterns to consider, not templates to copy. " +
      "Voice rules and the brand brief still override anything here.",
  );
  for (const ins of insights) {
    const label = CHANNELS[ins.channel].label;
    lines.push("");
    lines.push(`### ${label}`);
    lines.push(ins.reasoning);
    if (ins.topPatterns.length > 0) {
      lines.push("");
      lines.push("Patterns observed:");
      for (const p of ins.topPatterns) lines.push(`- ${p}`);
    }
    if (ins.recommendedThemes.length > 0) {
      lines.push("");
      lines.push(
        `Themes trending on this channel (consider as theme tags): ${ins.recommendedThemes.join(", ")}`,
      );
    }
    if (ins.samplePosts.length > 0) {
      lines.push("");
      lines.push("Sample posts (for pattern reference — do NOT paraphrase):");
      for (const s of ins.samplePosts) {
        lines.push(`- "${s.text}" — ${s.why_it_worked}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
```

Wire-in (single line inside `planSystemPrompt`):

```ts
themeWinnersBlock(inputs.themeWinners),
competitorInsightsBlock(inputs.competitorInsights), // ← add this line at prompt.ts:321
sourceBlock(inputs.source),
```

Anti-paraphrase guidance lives inline in the block — same trick `sourceBlock`
uses for verbatim quotes. The planner has the brief, the voice profile, and a
"do not paraphrase" instruction; combined that's enough guardrail without
adding an explicit rule to the `## Rules` block.

---

## 5. Form field name

**`compare_competitors`** — HTML checkbox name, value `"on"` when checked.

Parsing pattern (matches the existing `include_*` boolean check in
`src/app/(app)/plans/new/actions.ts:50`):

```ts
const compareCompetitors = formData.get("compare_competitors") === "on";
```

Both forms add a single `<input type="checkbox" name="compare_competitors">`.
For the goals form (`generate-plan-button.tsx`), the checkbox sits above the
submit button. For `new-plan-form.tsx`, place it just below the weeks input —
adjacent to the "Claude reads your brief…" helper text at line 118.

---

## 6. Server action wiring

### `src/app/(app)/plans/new/actions.ts` (`generatePlanAction`)

**Insertion point:** between the existing parallel signal-gathering
`Promise.all` at line 117 and the `assertWithinPostQuota` call at line 134.

```ts
// existing line ~117
const [themeSignals, rejections, savedPatterns, hashtagSuggestions, themeWinners] =
  await Promise.all([ ... ]);

// NEW — read the toggle off the form
const compareCompetitors = formData.get("compare_competitors") === "on";

// NEW — fire the research pass before the quota check (we want quota
// errors to short-circuit *before* burning research tokens, so move
// quota up; OR keep order as-is and accept the small overdraw risk on
// research tokens for over-quota users). Recommendation: keep quota
// first, run research after — see below.

// existing — quota check stays at line 134
await assertWithinPostQuota(ws.id, estimatedPosts);

// NEW — competitor research, post-quota, pre-LLM
let competitorInsights: CompetitorInsight[] | undefined;
if (compareCompetitors) {
  try {
    competitorInsights = await researchCompetitorsLive({
      workspaceId: ws.id,
      brief: briefRes.data,
      channels: channelsToScan, // already deduped at line 116
      supabase: svc,             // service client — defined later, move up
    });
  } catch (err) {
    console.warn("Competitor research failed, generating without:", err);
    competitorInsights = undefined; // skip silently
  }
}

// existing — generatePlan call gets one extra field
const attemptResult = await generatePlan({
  brief: briefRes.data,
  channelMix,
  weeks: parsed.data.weeks,
  startDate,
  winners,
  losers,
  rejections,
  savedPatterns,
  retryNote,
  hashtagSuggestions,
  themeWinners,
  competitorInsights, // ← new
});
```

Note: `svc` (service client) currently lives at line 191. Hoist its creation
up to before the research call, OR mint a second `supabaseService()` instance
inside `researchCompetitorsLive()` — the latter avoids reordering and the
client is cheap (it's just an HTTP client + key).

### `src/app/(app)/goals/[id]/actions.ts` (`generatePostsAction`)

**Insertion point:** between the parallel signal-gathering at line 171–176
and the `generatePostsFromGoal()` call at line 182.

```ts
// existing line 171
const [themeSignals, rejections, savedPatterns, themeWinners] = await Promise.all([ ... ]);

// NEW
const compareCompetitors = formData.get("compare_competitors") === "on";
const channelsToScan = Array.from(new Set(channelMix.map((c) => c.channel)));
let competitorInsights: CompetitorInsight[] | undefined;
if (compareCompetitors) {
  try {
    competitorInsights = await researchCompetitorsLive({
      workspaceId: ws.id,
      brief: briefRes.data,
      channels: channelsToScan,
      supabase: supabaseService(),
    });
  } catch (err) {
    console.warn("Competitor research failed, generating without:", err);
  }
}

// existing generate call — add competitorInsights
result = await generatePostsFromGoal({
  brief: briefRes.data,
  goal: goalRes.data,
  strategy,
  channelMix,
  weeks: strategy.weeks,
  startDate: new Date(),
  winners: themeSignals.winners,
  losers: themeSignals.losers,
  rejections,
  savedPatterns,
  themeWinners,
  competitorInsights, // ← new
});
```

`generatePostsFromGoal()` lives in `src/lib/goals/generate-plan.ts` — it
wraps `generatePlan()` and forwards `PlanGenInputs`. The `competitorInsights`
field passes through transparently because of optional spread; no code
change needed there if the wrapper already does `...rest`. If it picks fields
explicitly, add `competitorInsights` to the forwarded set. **Action item for
backend agent:** verify and update if needed.

---

## 7. Web search tool — confirmed

Anthropic's first-party tool block is the right call:

```ts
{ type: "web_search_20250305", name: "web_search", max_uses: 5 }
```

- No third-party research utility exists in the codebase (verified — no
  Brave/Tavily/SerpAPI/Firecrawl references in `src/`).
- The `@anthropic-ai/sdk` is already a dependency.
- `max_uses: 5` is the right ceiling for "find 3–7 creators on this channel
  and skim a few of their recent posts." Going higher burns tokens; going
  lower starves Claude on niche topics.
- Combine with `tool_choice: "auto"` and a second `submit_competitor_insight`
  tool so the model can search first, then submit. Forcing the submit tool
  via `tool_choice: { type: "tool" }` would block the web_search calls.

---

## 8. Failure modes

Default policy: **skip silently, log a warning, generate the plan without
competitor signals.** Never let research failure block a plan.

| Failure | Handling |
|---|---|
| Anthropic API error (rate limit, 500, network) | Catch in the per-channel `Promise.all` settler — channels that errored return undefined; the final array filters them. If ALL channels error, `researchCompetitorsLive()` returns `[]` and the action sees an empty array (treated as no insights). |
| Web search returns nothing / Claude refuses to call submit tool | The per-channel call throws; same path as above. |
| Per-channel timeout (>30s) | `AbortController` aborts the message create; channel falls back to undefined. |
| Total research timeout (>45s aggregate) | Outer `Promise.race` against a 45s deadline. On timeout, `researchCompetitorsLive` returns whatever channels completed and discards in-flight ones. |
| Schema validation fail on submit_competitor_insight output | `console.warn` with the validation issues; channel returns undefined. |
| Watch_handles upsert fails | `console.warn`; we still return the insight (the planner doesn't need persistence to land successfully). |
| User's brief is empty / missing | `researchCompetitorsLive` early-returns `[]` with a warning — Claude has nothing to research against. |

All warnings go through `console.warn` with prefix `"Competitor research:"`
for grep-ability in production logs. Match the existing failure-logging
style used for Smart Timing (`src/app/(app)/plans/new/actions.ts:317`) and
hashtag backfill (`src/app/(app)/plans/new/actions.ts:471`).

### What the user sees on failure

Nothing — the plan generates and looks identical to a plan with the toggle
off. No banner, no error toast. The toggle on the form simply hasn't been
"honoured" but the user got a plan, which is the contract.

Future polish (out of scope for V1): surface a one-line note on the plan
detail page ("Competitor research timed out — plan generated from your
historical data only") when `competitorInsights === undefined && toggle
was on`. Requires plumbing the boolean through to `posting_plans` metadata.

---

## File touch-list

**New:**
- `/Users/mawad/Desktop/hunger/marketingmagic/src/lib/plan/competitor-research.ts` — `CompetitorInsight`, Zod schema, `researchCompetitorsLive()`, both Anthropic prompts.

**Modified:**
- `/Users/mawad/Desktop/hunger/marketingmagic/src/lib/plan/prompt.ts:41` — add `competitorInsights?: CompetitorInsight[]` to `PlanGenInputs`.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/lib/plan/prompt.ts:320` — call `competitorInsightsBlock(inputs.competitorInsights)` between `themeWinnersBlock` and `sourceBlock`.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/lib/plan/prompt.ts` (top) — import `CompetitorInsight`.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/app/(app)/plans/new/actions.ts:127` — read `compare_competitors`, call research, forward to `generatePlan`.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/app/(app)/plans/new/new-plan-form.tsx:118` — checkbox UI.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/app/(app)/goals/[id]/actions.ts:176` — read `compare_competitors`, call research, forward to `generatePostsFromGoal`.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/app/(app)/goals/[id]/generate-plan-button.tsx:17` — checkbox UI.
- `/Users/mawad/Desktop/hunger/marketingmagic/src/lib/goals/generate-plan.ts` — verify `competitorInsights` is forwarded through (may already work via spread).

**No DB migration.** Reuses `watch_handles` + `competitor_posts` as-is.
