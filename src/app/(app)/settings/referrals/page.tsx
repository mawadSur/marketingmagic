import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { resolvePlanForWorkspace } from "@/lib/billing/entitlements";
import { siteUrl } from "@/lib/env";
import {
  getOrCreateReferralCode,
  countReferrals,
  REFERRAL_BONUS_POSTS,
} from "@/lib/growth/referrals";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CopyInviteLink, AttributionToggle } from "./referral-controls";

export const dynamic = "force-dynamic";

export default async function ReferralsPage() {
  const ws = await getActiveWorkspaceOrRedirect();

  // Mint the code lazily on first visit, then assemble the shareable link.
  const [code, signups, plan] = await Promise.all([
    getOrCreateReferralCode(ws.id),
    countReferrals(ws.id),
    resolvePlanForWorkspace(ws.id),
  ]);
  const inviteUrl = `${siteUrl()}/signup?ref=${encodeURIComponent(code)}`;
  const earned = signups * REFERRAL_BONUS_POSTS;
  const isHobby = plan === "hobby";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Refer &amp; earn</h1>
        <p className="text-sm text-muted-foreground">
          Share your invite link. Every workspace that signs up through it earns you{" "}
          {REFERRAL_BONUS_POSTS} bonus posts a month, forever.
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

      <div className="grid grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Signups driven</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold tabular-nums">{signups}</p>
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
