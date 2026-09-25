/**
 * A list's `sort_by` is `<key>-<asc|desc>` (spec projects-lists-parity). A key
 * may hold an underscore (`total_price`), so the split is on the dash that
 * comes right before the direction.
 */
export function splitSortBy(sortBy: string): { key: string; desc: boolean } {
  const [key, dir] = sortBy.split(/-(?=asc$|desc$)/);
  return { key, desc: dir === 'desc' };
}

/** What a click on `key` asks for: the active key flips, a new one starts at its first direction. */
export function nextSortBy(current: string, key: string, descFirst: boolean): string {
  const active = splitSortBy(current);
  if (active.key === key) return `${key}-${active.desc ? 'asc' : 'desc'}`;
  return `${key}-${descFirst ? 'desc' : 'asc'}`;
}
