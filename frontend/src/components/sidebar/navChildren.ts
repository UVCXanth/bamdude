/** A badge a sidebar child may carry; the number comes from `useWorkshopBadges`. */
export type NavBadgeKind = 'activeOrders';

/**
 * A child of a sidebar item (spec workshop-nav, rule 1). No icon of its own;
 * `match` lights it on its list AND on its detail pages, so the parent knows
 * the user is inside its section.
 */
export interface NavChild {
  id: string;
  to: string;
  labelKey: string;
  match: RegExp;
  badge?: NavBadgeKind;
}

/** The child the current path belongs to, or null outside the section. */
export function activeChildId(children: readonly NavChild[], pathname: string): string | null {
  return children.find((child) => child.match.test(pathname))?.id ?? null;
}
