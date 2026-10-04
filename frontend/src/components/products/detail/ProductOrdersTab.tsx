import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import type { OrderListItem, Product } from '../../../api/client';
import { answeredEmpty, listState } from '../../../utils/listState';
import { PaginationBar } from '../../PaginationBar';
import { lineConfigLabel } from '../../projects/lineConfigLabel';
import { OrderCoverage } from '../../projects/orderRow/OrderCoverage';
import { StageBadge } from '../../projects/StageBadge';
import { LoadFailedNote } from '../../workshop/LoadFailedNote';
import { RefreshFailedNote } from '../../workshop/RefreshFailedNote';
import { SectionLink } from '../../workshop/SectionLink';

const PER_PAGE = 24;
const HEAD = 'px-3 py-2 text-left text-xs font-normal text-bambu-gray';

/** This product's lines of one order (A02): «× qty · configuration», a parts line «parts only». */
function ProductLines({ order }: { order: OrderListItem }) {
  const { t } = useTranslation();
  return (
    <>
      {(order.product_lines ?? []).map((line) => {
        const label = lineConfigLabel(line.configuration, line.mode, t);
        return (
          <small key={line.line_id} className="block text-xs text-bambu-gray-light">
            {line.mode === 'parts' ? label : label ? `× ${line.quantity} · ${label}` : `× ${line.quantity}`}
          </small>
        );
      })}
    </>
  );
}

/**
 * The «Orders» tab of the product page (WS-13 E9 H01–H02): the orders with a line of this
 * product, newest first, 24 a page — the order list's own answer (`GET /projects/?product_id=`)
 * with this product's lines in it (`product_lines`, A02), under the `projects` prefix every
 * order mutation refreshes. The coverage is the whole order's, as the mockup's: an order's
 * progress is what tells whether opening it is worth it, and a per-product slice of it
 * counted here would be another place that counts prints.
 *
 * States are `listState`'s; the last page is normalised only by an answer of its own key.
 * Under the table: the units printed for orders — every order status, never a print
 * nobody ordered.
 */
export function ProductOrdersTab({ product }: { product: Pick<Product, 'id' | 'units_printed_total'> }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const params = { product_id: product.id, page, per_page: PER_PAGE, sort_by: 'created-desc' };
  const orders = useQuery({
    queryKey: ['projects', params],
    queryFn: () => api.getOrdersPaged(params),
    placeholderData: keepPreviousData,
    retry: false,
  });
  const state = listState({ data: orders.data, isError: orders.isError, isPlaceholderData: orders.isPlaceholderData });
  const meta = orders.data?.meta;

  useEffect(() => {
    if (meta && !orders.isPlaceholderData && meta.last_page >= 1 && page > meta.last_page) setPage(meta.last_page);
  }, [meta, orders.isPlaceholderData, page]);

  let body;
  if (state === 'loading') {
    body = (
      <div data-testid="product-orders-skeleton" aria-busy="true" className="space-y-2 animate-pulse">
        <span className="sr-only" role="status">
          {t('common.loading')}
        </span>
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-12 rounded bg-bambu-dark-tertiary/60" />
        ))}
      </div>
    );
  } else if (state === 'failed') {
    body = <LoadFailedNote message={t('products.detail.ordersTab.failed')} onRetry={() => orders.refetch()} />;
  } else {
    const items = orders.data?.items ?? [];
    body = (
      <div className={state === 'transition' ? 'opacity-60' : undefined} aria-busy={state === 'transition' || undefined}>
        {state === 'refresh-failed' && <RefreshFailedNote onRetry={() => orders.refetch()} />}
        {answeredEmpty(state, orders.data) || items.length === 0 ? (
          <p className="py-6 text-center text-sm text-bambu-gray">{t('products.detail.ordersTab.empty')}</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-bambu-dark-tertiary">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-bambu-dark-tertiary">
                    <th className={HEAD}>{t('products.detail.ordersTab.order')}</th>
                    <th className={HEAD}>{t('products.detail.ordersTab.configuration')}</th>
                    <th className={HEAD}>{t('products.detail.ordersTab.state')}</th>
                    <th className={HEAD}>{t('products.detail.ordersTab.covered')}</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => (
                    <tr key={o.id} data-testid={`product-order-${o.id}`} className="border-b border-bambu-dark-tertiary align-top last:border-0">
                      <td className="min-w-[12rem] px-3 py-2.5">
                        <SectionLink to={`/projects/${o.id}`} className="font-medium text-bambu-green hover:underline wrap-anywhere">
                          {`${o.code} · ${o.name}`}
                        </SectionLink>
                        <small className="block text-xs text-bambu-gray">{o.customer_name ?? t('orders.list.noCustomer')}</small>
                      </td>
                      <td className="px-3 py-2.5">
                        <ProductLines order={o} />
                      </td>
                      <td className="px-3 py-2.5">
                        <StageBadge stage={o.stage} status={o.status} />
                      </td>
                      <td className="min-w-[10rem] px-3 py-2.5">
                        <OrderCoverage order={o} variant="table" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {meta && (
              <PaginationBar
                page={meta.current_page}
                totalPages={meta.last_page}
                perPage={PER_PAGE}
                total={meta.total}
                onPageChange={setPage}
                onPerPageChange={() => {}}
                perPageOptions={[PER_PAGE]}
                allowAll={false}
                items={t('products.detail.ordersTab.orders', { count: meta.total })}
                variant="bare"
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {body}
      {/* ⚠️ Units DELIVERED against orders — every order status, capped at each line's need.
          Not "units ever printed": a print nobody ordered is not in it. */}
      <p className="text-xs text-bambu-gray">
        {t('products.detail.ordersTab.unitsPrinted')}{' '}
        <b className="font-semibold text-white" data-testid="product-units-printed-total">
          {product.units_printed_total}
        </b>{' '}
        {t('products.detail.ordersTab.unitsSuffix')}
      </p>
    </div>
  );
}
