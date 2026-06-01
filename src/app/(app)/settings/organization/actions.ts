"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { supabaseService } from "@/lib/supabase/service";
import { slugify } from "@/lib/slug";
import { setActiveWorkspaceCookie } from "@/lib/workspace";
import { syncOrgSubscriptionQuantitySafe } from "@/lib/billing/org-subscription";

// ─────────────────────────────────────────────────────────────
// Organization settings — create org + add client (Phase A, migration 029)
// ─────────────────────────────────────────────────────────────
//
// Mirrors the workspace-create flow (onboarding/workspace/actions.ts). Solo
// users never touch this surface; it only matters once a user wants to run an
// agency. Creating an org is additive — it does NOT migrate the user's existing
// solo workspaces into the org (those stay solo). "Add a client" mints a brand
// new workspace with organization_id set.

export type CreateOrgState = { error: string | null };

const createOrgSchema = z.object({ name: z.string().trim().min(2).max(60) });

export async function createOrganizationAction(
  _prev: CreateOrgState,
  formData: FormData,
): Promise<CreateOrgState> {
  const parsed = createOrgSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) return { error: "Pick a name between 2 and 60 characters." };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  const slug = await uniqueOrgSlug(slugify(parsed.data.name) || "agency");

  const { error } = await supabase.from("organizations").insert({
    name: parsed.data.name,
    slug,
    owner_id: user.id,
  });
  if (error) return { error: error.message };

  revalidatePath("/settings/organization");
  redirect("/settings/organization");
}

export type AddClientState = { error: string | null };

const addClientSchema = z.object({
  name: z.string().trim().min(2).max(60),
  organization_id: z.string().uuid(),
});

/**
 * Create a new client workspace under an organization. ADDING A CLIENT IS AN
 * ORG-ADMIN-ONLY action: the caller must be the org owner OR hold an 'admin'
 * org_membership role. A 'manager' member (who can run existing client
 * workspaces but not change org structure) is explicitly NOT allowed — adding a
 * client bumps the billed seat count (locked decision #1), so it sits with the
 * same people who control billing/membership.
 *
 * Authorization is enforced server-side via the user_is_org_admin(org_id) RPC
 * (SECURITY DEFINER, owner-or-'admin'), evaluated under the caller's auth
 * session. We do NOT rely on RLS readability alone (which a manager would also
 * pass) and we do NOT take the org id from any trusted source other than the
 * form — the RPC re-derives the caller's role from auth.uid(), so a forged or
 * manager-level request can't escalate. The service-role insert path is never
 * used here, so there is no way to bypass the gate.
 *
 * Phase C (billing) hooks the Stripe subscription-quantity bump after the gate.
 */
export async function addClientAction(
  _prev: AddClientState,
  formData: FormData,
): Promise<AddClientState> {
  const parsed = addClientSchema.safeParse({
    name: formData.get("name"),
    organization_id: formData.get("organization_id"),
  });
  if (!parsed.success) return { error: "Enter a client name (2–60 characters)." };

  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "You must be signed in." };

  // Authorization (org-admin-only): owner or 'admin' role. The RPC runs under
  // the caller's session and re-derives the role from auth.uid(), so a
  // 'manager' member or a non-member is rejected — no privilege escalation.
  const { data: isAdmin, error: authzErr } = await supabase.rpc("user_is_org_admin", {
    org_id: parsed.data.organization_id,
  });
  if (authzErr || isAdmin !== true) {
    return { error: "Only an organization admin can add a client." };
  }

  const slug = await uniqueWorkspaceSlug(slugify(parsed.data.name) || "client");

  // owner_id is the agency user who created the client. The org grant in
  // is_workspace_member is what gives the rest of the agency staff access.
  const { error } = await supabase.from("workspaces").insert({
    name: parsed.data.name,
    slug,
    owner_id: user.id,
    organization_id: parsed.data.organization_id,
  });
  if (error) return { error: error.message };

  // Phase C: a new client = one more billed seat. Bump the org subscription's
  // quantity (Stripe prorates). Best-effort: a Stripe failure here logs loudly
  // but never blocks the client from being created — the webhook + the org
  // billing page reconcile any drift. No-op until the org has a subscription.
  await syncOrgSubscriptionQuantitySafe(parsed.data.organization_id);

  // Make the new client the active workspace so the operator drops straight
  // into setting it up.
  await setActiveWorkspaceCookie(slug);

  revalidatePath("/settings/organization");
  revalidatePath("/", "layout");
  redirect("/settings/organization");
}

// ─── slug helpers (mirror onboarding/workspace/actions.ts) ──────────────

async function uniqueOrgSlug(base: string): Promise<string> {
  const svc = supabaseService();
  let candidate = base;
  for (let i = 0; i < 25; i++) {
    const { data } = await svc.from("organizations").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${Math.floor(Math.random() * 1000)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

async function uniqueWorkspaceSlug(base: string): Promise<string> {
  const svc = supabaseService();
  let candidate = base;
  for (let i = 0; i < 25; i++) {
    const { data } = await svc.from("workspaces").select("id").eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${Math.floor(Math.random() * 1000)}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}
