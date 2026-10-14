/**
 * A source's swap declaration as the dialog reads it (swap-source-lifecycle spec r4 §9).
 *
 * `true` — the file carries its own plate-swap sequence, so BamDude adds none of its swap
 * macros; `false` — it does not, and the operator's swap choices apply; `'unknown'` — nothing
 * says, so a request for our swap macros is refused rather than guessed.
 */
export type SwapFact = true | false | 'unknown';

/** The two answer fields every archive, library and queue copy-source response carries. */
export interface SwapFactWire {
  swap_compatible?: unknown;
  swap_compatibility_known?: unknown;
}

/**
 * The one decoder. A server from before `swap_compatibility_known` sent the bool alone, read only
 * when it is a strict bool. No answer (loading, failed read), a known flag that is not a bool and a
 * declaration that is not known are all unknown — never False.
 */
export function decodeSwapFact(source: SwapFactWire | null | undefined): SwapFact {
  if (!source || typeof source !== 'object') return 'unknown';
  const declared = source.swap_compatible;
  if (typeof declared !== 'boolean') return 'unknown';
  const known = source.swap_compatibility_known;
  if (known === undefined) return declared;
  if (known !== true) return 'unknown';
  return declared;
}
