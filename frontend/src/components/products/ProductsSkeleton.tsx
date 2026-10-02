import { useTranslation } from 'react-i18next';
import type { ListView } from '../ListViewToggle';

const SKELETON_ROWS = 6;

/**
 * The catalog's first read (WS-13 E8 C08), shaped like what comes — a table waits as
 * the six-column table, the cards as the vertical cards. The grey boxes are
 * decoration; `role="status"` with one visually-hidden line is what announces the
 * wait (as `OrdersSkeleton`).
 */
export function ProductsSkeleton({ view }: { view: ListView }) {
  const { t } = useTranslation();
  if (view === 'table') {
    return (
      <div role="status" aria-busy="true" data-testid="products-skeleton" data-shape="table">
        <span className="sr-only">{t('common.loading')}</span>
        <div aria-hidden="true" className="rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary overflow-hidden">
          <div className="h-9 bg-bambu-dark-tertiary/50" />
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="animate-pulse flex items-center gap-4 px-3 py-3 border-t border-bambu-dark-tertiary">
              <div className="h-10 w-10 flex-shrink-0 rounded-lg bg-bambu-dark" />
              <div className="h-4 w-1/4 rounded bg-bambu-dark" />
              <div className="h-4 w-24 rounded bg-bambu-dark" />
              <div className="h-4 w-16 rounded bg-bambu-dark" />
              <div className="h-4 w-20 rounded bg-bambu-dark" />
              <div className="h-4 w-16 rounded bg-bambu-dark" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" data-testid="products-skeleton" data-shape="cards">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true" className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))]">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="animate-pulse rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary p-4">
            <div className="h-[120px] rounded-lg bg-bambu-dark mb-3" />
            <div className="h-3 w-1/2 rounded bg-bambu-dark mb-2" />
            <div className="h-4 w-2/3 rounded bg-bambu-dark mb-2" />
            <div className="h-3 w-3/4 rounded bg-bambu-dark mb-3" />
            <div className="h-4 w-1/3 rounded bg-bambu-dark" />
          </div>
        ))}
      </div>
    </div>
  );
}
