/** The catalog's readiness filter — a closed set; anything else in the URL is no filter. */
export type CatalogStatus = '' | 'draft' | 'ready';
/** The stock filter as the URL spells it (`low` is the server's `below_min`). */
export type CatalogStock = '' | 'finished' | 'kits' | 'low';

/** An unknown readiness in a hand-edited URL is no filter (never a 422) — WS-13 E8 C04. */
export function catalogStatus(raw: string): CatalogStatus {
  return raw === 'draft' || raw === 'ready' ? raw : '';
}

/** `1` was «has free kits» before the four modes (WS-13 E8 C04); anything unknown is none. */
export function catalogStock(raw: string): CatalogStock {
  if (raw === '1') return 'kits';
  return raw === 'finished' || raw === 'kits' || raw === 'low' ? raw : '';
}
