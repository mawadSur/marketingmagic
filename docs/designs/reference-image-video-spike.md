# Reference-Image Video — SPIKE (research + scaffold)

> **Status: SPIKE.** This is research + a feature-flagged scaffold, **not** a finished
> feature. No live external calls are wired. A vendor decision and a real adapter
> implementation are still required before this ships. See "What's real vs. what's
> a decision" at the bottom.
>
> Roadmap reference: **bet ④ — "upload a photo of yourself, generate video using it
> as a reference (your likeness)."** (`docs/designs/roadmap.md` was not present in
> this worktree at spike time; this doc captures the bet as described in the task +
> the memory-noted MPT plan.)

## 1. Problem & why it's a NEW path

The current video pipeline (`services/mpt-worker` / MoneyPrinterTurbo, orchestrated
from `src/lib/video/*`) stitches **Pexels stock clips + Edge-TTS narration + burned-in
subtitles**. It has no notion of a user-supplied image, and MoneyPrinterTurbo cannot
do image-conditioned / likeness / avatar generation at all. The reference-image
feature is therefore a **separate generation path**, not a parameter on the existing
render. It does, however, reuse the same *shape*:

- **BYO key** per workspace (encrypted at rest, `workspace_byo_keys`).
- **Headless async render** — POST a job, get a task/request id, poll for status,
  pull the finished mp4 into Supabase Storage, attach to a draft post.
- **Job table** mirroring `video_jobs` (status machine, progress, storage_path).

That parallelism is deliberate: the new path mirrors the existing
`mpt-client → jobs → orchestrator → poll cron` skeleton so it slots into the same
mental model and the same cron-poll infrastructure.

## 2. Two distinct sub-capabilities (important)

"Reference image → video" splits into two genuinely different product features that
need different providers. Worth calling out so the vendor decision is scoped:

| Capability | What the user gets | Input | Example providers |
|---|---|---|---|
| **A. Image-conditioned video** (animate a still) | The uploaded photo becomes the first frame / scene; camera + subject move per a text prompt. Likeness preserved as "this is my photo, now moving." | image + text prompt | fal.ai (Kling / Luma / Pika hosted), Runway, Luma, Hailuo |
| **B. Talking avatar** (lip-synced presenter) | A talking-head video of the person in the photo, lip-synced to a script or audio. | image + script **or** audio (+ voice) | HeyGen, D-ID |

Bet ④ as worded ("use it as a reference / their likeness") most naturally maps to
**A** for a first cut (animate the founder's photo into B-roll-style marketing
video), with **B** as a strong fast-follow (founder "presents" the post). The
scaffold below is written to support **either** — the provider interface carries an
optional `script`/`audio` so a talking-avatar adapter is a drop-in.

## 3. Candidate providers (BYO-key fit)

Evaluated against the existing constraint: **BYO key, headless render, poll for
result** (the MPT flow). All three below fit that flow.

### 3a. fal.ai (image-to-video; hosts Kling / Luma / Pika / Hailuo) — **RECOMMENDED**

- **Capability:** A (image-conditioned). Hosts many image-to-video models behind one
  API (Kling v1.6/v2.1/v3, Luma Dream Machine, Pika, Hailuo/MiniMax).
- **Input shape:** `{ image_url | image bytes, prompt, duration, aspect_ratio }`.
  Image-to-video, so the reference photo is a first-class input.
- **Output:** an mp4 URL (CDN, can expire → pull bytes, same as the existing
  `src/lib/images/fal.ts` does for stills).
- **Auth model:** `Authorization: Key <FAL_KEY>` header — **identical** to the header
  the app *already* sends in `src/lib/images/fal.ts`. BYO key = the workspace's own
  fal key.
- **Async/poll:** queue API — `POST` to submit → `{ request_id }` → poll
  `GET .../requests/{id}/status` → `GET .../requests/{id}` for the result. This is a
  near-exact analog of MPT's `POST /videos → {task_id} → GET /tasks/{id}`. Maps onto
  the existing poll-cron with almost no new infrastructure.
- **Pricing (rough, 2026):** roughly **$0.01–$0.15 / second** of output depending on
  model/quality tier (Kling standard cheap end, Luma/4K premium end). A 5s clip is
  cents-to-low-dollars. BYO = the customer pays fal directly.
