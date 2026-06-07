// Pure helpers for the audio-retention toggle. Kept OUT of
// audio-retention-actions.ts because that file is "use server" — Next requires
// every export in a "use server" module to be an async Server Action, so a
// synchronous helper there fails the production build ("Server Actions must be
// async functions"). This plain module is the home for the testable bits.

export type AudioRetentionState = { error: string | null; message: string | null };

// Pure parse of the checkbox field. HTML checkboxes submit their `value`
// (default "on") when checked and omit the field entirely when unchecked —
// so a present, truthy value means opt-in, anything else (incl. null) means
// opt-out.
export function parseOptInCheckbox(raw: FormDataEntryValue | null): boolean {
  return raw === "on" || raw === "true" || raw === "1";
}
