import { channelSpec } from "./registry";

// Returns true when the given ISO timestamp falls inside one of the
// channel's recommended posting windows. Used for the dashboard calendar
// "best time" badge and for the planner's bias check.
//
// Times in the registry are local (HH:MM, 24h). We use the *local* time of
// the timestamp in the current process's timezone — the host running the
// dashboard. In production we'd convert to the audience's timezone if we
// captured it, but local-to-the-publisher is the reasonable default for V1.
export function isInRecommendedWindow(channel: string, isoTimestamp: string): boolean {
  const spec = channelSpec(channel);
  if (!spec) return false;
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return false;
  // JS Date.getDay(): 0=Sun, 1=Mon … 6=Sat. ISO weekday: 1=Mon … 7=Sun.
  const isoWeekday = d.getDay() === 0 ? 7 : d.getDay();
  const minutes = d.getHours() * 60 + d.getMinutes();
  const window = spec.recommendedWindows.find((w) => w.weekday === isoWeekday);
  if (!window) return false;
  return window.ranges.some(([start, end]) => {
    const [sH, sM] = start.split(":").map(Number);
    const [eH, eM] = end.split(":").map(Number);
    const startMin = sH! * 60 + sM!;
    const endMin = eH! * 60 + eM!;
    return minutes >= startMin && minutes <= endMin;
  });
}

// Returns the next-soonest recommended window for a channel from `from`, as
// an ISO string. Useful when nudging users about a draft scheduled outside a
// good window.
export function nextRecommendedSlot(channel: string, from: Date = new Date()): string | null {
  const spec = channelSpec(channel);
  if (!spec) return null;
  // Search up to 14 days forward.
  for (let i = 0; i < 14; i++) {
    const day = new Date(from);
    day.setDate(day.getDate() + i);
    const isoWeekday = day.getDay() === 0 ? 7 : day.getDay();
    const window = spec.recommendedWindows.find((w) => w.weekday === isoWeekday);
    if (!window) continue;
    for (const [start] of window.ranges) {
      const [sH, sM] = start.split(":").map(Number);
      const candidate = new Date(day);
      candidate.setHours(sH!, sM!, 0, 0);
      if (candidate >= from) return candidate.toISOString();
    }
  }
  return null;
}
