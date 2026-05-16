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
