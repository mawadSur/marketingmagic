import Link from "next/link";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseServer } from "@/lib/supabase/server";
import { EmptyState } from "@/components/ui/empty-state";
import { QueueTabs } from "../queue-tabs";
import { GroupsManager, type GroupView, type GroupDraftView } from "./groups-manager";
import { TodayPanel } from "./today-panel";
import {
  postingVerdictNow,
  type GroupPostingRules,
} from "@/lib/groups/posting-rules";
import {
  nextRecommendedSlot,
  upcomingRecommendedSlots,
  isAllowedToday,
} from "@/lib/groups/schedule";
import type { FacebookGroupPromoPolicy } from "@/lib/db/types";

export const dynamic = "force-dynamic";

// Facebook Group Assist.
//
// Meta removed the Groups API (publish_to_groups + the group /feed endpoint,
// 2024-04-22), so there is no supported way to post to — or join — a group
// programmatically. This surface is the ToS-safe alternative: we draft
// group-tailored copy (AI from the brand brief/voice + the group's own rules,
// or manual), tell the operator whether NOW is a good time to post in each
// group, and they copy + paste + post by hand. Nothing here is ever
// auto-published; group drafts live in their own tables, never in `posts`.

export default async function GroupsPage() {
  const ws = await getActiveWorkspaceOrRedirect();
  const supabase = await supabaseServer();

  const [groupsRes, draftsRes, briefRes, hasBriefRes] = await Promise.all([
    supabase
      .from("facebook_groups")
      .select("id, name, url, member_count, promo_policy, promo_weekdays, allow_links, rules_notes")
      .eq("workspace_id", ws.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("facebook_group_drafts")
      .select("id, group_id, text, source, status, posted_at, created_at")
      .eq("workspace_id", ws.id)
      .in("status", ["draft", "posted"])
      .order("created_at", { ascending: false }),
    supabase.from("brand_briefs").select("audience_timezone").eq("workspace_id", ws.id).maybeSingle(),
    supabase.from("brand_briefs").select("id").eq("workspace_id", ws.id).maybeSingle(),
  ]);

  const timezone = briefRes.data?.audience_timezone || "UTC";
  const hasBrief = Boolean(hasBriefRes.data);
  const now = new Date();

  // Bucket drafts under their group. Posted drafts stay visible (as a recent
  // activity log) but are separated from the actionable "to post" list in the
  // client component.
  const draftsByGroup = new Map<string, GroupDraftView[]>();
  for (const d of draftsRes.data ?? []) {
    const list = draftsByGroup.get(d.group_id) ?? [];
    list.push({
      id: d.id,
      text: d.text,
      source: d.source,
      status: d.status,
      posted_at: d.posted_at,
      created_at: d.created_at,
    });
    draftsByGroup.set(d.group_id, list);
  }

  const groups: GroupView[] = (groupsRes.data ?? []).map((g) => {
    const rules: GroupPostingRules = {
      promo_policy: g.promo_policy as FacebookGroupPromoPolicy,
      promo_weekdays: g.promo_weekdays ?? [],
      allow_links: g.allow_links,
      rules_notes: g.rules_notes ?? "",
    };
    const verdict = postingVerdictNow(rules, now, timezone);
    return {
      id: g.id,
      name: g.name,
      url: g.url,
      member_count: g.member_count,
      promo_policy: rules.promo_policy,
      promo_weekdays: rules.promo_weekdays,
      allow_links: g.allow_links,
      rules_notes: rules.rules_notes,
      verdict,
      recommendedSlot: nextRecommendedSlot(rules, now, timezone),
      upcomingSlots: upcomingRecommendedSlots(rules, now, timezone, 3),
      allowedToday: isAllowedToday(rules, now, timezone),
      drafts: draftsByGroup.get(g.id) ?? [],
    };
  });

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          {/* "timing", not "schedule" — this feature recommends WHEN to post but
              never auto-posts (Meta has no Groups API), so avoid implying the
              time-based scheduling the main queue offers. */}
          <p className="label-eyebrow">Drafts &amp; timing</p>
          <h1 className="text-3xl font-semibold tracking-tight">Facebook Groups</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Draft posts tailored to each group&apos;s rules, then copy &amp; post them yourself.
            Facebook doesn&apos;t allow apps to post to groups, so this keeps you compliant — we
            handle the writing and the timing heads-up; you tap &ldquo;post.&rdquo;
          </p>
        </div>
      </header>

      <QueueTabs />

      {/* Why this is manual — set expectations up front so users don't hunt for
          an "auto-post to group" toggle that can't exist. */}
      <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-4 text-sm">
        <p className="font-medium">Posting to groups is manual — by design.</p>
        <p className="mt-1 text-muted-foreground">
          Meta retired the Groups API in April 2024, so no tool can post to a Facebook Group for
          you (anything claiming otherwise risks your account). We draft the post and tell you when
          each group allows it; you paste and post in one tap.
        </p>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon="plug"
          title="No groups yet."
          description="Add a Facebook group you're active in — paste its link and its posting rules, and we'll draft posts that fit and warn you when it's the wrong day."
        />
      ) : (
        <TodayPanel groups={groups} />
      )}

      <GroupsManager groups={groups} hasBrief={hasBrief} timezone={timezone} />

      <p className="text-xs text-muted-foreground">
        Don&apos;t have a brief yet?{" "}
        <Link href="/settings/brief" className="font-medium text-foreground underline-offset-2 hover:underline">
          Add your business info
        </Link>{" "}
        so AI drafts sound like you.
      </p>
    </div>
  );
}
