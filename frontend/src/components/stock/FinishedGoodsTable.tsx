import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCheck,
  ExternalLink,
  Lock,
  LockOpen,
  MapPin,
  Package,
  Wrench,
} from 'lucide-react';
import { api } from '../../api/client';
import type { StockItem } from '../../api/client';
import { CardActionMenu, CardActionMenuItem } from '../CardActionMenu';
import { SortableHeader } from '../SortableHeader';
import { WorkshopPanel, WorkshopTableScroll } from '../workshop/WorkshopPanel';
import { CONFIG_ACCENT_CLASS, lineConfigLabel } from '../projects/lineConfigLabel';

export type FinishedAction = 'receipt' | 'stocktake' | 'assemble' | 'reserve' | 'release' | 'issue' | 'params' | 'open';

interface FinishedGoodsTableProps {
  items: StockItem[];
  /** The list's `sort_by`; the headers ask the SERVER to sort. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  /** `projects:update`, read once by the page. */
  canEdit: boolean;
  onAction: (kind: FinishedAction, item: StockItem) => void;
  /** The page bar, drawn inside the same panel under the rows (outside the scroll). */
  footer?: ReactNode;
}

type Tone = 'low' | 'ok' | 'none';

const TONE_CLASS: Record<Tone, string> = {
  low: 'bg-status-warning/15 text-status-warning',
  ok: 'bg-bambu-green/15 text-bambu-green',
  none: 'bg-bambu-dark-tertiary text-bambu-gray',
};

/**
 * One row per finished-goods position (spec workshop-finished-goods, rule 24), in the
 * mockup's eight columns (WS-13 E12 C03): the product with its SKU, code and configuration,
 * the location chip, on hand, reserved, an «available» badge, the minimum with what is
 * missing in words, what the shelf can assemble, and the row's menu.
 *
 * Every figure is the server's — `available`, `below_min`, `short_by` and `can_assemble`
 * are never recomputed here, and the rows are one page of many, so the headers sort on the
 * server. The code has no header of its own (C04): the page names a `code` sort above the
 * table. The configuration caption is the order line's (`lineConfigLabel`, the same accent):
 * the same shape, the same words.
 */
