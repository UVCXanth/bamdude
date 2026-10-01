import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { StatTile, StatTiles } from '../StatTile';
import { LoadFailedNote } from '../workshop/LoadFailedNote';

/**
 * The orders page's four tiles (spec workshop-lists, rule 16): the farm's
 * active orders from `GET /projects/summary`. Keyed under `['projects']`, so
 * every order mutation that refreshes the list refreshes the tiles too.
 *
 * The fourth is the QC STAGE (WS-13 E7 C02, O02) — the operator's manual stage,
 * so its line says what to do there, not that everything printed.
 */
export function OrdersTiles() {
  const { t } = useTranslation();
  const { data, isError, refetch } = useQuery({ queryKey: ['projects', 'summary'], queryFn: () => api.getOrdersSummary() });
  const failed = isError && !data;
  return (
    <>
    <StatTiles>
      <StatTile
        testId="orders-tile-active"
        label={t('orders.tiles.active')}
        value={data?.active}
        failed={failed}
        sub={data ? t('orders.tiles.activeSub', { overdue: data.overdue, urgent: data.urgent }) : undefined}
      />
      <StatTile
        testId="orders-tile-printing"
        label={t('orders.tiles.printing')}
        value={data?.printing}
        suffix={data?.queued}
        failed={failed}
        sub={t('orders.tiles.printingSub')}
      />
      <StatTile
        testId="orders-tile-remaining"
        label={t('orders.tiles.remaining')}
        value={data?.remaining}
        failed={failed}
        sub={t('orders.tiles.remainingSub')}
      />
      <StatTile
        testId="orders-tile-qc"
        label={t('orders.tiles.qc')}
        value={data?.qc}
        failed={failed}
        sub={t('orders.tiles.qcSub')}
      />
    </StatTiles>
    {failed && (
      <LoadFailedNote role="status" className="-mt-2 mb-4" message={t('orders.tiles.failed')} onRetry={() => void refetch()} />
    )}
    </>
  );
}
