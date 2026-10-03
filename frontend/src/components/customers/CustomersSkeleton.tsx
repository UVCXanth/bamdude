import { useTranslation } from 'react-i18next';
import type { ListView } from '../ListViewToggle';

const SKELETON_ROWS = 6;

/**
 * The customers list's first read (WS-13 E11 B05), shaped like what comes — the table as
 * its rows, the cards as cards. The grey boxes are decoration; `role="status"` with one
 * visually-hidden line announces the wait (as `ProductsSkeleton`).
 */
export function CustomersSkeleton({ view }: { view: ListView }) {
  const { t } = useTranslation();
  if (view === 'table') {
    return (
      <div role="status" aria-busy="true" data-testid="customers-skeleton" data-shape="table">
        <span className="sr-only">{t('common.loading')}</span>
        <div aria-hidden="true" className="rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary overflow-hidden">
          <div className="h-9 bg-bambu-dark-tertiary/50" />
          {Array.from({ length: SKELETON_ROWS }, (_, i) => (
            <div key={i} className="animate-pulse flex items-center gap-4 px-3 py-3 border-t border-bambu-dark-tertiary">
              <div className="h-10 w-10 flex-shrink-0 rounded-[10px] bg-bambu-dark" />
              <div className="h-4 w-1/5 rounded bg-bambu-dark" />
              <div className="h-4 w-1/5 rounded bg-bambu-dark" />
              <div className="h-4 w-24 rounded bg-bambu-dark" />
              <div className="h-4 w-20 rounded bg-bambu-dark" />
              <div className="h-4 w-16 rounded bg-bambu-dark" />
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div role="status" aria-busy="true" data-testid="customers-skeleton" data-shape="cards">
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true" className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))]">
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="animate-pulse rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary p-4">
            <div className="h-10 w-10 rounded-[10px] bg-bambu-dark mb-3" />
            <div className="h-4 w-2/3 rounded bg-bambu-dark mb-2" />
            <div className="h-3 w-1/2 rounded bg-bambu-dark mb-3" />
            <div className="h-4 w-1/3 rounded bg-bambu-dark" />
          </div>
        ))}
      </div>
    </div>
  );
}
