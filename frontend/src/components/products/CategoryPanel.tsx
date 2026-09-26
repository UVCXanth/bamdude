import { useTranslation } from 'react-i18next';
import { Settings2 } from 'lucide-react';
import type { ProductCategory, ProductCategoryCount } from '../../api/client';
import { Select } from '../Select';

/** `''` — every product; `'none'` — the uncategorized; otherwise a category id. */
export type CategorySelection = string;

interface Entry {
  value: CategorySelection;
  name: string;
  count: number | null;
}

/**
 * The catalog's categories (spec workshop-product-catalog, rule 20).
 *
 * The COUNTS are the server's, from the list response — every filter of the
 * page but the category itself. The directory (`GET /product-categories`)
 * supplies the names, so a category with nothing under the current filters is
 * still listed, at 0 (the list response omits it). «All products» carries no
 * count: adding the others up here would be a figure the page computed.
 *
 * Wide screens get the list beside the catalog; narrow ones a select above it.
 */
export function CategoryPanel({
  directory,
  counts,
  uncategorized,
  selected,
  onSelect,
  onManage,
}: {
  directory: ProductCategory[];
  counts: ProductCategoryCount[];
  uncategorized: number;
  selected: CategorySelection;
  onSelect: (value: CategorySelection) => void;
  /** Absent without the permission to edit the directory. */
  onManage?: () => void;
}) {
  const { t } = useTranslation();
  const countOf = new Map(counts.map((c) => [c.id, c.count]));
  const named = new Map(directory.map((c) => [c.id, c.name]));
  // A category the list counted but the directory has not caught up with yet.
  for (const c of counts) if (!named.has(c.id)) named.set(c.id, c.name);
  const entries: Entry[] = [
    { value: '', name: t('products.catalog.all'), count: null },
    { value: 'none', name: t('products.catalog.uncategorized'), count: uncategorized },
    ...[...named].map(([id, name]) => ({ value: String(id), name, count: countOf.get(id) ?? 0 })),
  ];

  return (
    <>
      <nav aria-label={t('products.catalog.categories')} className="hidden lg:block">
        <ul className="space-y-0.5">
          {entries.map((entry) => {
            const active = entry.value === selected;
            return (
              <li key={entry.value || 'all'}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(entry.value)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-sm text-left ${
                    active ? 'bg-bambu-green/15 text-bambu-green' : 'text-white hover:bg-bambu-dark-tertiary'
                  }`}
                >
                  <span className="truncate">{entry.name}</span>
                  {entry.count !== null && <span className="text-xs text-bambu-gray tabular-nums">{entry.count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {onManage && (
          <button
            type="button"
            onClick={onManage}
            className="mt-3 flex items-center gap-1.5 px-3 text-xs text-bambu-gray hover:text-white"
          >
            <Settings2 className="w-3.5 h-3.5" />
            {t('products.catalog.manage')}
          </button>
        )}
      </nav>
      <div className="lg:hidden flex items-center gap-2 mb-3">
        <Select
          aria-label={t('products.catalog.categories')}
          value={selected}
          onChange={(e) => onSelect(e.target.value)}
          className="min-w-0 flex-1"
        >
          {entries.map((entry) => (
            <option key={entry.value || 'all'} value={entry.value}>
              {entry.count === null ? entry.name : `${entry.name} (${entry.count})`}
            </option>
          ))}
        </Select>
        {onManage && (
          <button
            type="button"
            onClick={onManage}
            aria-label={t('products.catalog.manage')}
            className="p-2 text-bambu-gray hover:text-white"
          >
            <Settings2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </>
  );
}
