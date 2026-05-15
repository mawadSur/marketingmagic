import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test as base, type BrowserContext, type Page } from "@playwright/test";
import type { Database } from "../../../src/lib/db/types";

// E2E users are throwaway. They share a stable prefix so a stuck CI run
// can be cleaned up by hand without touching real accounts.
const E2E_EMAIL_PREFIX = "e2e+";
const E2E_DOMAIN = "marketingmagic-tests.local";
const E2E_PASSWORD = "test-password-Aa1!";

let admin: SupabaseClient<Database> | null = null;

function getAdmin(): SupabaseClient<Database> {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are required for e2e tests",
    );
  }
  admin = createClient<Database>(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return admin;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export async function createTestUser(): Promise<TestUser> {
  const a = getAdmin();
  const email = `${E2E_EMAIL_PREFIX}${Date.now()}.${Math.random().toString(36).slice(2, 8)}@${E2E_DOMAIN}`;
  const { data, error } = await a.auth.admin.createUser({
    email,
    password: E2E_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createTestUser failed: ${error?.message ?? "no user returned"}`);
  }
  return { id: data.user.id, email, password: E2E_PASSWORD };
}

export async function deleteTestUser(userId: string): Promise<void> {
  const a = getAdmin();
  // workspaces.owner_id FK uses ON DELETE RESTRICT, so drop the user's
  // workspaces first. Everything else cascades from workspaces.
  await a.from("workspaces").delete().eq("owner_id", userId);
  await a.auth.admin.deleteUser(userId);
}

// Drive the real /login form so the session cookies are set exactly as
// they are for a normal user — no shortcuts that could mask cookie bugs.
export async function loginViaUI(page: Page, user: TestUser): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: /log in/i }).click();
  // The action redirects to /dashboard on success; with no workspace yet
  // the (app) layout bounces to /onboarding/workspace. Either is fine.
  // Generous timeout: Next.js dev compiles routes JIT on first hit, which
  // can chew 20+ seconds on a cold cache.
  await page.waitForURL(/\/(dashboard|onboarding\/workspace)/, { timeout: 45_000 });
}

interface Fixtures {
  testUser: TestUser;
  authedContext: { context: BrowserContext; page: Page; user: TestUser };
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  testUser: async ({}, use) => {
    const user = await createTestUser();
    try {
      await use(user);
    } finally {
      await deleteTestUser(user.id);
    }
  },
  authedContext: async ({ browser, testUser }, use) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginViaUI(page, testUser);
    try {
      await use({ context, page, user: testUser });
    } finally {
      await context.close();
    }
  },
});

export { expect } from "@playwright/test";
