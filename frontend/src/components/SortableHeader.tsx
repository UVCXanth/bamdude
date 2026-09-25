import { nextSortBy, splitSortBy } from '../utils/listSort';

/**
 * One sortable header cell of the Workshop tables (spec workshop-lists, rule 13).
 * The server sorts (`sort_by`): the rows are one page of many, and a header
 * that sorted only what is on screen would read as the whole list's order.
 * A fresh click takes the key's first direction (`descFirst` for numbers and
 * dates that read best largest-first); a click on the active key flips it.
 */
export function SortableHeader({
  sortKey,
  label,
  sort,
  onSort,
  descFirst = false,
  align = 'left',
}: {
  sortKey: string;
  label: string;
  sort: string;
  onSort: (sortBy: string) => void;
  descFirst?: boolean;
  align?: 'left' | 'right';
}) {
  const { key, desc } = splitSortBy(sort);
  const active = key === sortKey;
  return (
    <th
      className={`font-normal p-2 ${align === 'right' ? 'text-right' : 'text-left'}`}
      aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
    >
      <button type="button" onClick={() => onSort(nextSortBy(sort, sortKey, descFirst))} className="hover:text-white">
        {label}
        {active && <span aria-hidden> {desc ? '▼' : '▲'}</span>}
      </button>
    </th>
  );
}
