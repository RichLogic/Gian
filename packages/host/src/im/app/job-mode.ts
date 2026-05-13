/**
 * Stub for rvc's `apps/host/src/app/job-mode.ts`. Gian doesn't have job
 * mode (autonomous multi-round agents); IM manager imports
 * `stripJobStatusBlock` to peel a structured status preface off the
 * agent's reply before posting to IM. With no job mode, the function is
 * an identity pass-through.
 *
 * If/when Gian grows job mode, port the real implementation from rvc.
 */
export function stripJobStatusBlock(text: string | null | undefined): string {
  return text ?? '';
}
