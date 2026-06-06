// Facebook Group "should I post right now?" heads-up engine.
//
// Meta gives us no API for groups, so the human does the posting. The most
// useful thing we CAN do is keep them from getting their post removed (or
// themselves banned) by warning when it's the wrong day or wrong kind of post
// for a group's rules. This module turns a group's recorded rules + the
// current time (in the audience timezone) into a single, plain-language
// verdict the UI renders as a banner.
//
// Pure + deterministic: callers pass the "now" weekday in, so this is trivial
// to unit-test and never touches Date.now() directly in the core logic.

import type { FacebookGroupPromoPolicy } from "@/lib/db/types";

// What the UI needs to render a heads-up banner. `level` drives the colour,
// `headline` is the one-liner, `detail` explains why, and `tips` are concrete
// nudges (e.g. "put the link in a comment").
export type PostingVerdictLevel = "good" | "caution" | "blocked";

export interface PostingVerdict {
  level: PostingVerdictLevel;
  headline: string;
  detail: string;
  tips: string[];
}

export interface GroupPostingRules {
  promo_policy: FacebookGroupPromoPolicy;
  // ISO weekdays (1=Mon … 7=Sun) promo is allowed on. Only meaningful when
  // promo_policy === 'limited'.
  promo_weekdays: number[];
  allow_links: boolean;
  rules_notes: string;
}

// ISO weekday (1=Mon … 7=Sun) names for human-readable messages.
const WEEKDAY_NAMES = [
  "", // index 0 unused (ISO weekdays are 1-7)
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
];

/**
 * Resolve the ISO weekday (1=Mon … 7=Sun) for an instant in a given IANA
 * timezone. Mirrors the timezone handling in lib/timing/analyze.ts: we format
 * the date in the target zone and map JS's 0=Sun…6=Sat to ISO 1=Mon…7=Sun.
 * Falls back to UTC if Intl rejects the zone.
 */
export function isoWeekdayInTimezone(date: Date, timezone: string): number {
  let weekdayName: string;
  try {
    weekdayName = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: timezone || "UTC",
    }).format(date);
  } catch {
    weekdayName = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "UTC",
    }).format(date);
  }
  // Map the formatted short name → ISO weekday. Using names (not getDay) keeps
  // us in the *target* timezone rather than the server's local zone.
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  return map[weekdayName] ?? 1;
}

function listWeekdays(weekdays: number[]): string {
  const names = weekdays
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b)
    .map((d) => WEEKDAY_NAMES[d]);
  if (names.length === 0) return "specific days";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/**
 * The core heads-up. Given a group's rules and the current ISO weekday (in the
 * audience timezone), return whether now is a good/caution/blocked time to post
 * promotional content, plus concrete tips.
 *
 * `todayIsoWeekday` is 1=Mon … 7=Sun. Pass it in (computed via
 * isoWeekdayInTimezone) so this stays pure and testable.
 */
export function postingVerdict(
  rules: GroupPostingRules,
  todayIsoWeekday: number,
): PostingVerdict {
  const tips: string[] = [];
  if (!rules.allow_links) {
    tips.push("This group bans links — drop the URL and offer it in a comment if asked.");
  }
  if (rules.rules_notes.trim().length > 0) {
    tips.push("Re-read the group's rules before posting (saved on the group).");
  }

  switch (rules.promo_policy) {
    case "open": {
      return {
        level: "good",
        headline: "Good to post",
        detail: "This group allows promotional posts any day. Keep it useful and on-voice.",
        tips,
      };
    }
    case "value_only": {
      return {
        level: "caution",
        headline: "Lead with value — soft promo only",
        detail:
          "This group doesn't allow straight promotion. Open with something genuinely useful; mention what you do only briefly, if at all.",
        tips: [
          "Frame it as a story, lesson, or question — not an ad.",
          "Put any link in a comment, not the post body.",
          ...tips,
        ],
      };
    }
    case "limited": {
      const allowedToday =
        rules.promo_weekdays.length === 0 || rules.promo_weekdays.includes(todayIsoWeekday);
      if (allowedToday) {
        return {
          level: "good",
          headline: "Good to post — it's an allowed promo day",
          detail:
            rules.promo_weekdays.length === 0
              ? "Promo is limited in this group, but no specific days are recorded. Double-check the rules."
              : `${WEEKDAY_NAMES[todayIsoWeekday]} is an allowed promo day for this group.`,
          tips,
        };
      }
      return {
        level: "blocked",
        headline: "Not a promo day for this group",
        detail: `This group only allows promotional posts on ${listWeekdays(
          rules.promo_weekdays,
        )}. Posting today risks removal or a warning.`,
        tips: [
          "Save this draft and post it on an allowed day.",
          ...tips,
        ],
      };
    }
    default: {
      // Exhaustiveness guard — a new promo_policy value should surface here
      // rather than silently returning "good".
      return {
        level: "caution",
        headline: "Check the group's rules",
        detail: "Posting policy unknown — review this group's rules before posting.",
        tips,
      };
    }
  }
}

/**
 * Convenience: compute the verdict for "now" given the audience timezone.
 * Thin wrapper so server/UI callers don't repeat the weekday math.
 */
export function postingVerdictNow(
  rules: GroupPostingRules,
  now: Date,
  audienceTimezone: string,
): PostingVerdict {
  return postingVerdict(rules, isoWeekdayInTimezone(now, audienceTimezone));
}
