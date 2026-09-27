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
import { lineConfigLabel } from '../projects/lineConfigLabel';

export type FinishedAction = 'receipt' | 'stocktake' | 'assemble' | 'reserve' | 'release' | 'issue' | 'params' | 'open';

interface FinishedGoodsTableProps {
  items: StockItem[];
  /** The list's `sort_by`; the headers ask the SERVER to sort. */
  sort: string;
  onSortChange: (sortBy: string) => void;
  /** `projects:update`, read once by the page. */
  canEdit: boolean;
  onAction: (kind: FinishedAction, item: StockItem) => void;
  /** The page bar, drawn inside the same card under the rows. */
  footer?: ReactNode;
}

/**
 * One row per finished-goods position (spec workshop-finished-goods, rule 24).
 *
 * Every figure is the server's — `available`, `below_min` and `can_assemble`
 * are never recomputed here, and the rows are one page of many, so the headers
 * sort on the server. The configuration caption is the order line's
 * (`lineConfigLabel`): the same shape, the same words.
 */
export function FinishedGoodsTable({ items, sort, onSortChange, canEdit, onAction, footer }: FinishedGoodsTableProps) {
  const { t } = useTranslation();

  const menuItem = (kind: FinishedAction, item: StockItem, icon: ReactNode, label: string, close: () => void, disabled = false) => (
    <CardActionMenuItem
      key={kind}
      disabled={disabled}
      onSelect={() => {
        onAction(kind, item);
        close();
      }}
    >
      {icon}
      {label}
    </CardActionMenuItem>
  );

  return (
    <div className="rounded-xl border border-bambu-dark-tertiary bg-bambu-dark-secondary overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-bambu-gray text-left">
              <SortableHeader sortKey="product" label={t('stock.finished.product')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="code" label={t('stock.finished.code')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="location" label={t('stock.finished.location')} sort={sort} onSort={onSortChange} />
              <SortableHeader sortKey="on_hand" label={t('stock.finished.onHand')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="reserved" label={t('stock.finished.reserved')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <SortableHeader sortKey="available" label={t('stock.finished.available')} sort={sort} onSort={onSortChange} align="right" />
              <SortableHeader sortKey="min" label={t('stock.finished.minimum')} sort={sort} onSort={onSortChange} descFirst align="right" />
              <th className="font-normal p-2">{t('stock.finished.fromParts')}</th>
              <th className="p-2" aria-label={t('common.actions')} />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const caption = lineConfigLabel(item.configuration, 'product', t);
              return (
                <tr key={item.id} className="border-t border-bambu-dark-tertiary text-white" data-testid={`finished-row-${item.id}`}>
                  <td className="p-2">
                    <Link to={`/stock/${item.id}`} className="flex items-center gap-2 hover:underline">
                      {item.product.has_cover ? (
                        <img
                          src={api.getProductCoverImageUrl(item.product.id)}
                          alt=""
                          className="w-9 h-9 flex-shrink-0 rounded object-contain bg-bambu-dark"
                        />
                      ) : (
                        <span className="w-9 h-9 flex-shrink-0 rounded bg-bambu-dark flex items-center justify-center">
                          <Package className="w-4 h-4 text-bambu-gray" />
                        </span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate">{item.product.name}</span>
                        {item.product.sku && <span className="block text-xs text-bambu-gray">{item.product.sku}</span>}
                        {caption && <span className="block text-xs text-bambu-gray">{caption}</span>}
                      </span>
                    </Link>
                  </td>
                  <td className="p-2 text-bambu-gray whitespace-nowrap">{item.code}</td>
                  <td className="p-2">
                    {item.location ?? <span className="text-bambu-gray">{t('stock.finished.noLocation')}</span>}
                  </td>
                  <td className="p-2 text-right tabular-nums" data-testid={`finished-on-hand-${item.id}`}>{item.on_hand}</td>
                  <td className="p-2 text-right tabular-nums" data-testid={`finished-reserved-${item.id}`}>{item.reserved}</td>
                  <td
                    className={`p-2 text-right tabular-nums font-medium ${item.below_min ? 'text-status-warning' : ''}`}
                    data-testid={`finished-available-${item.id}`}
                  >
                    {item.available}
                  </td>
                  <td className="p-2 text-right tabular-nums">
                    {item.min_qty > 0 ? item.min_qty : <span className="text-bambu-gray">—</span>}
                    {item.below_min && (
                      <span className="block text-xs text-status-warning">
                        {t('stock.finished.shortBy', { n: item.min_qty - item.available })}
                      </span>
                    )}
                  </td>
                  <td className="p-2 text-bambu-gray whitespace-nowrap">
                    {item.can_assemble > 0 ? t('stock.finished.canAssemble', { n: item.can_assemble }) : '—'}
                  </td>
                  <td className="p-2 text-right">
                    <CardActionMenu label={t('common.actions')} testId={`finished-${item.id}-menu`} width={220}>
                      {(close) => (
                        <>
                          {canEdit && (
                            <>
                              {menuItem('receipt', item, <ArrowDownToLine className="w-4 h-4" />, t('stock.finished.action.receipt'), close)}
                              {menuItem('stocktake', item, <ClipboardCheck className="w-4 h-4" />, t('stock.finished.action.stocktake'), close)}
                              {item.can_assemble > 0 &&
                                menuItem('assemble', item, <Wrench className="w-4 h-4" />, t('stock.finished.action.assemble'), close)}
                              {menuItem('reserve', item, <Lock className="w-4 h-4" />, t('stock.finished.action.reserve'), close, item.available <= 0)}
                              {menuItem('release', item, <LockOpen className="w-4 h-4" />, t('stock.finished.action.release'), close, item.reserved <= 0)}
                              {menuItem('issue', item, <ArrowUpFromLine className="w-4 h-4" />, t('stock.finished.action.issue'), close, item.on_hand <= 0)}
                              {menuItem('params', item, <MapPin className="w-4 h-4" />, t('stock.finished.action.params'), close)}
                            </>
                          )}
                          {menuItem('open', item, <ExternalLink className="w-4 h-4" />, t('stock.finished.action.open'), close)}
                        </>
                      )}
                    </CardActionMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
