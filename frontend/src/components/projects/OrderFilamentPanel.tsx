import { useTranslation } from 'react-i18next';
import { useOrderFilament } from '../../hooks/useOrderFilament';
import { Button } from '../Button';
import { WorkshopPanel } from '../workshop/WorkshopPanel';
import { FilamentNeedsRows } from './FilamentNeeds';

/**
 * «Filament» — the order page's side panel (WS-13 E3 G03): the need per
 * material and colour against the shelf, always there.
 *
 * ⚠️ **An absent answer is not an empty one** (R02): a closed order computes
 * no need and says so without asking; a cold read waits; a failed read offers a
 * retry; a failed REFRESH keeps the answer it has and says it is not fresh; and
 * only a successful answer with nothing in it is «no calculated need» — never
 * «no plan», which the filament endpoint cannot know.
 */
export function OrderFilamentPanel({
  orderId,
  active,
  headingLevel = 2,
}: {
  orderId: number;
  active: boolean;
  headingLevel?: 2 | 3;
}) {
  const { t } = useTranslation();
  const needs = useOrderFilament(orderId, active);

  const body = () => {
    if (!active) return <p className="text-sm text-bambu-gray">{t('orders.filament.closed')}</p>;
    if (!needs.data) {
      return needs.isError ? (
        <Failed text={t('orders.filament.error')} onRetry={() => needs.refetch()} />
      ) : (
        <p className="text-sm text-bambu-gray">{t('common.loading')}</p>
      );
    }
    const data = needs.data;
    const empty = data.rows.length === 0 && data.unknown_prints === 0 && !data.stock_unavailable;
    return (
      <>
        {needs.isError && <Stale onRetry={() => needs.refetch()} />}
        {empty ? (
          <p className="text-sm text-bambu-gray">{t('orders.filament.empty')}</p>
        ) : (
          <FilamentNeedsRows needs={data} />
        )}
        <p className="mt-2 text-xs leading-[18px] text-bambu-gray">
          {t('orders.filament.queuedHint')}
          {data.assumptions.includes('slicer_estimate') && ` ${t('orders.filament.slicerEstimate')}`}
        </p>
      </>
    );
  };

  return (
    <WorkshopPanel data-testid="order-filament-panel" title={t('orders.filament.title')} headingLevel={headingLevel}>
      {body()}
    </WorkshopPanel>
  );
}

function Failed({ text, onRetry }: { text: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-red-400">
      <span>{text}</span>
      <Button size="sm" variant="secondary" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}

function Stale({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-amber-400">
      {t('orders.detail.refreshFailed')}
      <button type="button" onClick={onRetry} className="text-bambu-green hover:underline">
        {t('common.retry')}
      </button>
    </p>
  );
}
