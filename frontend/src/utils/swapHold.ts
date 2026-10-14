/**
 * Our change-table macro was owed when this print ended and did not run (swap-source-lifecycle spec r4
 * §10, R2-6). The server records only codes on the archive (`extra_data.swap_hold`); the sentence is
 * composed here, in the reader's language. It is shown on the print itself because the queue's hold may
 * have no next job to carry the reason.
 */
const REASONS = [
  'swap_hold_source_unknown',
  'swap_hold_source_baked',
  'swap_hold_run_unproven',
  'swap_hold_not_completed',
  'swap_hold_swap_off',
  'swap_hold_outcome_uncertain',
  'swap_hold_macro_error',
] as const;

type Translate = (key: string) => string;

/** The sentence for a recorded hold, or `null` when there is none (or it is not one of ours). */
export function swapHoldText(t: Translate, extraData: unknown): string | null {
  if (!extraData || typeof extraData !== 'object') return null;
  const hold = (extraData as Record<string, unknown>).swap_hold;
  if (!hold || typeof hold !== 'object') return null;
  const { reason, cycle } = hold as { reason?: unknown; cycle?: unknown };
  if (cycle === 'started') return t('archives.swapHold.started');
  if (cycle === 'possibly_started') return t('archives.swapHold.possiblyStarted');
  if (cycle === 'not_started' && typeof reason === 'string' && (REASONS as readonly string[]).includes(reason)) {
    return t(`archives.swapHold.reason.${reason}`);
  }
  return null;
}
