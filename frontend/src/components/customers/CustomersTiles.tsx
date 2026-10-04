import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { formatMoney } from '../../utils/currency';
import { StatTile, StatTiles } from '../StatTile';
import { useUiPreferences } from '../../hooks/useUiPreferences';

/**
 * The customers page's four tiles (spec workshop-lists, rule 16; the mockup's words,
 * WS-13 E11 B02): the whole farm from `GET /customers/summary`, never the list's search. Keyed under
 * `['customers']`, so every order mutation that refreshes the list refreshes
 * the tiles too.
 */
export function CustomersTiles() {
  const { t } = useTranslation();
  const { data, isError } = useQuery({ queryKey: ['customers', 'summary'], queryFn: () => api.getCustomersSummary() });
  // The app-wide currency, fetched the way every money-showing screen fetches it.
  const { data: settings } = useUiPreferences();
  const failed = isError && !data;
  return (
    <StatTiles>
      <StatTile
        testId="customers-tile-customers"
        label={t('customers.tiles.customers')}
        value={data?.customers}
        failed={failed}
        sub={data ? t('customers.tiles.customersSub', { count: data.regular }) : undefined}
      />
      <StatTile
        testId="customers-tile-with-active"
        label={t('customers.tiles.withActive')}
        value={data ? (data.with_active ?? '—') : undefined}
        failed={failed}
        sub={t('customers.tiles.withActiveSub')}
      />
      <StatTile
        testId="customers-tile-active-orders"
        label={t('customers.tiles.activeOrders')}
        value={data ? (data.active_orders ?? '—') : undefined}
        failed={failed}
        sub={t('customers.tiles.activeOrdersSub')}
      />
      <StatTile
        testId="customers-tile-total"
        label={t('customers.tiles.totalPrice')}
        value={data ? (data.total_price == null ? '—' : formatMoney(data.total_price, settings?.currency)) : undefined}
        failed={failed}
        sub={t('customers.tiles.totalPriceSub')}
      />
    </StatTiles>
  );
}
