"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import { assertWithinChannelQuota, QuotaExceededError } from "@/lib/billing/limits";
import {
  facebookVerify,
  FB_PAGE_PICKER_COOKIE,
  type FacebookCredentials,
  type FacebookPickerStash,
} from "@/lib/social/facebook";

const schema = z.object({
  page_id: z.string().min(1),
});

// Finalize the operator's Page choice. The `fb_page_picker` cookie (set by the
// OAuth callback for the multi-Page case) holds every candidate Page + its
// token. We resolve the chosen Page's token from that cookie server-side,
// verify it against the Page node, run the channel quota, then insert ONE
// connected social_accounts row for the chosen Page. The cookie is cleared on
// success or any terminal redirect so the secret tokens don't linger.
export async function selectFacebookPageAction(formData: FormData): Promise<void> {
  const parsed = schema.safeParse({ page_id: formData.get("page_id") });
  if (!parsed.success) redirect("/settings/channels?error=invalid_page");

  const ws = await getActiveWorkspaceOrRedirect();
  const jar = await cookies();

  const raw = jar.get(FB_PAGE_PICKER_COOKIE)?.value;
  if (!raw) redirect("/settings/channels?error=facebook_picker_expired");

  let stash: FacebookPickerStash;
  try {
    stash = JSON.parse(raw) as FacebookPickerStash;
  } catch {
    jar.delete(FB_PAGE_PICKER_COOKIE);
    redirect("/settings/channels?error=facebook_picker_expired");
  }

  // Bind the choice to the workspace that started the flow.
  if (stash.workspaceId !== ws.id) {
    jar.delete(FB_PAGE_PICKER_COOKIE);
    redirect("/settings/channels?error=facebook_picker_workspace_mismatch");
  }

  const chosen = (stash.pages ?? []).find((p) => p.pageId === parsed.data.page_id);
  // The chosen Page must come from the stashed candidate set — never trust a
  // page_id that didn't originate from this OAuth grant's /me/accounts list.
  if (!chosen) {
    jar.delete(FB_PAGE_PICKER_COOKIE);
    redirect("/settings/channels?error=page_not_found");
  }

  // Sanity-check the Page token works against the Page node (mirrors the
  // single-Page callback path).
  let name = chosen.pageName;
  try {
    const verified = await facebookVerify(chosen.pageId, chosen.pageAccessToken);
    name = verified.name || chosen.pageName;
  } catch {
    jar.delete(FB_PAGE_PICKER_COOKIE);
    redirect("/settings/channels?error=facebook_verify_failed");
  }

  // Plan-gating: hobby tier caps connected channels at 1. Checked here (not in
  // the callback) because this is where the single real row is inserted.
  // Reconnect of the same (channel, handle) is grandfathered through.
  try {
    await assertWithinChannelQuota(ws.id, { channel: "facebook", handle: name });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      jar.delete(FB_PAGE_PICKER_COOKIE);
      redirect(`/settings/billing?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }

  const creds: FacebookCredentials = {
    pageId: chosen.pageId,
    pageAccessToken: chosen.pageAccessToken,
    expiresAt: stash.expiresAt,
  };

  const svc = supabaseService();
  const { error: dbErr } = await svc.from("social_accounts").upsert(
    {
      workspace_id: ws.id,
      channel: "facebook",
      handle: name,
      credentials: creds as unknown as Record<string, string>,
      status: "connected",
    },
    { onConflict: "workspace_id,channel,handle" },
  );
  if (dbErr) {
    jar.delete(FB_PAGE_PICKER_COOKIE);
    redirect(`/settings/channels?error=${encodeURIComponent(dbErr.message)}`);
  }

  jar.delete(FB_PAGE_PICKER_COOKIE);
  redirect("/settings/channels?connected=facebook");
}
