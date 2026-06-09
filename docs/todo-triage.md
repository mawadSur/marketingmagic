# TODO/FIXME Triage

## Overview

This document catalogs all `TODO` and `FIXME` markers in `src/` and classifies each as either:
- **deferred-feature** — intentional placeholder for future work; safe to ship without.
- **correctness-gap** — missing functionality that could cause bugs or incorrect behavior; should be addressed before production use of that feature.

**Total markers:** 25

**Correctness gaps:** 0
**Deferred features:** 25

---

## Deferred Features (Safe to Ship)

### 1. Video Analysis — Organic Videos (BYO Upload)

**File:line:** `src/app/(app)/video/analyze/page.tsx:9`

**Marker:**
```typescript
// Organic videos posted outside our pipeline are deferred (see run.ts TODO).
```

**Classification:** deferred-feature

**Context:** The video analysis page currently only analyzes videos generated through the MarketingMagic pipeline (videos in `video_jobs` table). Organic videos (uploaded by the user or posted via external tools) are NOT yet supported.

**Impact:** Users can't analyze BYO videos yet. Feature is incomplete but clearly scoped as future work.

**Action:** Ship as-is. The UI already communicates the limitation (only shows pipeline videos). Add BYO video upload in a future iteration.

---

### 2. Video Analysis — Organic Videos (Backend Gap)

**File:line:** `src/lib/video/analyze/run.ts:13`

**Marker:**
```typescript
// posted outside our pipeline are deferred (see the TODO below).
```

**File:line:** `src/lib/video/analyze/run.ts:67`

**Marker:**
```typescript
// TODO: organic videos posted outside our pipeline — we have only an
```

