import Link from "next/link";
import { redirect } from "next/navigation";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { ENABLED_CHANNELS } from "@/lib/channels/registry";
import { WizardShell } from "./wizard-shell";
import { Step1Brief } from "./step-1-brief";
import { Step2Channels } from "./step-2-channels";
import { Step3Plan } from "./step-3-plan";
import { Step4Done } from "./step-4-done";

export const dynamic = "force-dynamic";

interface WizardPageProps {
  // Next 16 / App Router: searchParams is a Promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parseStep(raw: string | string[] | undefined): 1 | 2 | 3 | 4 {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (n === 2 || n === 3 || n === 4) return n;
  return 1;
}

export default async function OnboardingWizardPage({ searchParams }: WizardPageProps) {
  const ws = await getActiveWorkspaceOrRedirect();
  const params = await searchParams;
  const step = parseStep(params.step);
  const connectedParam = Array.isArray(params.connected) ? params.connected[0] : params.connected;

  if (step === 1) {
    const supabase = await supabaseServer();
    const { data: brief } = await supabase
      .from("brand_briefs")
      .select(
        "product_description, voice, target_audience, do_not_say, reference_links, reference_posts",
      )
      .eq("workspace_id", ws.id)
      .maybeSingle();

    return (
      <WizardShell
        step={1}
        title="Tell us about your business"
        subtitle="So we can write in your voice. Paste your site and we'll do most of the work."
        skipHref="/onboarding/wizard?step=2"
      >
        <Step1Brief initialBrief={brief ?? null} />
      </WizardShell>
    );
  }

  if (step === 2) {
    const supabase = await supabaseServer();
    const { data: accounts } = await supabase
      .from("social_accounts_safe")
      .select("channel, status")
      .eq("workspace_id", ws.id)
      .eq("status", "connected");

    const connectedChannels = Array.from(
      new Set((accounts ?? []).map((a) => a.channel as string).filter(Boolean)),
    );

    return (
      <WizardShell
        step={2}
        title="Where do you want to post?"
        subtitle="Connect one channel to get started. You can always add more later."
        // No skip: connecting a channel is the activation gate — you can't publish
        // without one, and a "skip" here dead-ends users in an empty queue (it was
        // the single biggest funnel drop-off). The step itself offers an honest
        // path for users without accounts yet ("Find me handles"). The in-step
        // "Continue to plan" button stays disabled until ≥1 channel is connected.
        skipHref={null}
      >
        <Step2Channels
          connectedChannels={connectedChannels}
          justConnected={connectedParam ?? null}
        />
      </WizardShell>
    );
  }

  if (step === 3) {
    const supabase = await supabaseServer();
    const [briefRes, accountsRes] = await Promise.all([
      supabase.from("brand_briefs").select("id").eq("workspace_id", ws.id).maybeSingle(),
      supabase
        .from("social_accounts_safe")
        .select("id, channel, handle")
        .eq("workspace_id", ws.id)
        .eq("status", "connected")
        .order("created_at", { ascending: true }),
    ]);

    const accounts = (accountsRes.data ?? []).filter((a) =>
      ENABLED_CHANNELS.includes(a.channel as (typeof ENABLED_CHANNELS)[number]),
    );

    // Preflight: same gates the regular /plans/new applies, surfaced as
    // friendly nudges back to earlier steps instead of a wall of text.
    if (!briefRes.data) {
      return (
        <WizardShell
          step={3}
          title="Almost — we need a brief first"
          subtitle="The brief teaches the planner what to write. Takes a minute."
          // "I'll do this later" is a real escape to the dashboard — NOT a loop
          // back to the brief step (which would contradict the label). The
          // dashboard's activation card re-surfaces "Write your brand brief" as
          // the next-best-action, so the user lands somewhere that nudges them
          // back to it. The primary CTA below still drives them to write it now.
          skipHref="/dashboard"
          skipLabel="I'll do this later"
        >
          <BackToStepBlock
            href="/onboarding/wizard?step=1"
            label="Write the brief →"
          />
        </WizardShell>
      );
    }
    if (accounts.length === 0) {
      return (
        <WizardShell
          step={3}
          title="One more thing — connect a channel"
          subtitle="We need somewhere to post before we can plan posts."
          // Gentle redirect back to the missing step, not a dump on an empty
          // dashboard: this user is ready to plan, they just skipped connecting.
          skipHref="/onboarding/wizard?step=2"
          skipLabel="I'll do this later"
        >
          <BackToStepBlock
            href="/onboarding/wizard?step=2"
            label="Connect a channel →"
          />
        </WizardShell>
      );
    }

    return (
      <WizardShell
        step={3}
        title="Let's plan your first week"
        subtitle="We'll draft posts using your brief. Nothing publishes without your approval."
        // No skip: this user has a brief AND a channel — they're ready to plan.
        // Skipping here drops a ready user into an empty product (the North-Star
        // event is a PUBLISHED post; an empty dashboard is the drop-off). The
        // only forward path is generating the plan (Step3Plan's generate action).
        skipHref={null}
      >
        <Step3Plan accounts={accounts} />
      </WizardShell>
    );
  }

  // step === 4
  // If somehow there's no plan yet, kick them back to step 3 so we don't
  // congratulate them for something they haven't done.
  const supabase = await supabaseServer();
  const { data: anyPlan } = await supabase
    .from("posting_plans")
    .select("id")
    .eq("workspace_id", ws.id)
    .limit(1)
    .maybeSingle();
  if (!anyPlan) redirect("/onboarding/wizard?step=3");

  // The activation aha isn't "a plan exists" — it's a post that's actually LIVE.
  // Pull the first ready-to-publish draft so the done screen can ship it in one
  // click (publishNowAction) instead of punting the user to /queue and a cron.
  const { data: firstDraft } = await supabase
    .from("posts")
    .select("id, channel, text")
    .eq("workspace_id", ws.id)
    .eq("status", "pending_approval")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  return (
    <WizardShell
      step={4}
      title="You're all set up"
      subtitle="That's the boring part done. Now the fun part."
      skipHref={null}
    >
      <Step4Done
        firstDraft={
          firstDraft
            ? { id: firstDraft.id as string, channel: firstDraft.channel as string, text: firstDraft.text as string }
            : null
        }
      />
    </WizardShell>
  );
}

function BackToStepBlock({ href, label }: { href: string; label: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-6 text-center">
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        {label}
      </Link>
    </div>
  );
}
