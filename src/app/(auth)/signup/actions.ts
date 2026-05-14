"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { siteUrl } from "@/lib/env";

export type SignupActionState = { error: string | null; info: string | null };

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters."),
  // Optional invite token — when present we redirect to the invite page
  // after signup so the user lands on the accept screen rather than the
  // workspace-creation onboarding (their workspace is the one they were
  // invited to, not a new one).
  invite: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .nullable(),
});

export async function signupAction(
  _prev: SignupActionState,
  formData: FormData,
): Promise<SignupActionState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    invite: formData.get("invite") || null,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input.", info: null };
  }

  // For invite signups we send the email-confirm link to the invite page
  // rather than the default workspace-creation onboarding, so they finish
  // the join flow.
  const next = parsed.data.invite
    ? `/invite/${encodeURIComponent(parsed.data.invite)}`
    : "/onboarding/workspace";

  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${siteUrl()}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  });
  if (error) {
    return { error: error.message, info: null };
  }
  if (!data.session) {
    return {
      error: null,
      info: "Check your email to confirm your account, then log in.",
    };
  }
  redirect(next);
}
