import Link from "next/link";
import { Link2, PenLine, CalendarPlus, Send, ArrowRight } from "lucide-react";
import { supabaseServer } from "@/lib/supabase/server";

// Slice D — dashboard "next best action" activation card.
//
// Un-activated workspaces (never published a single post) used to land on a
// generic dashboard full of empty/cold-start widgets with no clear next step.
// This card sits at the TOP of the dashboard and points to the SINGLE next
// action based on where the workspace actually is in the activation funnel:
//
//   0 connected channels        → "Connect your first channel"  → /settings/channels
//   ≥1 channel, no brand brief  → "Write your brand brief"      → /onboarding/wizard?step=1
//   ≥1 channel + brief, 0 plans → "Generate your first week"    → /onboarding/wizard?step=3
//   has a pre-publish draft     → "Publish your first post"     → /onboarding/wizard?step=4
//
// The brief step matters: the brand brief is the gate to plan generation, so a
// user with channels-but-no-brief who's pointed straight at "Generate your
// first week" dead-ends on the wizard's "we need a brief first" preflight.
// Surfacing the brief as its own next-best-action keeps the funnel unblocked.
//
// The moment the workspace has ≥1 post with status='posted', the card stops
// rendering and the normal dashboard takes over (matches the dashboard's
// "no empty cards once there's real signal" convention).
//
// Self-contained server component (same shape as EngagementDebtWidget /
// WinningThemesWidget): takes a workspaceId and runs its own RLS-scoped reads
// via the authed server client, so the page stays a thin composition. All five
// reads are cheap existence/count head-queries batched in one Promise.all.

type Step = {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  href: string;
  icon: typeof Link2;
};

// Post statuses that mean "drafted but not yet live" — anything in the
// pre-publish pipeline. If any exist, the next step is to ship one.
const DRAFT_STATUSES = ["draft", "pending_approval", "approved", "scheduled"] as const;

export async function ActivationCard({ workspaceId }: { workspaceId: string }) {
  const supabase = await supabaseServer();

  const [postedRes, channelsRes, briefRes, planRes, draftRes] = await Promise.all([
    // All-time published count — the activation gate. Head/count only.
    supabase
      .from("posts")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "posted"),
    // Connected channels (a disconnected/expired account can't publish, so we
    // only count status='connected' — same semantics as the onboarding wizard).
    supabase
      .from("social_accounts_safe")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("status", "connected"),
    // Does a brand brief exist yet? It's the gate to plan generation — same
    // existence check the onboarding wizard's step-3 preflight uses.
    supabase
      .from("brand_briefs")
      .select("id")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    // Does any posting plan exist yet?
    supabase
      .from("posting_plans")
      .select("id")
      .eq("workspace_id", workspaceId)
      .limit(1)
      .maybeSingle(),
    // Is there a draft sitting in a pre-publish state, ready to ship?
    supabase
      .from("posts")
      .select("id")
      .eq("workspace_id", workspaceId)
      .in("status", DRAFT_STATUSES)
      .limit(1)
      .maybeSingle(),
  ]);

  // Already activated — hand the page back to the normal dashboard.
  if ((postedRes.count ?? 0) > 0) return null;

  const channelCount = channelsRes.count ?? 0;
  const hasBrief = Boolean(briefRes.data);
  const hasPlan = Boolean(planRes.data);
  const hasDraft = Boolean(draftRes.data);

  const step = resolveStep({ channelCount, hasBrief, hasPlan, hasDraft });

  const Icon = step.icon;

  return (
    <section
      aria-labelledby="activation-card-title"
      className="overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card shadow-sm"
    >
      <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
          <div className="space-y-1.5">
            <p className="label-eyebrow text-primary">{step.eyebrow}</p>
            <h2 id="activation-card-title" className="text-lg font-semibold tracking-tight">
              {step.title}
            </h2>
            <p className="max-w-xl text-sm text-muted-foreground">{step.body}</p>
          </div>
        </div>
        <Link
          href={step.href}
          className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity duration-200 hover:opacity-90"
        >
          {step.cta}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </section>
  );
}

// Pure state → next-best-action resolver. Order matters: each step assumes the
// prior one is done, so we check the most-advanced state first and fall back
// toward the activation cliff. A workspace with a draft already has a channel +
// brief + plan, so "publish" wins; a channel + brief but no plan → "generate";
// a channel but no brief → "write brief" (the brief gates plan generation, so
// it must come before "generate"); no channel at all → "connect". Default falls
// back to connect, the very first step.
function resolveStep({
  channelCount,
  hasBrief,
  hasPlan,
  hasDraft,
}: {
  channelCount: number;
  hasBrief: boolean;
  hasPlan: boolean;
  hasDraft: boolean;
}): Step {
  if (hasDraft) {
    return {
      eyebrow: "One step left",
      title: "Publish your first post",
      body: "You've got drafts ready to go. Ship one to go live — that's the whole point. Nothing posts without your click.",
      cta: "Publish your first post",
      // The wizard's done screen ships the first draft in one click. /queue is a
      // safe fallback if the wizard can't resolve a draft.
      href: "/onboarding/wizard?step=4",
      icon: Send,
    };
  }

  if (channelCount > 0 && hasBrief && !hasPlan) {
    return {
      eyebrow: "Next step",
      title: "Generate your first week",
      body: "Your channel's connected. Let's draft a week of posts in your voice — review them, then publish. Takes about a minute.",
      cta: "Generate your first week",
      href: "/onboarding/wizard?step=3",
      icon: CalendarPlus,
    };
  }

  if (channelCount > 0 && !hasBrief) {
    return {
      eyebrow: "Next step",
      title: "Write your brand brief",
      body: "Your channel's connected. Now teach the planner your voice — what you do, who you sell to, how you sound. Paste your site and we'll draft it for you.",
      cta: "Write your brand brief",
      // The wizard's brief step doubles as the canonical brief entry: it reads
      // your site to pre-fill the fields, then advances forward through the
      // funnel on save (→ channels → plan) so the user lands somewhere useful.
      href: "/onboarding/wizard?step=1",
      icon: PenLine,
    };
  }

  // 0 channels (or any earlier state) — connect a channel, the activation gate.
  return {
    eyebrow: "Get started",
    title: "Connect your first channel",
    body: "Hook up one social account so we have somewhere to post. It's the one thing standing between you and your first published post.",
    cta: "Connect your first channel",
    href: "/settings/channels",
    icon: Link2,
  };
}
