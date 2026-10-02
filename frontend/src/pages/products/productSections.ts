/**
 * The product page's five tabs, in the mockup's order (WS-13 E9 C02–C03). The value is
 * what the URL's `tab` carries; `composition` is the default and is never written (a
 * clean URL is the composition).
 */
export const PRODUCT_SECTIONS = ['composition', 'plates', 'stock', 'docs', 'orders'] as const;

export type ProductSection = (typeof PRODUCT_SECTIONS)[number];

/** Anything the URL may hold, read as a tab — an unknown value is the composition, and
 *  reading it rewrites nothing (C03, as E7 / E8-R01). */
export function parseProductSection(raw: string | null | undefined): ProductSection {
  return (PRODUCT_SECTIONS as readonly string[]).includes(raw ?? '') ? (raw as ProductSection) : 'composition';
}

/** What the URL carries for a tab: nothing for the composition. */
export function sectionParam(section: ProductSection): string {
  return section === 'composition' ? '' : section;
}