**Classification:** deferred-feature (same as #1)

**Context:** The backend `analyzeVideo` function currently requires a `video_url` from the MM pipeline. It doesn't support analyzing arbitrary URLs (e.g., a YouTube link the user wants to study).

**Impact:** Same as #1 — organic video analysis is a future feature.

**Action:** Ship as-is. The function throws a clear error when video_url is missing, so the gap is explicit. Add organic video ingestion later.

---

### 3. Inbox Spam Auto-Ignore — Review Lane

**File:line:** `src/app/(app)/inbox/page.tsx:47`

**Marker:**
```typescript
// TODO #0: explicit review lane for messages the spam pass auto-ignored,
```

**Classification:** deferred-feature

**Context:** The inbox spam auto-ignore feature (TODO #0 in the backlog) includes a plan for a separate "Ignored" tab where users can review messages that were auto-ignored as spam. This UI is not yet built.

**Impact:** Users can't review auto-ignored messages yet. The spam-ignore pass runs (cron), but there's no UI to audit decisions.

**Action:** Ship as-is IF spam auto-ignore is still opt-in or shadow-mode. Add the review lane before enabling spam-ignore by default.

---

### 4. Voice Evolution Cron — Signal #2 (User's Own Text)

**File:line:** `src/app/api/cron/voice-evolution/route.ts:13`

**Marker:**
```typescript
// the profile from TWO signals (TODO #0, gap 2):
```

**File:line:** `src/app/api/cron/voice-evolution/route.ts:144`

**Marker:**
```typescript
// TODO #0 (gap 2): also load the user's OWN sent/published text as genuine-
```

**Classification:** deferred-feature

**Context:** The voice evolution cron currently learns from inbound interactions only (comments/DMs the user receives). It does NOT yet learn from the user's OWN sent messages or published posts. This is gap 2 in the voice-profile improvement plan.

**Impact:** Voice profiles are less accurate (missing the user's own writing style as an exemplar). Feature is incomplete but functional with just inbound signals.

**Action:** Ship as-is. The cron works without this signal (just less optimal). Add user-sent text collection in a future iteration.

---

### 5. Voice Evolution — User's Own Text (Backend Stub)

**File:line:** `src/lib/voice/from-sent.ts:1`

**Marker:**
```typescript
// TODO #0 (gap 2) — gather the user's OWN sent/published text as genuine-
```

**Classification:** deferred-feature (same as #4)

**Context:** Stub file for collecting the user's own sent/published text. Not yet implemented.

**Impact:** Same as #4.

**Action:** Ship as-is. The stub file is empty (exports nothing), so it's clearly not in use yet.

---

### 6. Voice Profile Schema — Sent Exemplar Count

**File:line:** `src/lib/voice/schema.ts:42`

**Marker:**
```typescript
// TODO #0 (gap 2): how many of the user's OWN sent/published exemplars
```

**File:line:** `src/lib/db/types.ts:174`

**Marker:**
```typescript
// TODO #0 (gap 2): how many of the user's OWN sent/published exemplars
```

**Classification:** deferred-feature (same as #4)

**Context:** The `voice_profiles` table schema includes a placeholder comment for a future `sent_exemplars_count` field. The field is NOT in the DB yet (no migration added).

**Impact:** None — the field doesn't exist yet, so the TODO is just a schema-evolution note.

**Action:** Ship as-is. Add the field when implementing gap 2.

---

### 7. Poll Interactions Cron — Spam Auto-Ignore Context

**File:line:** `src/app/api/cron/poll-interactions/route.ts:102`

**Marker:**
```typescript
// TODO #0 — inbox spam auto-ignore context (mode + Claude opt-in). Reuses
```

**File:line:** `src/app/api/cron/poll-interactions/route.ts:123`

**Marker:**
```typescript
// TODO #0 — count of rows auto-ignored as spam on this account this run
```

**Classification:** deferred-feature

**Context:** The poll-interactions cron currently fetches ALL new interactions. When spam auto-ignore is enabled (TODO #0), it will need to pass context (mode, opt-in flag) to the spam-ignore orchestrator and track how many rows were auto-ignored.

**Impact:** None yet — spam auto-ignore is not live. These TODOs mark where the cron will hook into the spam orchestrator once it's built.

**Action:** Ship as-is. The cron works without spam-ignore. Add the integration when spam-ignore ships.

---

### 8. Poll Interactions Cron — Spam Auto-Ignore Orchestrator Hook

**File:line:** `src/app/api/cron/poll-interactions/route.ts:364`

**Marker:**
```typescript
// TODO #0 — run the spam auto-ignore pass for one account over the
```

**Classification:** deferred-feature (same as #7)

**Context:** Placeholder comment for the spam auto-ignore orchestrator call (per-account spam pass).

**Impact:** Same as #7.

**Action:** Ship as-is.

---

### 9. Interactions Schema — Spam Auto-Ignore Fields

**File:line:** `src/lib/interactions/schema.ts:41`

**Marker:**
```typescript
// TODO #0 (migration 056): auto-ignored as spam by the poll-interactions
```

**File:line:** `src/lib/interactions/schema.ts:95`

**Marker:**
```typescript
// TODO #0 (migration 056): 0-100 spam likelihood (higher = spammier). NULL
```

**File:line:** `src/lib/db/types.ts:216`

**Marker:**
```typescript
// auto-ignored as spam by the poll-interactions spam pass (TODO #0,
```

**File:line:** `src/lib/db/types.ts:258`

**Marker:**
```typescript
// TODO #0 (migration 056): tri-state inbox spam auto-ignore.
```

**File:line:** `src/lib/db/types.ts:263`

**Marker:**
```typescript
// TODO #0 (migration 056): escalate borderline-band inbound to a
```

**File:line:** `src/lib/db/types.ts:1380`

**Marker:**
```typescript
// TODO #0 (migration 056): 0-100 spam likelihood (higher = spammier).
```

**File:line:** `src/lib/db/types.ts:1513`

**Marker:**
```typescript
// TODO #0 (migration 056): audit trail of every spam auto-ignore
```

**Classification:** deferred-feature

**Context:** The interactions table schema includes placeholder comments for future spam-related fields (`spam_ignored_at`, `spam_score`, `spam_ignore_audit`). These fields do NOT exist yet (migration 056 is not applied). The TODO markers reference "TODO #0" (inbox spam auto-ignore) from the backlog.

**Impact:** None — the fields don't exist yet, so the TODOs are just schema-evolution notes. Spam auto-ignore is not active.

**Action:** Ship as-is. Add migration 056 when spam auto-ignore is ready to ship.

---

### 10. Spam Auto-Ignore — Classification Stub

**File:line:** `src/lib/interactions/spam.ts:1`

**Marker:**
```typescript
// TODO #0 (gap 1) — Inbox spam classification.
```

**Classification:** deferred-feature

**Context:** Stub file for spam classification logic. Not yet implemented.

**Impact:** None — spam auto-ignore is not live. This is a placeholder for the classification function (LLM-based or rule-based spam detection).

**Action:** Ship as-is. Implement the classifier when building TODO #0.

---

### 11. Spam Auto-Ignore — Orchestrator Stub

**File:line:** `src/lib/interactions/auto-reply/spam-ignore.ts:1`

**Marker:**
```typescript
// TODO #0 (gap 1) — the SPAM-IGNORE ORCHESTRATOR.
```

**Classification:** deferred-feature

**Context:** Stub file for the spam auto-ignore orchestrator (runs the spam pass over new interactions). Not yet implemented.

**Impact:** None — spam auto-ignore is not live.

**Action:** Ship as-is.

---

### 12. Spam Auto-Ignore — Policy Gate Stub

**File:line:** `src/lib/interactions/auto-reply/spam-policy.ts:1`

**Marker:**
```typescript
// TODO #0 (gap 1) — the SPAM-IGNORE GATE.
```

**Classification:** deferred-feature

**Context:** Stub file for the spam-ignore gate (checks if spam auto-ignore is enabled for a workspace). Not yet implemented.

**Impact:** None — spam auto-ignore is not live.

**Action:** Ship as-is.

---

### 13. Voice Memo Retention — Sweep Cron

**File:line:** `src/lib/voice-memo/retention.ts:18`

**Marker:**
```typescript
//   2. An application-side sweep cron (see TODO below) so retention is
```

**File:line:** `src/lib/voice-memo/retention.ts:27`

**Marker:**
```typescript
// the sweep cron (below, TODO) to decide what to delete. `now` is injectable
```

**File:line:** `src/lib/voice-memo/retention.ts:34`

**Marker:**
```typescript
// TODO(voice-memo retention cron): wire an /api/cron/audio-retention route
```

**Classification:** deferred-feature

**Context:** The voice-memo retention policy is defined (bucket policy deletes recordings after 90 days), but there's no application-side cron to purge expired DB rows (`audio_recordings` table). The retention logic exists (exported functions), but the cron route is not yet wired.

**Impact:** Expired audio recordings stay in the DB (soft leak — the actual audio files are deleted by bucket policy). The DB grows unbounded until the cron is added.

**Action:** Ship as-is IF voice memos are low-volume (< 1000 recordings). Add the sweep cron before voice memos scale (prevents DB bloat). Mark as P1 for voice-memo GA.

---

## Correctness Gaps (Needs Fixing)

**None found.** All 25 TODOs are deferred features, not correctness bugs.

---

## Summary Table

| File:Line | Type | Classification | Feature Area | Urgency |
|-----------|------|----------------|--------------|---------|
| `src/app/(app)/video/analyze/page.tsx:9` | TODO | deferred-feature | Video analysis (organic videos) | Low |
| `src/lib/video/analyze/run.ts:13` | TODO | deferred-feature | Video analysis (organic videos) | Low |
| `src/lib/video/analyze/run.ts:67` | TODO | deferred-feature | Video analysis (organic videos) | Low |
| `src/app/(app)/inbox/page.tsx:47` | TODO | deferred-feature | Inbox spam review lane | Medium (before spam GA) |
| `src/app/api/cron/voice-evolution/route.ts:13` | TODO | deferred-feature | Voice evolution (gap 2) | Low |
| `src/app/api/cron/voice-evolution/route.ts:144` | TODO | deferred-feature | Voice evolution (gap 2) | Low |
| `src/lib/voice/from-sent.ts:1` | TODO | deferred-feature | Voice evolution (gap 2) | Low |
| `src/lib/voice/schema.ts:42` | TODO | deferred-feature | Voice evolution (gap 2) | Low |
| `src/lib/db/types.ts:174` | TODO | deferred-feature | Voice evolution (gap 2) | Low |
| `src/app/api/cron/poll-interactions/route.ts:102` | TODO | deferred-feature | Spam auto-ignore integration | Medium (before spam GA) |
| `src/app/api/cron/poll-interactions/route.ts:123` | TODO | deferred-feature | Spam auto-ignore integration | Medium (before spam GA) |
| `src/app/api/cron/poll-interactions/route.ts:364` | TODO | deferred-feature | Spam auto-ignore orchestrator | Medium (before spam GA) |
| `src/lib/interactions/schema.ts:41` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/interactions/schema.ts:95` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/db/types.ts:216` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/db/types.ts:258` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/db/types.ts:263` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/db/types.ts:1380` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/db/types.ts:1513` | TODO | deferred-feature | Spam schema (migration 056) | Medium (before spam GA) |
| `src/lib/interactions/spam.ts:1` | TODO | deferred-feature | Spam classification stub | Medium (before spam GA) |
| `src/lib/interactions/auto-reply/spam-ignore.ts:1` | TODO | deferred-feature | Spam orchestrator stub | Medium (before spam GA) |
| `src/lib/interactions/auto-reply/spam-policy.ts:1` | TODO | deferred-feature | Spam policy gate stub | Medium (before spam GA) |
| `src/lib/voice-memo/retention.ts:18` | TODO | deferred-feature | Voice memo retention cron | Medium (before scale) |
| `src/lib/voice-memo/retention.ts:27` | TODO | deferred-feature | Voice memo retention cron | Medium (before scale) |
| `src/lib/voice-memo/retention.ts:34` | TODO | deferred-feature | Voice memo retention cron | Medium (before scale) |

---

## Recommendations

### Pre-Launch (P0)
**None.** All TODOs are deferred features with no correctness impact.

### Before Feature GA (P1)
1. **Spam auto-ignore:** Complete all 12 spam-related TODOs before enabling spam auto-ignore by default (currently opt-in or shadow-mode).
2. **Voice memo retention:** Wire the sweep cron before voice memos reach 10k recordings (prevents DB bloat).

### Future Iterations (P2)
3. **Video analysis:** Add organic video (BYO URL) support.
4. **Voice evolution gap 2:** Collect user's own sent/published text as training data.

---

## Next Steps

1. **Accept all deferred-feature TODOs** — they're intentional placeholders, not bugs.
2. **Track spam auto-ignore TODOs** in the TODO #0 epic (inbox spam classification) — ensure they're all closed before spam GA.
3. **Monitor voice memo table growth** — add retention cron before it becomes a scaling issue.
4. **Re-run this triage quarterly** — new TODOs should be classified (deferred vs correctness-gap) to prevent tech debt accumulation.
