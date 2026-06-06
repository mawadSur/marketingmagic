import { test, expect } from "./helpers/test-user";
import type { Page } from "@playwright/test";

// ── Facebook Group Assist — end-to-end ───────────────────────────────────────
//
// Validates the ToS-safe, human-in-the-loop group workflow through the real UI
// against the real DB (migrations 040 + 041): add a group, see the live "should
// I post now?" verdict, the "Good to post today" ToS gate, and the manual
// draft → mark-posted loop. We deliberately DON'T exercise "Generate with AI"
// here — it spends Anthropic tokens and needs a brand brief; the verdict +
// draft round-trip is what proves the feature works.
//
// Timezone note: a fresh test user has no brand brief, so the server computes
// verdicts in UTC (page.tsx: `audience_timezone || "UTC"`). We pick allowed/
// disallowed weekdays in UTC to match.

const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function todayIsoWeekdayUTC(): number {
  // JS getUTCDay: 0=Sun..6=Sat → ISO 1=Mon..7=Sun.
  const js = new Date().getUTCDay();
  return js === 0 ? 7 : js;
}

async function bootstrapWorkspace(page: Page) {
  await page.getByLabel(/workspace name/i).fill("Groups Test WS");
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(/\/onboarding\/wizard/, { timeout: 45_000 });
}

async function openGroupsPage(page: Page) {
  await page.goto("/queue/groups");
  await expect(page.getByRole("heading", { name: "Facebook Groups", level: 1 })).toBeVisible();
}

// Fill the add-group form. `policy` is the visible <option> label; `weekday`
// (ISO 1-7) is only used for the "limited" policy.
async function addGroup(
  page: Page,
  opts: { name: string; url: string; policy: RegExp; weekday?: number },
) {
  await page.getByRole("button", { name: /^Add a group$/ }).click();
  await page.getByLabel("Group name").fill(opts.name);
  await page.getByLabel("Group URL").fill(opts.url);
  await page.getByLabel("Promotion policy").selectOption({ label: (await firstOptionMatching(page, opts.policy)) });
  if (opts.weekday) {
    // The weekday picker only renders for the "limited" policy.
    await page.getByRole("button", { name: WEEKDAY_SHORT[opts.weekday], exact: true }).click();
  }
  await page.getByRole("button", { name: /^Add group$/ }).click();
  // Form closes + the card renders (the group's name appears as a heading).
  await expect(page.getByRole("heading", { name: opts.name, level: 3 })).toBeVisible();
}

// Resolve the exact <option> label text for a select, given a matcher — keeps
// the test robust to copy tweaks in the option wording.
async function firstOptionMatching(page: Page, re: RegExp): Promise<string> {
  const labels = await page.getByLabel("Promotion policy").locator("option").allTextContents();
  const found = labels.find((l) => re.test(l));
  if (!found) throw new Error(`No promotion-policy option matched ${re} in ${JSON.stringify(labels)}`);
  return found;
}

test.describe("Facebook Group Assist", () => {
  test("page renders the tab, the manual-by-design banner, and the empty state", async ({ authedContext }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await openGroupsPage(page);

    // Tab strip is shared with the approval queue.
    await expect(page.getByRole("link", { name: "Facebook Groups" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Approval queue" })).toBeVisible();

    // The "this is manual by design" expectation-setter.
    await expect(page.getByText(/Posting to groups is manual/i)).toBeVisible();
    await expect(page.getByText(/Meta retired the Groups API/i)).toBeVisible();

    // Fresh workspace → no groups yet.
    await expect(page.getByText(/No groups yet/i)).toBeVisible();
  });

  test("open-policy group → 'good to post' verdict + appears in Today panel + manual draft round-trip", async ({
    authedContext,
  }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await openGroupsPage(page);

    await addGroup(page, {
      name: "Open Founders",
      url: "https://www.facebook.com/groups/openfounders",
      policy: /any day/i,
    });

    // Scope to the group card via its accessible name (aria-label="Group: …").
    const card = page.getByRole("listitem", { name: "Group: Open Founders" });

    // Verdict banner: open policy is always good to post.
    await expect(card.getByText(/Good to post/i)).toBeVisible();
    // Recommended time line is present.
    await expect(card.getByText(/Best time to post:/i)).toBeVisible();

    // "Good to post today" panel lists this group (open = allowed any day).
    const todayPanel = page.getByRole("region", { name: "Good to post today" });
    await expect(page.getByRole("heading", { name: /Good to post today/i })).toBeVisible();
    await expect(todayPanel.getByRole("link", { name: "Open Founders" })).toBeVisible();

    // Manual draft round-trip.
    await card.getByRole("button", { name: /Write your own/i }).click();
    await card.getByPlaceholder(/Write a post for Open Founders/i).fill(
      "Sharing a quick lesson from our launch week — happy to answer questions.",
    );
    await card.getByRole("button", { name: /^Save draft$/ }).click();

    // The draft shows in the "To post" list with a copy/open + mark-posted CTA.
    await expect(card.getByText(/To post \(1\)/i)).toBeVisible();
    await expect(card.getByText(/quick lesson from our launch week/i)).toBeVisible();
    await expect(card.getByRole("button", { name: /Copy & open Open Founders/i })).toBeVisible();

    // Mark posted → leaves the "to post" list, lands in "Recently posted".
    await card.getByRole("button", { name: /^Mark posted$/ }).click();
    await expect(card.getByText(/To post/i)).toHaveCount(0);
    await expect(card.getByText(/Recently posted \(1\)/i)).toBeVisible();
  });

  test("limited-policy group on a disallowed day → 'not a promo day' + excluded from Today panel", async ({
    authedContext,
  }) => {
    const { page } = authedContext;
    await bootstrapWorkspace(page);
    await openGroupsPage(page);

    // Pick a weekday that is NOT today (UTC), so posting is blocked right now.
    const today = todayIsoWeekdayUTC();
    const disallowed = (today % 7) + 1; // next ISO weekday, guaranteed != today

    await addGroup(page, {
      name: "Strict Promo Group",
      url: "https://www.facebook.com/groups/strictpromo",
      policy: /certain days/i,
      weekday: disallowed,
    });

    const card = page.getByRole("listitem", { name: "Group: Strict Promo Group" });

    // Blocked verdict — it's not an allowed promo day.
    await expect(card.getByText(/Not a promo day/i)).toBeVisible();

    // ToS gate: the group must NOT be offered in the "Good to post today" panel.
    // (The panel either shows "None of your groups…" or simply omits this one.)
    const todayLink = page
      .getByRole("region", { name: "Good to post today" })
      .getByRole("link", { name: "Strict Promo Group" });
    await expect(todayLink).toHaveCount(0);
  });
});
