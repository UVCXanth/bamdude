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

/** The SOURCE pair an archive answers beside its run's (swap-source-declaration spec r3 §7). */
export interface SourceSwapFactWire {
  source_swap_compatible?: unknown;
  source_swap_compatibility_known?: unknown;
}

/**
 * What a future reprint of an archive reads: its SOURCE pair, never the executed run's. A missing or
 * malformed pair is unknown -- there is no legacy reading of a field that never existed without its
 * known flag, and no fallback to the run's pair.
 */
export function decodeSourceSwapFact(archive: (SourceSwapFactWire & SwapFactWire) | null | undefined): SwapFact {
  if (!archive || typeof archive !== 'object') return 'unknown';
  if (typeof archive.source_swap_compatibility_known !== 'boolean') return 'unknown';
  return decodeSwapFact({
    swap_compatible: archive.source_swap_compatible,
    swap_compatibility_known: archive.source_swap_compatibility_known,
  });
}

/**
 * A fresh version 4 UUID for one declaration or refresh attempt. Built on `getRandomValues`, which
 * every browser has: `crypto.randomUUID` exists only in a secure context, and a farm reached over
 * plain HTTP on the LAN is not one.
 */
export function newOperationId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
