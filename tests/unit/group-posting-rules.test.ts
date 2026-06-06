import { describe, expect, it } from "vitest";
import {
  postingVerdict,
  postingVerdictNow,
  isoWeekdayInTimezone,
  type GroupPostingRules,
} from "@/lib/groups/posting-rules";

// ── Facebook Group "should I post now?" heads-up logic ───────────────────────
//
// This is the value+safety core of Group Assist: we have no API to post to a
// group, so the most useful thing we can do is keep the operator from getting
// removed/banned by warning when it's the wrong day or wrong kind of post. The
// logic is pure (weekday passed in), so we exercise every policy branch.

const base: GroupPostingRules = {
  promo_policy: "open",
  promo_weekdays: [],
  allow_links: true,
  rules_notes: "",
};

describe("postingVerdict", () => {
  it("open policy → always good to post, any weekday", () => {
    for (let day = 1; day <= 7; day++) {
      const v = postingVerdict({ ...base, promo_policy: "open" }, day);
      expect(v.level).toBe("good");
    }
  });

  it("value_only policy → caution with soft-promo guidance", () => {
    const v = postingVerdict({ ...base, promo_policy: "value_only" }, 3);
    expect(v.level).toBe("caution");
    expect(v.tips.join(" ").toLowerCase()).toContain("comment");
  });

  it("limited policy → good on an allowed day", () => {
    const v = postingVerdict(
      { ...base, promo_policy: "limited", promo_weekdays: [5] }, // Fridays only
      5, // it's Friday
    );
    expect(v.level).toBe("good");
    expect(v.headline.toLowerCase()).toContain("promo day");
  });

  it("limited policy → blocked on a disallowed day, names the allowed days", () => {
    const v = postingVerdict(
      { ...base, promo_policy: "limited", promo_weekdays: [5] }, // Fridays only
      2, // it's Tuesday
    );
    expect(v.level).toBe("blocked");
    expect(v.detail).toContain("Friday");
  });

  it("limited policy with multiple days → lists them with an Oxford 'and'", () => {
    const v = postingVerdict(
      { ...base, promo_policy: "limited", promo_weekdays: [1, 3, 5] },
      6, // Saturday — blocked
    );
    expect(v.level).toBe("blocked");
    expect(v.detail).toContain("Monday, Wednesday, and Friday");
  });

  it("limited policy with no recorded days → not blocked, but cautions to check", () => {
    const v = postingVerdict(
      { ...base, promo_policy: "limited", promo_weekdays: [] },
      2,
    );
    // With no days recorded we can't say today is disallowed — fall to a
    // permissive 'good' that nudges the user to double-check the rules.
    expect(v.level).toBe("good");
    expect(v.detail.toLowerCase()).toContain("double-check");
  });

  it("no-links group → surfaces a 'put the link in a comment' tip on every level", () => {
    const open = postingVerdict({ ...base, promo_policy: "open", allow_links: false }, 1);
    expect(open.tips.join(" ").toLowerCase()).toContain("link");

    const blocked = postingVerdict(
      { ...base, promo_policy: "limited", promo_weekdays: [5], allow_links: false },
      2,
    );
    expect(blocked.tips.join(" ").toLowerCase()).toContain("link");
  });

  it("rules_notes present → nudges the operator to re-read the rules", () => {
    const v = postingVerdict({ ...base, rules_notes: "No memes." }, 1);
    expect(v.tips.join(" ").toLowerCase()).toContain("rules");
  });
});

describe("isoWeekdayInTimezone", () => {
  it("maps a known UTC instant to the right ISO weekday", () => {
    // 2026-06-05 is a Friday (ISO weekday 5).
    const friday = new Date("2026-06-05T12:00:00Z");
    expect(isoWeekdayInTimezone(friday, "UTC")).toBe(5);
  });

  it("respects timezone rollover across the date line", () => {
    // 2026-06-05T02:00Z is still Thursday (4) in New York (UTC-4 in June)…
    const instant = new Date("2026-06-05T02:00:00Z");
    expect(isoWeekdayInTimezone(instant, "America/New_York")).toBe(4);
    // …but already Friday (5) in UTC.
    expect(isoWeekdayInTimezone(instant, "UTC")).toBe(5);
  });

  it("falls back to UTC for a bogus timezone instead of throwing", () => {
    const friday = new Date("2026-06-05T12:00:00Z");
    expect(() => isoWeekdayInTimezone(friday, "Not/AZone")).not.toThrow();
    expect(isoWeekdayInTimezone(friday, "Not/AZone")).toBe(5);
  });
});

describe("postingVerdictNow", () => {
  it("blocks a Friday-only group when 'now' is a Tuesday in the audience tz", () => {
    // 2026-06-09T12:00Z is a Tuesday.
    const tuesday = new Date("2026-06-09T12:00:00Z");
    const v = postingVerdictNow(
      { ...base, promo_policy: "limited", promo_weekdays: [5] },
      tuesday,
      "UTC",
    );
    expect(v.level).toBe("blocked");
  });
});