- **Why it wins here:** the app *already integrates fal.ai for image generation* with
  the exact same auth header and "pull bytes, own the asset" pattern. Lowest net-new
  surface: one new model family on a vendor we already speak to. Lets us defer the
  talking-avatar/consent complexity to a later bet.

### 3b. HeyGen (talking avatar) — strong for capability B

- **Capability:** B (lip-synced presenter from photo + script/voice; "Avatar IV"
  generates an avatar from a single image).
- **Input shape:** `{ photo/avatar_id, script text | audio, voice_id, aspect }`.
- **Auth model:** `X-Api-Key` header. BYO = workspace's HeyGen key.
- **Async/poll:** submit a video generation → `video_id` → poll status → download mp4.
  Fits the poll-cron flow.
- **Pricing (rough, 2026):** ~**$1 / minute** of 720p/1080p standard; **Avatar IV
  ~$4 / minute** of 1080p. No free API tier (PAYG from ~$5). Pricier per-output than
  fal, but it's a finished talking-head, not raw motion.
- **Big caveat — CONSENT:** HeyGen requires **explicit, verified consent of the person
  depicted** to build a custom avatar; using someone else's likeness without consent
  is prohibited and actively enforced. For "a photo of *yourself*" this is fine, but
  our UX must make the self-likeness attestation explicit and pass it through.

### 3c. D-ID (talking avatar) — clean async, cheapest entry

- **Capability:** B (talking-head from a photo + text/audio; the "Talks" / photo-avatar
  endpoint).
- **Input shape:** `{ source_url (image), script: { type: text|audio, input, voice } }`.
- **Auth model:** `Authorization: Basic <key>` header. BYO = workspace's D-ID key.
- **Async/poll:** **textbook** match — `POST` returns an `id`, poll
  `GET /talks/{id}` until `status: done`, then read `result_url`. Renders are fast
  (~10–30s).
- **Pricing (rough, 2026):** Lite ~$5.9/mo (watermark), Pro ~$48/mo unlocks API; PAYG
  per-minute. Cheapest entry of the three; lower max quality / shorter outputs than
  HeyGen.
- **Caveat:** same likeness/consent posture as HeyGen (must own/consent to the face).

## 4. Recommendation

**Adopt fal.ai (image-conditioned, capability A) as the first reference-image video
provider.** Rationale:

1. **Zero new auth/vendor learning curve** — the app already calls fal.ai with the
   exact `Authorization: Key …` header and the "pull bytes → upload to Storage" idiom.
2. **Cleanest BYO story** — one fal key per workspace, encrypted via the *existing*
   `workspace_byo_keys` + `byo-keys.ts` machinery (new provider value `"fal_video"`).
3. **Async/poll shape is isomorphic to MPT** — drops into the same poll-cron pattern.
4. **Sidesteps the heaviest risk first** — image-conditioned "animate my photo" carries
   a *lighter* consent/deepfake burden than a fully lip-synced talking head, so we ship
   value while deferring the talking-avatar consent-verification UX to a later bet.

**Provider interface is written vendor-neutral** (`src/lib/video/reference/provider.ts`)
with an optional `script`/`audio`/`voice` so a HeyGen or D-ID talking-avatar adapter is
a drop-in later **without re-touching call sites** — same as how `images/provider.ts`
abstracts fal vs. a future higgsfield.

### Top risk (the one to flag loudest)

**Likeness / consent + content-policy.** Every viable provider treats an uploaded human
face as regulated input. Even the "safe" image-conditioned path (fal) is one prompt away
from generating a deceptive or policy-violating clip of a real person, and the
talking-avatar providers (HeyGen/D-ID) *require verified consent of the depicted person*
and enforce it. Product implications we must design for **before** going live:

- An explicit **"this is me / I have the right to use this face"** attestation at upload,
  stored with the reference image.
- Provider content-moderation failures surfaced as a clean job-failure reason (not a
  silent dead job).
- A deletion path (the bucket migration includes member delete RLS).

Secondary risks: **cost predictability** (per-second/per-minute billing on BYO keys —
needs the same quota gate as `assertWithinVideoQuota`), **latency/quality variance**
across hosted models, and **CDN URL expiry** (mitigated by pulling bytes immediately,
as the fal stills path already does).

## 5. Proposed data model

Mirrors migration `026_video_pipeline.sql` (`post-media-video` bucket + `video_jobs`)
and `003_post_media_bucket.sql` (workspace-prefixed RLS).

