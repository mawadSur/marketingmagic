import { createClient } from "@supabase/supabase-js";
import { test, expect } from "./helpers/test-user";
import { signLinkClaimToken } from "../../src/lib/integrations/sign";
import type { Database } from "../../src/lib/db/types";

// Phase 4.7 multi-member attribution — locks the link-claim flow that
// converts a signed Discord prompt into a discord_links row attributing
// future approvals to the right Supabase user.
//
// Skipped when EMAIL_LINK_SECRET isn't configured: the link page returns
// a "not configured" error in that case, so the happy-path assertions
// would all fail the same way. Set the env var locally + in Vercel to
// activate. The Discord action handler is already guarded with the same
// check so this skip mirrors production behaviour.
test.describe("Discord link claim", () => {
  test.skip(
    !process.env.EMAIL_LINK_SECRET,
    "EMAIL_LINK_SECRET not set — Discord link-claim is disabled",
  );


  test("happy path: valid token → discord_links row + success page", async ({
    authedContext,
  }) => {
    const { page, user } = authedContext;
    const secret = process.env.EMAIL_LINK_SECRET!;

    // Bootstrap a workspace so the test user is a member of something.
    await page.getByLabel(/workspace name/i).fill("Discord Link Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    // Discover the workspace id via service role — the UI doesn't expose it.
    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id, name")
      .eq("owner_id", user.id);
    expect(workspaces?.length).toBe(1);
    const workspaceId = workspaces![0]!.id;

    const fakeDiscordId = `e2e-discord-${Date.now()}`;
    const token = signLinkClaimToken(
      {
        workspace_id: workspaceId,
        discord_user_id: fakeDiscordId,
        discord_username: "e2e-tester#0001",
      },
      secret!,
    );

    await page.goto(`/integrations/discord/link?token=${encodeURIComponent(token)}`);

    await expect(page.getByRole("heading", { name: /you.{0,3}re linked/i })).toBeVisible();
    await expect(page.getByText(fakeDiscordId)).toBeVisible();

    // Verify the row landed in the database.
    const { data: link } = await admin
      .from("discord_links")
      .select("member_user_id, discord_user_id")
      .eq("workspace_id", workspaceId)
      .eq("discord_user_id", fakeDiscordId)
      .maybeSingle();
    expect(link).not.toBeNull();
    expect(link!.member_user_id).toBe(user.id);
  });

  test("re-clicking the same link is idempotent", async ({ authedContext }) => {
    const { page, user } = authedContext;
    const secret = process.env.EMAIL_LINK_SECRET!;

    await page.getByLabel(/workspace name/i).fill("Idempotent Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    const admin = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data: workspaces } = await admin
      .from("workspaces")
      .select("id")
      .eq("owner_id", user.id);
    const workspaceId = workspaces![0]!.id;
    const fakeDiscordId = `e2e-idem-${Date.now()}`;
    const token = signLinkClaimToken(
      {
        workspace_id: workspaceId,
        discord_user_id: fakeDiscordId,
        discord_username: "idem#0002",
      },
      secret,
    );

    await page.goto(`/integrations/discord/link?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { name: /you.{0,3}re linked/i })).toBeVisible();

    // Click again — same success page, no duplicate row.
    await page.goto(`/integrations/discord/link?token=${encodeURIComponent(token)}`);
    await expect(page.getByRole("heading", { name: /you.{0,3}re linked/i })).toBeVisible();

    const { count } = await admin
      .from("discord_links")
      .select("*", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("discord_user_id", fakeDiscordId);
    expect(count).toBe(1);
  });

  test("missing token → friendly error", async ({ authedContext }) => {
    const { page } = authedContext;
    await page.getByLabel(/workspace name/i).fill("No Token Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    await page.goto("/integrations/discord/link");
    await expect(page.getByRole("heading", { name: /missing token/i })).toBeVisible();
  });

  test("bad-signature token → invalid-link error", async ({ authedContext }) => {
    const { page } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Bad Sig Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    // Token in the right shape but signed with a different secret.
    const tampered = signLinkClaimToken(
      {
        workspace_id: "00000000-0000-0000-0000-000000000000",
        discord_user_id: "tampered",
        discord_username: "tampered",
      },
      "definitely-not-the-real-secret-padded-for-min-length",
    );
    await page.goto(`/integrations/discord/link?token=${encodeURIComponent(tampered)}`);
    await expect(page.getByRole("heading", { name: /no longer valid/i })).toBeVisible();
  });

  test("token for a workspace the user isn't a member of → membership error", async ({
    authedContext,
  }) => {
    const { page } = authedContext;
    const secret = process.env.EMAIL_LINK_SECRET!;
    await page.getByLabel(/workspace name/i).fill("Outsider Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    // Random uuid — guaranteed not a workspace this user belongs to.
    const token = signLinkClaimToken(
      {
        workspace_id: "11111111-2222-3333-4444-555555555555",
        discord_user_id: "outsider",
        discord_username: "outsider",
      },
      secret,
    );
    await page.goto(`/integrations/discord/link?token=${encodeURIComponent(token)}`);
    await expect(
      page.getByRole("heading", { name: /different workspace/i }),
    ).toBeVisible();
  });
});
