import { useTranslation } from 'react-i18next';

const BAR = 'rounded bg-bambu-dark-tertiary/70';

/**
 * The product page's first read (WS-13 E9 C04): the page's own shape — the crumbs, the
 * title, the two columns and the tab strip — never a spinner, so nothing jumps when the
 * product arrives. The grid is the page's (`productLayoutClass`).
 */
export function ProductPageSkeleton({ layoutClass }: { layoutClass: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="product-page-skeleton" aria-busy="true" className="space-y-4 animate-pulse">
      <span className="sr-only" role="status">
        {t('common.loading')}
      </span>
      <div className={`h-4 w-40 ${BAR}`} />
      <div className={`h-7 w-72 max-w-full ${BAR}`} />
      <div className={layoutClass}>
        <div className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary">
          <div className="h-[200px] bg-bambu-dark-tertiary/60" />
          <div className="space-y-4 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-1.5">
                <div className={`h-3 w-24 ${BAR}`} />
                <div className={`h-4 w-36 ${BAR}`} />
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-4 rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
          <div className="flex gap-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={`h-5 w-24 ${BAR}`} />
            ))}
          </div>
          <div className={`h-40 ${BAR}`} />
        </div>
      </div>
    </div>
  );
}
