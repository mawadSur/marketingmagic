"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getActiveWorkspaceOrRedirect } from "@/lib/workspace";
import { supabaseService } from "@/lib/supabase/service";
import type { LinkedInCredentials } from "@/lib/social/linkedin";

const schema = z.object({
  account_id: z.string().uuid(),
  target: z.string().min(1), // "personal" or an "urn:li:organization:..." string
});

export async function selectLinkedInTargetAction(formData: FormData): Promise<void> {
  const parsed = schema.safeParse({
    account_id: formData.get("account_id"),
    target: formData.get("target"),
  });
  if (!parsed.success) redirect("/settings/channels?error=invalid_target");

  const ws = await getActiveWorkspaceOrRedirect();
  const svc = supabaseService();

  const { data: acct } = await svc
    .from("social_accounts")
    .select("id, workspace_id, credentials")
    .eq("id", parsed.data.account_id)
    .maybeSingle();
  if (!acct || acct.workspace_id !== ws.id) redirect("/settings/channels?error=account_not_found");

  const creds = acct.credentials as unknown as LinkedInCredentials;
  const isOrg = parsed.data.target.startsWith("urn:li:organization:");
  const next: LinkedInCredentials = {
    ...creds,
    targetOrgUrn: isOrg ? parsed.data.target : undefined,
  };

  await svc
    .from("social_accounts")
    .update({ credentials: next as unknown as Record<string, string> })
    .eq("id", acct.id);

  redirect("/settings/channels?connected=linkedin");
}
