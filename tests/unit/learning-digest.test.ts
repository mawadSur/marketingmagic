import { afterEach, describe, expect, it, vi } from "vitest";

// ── Unit: weekly learning digest composer (src/lib/dashboard/learning-digest.ts)
//
// Proves the learning loop is assembled & rendered correctly, and that it
// degrades gracefully:
//   • winners + AI review present → both assembled, "next plan leans in" line
//     names the winners; rendered HTML carries all the signals.
//   • COLD START (no confident winners AND no AI review) → assemble returns
//     null so the cron skips the send (no empty email).
//   • winners-only / review-only → still assembled (only BOTH empty bails).
//
// The Resend graceful-degrade (RESEND_API_KEY unset → log + skip, no network)
// is exercised end-to-end by the cron-route test below.

const { loadThemeWinners } = vi.hoisted(() => ({ loadThemeWinners: vi.fn() }));
const { getOrGenerateAiReview } = vi.hoisted(() => ({
  getOrGenerateAiReview: vi.fn(),
}));

vi.mock("@/lib/analytics/themes", () => ({ loadThemeWinners }));
vi.mock("@/lib/dashboard/ai-review", () => ({ getOrGenerateAiReview }));

import {
  assembleLearningDigest,
  renderLearningDigest,
} from "@/lib/dashboard/learning-digest";

const opts = {
  workspaceName: "Acme Co",
  dashboardUrl: "https://app.example.com/dashboard",
  analyticsUrl: "https://app.example.com/analytics",
};

const sampleWinner = {
  tag: "founder-story",
  posterior_mean: 0.08,
  ci_low: 0.05,
  ci_high: 0.11,
  posts: 7,
  lift: 1.6,
};

const sampleReview = {
  summary: "Founder stories and how-tos outperformed promos this week.",
  themes_worked: ["founder-story — authentic and high-reply"],
  themes_struggled: ["promo — low engagement"],
  timing_suggestions: ["post mornings"],
  next_actions: ["double down on founder narratives"],
  generated_at: new Date().toISOString(),
  is_stale: false,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("assembleLearningDigest — assembly", () => {
  it("assembles winners + AI review and renders all signals", async () => {
    loadThemeWinners.mockResolvedValue([sampleWinner]);
    getOrGenerateAiReview.mockResolvedValue(sampleReview);

    const data = await assembleLearningDigest("ws-1", opts);
    expect(data).not.toBeNull();
    expect(data!.winners).toHaveLength(1);
    expect(data!.review?.summary).toContain("Founder stories");

    const html = renderLearningDigest(data!);
    // winner theme + lift surfaced
    expect(html).toContain("founder-story");
    expect(html).toMatch(/\+60% vs your baseline/);
    // AI review sections surfaced
    expect(html).toContain("Founder stories and how-tos outperformed");
    expect(html).toContain("What worked");
    expect(html).toContain("What struggled");
    expect(html).toContain("Next actions");
    expect(html).toContain("double down on founder narratives");
    // loop-closing "next plan leans into the winners" line names the winner
    expect(html).toMatch(/next plan leans into .*founder-story/i);
  });

  it("COLD START: returns null when no winners AND no review (skip the send)", async () => {
    loadThemeWinners.mockResolvedValue([]);
    getOrGenerateAiReview.mockResolvedValue(null);

    const data = await assembleLearningDigest("ws-cold", opts);
    expect(data).toBeNull();
  });

  it("treats an empty/blank review as no signal (cold start with no winners)", async () => {
    loadThemeWinners.mockResolvedValue([]);
    getOrGenerateAiReview.mockResolvedValue({
      ...sampleReview,
      summary: "",
      themes_worked: [],
      themes_struggled: [],
      next_actions: [],
    });

    const data = await assembleLearningDigest("ws-empty", opts);
    expect(data).toBeNull();
  });

  it("assembles with winners only (review null) and still leans into winners", async () => {
    loadThemeWinners.mockResolvedValue([sampleWinner]);
    getOrGenerateAiReview.mockResolvedValue(null);

    const data = await assembleLearningDigest("ws-2", opts);
    expect(data).not.toBeNull();
    expect(data!.review).toBeNull();
    const html = renderLearningDigest(data!);
    expect(html).toMatch(/next plan leans into .*founder-story/i);
    expect(html).not.toContain("What the AI review found");
  });

  it("assembles with review only (no confident winners)", async () => {
    loadThemeWinners.mockResolvedValue([]);
    getOrGenerateAiReview.mockResolvedValue(sampleReview);

    const data = await assembleLearningDigest("ws-3", opts);
    expect(data).not.toBeNull();
    expect(data!.winners).toHaveLength(0);
    const html = renderLearningDigest(data!);
    expect(html).toContain("Founder stories and how-tos outperformed");
    // falls back to the review-based lean-in line
    expect(html).toMatch(/next plan leans into what the review found/i);
  });

  it("does not throw if an upstream signal fails — degrades to the other", async () => {
    loadThemeWinners.mockRejectedValue(new Error("themes db down"));
    getOrGenerateAiReview.mockResolvedValue(sampleReview);

    const data = await assembleLearningDigest("ws-4", opts);
    expect(data).not.toBeNull();
    expect(data!.winners).toHaveLength(0);
    expect(data!.review?.summary).toContain("Founder stories");
  });
});
