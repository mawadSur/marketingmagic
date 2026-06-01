import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";
import { siteUrl } from "@/lib/env";
import {
  getOrCreateReferralCode,
  countReferralsByVesting,
  REFERRAL_BONUS_POSTS,
} from "@/lib/growth/referrals";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyInviteLink, AttributionToggle } from "./referral-controls";

export const dynamic = "force-dynamic";

export default async function ReferralsPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  // Mint the code lazily on first visit, then assemble the shareable link.
  const [code, counts, plan] = await Promise.all([
    getOrCreateReferralCode(ws.id),
    countReferralsByVesting(ws.id),
    resolvePlanForWorkspace(ws.id),
  ]);
  const inviteUrl = `${siteUrl()}/signup?ref=${encodeURIComponent(code)}`;
  // Bonus is only earned once a referral VESTS (the referred workspace ships
  // its first post). Pending signups haven't paid out yet — that's the
  // anti-farming guarantee made visible.
  const earned = counts.vested * REFERRAL_BONUS_POSTS;
  const isHobby = plan === "hobby";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Refer &amp; earn</h1>
        <p className="text-sm text-muted-foreground">
          Share your invite link. Every workspace that signs up through it and
          ships their first post earns you {REFERRAL_BONUS_POSTS} bonus posts a
          month, forever.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your invite link</CardTitle>
          <CardDescription>
            Anyone who creates a workspace through this link is attributed to you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyInviteLink url={inviteUrl} />
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Vested signups</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">{counts.vested}</p>
            <p className="mt-1 text-xs text-muted-foreground">Posted &amp; paid out</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pending signups</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">{counts.pending}</p>
            <p className="mt-1 text-xs text-muted-foreground">Awaiting first post</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Bonus posts / month</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">+{earned}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Attribution</CardTitle>
          <CardDescription>
            Free workspaces help spread the word with a small footer on each post.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AttributionToggle enabled={ws.attribution_enabled} isHobby={isHobby} />
        </CardContent>
      </Card>
    </div>
  );
}
