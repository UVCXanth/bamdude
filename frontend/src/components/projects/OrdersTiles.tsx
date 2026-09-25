import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { StatTile, StatTiles } from '../StatTile';

/**
 * The orders page's four tiles (spec workshop-lists, rule 16): the farm's
 * active orders from `GET /projects/summary`. Keyed under `['projects']`, so
 * every order mutation that refreshes the list refreshes the tiles too.
 */
export function OrdersTiles() {
  const { t } = useTranslation();
  const { data, isError } = useQuery({ queryKey: ['projects', 'summary'], queryFn: () => api.getOrdersSummary() });
  const failed = isError && !data;
  return (
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
        testId="orders-tile-covered"
        label={t('orders.tiles.allCovered')}
        value={data?.all_covered}
        failed={failed}
        sub={t('orders.tiles.allCoveredSub')}
      />
    </StatTiles>
  );
}
