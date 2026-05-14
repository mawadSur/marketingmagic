// Phase 6.5 — Time-decay weighting.
//
// We want recent posts to count more than 60-day-old posts when estimating
// per-slot engagement. The simplest model is exponential decay:
//
//     weight(age_days) = 0.5 ** (age_days / HALF_LIFE_DAYS)
//
// HALF_LIFE_DAYS = 30 — a 60-day-old post counts ¼ of a 0-day-old one. We
// picked 30 because metrics fully settle inside ~7 days and platform algos
// shift quarterly. Posts older than 90 days are dropped at the query level
// upstream of this function.
//
// Phase 6A theme analytics doesn't currently use decay (it averages within
// a 30d window). When it grows to a longer window, it should import the
// same `decayWeight` to keep weighting policies consistent.

const HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function decayWeight(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

export function decayWeightFor(postedAt: string | Date, now: Date = new Date()): number {
  const ts = postedAt instanceof Date ? postedAt : new Date(postedAt);
  if (Number.isNaN(ts.getTime())) return 0;
  const ageDays = Math.max(0, (now.getTime() - ts.getTime()) / MS_PER_DAY);
  return decayWeight(ageDays);
}

export const TIMING_DECAY_HALF_LIFE_DAYS = HALF_LIFE_DAYS;