export function FinishedGoodsTable({ items, sort, onSortChange, canEdit, onAction, footer }: FinishedGoodsTableProps) {
  const { t } = useTranslation();

  const menuItem = (
    kind: FinishedAction,
    item: StockItem,
    icon: ReactNode,
    close: () => void,
    disabledReason?: string,
  ) => (
    <CardActionMenuItem
      key={kind}
      disabled={disabledReason !== undefined}
      title={disabledReason}
      onSelect={() => {
        onAction(kind, item);
        close();
      }}
    >
      {icon}
      {t(`stock.finished.action.${kind}`)}
    </CardActionMenuItem>
  );

  return (
    <WorkshopPanel flush footer={footer}>
      <WorkshopTableScroll label={t('stock.tabs.finished')}>
        <table className="w-full text-sm">
          <thead className="text-xs text-bambu-gray bg-bambu-dark-secondary">
            <tr>
              <SortableHeader sortKey="product" label={t('stock.finished.product')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="location" label={t('stock.finished.location')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="on_hand" label={t('stock.finished.onHand')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="reserved" label={t('stock.finished.reserved')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="available" label={t('stock.finished.available')} sort={sort} onSort={onSortChange} align="right" />
              <SortableHeader sortKey="min" label={t('stock.finished.minimum')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <th className="font-normal p-2 text-left">{t('stock.finished.fromParts')}</th>
              <th className="p-2" aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const caption = lineConfigLabel(item.configuration, 'product', t);
              const tone: Tone = item.below_min ? 'low' : item.available > 0 ? 'ok' : 'none';
              return (
                <tr key={item.id} className="border-t border-bambu-dark-tertiary text-white" data-testid={`finished-row-${item.id}`}>
                  <td className="p-2">
                    <div className="flex items-center gap-2">
                      {item.product.has_cover ? (
                        <img
                          src={api.getProductCoverImageUrl(item.product.id)}
                          alt=""
                          className="w-10 h-10 flex-shrink-0 rounded object-contain bg-bambu-dark"
                        />
                      ) : (
                        <span className="w-10 h-10 flex-shrink-0 rounded bg-bambu-dark flex items-center justify-center" aria-hidden>
                          <Package className="w-4 h-4 text-bambu-gray" />
                        </span>
                      )}
                      <span className="min-w-0">
                        <Link to={`/stock/${item.id}`} className="block truncate hover:underline">
                          {item.product.name}
                        </Link>
                        <small className="block text-xs text-bambu-gray">
                          <span className="font-mono">{item.product.sku || '—'}</span>
                          {' · '}
                          <span className="whitespace-nowrap">{item.code}</span>
                          {caption && (
                            <>
                              {' · '}
                              <span data-config-accent className={CONFIG_ACCENT_CLASS}>
                                {caption}
                              </span>
                            </>
                          )}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td className="p-2">
                    {item.location ? (
                      <span
                        data-testid={`finished-location-${item.id}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-bambu-dark-tertiary text-xs text-white whitespace-nowrap"
                      >
                        <MapPin className="w-3 h-3 text-bambu-gray" aria-hidden />
                        {item.location}
                      </span>
                    ) : (
                      <small data-testid={`finished-location-${item.id}`} className="text-xs text-bambu-gray">
                        {t('stock.finished.noLocation')}
                      </small>
                    )}
                  </td>
                  <td className="p-2 text-right tabular-nums" data-testid={`finished-on-hand-${item.id}`}>
                    {item.on_hand}
                  </td>
                  <td className="p-2 text-right tabular-nums" data-testid={`finished-reserved-${item.id}`}>
                    {item.reserved}
                  </td>
                  <td className="p-2 text-right">
                    <span
                      data-testid={`finished-available-${item.id}`}
                      data-tone={tone}
                      className={`inline-block min-w-8 px-2 py-0.5 rounded-full text-xs font-medium text-center tabular-nums ${TONE_CLASS[tone]}`}
                    >
                      {item.available}
                    </span>
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {item.min_qty > 0 ? item.min_qty : <span className="text-bambu-gray">—</span>}
                    {item.below_min && (
                      <small className="block text-xs text-status-warning">
                        {t('stock.finished.shortBy', { n: item.short_by })}
                      </small>
                    )}
                  </td>
                  <td className="p-2 text-bambu-gray whitespace-nowrap">
                    {item.can_assemble > 0 ? (
                      <small className="text-xs">{t('stock.finished.fromPartsValue', { n: item.can_assemble })}</small>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2 text-right">
                    <CardActionMenu label={t('common.actions')} testId={`finished-${item.id}-menu`} width={220}>
                      {(close) => (
                        <>
                          {canEdit && (
                            <>
                              {menuItem('receipt', item, <ArrowDownToLine className="w-4 h-4" />, close)}
                              {item.can_assemble > 0 && menuItem('assemble', item, <Wrench className="w-4 h-4" />, close)}
                              {menuItem(
                                'reserve',
                                item,
                                <Lock className="w-4 h-4" />,
                                close,
                                item.available <= 0 ? t('stock.finished.disabled.reserve') : undefined,
                              )}
                              {menuItem(
                                'release',
                                item,
                                <LockOpen className="w-4 h-4" />,
                                close,
                                item.reserved <= 0 ? t('stock.finished.disabled.release') : undefined,
                              )}
                              {menuItem(
                                'issue',
                                item,
                                <ArrowUpFromLine className="w-4 h-4" />,
                                close,
                                item.on_hand <= 0 ? t('stock.finished.disabled.issue') : undefined,
                              )}
                              {menuItem('params', item, <MapPin className="w-4 h-4" />, close)}
                              {menuItem('stocktake', item, <ClipboardCheck className="w-4 h-4" />, close)}
                              <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />
                            </>
                          )}
                          {menuItem('open', item, <ExternalLink className="w-4 h-4" />, close)}
                        </>
                      )}
                    </CardActionMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </WorkshopTableScroll>
    </WorkshopPanel>
  );
}
