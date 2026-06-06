// Recommended day + time-of-day for posting to a Facebook Group.
//
// We can't post for the user (Meta removed the Groups API on 2024-04-22), so
// the most helpful thing we can do is tell them WHEN: which day (constrained by
// the group's promo rules) and what time of day tends to perform on Facebook.
//
// The time-of-day signal is reused from the channel registry's Facebook
// `recommendedWindows` (Sprout-derived engagement windows) — the same data the
// planner uses for Smart Timing. We do NOT invent new numbers; we just project
// those windows onto the days a group actually allows promo, in the audience
// timezone.
//
// Pure + deterministic: callers pass "now" in, so this is fully unit-testable
// and never touches Date.now() in the core logic.

import { CHANNELS } from "@/lib/channels/registry";
import { isoWeekdayInTimezone, type GroupPostingRules } from "@/lib/groups/posting-rules";

const WEEKDAY_NAMES = [
  "",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];
const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// One recommended posting slot: a weekday + a human time range.
export interface RecommendedSlot {
  isoWeekday: number; // 1=Mon … 7=Sun
  weekdayName: string; // "Friday"
  weekdayShort: string; // "Fri"
  // First Facebook engagement window for that day, formatted "9:00–11:00 AM".
  timeRange: string;
  // Whether this slot is the soonest upcoming one (today or next allowed day).
  isToday: boolean;
}

// Format a "HH:MM" 24h string (from the registry windows) to a friendly 12h.
function fmtTime(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${period}` : `${h12}:${mStr} ${period}`;
}

// The Facebook engagement window for a given ISO weekday, formatted as a range.
// Returns null if the registry has no window for that day (e.g. weekends).
function facebookWindowFor(isoWeekday: number): string | null {
  const fb = CHANNELS.facebook;
  const entry = fb.recommendedWindows.find((w) => w.weekday === isoWeekday);
  const range = entry?.ranges[0];
  if (!range) return null;
  const [start, end] = range;
  // Share the AM/PM suffix when both ends sit in the same period for brevity.
  const startPeriod = Number(start.split(":")[0]) >= 12 ? "PM" : "AM";
  const endPeriod = Number(end.split(":")[0]) >= 12 ? "PM" : "AM";
  if (startPeriod === endPeriod) {
    const s = fmtTime(start).replace(/ (AM|PM)$/, "");
    return `${s}–${fmtTime(end)}`;
  }
  return `${fmtTime(start)}–${fmtTime(end)}`;
}

// Fallback time range when a group's only allowed day has no Facebook window
// in the registry (e.g. a Saturday-only promo group). Mid-morning is a safe,
// honest default rather than showing nothing.
const DEFAULT_RANGE = "9–11 AM";

// Which ISO weekdays is promo allowed on, per the group's rules?
//   open / value_only → any day (value_only is about CONTENT, not timing)
//   limited           → the recorded promo_weekdays (or any day if none set)
export function allowedWeekdays(rules: GroupPostingRules): number[] {
  if (rules.promo_policy === "limited" && rules.promo_weekdays.length > 0) {
    return [...rules.promo_weekdays].filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  }
  return [1, 2, 3, 4, 5, 6, 7];
}

/**
 * The soonest recommended slot to post in this group, starting from `now`
 * (in the audience timezone). Walks forward up to 7 days to the next allowed
 * weekday and pairs it with that day's Facebook engagement window.
 */
export function nextRecommendedSlot(
  rules: GroupPostingRules,
  now: Date,
  audienceTimezone: string,
): RecommendedSlot {
  const today = isoWeekdayInTimezone(now, audienceTimezone);
  const allowed = new Set(allowedWeekdays(rules));

  for (let offset = 0; offset < 7; offset++) {
    // ISO weekday wrapping: ((today-1 + offset) mod 7) + 1
    const day = ((today - 1 + offset) % 7) + 1;
    if (!allowed.has(day)) continue;
    return {
      isoWeekday: day,
      weekdayName: WEEKDAY_NAMES[day],
      weekdayShort: WEEKDAY_SHORT[day],
      timeRange: facebookWindowFor(day) ?? DEFAULT_RANGE,
      isToday: offset === 0,
    };
  }
  // Unreachable (allowed is never empty), but keep the type total.
  return {
    isoWeekday: today,
    weekdayName: WEEKDAY_NAMES[today],
    weekdayShort: WEEKDAY_SHORT[today],
    timeRange: facebookWindowFor(today) ?? DEFAULT_RANGE,
    isToday: true,
  };
}

/**
 * Up to `max` upcoming recommended slots (this week), for a fuller "post on
 * Mon 9–11, Wed 9–3, Fri 9–11" hint on the group card.
 */
export function upcomingRecommendedSlots(
  rules: GroupPostingRules,
  now: Date,
  audienceTimezone: string,
  max = 3,
): RecommendedSlot[] {
  const today = isoWeekdayInTimezone(now, audienceTimezone);
  const allowed = allowedWeekdays(rules);
  const out: RecommendedSlot[] = [];
  for (let offset = 0; offset < 7 && out.length < max; offset++) {
    const day = ((today - 1 + offset) % 7) + 1;
    if (!allowed.includes(day)) continue;
    out.push({
      isoWeekday: day,
      weekdayName: WEEKDAY_NAMES[day],
      weekdayShort: WEEKDAY_SHORT[day],
      timeRange: facebookWindowFor(day) ?? DEFAULT_RANGE,
      isToday: offset === 0,
    });
  }
  return out;
}

/**
 * Is posting promo to this group allowed TODAY (in the audience timezone)?
 * Drives the "Good to post today" panel. ToS-aware:
 *   - open        → yes
 *   - value_only  → yes (timing is fine; the CONTENT must be value-first — the
 *                   verdict banner handles that nuance separately)
 *   - limited     → only if today is one of promo_weekdays (or none recorded)
 */
export function isAllowedToday(
  rules: GroupPostingRules,
  now: Date,
  audienceTimezone: string,
): boolean {
  const today = isoWeekdayInTimezone(now, audienceTimezone);
  return allowedWeekdays(rules).includes(today);
}
