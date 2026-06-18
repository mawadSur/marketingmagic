"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { safeInternalPath } from "@/lib/auth/redirect";

export type LoginActionState = { error: string | null };

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  next: z.string().optional(),
});

export async function loginAction(_prev: LoginActionState, formData: FormData): Promise<LoginActionState> {
  const parsed = schema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next"),
  });
  if (!parsed.success) {
    return { error: "Enter a valid email and password." };
  }

  // `next` is a hidden form field — anyone can set it, so route it through the
  // internal-path guard to block open redirects (//evil.com, https://evil.com).
  const next = safeInternalPath(parsed.data.next, "/dashboard");

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });
  if (error) {
    return { error: error.message };
  }
  redirect(next);
}
