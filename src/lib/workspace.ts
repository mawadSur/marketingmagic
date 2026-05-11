import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { supabaseServer } from "@/lib/supabase/server";
import type { Database } from "@/lib/db/types";

export const ACTIVE_WS_COOKIE = "mm_active_ws";

type Workspace = Database["public"]["Tables"]["workspaces"]["Row"];

export async function listWorkspaces(): Promise<Workspace[]> {
  const supabase = await supabaseServer();
  const { data } = await supabase
    .from("workspaces")
    .select("*")
    .order("created_at", { ascending: true });
  return data ?? [];
}

export async function getAuthedUserOrRedirect(redirectTo = "/login"): Promise<User> {
  const supabase = await supabaseServer();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect(redirectTo);
  return user;
}

export async function getActiveWorkspaceOrRedirect(): Promise<Workspace> {
  await getAuthedUserOrRedirect();
  const workspaces = await listWorkspaces();
  if (workspaces.length === 0) redirect("/onboarding/workspace");

  const cookieStore = await cookies();
  const slug = cookieStore.get(ACTIVE_WS_COOKIE)?.value;
  const active = (slug && workspaces.find((w) => w.slug === slug)) || workspaces[0]!;
  return active;
}

export async function setActiveWorkspaceCookie(slug: string) {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_WS_COOKIE, slug, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
}