### 5a. Storage bucket: `reference-image` (migration `030`, scaffolded)

- Public bucket, **workspace-prefixed** layout `<workspace_id>/<upload_id>/<file>`.
- RLS mirrors `post-media-video`: `is_workspace_member(split_part(name,'/',1)::uuid)`
  for select/insert/update/delete; service role bypasses (the orchestrator/cron read
  bytes to hand to the provider).
- 10 MB cap, mime `image/jpeg|png|webp` (a portrait, not a hero video).
- Holds the user's uploaded reference photo. The render job carries the public URL (or
  the storage path) of the chosen reference.

### 5b. Render job carries the reference

Two equally valid options (decision deferred — both noted in the migration):

- **Option A (recommended for v1): reuse `video_jobs`.** Add a discriminator and the
  reference pointer into the existing `params jsonb` — no schema churn:
  `params = { kind: "reference_image", provider: "fal_video", reference_path,
  reference_public_url, prompt, aspect, duration }`. The existing poll-cron branches on
  `params.kind`. The migration `030` adds a nullable `reference_image_path` column +ix
  for cheap lookups/cleanup, but the orchestrator can run off `params` alone.
- **Option B: a dedicated `reference_video_jobs` table.** Cleaner separation, but
  duplicates the whole status machine + RLS + cron wiring. Not worth it for a spike;
  noted for the lead.

The scaffold takes **Option A** (params discriminator) and the `030` migration adds the
bucket + an optional `video_jobs.reference_image_path` column, clearly commented as
spike-only and safe to renumber.

### 5c. BYO key

New provider family value **`"fal_video"`** in the existing `workspace_byo_keys`
table — *no new table*. Encrypted via the existing `byo-keys.ts` AES-256-GCM helpers.
A `ByoFalVideoSecrets` type (`{ api_key }`) is added alongside `ByoLlmSecrets` /
`ByoPexelsSecrets`. (Scaffold defines the type + a stub plaintext shape; it is **not**
wired into the live `getWorkspaceKeys` switch yet, to avoid touching the shipped video
path — see the provider stub.)

## 6. Feature flag

Everything is gated behind **`REFERENCE_VIDEO_ENABLED`** (env, default off) surfaced via
`referenceVideoEnabled()` in `src/lib/env.ts`. With the flag off:

- the provider stub throws `ReferenceVideoNotEnabledError` ("Reference-image video is
  not yet enabled on this deployment");
- the upload UI slot renders a "coming soon / not enabled" state and does not POST.

This mirrors the existing graceful-degrade gates (`mptConfigured()`,
`videoPublishEnabled()`).

## 7. What's real vs. what's a decision

**Real (this spike):**
- The research above (providers, fit, pricing, risks).
- A vendor-neutral provider interface + a throwing stub (no live calls).
- An upload UI slot (image → workspace-scoped bucket) behind the flag.
- A bucket migration (`030`) + optional `reference_image_path` column.
- The feature flag + env wiring.
- typecheck / build / existing tests still green.

**Still a decision / a build (NOT done here):**
- **Which provider to actually ship** (recommendation = fal, but not committed in code).
- The real adapter (submit → poll → pull bytes) for the chosen vendor.
- The consent/likeness attestation UX + storage and content-moderation failure surface.
- Quota gating (`assertWithinVideoQuota` analog) + a billing meter for the new path.
- Wiring the new path into the poll-cron + draft-post attachment.
- Adding `"fal_video"` to the live `getWorkspaceKeys` decode switch + a settings form.

## Sources

- fal.ai Kling image-to-video API (queue submit/status/result, `Authorization: Key`): https://fal.ai/models/fal-ai/kling-video/v2.1/master/image-to-video/api
- AI video generation API pricing ($0.01–$0.15/sec): https://tokenmix.ai/blog/ai-video-generation-api
- Best image-to-video APIs (Runway/Kling/Luma/Pika comparison): https://www.veed.io/learn/best-image-to-video-api
- HeyGen API pricing (~$1/min standard, ~$4/min Avatar IV): https://help.heygen.com/en/articles/10060327-heygen-api-pricing-explained
- HeyGen consent/likeness policy: https://www.heygen.com/moderation-policy
- D-ID async polling + photo-avatar quickstart: https://docs.d-id.com/docs/v2-photo-avatar-quickstart
- D-ID API pricing: https://www.d-id.com/pricing/api/
