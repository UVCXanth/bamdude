/**
 * The name of a product's copy (WS-13 E8 F03, R02) — the ONE generator, for the catalog
 * and the product page alike. The whole localized suffix (` (copy)`, ` (копія)`) always
 * goes on; the base is cut so the name fits the column (`Product.name`, 255), counted in
 * Unicode code points — what the server counts — so a character outside the BMP is never
 * split into half a surrogate pair. A space the cut leaves at the end of the base goes.
 */
export function copyName(name: string, suffix: string, max = 255): string {
  const room = max - Array.from(suffix).length;
  const base = Array.from(name);
  const kept = base.length > room ? base.slice(0, Math.max(0, room)).join('').trimEnd() : name;
  return `${kept}${suffix}`;
}
