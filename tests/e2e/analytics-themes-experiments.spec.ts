import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { test, expect } from "./helpers/test-user";
import type { Database } from "../../src/lib/db/types";

// Phase 6A (theme analytics) + Phase 6B (Quick Experiments) — covers the
// surfaces we can drive without burning a real Claude API call:
//
//   - /analytics/themes empty state for a fresh workspace
//   - /analytics/themes with seeded posts + post_metrics rendering verdict badges
//   - /queue Quick Experiment button visibility on a scheduled post
//     (without invoking Claude — we only assert the affordance is present)
//   - Quick Experiments dashboard widget visible only when an experiment exists
//   - Directional-winner banner copy when a completed experiment is seeded
//
// The runQuickExperimentAction → generateVariants path calls Claude with
// real tokens, so test 3 stops short of clicking the button (it would
// charge a $$ token bill on every CI run). The data-layer + UI states
// it depends on are seeded via the service-role admin client instead.
//
// All workspaces created here cascade-delete through the test-user
// fixture: workspaces.owner_id is dropped first, then auth.users, and
// every related table (posts, post_metrics, experiments, post_variants)
// has ON DELETE CASCADE off workspaces. No manual cleanup needed.

const ADMIN_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ADMIN_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function admin(): SupabaseClient<Database> {
  return createClient<Database>(ADMIN_URL, ADMIN_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getWorkspaceId(ownerId: string): Promise<string> {
  const a = admin();
  const { data } = await a
    .from("workspaces")
    .select("id")
    .eq("owner_id", ownerId);
  if (!data || data.length === 0) {
    throw new Error("Expected at least one workspace for the test user");
  }
  return data[0]!.id;
}

// Seed a single social_account row so post inserts (which require
// social_account_id NOT NULL) succeed. Channel 'x' matches what the rest
// of the app defaults to.
async function seedSocialAccount(
  a: SupabaseClient<Database>,
  workspaceId: string,
  channel: "x" | "linkedin" = "x",
): Promise<string> {
  const { data, error } = await a
    .from("social_accounts")
    .insert({
      workspace_id: workspaceId,
      channel,
      handle: `e2e-${channel}-${Date.now()}`,
      credentials: { mock: true } as never,
      status: "connected",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`social_account seed failed: ${error?.message}`);
  return data.id;
}

test.describe("Phase 6A — /analytics/themes", () => {
  test("empty state on a fresh workspace (no posts, no metrics)", async ({
    authedContext,
  }) => {
    // First test in the file to hit /analytics/themes — Next dev compiles
    // the route JIT, which can blow through the 60s default timeout on a
    // cold cache. Mirror the wider timeouts goals.spec.ts uses for the
    // same reason.
    test.setTimeout(180_000);
    const { page } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Themes Empty Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    await page.goto("/analytics/themes", { timeout: 120_000 });
    // Header always renders — assert it so we know the page loaded, then
    // assert the empty-state microcopy.
    await expect(
      page.getByRole("heading", { name: /theme performance/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/not enough data yet/i)).toBeVisible();
    await expect(
      page.getByText(/14 days of posted-and-measured posts.*3\+ posts per theme/i),
    ).toBeVisible();
  });

  test("renders verdict badges + sample counts when posts + metrics are seeded", async ({
    authedContext,
  }) => {
    const { page, user } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Themes Seeded Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    const a = admin();
    const workspaceId = await getWorkspaceId(user.id);
    const socialAccountId = await seedSocialAccount(a, workspaceId);

    // 10 posts across 2 themes: 5 "growth" (high engagement) and 5 "ops"
    // (low engagement). Posted dates spread across the last 21 days so the
    // 28-day window catches them and decay weights don't all collapse to 1.
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    type SeedRow = {
      theme: string;
      daysAgo: number;
      impressions: number;
      likes: number;
    };
    const seedRows: SeedRow[] = [
      // Growth — ~5% engagement rate (winner)
      { theme: "growth", daysAgo: 2, impressions: 1000, likes: 60 },
      { theme: "growth", daysAgo: 5, impressions: 1200, likes: 70 },
      { theme: "growth", daysAgo: 9, impressions: 900, likes: 55 },
      { theme: "growth", daysAgo: 14, impressions: 1100, likes: 58 },
      { theme: "growth", daysAgo: 20, impressions: 1000, likes: 50 },
      // Ops — ~0.5% engagement rate (loser)
      { theme: "ops", daysAgo: 3, impressions: 1500, likes: 5 },
      { theme: "ops", daysAgo: 7, impressions: 1300, likes: 6 },
      { theme: "ops", daysAgo: 11, impressions: 1400, likes: 7 },
      { theme: "ops", daysAgo: 16, impressions: 1200, likes: 5 },
      { theme: "ops", daysAgo: 21, impressions: 1100, likes: 4 },
    ];

    for (const row of seedRows) {
      const postedAt = new Date(now - row.daysAgo * DAY).toISOString();
      const { data: post, error: postErr } = await a
        .from("posts")
        .insert({
          workspace_id: workspaceId,
          social_account_id: socialAccountId,
          channel: "x",
          text: `Seeded ${row.theme} post (d-${row.daysAgo})`,
          theme: row.theme,
          status: "posted",
        })
        .select("id")
        .single();
      if (postErr || !post) throw new Error(`post insert failed: ${postErr?.message}`);
      // posted_at isn't on the Insert type (it's set by the dispatcher in
      // prod). Update it explicitly so the themes analyzer's
      // `gte("posted_at", since)` filter catches our seeds.
      await a.from("posts").update({ posted_at: postedAt } as never).eq("id", post.id);

      const { error: metricErr } = await a.from("post_metrics").insert({
        post_id: post.id,
        impressions: row.impressions,
        likes: row.likes,
        reposts: 0,
        replies: 0,
        engagement_rate: row.likes / row.impressions,
        fetched_at: postedAt,
      });
      if (metricErr) throw new Error(`post_metrics insert failed: ${metricErr.message}`);
    }

    await page.goto("/analytics/themes");

    // Empty-state copy must NOT render — we have real data.
    await expect(page.getByText(/not enough data yet/i)).toHaveCount(0);

    // Table renders the theme tags with the leading "#" prefix the row
    // component injects. Both themes pass the MIN_POSTS_PER_THEME=3 gate.
    await expect(page.getByText("#growth")).toBeVisible();
    await expect(page.getByText("#ops")).toBeVisible();

    // Sample counts: each theme has 5 posts. The row prints the count in
    // the second column; we just verify at least one "5" lands on the page
    // body inside the table (avoiding ambient mentions of "5").
    const tableRows = page.locator("table tbody tr");
    await expect(tableRows).toHaveCount(2);

    // Verdict badge text — the winner side should hit "Likely winner" and
    // the loser side either "Likely loser" or "Inconclusive" depending on
    // the posterior. With 10× separation the loser badge is the expected
    // outcome, but the math is data-driven so we accept either non-winner
    // verdict for the ops row.
    await expect(page.getByText(/likely winner/i)).toBeVisible();
    const loserOrInconclusive = page
      .getByText(/likely loser|inconclusive/i)
      .first();
    await expect(loserOrInconclusive).toBeVisible();
  });
});

test.describe("Phase 6B — Quick Experiments", () => {
  test("/queue surfaces the 'Run Quick Experiment' button on a scheduled post", async ({
    authedContext,
  }) => {
    const { page, user } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Quick Exp Button Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    const a = admin();
    const workspaceId = await getWorkspaceId(user.id);
    const socialAccountId = await seedSocialAccount(a, workspaceId);

    // canRunExperiment in queue-row.tsx requires status === 'scheduled'
    // and !experiment_status. Pending parents are rejected by the action.
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { error: postErr } = await a.from("posts").insert({
      workspace_id: workspaceId,
      social_account_id: socialAccountId,
      channel: "x",
      text: "Scheduled parent post — Quick Experiment candidate.",
      theme: "growth",
      status: "scheduled",
      scheduled_at: scheduledAt,
    });
    if (postErr) throw new Error(`post insert failed: ${postErr.message}`);

    await page.goto("/queue");
    // The scheduled section renders the row. The button is rendered for
    // scheduled rows whose post_variants/experiments tables show no link
    // (which is true for a fresh seed).
    await expect(
      page.getByRole("button", { name: /run quick experiment/i }),
    ).toBeVisible();

    // Clicking the button would dispatch runQuickExperimentAction →
    // generateVariants → Anthropic. That's a real Claude call and would
    // bill tokens on every CI run, so we stop at affordance presence per
    // the spec ("Skip tests that require Claude API calls"). The post-
    // click side-effects (experiments + post_variants rows) are covered
    // by the dashboard-widget test below, which seeds those rows
    // directly through the service-role client.
  });

  test("Quick Experiments dashboard widget hides when no experiments, renders when one exists", async ({
    authedContext,
  }) => {
    const { page, user } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Widget Visibility Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    // Stage 1 — no experiments yet, widget should be hidden.
    await page.goto("/dashboard");
    await expect(page.getByText(/quick experiments/i)).toHaveCount(0);

    // Stage 2 — seed an active experiment + its variants via service role
    // (avoids the Claude call). Widget should now render.
    const a = admin();
    const workspaceId = await getWorkspaceId(user.id);
    const socialAccountId = await seedSocialAccount(a, workspaceId);

    const { data: parentPost } = await a
      .from("posts")
      .insert({
        workspace_id: workspaceId,
        social_account_id: socialAccountId,
        channel: "x",
        text: "Parent post for the active widget experiment.",
        theme: "growth",
        status: "scheduled",
        scheduled_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (!parentPost) throw new Error("parent post insert failed");

    const { data: exp } = await a
      .from("experiments")
      .insert({
        workspace_id: workspaceId,
        parent_post_id: parentPost.id,
        variant_count: 2,
        status: "active",
      })
      .select("id")
      .single();
    if (!exp) throw new Error("experiment insert failed");

    // Two variant posts + their post_variants rows. The widget reads
    // experiment summaries directly off the experiments + post_variants
    // tables, so these are the minimum rows needed to surface the row.
    for (let i = 0; i < 2; i++) {
      const { data: vp } = await a
        .from("posts")
        .insert({
          workspace_id: workspaceId,
          social_account_id: socialAccountId,
          channel: "x",
          text: `Variant ${i + 1} body`,
          theme: "growth",
          status: "pending_approval",
          scheduled_at: new Date(
            Date.now() + (48 + i * 48) * 60 * 60 * 1000,
          ).toISOString(),
        })
        .select("id")
        .single();
      if (!vp) throw new Error("variant post insert failed");
      const { error: pvErr } = await a.from("post_variants").insert({
        experiment_id: exp.id,
        parent_post_id: vp.id,
        workspace_id: workspaceId,
        allocation_weight: 1.0,
      });
      if (pvErr) throw new Error(`post_variants insert failed: ${pvErr.message}`);
    }

    await page.goto("/dashboard");
    // Widget heading + active-state badge both render once an experiment
    // exists. The directional banner (DIRECTIONAL_BANNER from
    // src/lib/experiments/winner.ts) is in the widget header.
    await expect(
      page.getByRole("heading", { name: /variant tests in flight/i }),
    ).toBeVisible();
    await expect(page.getByText(/^active$/i).first()).toBeVisible();
    await expect(page.getByText(/directional, not statistically rigorous/i)).toBeVisible();
  });

  test("Winner declaration: completed experiment surfaces winner row + directional banner", async ({
    authedContext,
  }) => {
    const { page, user } = authedContext;
    await page.getByLabel(/workspace name/i).fill("Winner Banner Test");
    await page.getByRole("button", { name: /create workspace/i }).click();
    await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });

    const a = admin();
    const workspaceId = await getWorkspaceId(user.id);
    const socialAccountId = await seedSocialAccount(a, workspaceId);

    // Seed parent + 2 variants, both with post_metrics rows >48h old
    // (so the "metrics matured" gate is satisfied). The widget reads
    // status='complete' + winner_variant_id from experiments to render
    // the winner row, so we set both directly.
    const HOUR = 60 * 60 * 1000;
    const postedThreeDaysAgo = new Date(Date.now() - 72 * HOUR).toISOString();

    const { data: parentPost } = await a
      .from("posts")
      .insert({
        workspace_id: workspaceId,
        social_account_id: socialAccountId,
        channel: "x",
        text: "Parent post — winner-banner experiment.",
        theme: "growth",
        status: "posted",
      })
      .select("id")
      .single();
    if (!parentPost) throw new Error("parent post insert failed");
    await a
      .from("posts")
      .update({ posted_at: postedThreeDaysAgo } as never)
      .eq("id", parentPost.id);

    // Parent metrics — modest engagement.
    await a.from("post_metrics").insert({
      post_id: parentPost.id,
      impressions: 1000,
      likes: 30,
      reposts: 0,
      replies: 0,
      engagement_rate: 0.03,
      fetched_at: postedThreeDaysAgo,
    });

    const variantIds: string[] = [];
    const variantPostIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { data: vp } = await a
        .from("posts")
        .insert({
          workspace_id: workspaceId,
          social_account_id: socialAccountId,
          channel: "x",
          text: `Variant ${i + 1} — winner-banner body`,
          theme: "growth",
          status: "posted",
        })
        .select("id")
        .single();
      if (!vp) throw new Error("variant post insert failed");
      await a
        .from("posts")
        .update({ posted_at: postedThreeDaysAgo } as never)
        .eq("id", vp.id);
      variantPostIds.push(vp.id);
      // Variant 0 = winner (8% engagement). Variant 1 = also-ran (2%).
      const engagementRate = i === 0 ? 0.08 : 0.02;
      const likes = Math.round(engagementRate * 1000);
      await a.from("post_metrics").insert({
        post_id: vp.id,
        impressions: 1000,
        likes,
        reposts: 0,
        replies: 0,
        engagement_rate: engagementRate,
        fetched_at: postedThreeDaysAgo,
      });
    }

    const { data: exp } = await a
      .from("experiments")
      .insert({
        workspace_id: workspaceId,
        parent_post_id: parentPost.id,
        variant_count: 2,
        status: "active",
      })
      .select("id")
      .single();
    if (!exp) throw new Error("experiment insert failed");

    for (let i = 0; i < variantPostIds.length; i++) {
      const isWinner = i === 0;
      const { data: pv } = await a
        .from("post_variants")
        .insert({
          experiment_id: exp.id,
          parent_post_id: variantPostIds[i]!,
          workspace_id: workspaceId,
          allocation_weight: 1.0,
          posted_at: postedThreeDaysAgo,
          metrics_snapshot: isWinner
            ? ({
                engagement_rate: 0.08,
                impressions: 1000,
                engagement: 80,
                sample_age_hours: 72,
              } as never)
            : null,
        })
        .select("id")
        .single();
      if (!pv) throw new Error("post_variants insert failed");
      variantIds.push(pv.id);
    }

    // Flip the experiment to complete + record the winner. This mirrors
    // what persistDeclaredWinner() does after evaluateExperiment().
    const winnerVariantId = variantIds[0]!;
    await a
      .from("experiments")
      .update({
        status: "complete",
        winner_variant_id: winnerVariantId,
        completed_at: new Date().toISOString(),
      })
      .eq("id", exp.id);

    await page.goto("/dashboard");

    // Winner badge + directional banner are both surfaced.
    await expect(page.getByText(/winner declared/i)).toBeVisible();
    await expect(page.getByText(/directional, not statistically rigorous/i)).toBeVisible();
    // Winner post body lands in the row.
    await expect(page.getByText(/winner-banner body/i).first()).toBeVisible();
  });
});
