/**
 * The order detail's six sections, in the mockup's order (WS-13 E3 F01). The
 * value is what the URL's `section` carries; `plan` is the default and is never
 * written (a clean URL is the plan).
 */
export const ORDER_SECTIONS = ['plan', 'prints', 'procurement', 'issues', 'notes', 'files'] as const;

export type OrderSection = (typeof ORDER_SECTIONS)[number];

/** Anything the URL may hold, read as a section — an unknown value is the plan (F02). */
export function parseOrderSection(raw: string | null | undefined): OrderSection {
  return (ORDER_SECTIONS as readonly string[]).includes(raw ?? '') ? (raw as OrderSection) : 'plan';
}

/** What the URL carries for a section: nothing for the plan. */
export function sectionParam(section: OrderSection): string {
  return section === 'plan' ? '' : section;
}
