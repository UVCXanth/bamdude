import { Trans, useTranslation } from 'react-i18next';
import { Settings2 } from 'lucide-react';
import type { ProductCategory, ProductCategoryCount } from '../../api/client';
import { listFigure, type ListState } from '../../utils/listState';
import { LoadFailedNote } from '../workshop/LoadFailedNote';

/** `''` — every product; `'none'` — the uncategorized; otherwise a category id. */
export type CategorySelection = string;

/** The panel's figures, all from one list answer: every filter but the category (G01). */
export interface CategoryFigures {
  categories: ProductCategoryCount[];
  uncategorized: number;
  /** «All products» — the server's sum of every group, never added up here. */
  all: number;
}

interface Entry {
  value: CategorySelection;
  name: string;
  /** A category the answer has no row for counts 0 — shown only once the answer is there. */
  count: number;
}

/**
 * The catalog's categories (spec workshop-product-catalog, rule 20; WS-13 E8 C06, C11).
 *
 * The COUNTS are the server's, from the list response — every filter of the page but
 * the category itself, «All products» included (`all_categories`). The directory
 * (`GET /product-categories`) supplies the names, so a category with nothing under the
 * current filters is still listed, at 0; until it answers, the categories the list
 * response named stand in, and a failed read says so beside them with its own retry.
 * A category chosen in the URL that nobody has named yet is «Category #id», still
 * chosen. Wide screens keep the panel sticky beside the results; at 760 and narrower
 * the whole list stands above them.
 */
export function CategoryPanel({
  directory,
  directoryFailed,
  onRetryDirectory,
  figures,
  state,
  selected,
  onSelect,
  onManage,
}: {
  directory: ProductCategory[] | undefined;
  directoryFailed: boolean;
  onRetryDirectory: () => unknown;
  figures: CategoryFigures | undefined;
  /** The list query's state — the counts follow it. */
  state: ListState;
  selected: CategorySelection;
  onSelect: (value: CategorySelection) => void;
  /** Absent without the permission to edit the directory. */
  onManage?: () => void;
}) {
  const { t } = useTranslation();
  const countOf = new Map((figures?.categories ?? []).map((c) => [c.id, c.count]));
  const named = new Map((directory ?? []).map((c) => [c.id, c.name]));
  // A category the list counted but the directory has not caught up with (or not read) yet.
  for (const c of figures?.categories ?? []) if (!named.has(c.id)) named.set(c.id, c.name);
  const entries: Entry[] = [
    { value: '', name: t('products.catalog.all'), count: figures?.all ?? 0 },
    { value: 'none', name: t('products.catalog.uncategorized'), count: figures?.uncategorized ?? 0 },
    ...[...named].map(([id, name]) => ({ value: String(id), name, count: countOf.get(id) ?? 0 })),
  ];
  if (selected && !entries.some((e) => e.value === selected)) {
    entries.push({ value: selected, name: t('products.catalog.unknownCategory', { id: selected }), count: 0 });
  }

  return (
    <nav
      aria-label={t('products.catalog.categories')}
      className="self-start min-[761px]:sticky min-[761px]:top-[calc(var(--app-top)+0.75rem)] min-[761px]:max-h-[calc(100dvh-1.5rem-var(--app-top))] min-[761px]:overflow-y-auto"
    >
      <div aria-hidden="true" className="px-3 pb-2 text-[10px] font-medium uppercase tracking-wider text-bambu-gray">
        {t('products.catalog.categories')}
      </div>
      <ul>
        {entries.map((entry) => {
          const active = entry.value === selected;
          return (
            <li key={entry.value || 'all'} className="mb-0.5">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(entry.value)}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm text-left ${
                  active ? 'bg-bambu-green/15 text-bambu-green' : 'text-bambu-gray hover:bg-bambu-dark-tertiary hover:text-white'
                }`}
              >
                <span className="min-w-0 break-words">{entry.name}</span>
                <small className="text-xs tabular-nums opacity-80">{listFigure(state, entry.count)}</small>
              </button>
            </li>
          );
        })}
      </ul>
      {directoryFailed && (
        <LoadFailedNote
          role="status"
          className="mt-2 px-3 text-xs"
          message={t(directory ? 'products.catalog.directoryRefreshFailed' : 'products.catalog.directoryFailed')}
          onRetry={onRetryDirectory}
        />
      )}
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
      <p className="mt-3 border-t border-bambu-dark-tertiary px-3 py-3.5 text-xs leading-[18px] text-bambu-gray">
        <Trans i18nKey="products.catalog.searchHint" components={{ ex: <code className="text-xs text-white" /> }} />
      </p>
    </nav>
  );
}
