import { describe, expect, it } from "vitest";
import {
  allowedWeekdays,
  nextRecommendedSlot,
  upcomingRecommendedSlots,
  isAllowedToday,
} from "@/lib/groups/schedule";
import type { GroupPostingRules } from "@/lib/groups/posting-rules";

// ── Recommended day + time for posting to a group ────────────────────────────
//
// The schedule logic projects Facebook engagement windows onto the days a
// group's rules allow, in the audience timezone. Pure (now passed in), so we
// pin concrete dates: 2026-06-08 is a Monday, 2026-06-09 Tuesday … 2026-06-12
// is a Friday, 2026-06-13 Saturday, 2026-06-14 Sunday.

const open: GroupPostingRules = {
  promo_policy: "open",
  promo_weekdays: [],
  allow_links: true,
  rules_notes: "",
};
const fridayOnly: GroupPostingRules = {
  promo_policy: "limited",
  promo_weekdays: [5],
  allow_links: true,
  rules_notes: "",
};

describe("allowedWeekdays", () => {
  it("open policy → all 7 days", () => {
    expect(allowedWeekdays(open)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("value_only → all 7 days (timing is unconstrained; content is the limit)", () => {
    expect(allowedWeekdays({ ...open, promo_policy: "value_only" })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it("limited → only the recorded promo days", () => {
    expect(allowedWeekdays(fridayOnly)).toEqual([5]);
  });
  it("limited with no recorded days → all days (can't constrain)", () => {
    expect(allowedWeekdays({ ...fridayOnly, promo_weekdays: [] })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("nextRecommendedSlot", () => {
  it("open group on a Monday → recommends today (Monday) with a Facebook window", () => {
    const monday = new Date("2026-06-08T08:00:00Z");
    const slot = nextRecommendedSlot(open, monday, "UTC");
    expect(slot.isoWeekday).toBe(1);
    expect(slot.weekdayName).toBe("Monday");
    expect(slot.isToday).toBe(true);
    // Registry has Monday FB windows starting 09:00 → formatted range.
    expect(slot.timeRange).toMatch(/\d/);
  });

  it("Friday-only group on a Tuesday → rolls forward to Friday, not today", () => {
    const tuesday = new Date("2026-06-09T12:00:00Z");
    const slot = nextRecommendedSlot(fridayOnly, tuesday, "UTC");
    expect(slot.isoWeekday).toBe(5);
    expect(slot.weekdayName).toBe("Friday");
    expect(slot.isToday).toBe(false);
  });

  it("Friday-only group on a Friday → recommends today", () => {
    const friday = new Date("2026-06-12T08:00:00Z");
    const slot = nextRecommendedSlot(fridayOnly, friday, "UTC");
    expect(slot.isoWeekday).toBe(5);
    expect(slot.isToday).toBe(true);
  });

  it("Saturday-only group → uses the default range (registry has no weekend window)", () => {
    const saturday = new Date("2026-06-13T08:00:00Z");
    const satGroup: GroupPostingRules = { ...fridayOnly, promo_weekdays: [6] };
    const slot = nextRecommendedSlot(satGroup, saturday, "UTC");
    expect(slot.isoWeekday).toBe(6);
    expect(slot.timeRange).toBe("9–11 AM");
  });
});

describe("upcomingRecommendedSlots", () => {
  it("open group → returns up to `max` distinct upcoming days", () => {
    const monday = new Date("2026-06-08T08:00:00Z");
    const slots = upcomingRecommendedSlots(open, monday, "UTC", 3);
    expect(slots).toHaveLength(3);
    expect(slots[0].isToday).toBe(true);
    // Distinct, ascending-from-today days.
    const days = slots.map((s) => s.isoWeekday);
    expect(new Set(days).size).toBe(3);
  });

  it("Friday-only group → only ever yields Fridays", () => {
    const monday = new Date("2026-06-08T08:00:00Z");
    const slots = upcomingRecommendedSlots(fridayOnly, monday, "UTC", 3);
    expect(slots.every((s) => s.isoWeekday === 5)).toBe(true);
    // Only one Friday in a 7-day forward window.
    expect(slots).toHaveLength(1);
  });
});

describe("isAllowedToday", () => {
  it("open group → always allowed today", () => {
    expect(isAllowedToday(open, new Date("2026-06-09T12:00:00Z"), "UTC")).toBe(true);
  });
  it("Friday-only group → not allowed on Tuesday", () => {
    expect(isAllowedToday(fridayOnly, new Date("2026-06-09T12:00:00Z"), "UTC")).toBe(false);
  });
  it("Friday-only group → allowed on Friday", () => {
    expect(isAllowedToday(fridayOnly, new Date("2026-06-12T12:00:00Z"), "UTC")).toBe(true);
  });
  it("value_only group → allowed today (content-limited, not time-limited)", () => {
    expect(isAllowedToday({ ...open, promo_policy: "value_only" }, new Date("2026-06-09T12:00:00Z"), "UTC")).toBe(true);
  });
});
