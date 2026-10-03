import { useTranslation } from 'react-i18next';

const SKELETON_ROWS = 6;

/**
 * A stock tab's first read (WS-13 E12 B04), shaped like the table that comes. The grey
 * boxes are decoration; `role="status"` with one visually-hidden line announces the wait
 * (as `CustomersSkeleton`).
 */
export function StockTableSkeleton({ tab }: { tab: string }) {
  const { t } = useTranslation();
  return (
    <div role="status" aria-busy="true" data-testid="stock-skeleton" data-tab={tab}>
      <span className="sr-only">{t('common.loading')}</span>
      <div aria-hidden="true" className="rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary overflow-hidden">
        <div className="h-9 bg-bambu-dark-tertiary/50" />
        {Array.from({ length: SKELETON_ROWS }, (_, i) => (
          <div key={i} className="animate-pulse flex items-center gap-4 px-3 py-3 border-t border-bambu-dark-tertiary">
            <div className="h-9 w-9 flex-shrink-0 rounded bg-bambu-dark" />
            <div className="h-4 w-1/4 rounded bg-bambu-dark" />
            <div className="h-4 w-16 rounded bg-bambu-dark" />
            <div className="h-4 w-12 rounded bg-bambu-dark" />
            <div className="h-4 w-12 rounded bg-bambu-dark" />
            <div className="h-4 w-12 rounded bg-bambu-dark" />
          </div>
        ))}
      </div>
    </div>
  );
}
