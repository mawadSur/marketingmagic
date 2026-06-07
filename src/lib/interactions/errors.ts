// Shared errors for the Phase 4.5 inbox / pollers / send helpers.
//
// MetaAppReviewPendingError is thrown by the IG + Threads poller stubs and
// send-reply stubs to signal that the schema and call sites are wired up,
// but the required Meta scopes (`instagram_manage_comments`, etc.) are
// gated on a Meta App Review submission. The UI catches this distinctly
// from generic errors so the user sees a "coming soon" badge rather than
// a red toast.

export class MetaAppReviewPendingError extends Error {
  // Carried in the response payload so the UI can show a stable copy.
  readonly scope: string;

  constructor(scope: string) {
    super(
      `Meta scope "${scope}" is pending App Review. ` +
        "Reply paths for Instagram and Threads will ship once Meta approves the scope. " +
        "Schema and call sites are stubbed so the rest of the inbox keeps shipping.",
    );
    this.name = "MetaAppReviewPendingError";
    this.scope = scope;
  }
}

// Bet 4 (comment→DM) — thrown by a per-channel DM-send helper when the
// connected account demonstrably lacks the capability/scope needed to send a
// direct message:
//   * X      — `dm.write` (typically a paid API tier; absent on Free/Basic).
//   * LinkedIn — messaging is partnership-gated (no public DM-send API for a
//                generic `w_member_social` app).
//   * Bluesky — the `chat.bsky.*` convo API needs the chat proxy header AND
//                the actor must have opted into DMs from the recipient.
//
// Modeled on MetaAppReviewPendingError, but with a crucial difference in how
// it's handled: the DM-send CORE catches this and turns it into a clean,
// AUDITED no-op (outcome='scope_missing') rather than a failure. Auto-DMing a
// stranger is higher blast-radius than a public reply, so the capability guard
// must fail closed and QUIETLY — never error the cron run, never retry.
export class DmScopeMissingError extends Error {
  // Machine-readable scope/capability we gated on (e.g. "dm.write").
  readonly scope: string;
  // The channel this capability belongs to.
  readonly channel: string;

  constructor(channel: string, scope: string, detail?: string) {
    super(
      `DM capability "${scope}" not available on the connected ${channel} account` +
        (detail ? `: ${detail}` : ".") +
        " Skipping the comment→DM send (no-op).",
    );
    this.name = "DmScopeMissingError";
    this.channel = channel;
    this.scope = scope;
  }
}
