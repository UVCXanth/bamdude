import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Ban, CheckCircle2, Copy, ExternalLink, Image as ImageIcon, PackageCheck, PackagePlus, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { Order, ProjectStatus } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { formatMoney } from '../../utils/currency';
import { formatDateOnly } from '../../utils/date';
import { isOverdue } from '../../utils/orderDates';
import { Button } from '../Button';
import { CardActionMenu, CardActionMenuItem } from '../CardActionMenu';
import { contactTitle } from '../customers/contactFormat';
import { OrderCoverThumb } from './OrderCover';
import { StatusBadge } from './StatusBadge';
import { PriorityBadge } from './PriorityBadge';
import { ResponsibleName } from './ResponsibleName';

interface OrderHeaderProps {
  order: Order;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSetStatus: (status: ProjectStatus) => void;
  /** «Bank the surplus» (pass 8, Decision 2). The page owns the call and the
   *  toast — it is the one that knows which products the order is for. */
  onBankSurplus: () => void;
  bankingSurplus: boolean;
  /** The cover dialog — the page owns it, like every other dialog of the order. */
  onCover: () => void;
  /** «Stock & issue…» — offered when the order has something to assemble, receive or
   *  issue (spec workshop-order-issue, rule 26); the primary action on the QC stage. */
  fulfilment?: { onOpen: () => void; primary: boolean };
  /** Drawn inside another page (the orders workspace): an h2 — the page has its own
   *  h1 — and «Open» to the full page as the first action. */
  embedded?: boolean;
  /** Where «Open» leads — the full page, on the section open here (WS-13 E3 F03). */
  openHref?: string;
}

/**
 * Who the order is for and what state it is in, in one compact block, and
 * every action on it (WS-13 E3 §C): a meta line (code · created), the title,
 * one row of facts in a fixed order, the description; on the right Edit, the
 * issue dialog and the bank button when they apply, the rest in one menu.
 *
 * ⚠️ **The lifecycle status is here, the stage is not** — the stage row under
 * the header says the stage; two badges would read as two different states.
 *
 * ⚠️ **The margin is the price over the cost WITH purchases**
 * (`margin_with_procurement`), the same cost the «Cost» tile shows. It is
 * rendered only beside a price, and null — one bought part has no price — is a
 * dash that says why, never a smaller number that looks known.
 *
 * ⚠️ **The bank button exists only while there is something to bank** (spec
 * D02 «conditional surplus action»). It gates on `bankable_surplus` — the
 * surplus MINUS what this order has already banked (Ruling 30) — never on the
 * surplus itself, a fact about the prints that banking never lowers.
 */
export function OrderHeader({
  order,
  onEdit,
  onDuplicate,
  onDelete,
  onSetStatus,
  onBankSurplus,
  bankingSurplus,
  onCover,
  fulfilment,
  embedded = false,
  openHref,
}: OrderHeaderProps) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  // The app-wide currency and date format, fetched the way every other screen
  // fetches them; the formatters cover the unresolved first paint.
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings, staleTime: 60_000 });

  const canUpdate = hasPermission('projects:update');
  const canCreate = hasPermission('projects:create');
  const canDelete = hasPermission('projects:delete');
  const active = order.status === 'active';
  const bankable = order.figures.bankable_surplus;
  const margin = order.figures.margin_with_procurement;
  const tags = order.tags ? order.tags.split(',').map((tag) => tag.trim()).filter(Boolean) : [];
  const overdue = isOverdue(order);
  const shortDate = (value: string) => formatDateOnly(value, { day: 'numeric', month: 'short' }, settings?.date_format);
  const Title = embedded ? 'h2' : 'h1';

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <OrderCoverThumb order={order} canEdit={canUpdate} onOpen={onCover} />
        <div className="min-w-0">
          <p data-testid="order-meta" className="text-xs text-bambu-gray">
            {order.code} · {t('orders.header.created', { date: shortDate(order.created_at) })}
          </p>
          <Title className="mt-0.5 mb-2 text-2xl leading-8 font-semibold text-white break-words">{order.name}</Title>

          <div data-testid="order-facts" className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-bambu-gray-light">
            {order.customer_id != null ? (
              <Link
                data-fact="customer"
                to={`/customers/${order.customer_id}`}
                className="font-medium text-white hover:underline"
              >
                {order.customer_name}
              </Link>
            ) : (
              <span data-fact="customer" className="text-bambu-gray">
                {t('orders.header.noCustomer')}
              </span>
            )}
            {order.contact && (
              <span data-fact="contact">
                {t('orders.header.contact', { name: contactTitle(order.contact) })}
                {order.contact.phone && (
                  <>
                    {' · '}
                    <a href={`tel:${order.contact.phone.replace(/[^\d+]/g, '')}`} className="hover:text-white">
                      {order.contact.phone}
                    </a>
                  </>
                )}
              </span>
            )}
            <span data-fact="status">
              <StatusBadge status={order.status} />
            </span>
            {order.priority !== 'normal' && (
              <span data-fact="priority">
                <PriorityBadge priority={order.priority} />
              </span>
            )}
            <span data-fact="due" data-overdue={overdue ? 'true' : undefined} className={overdue ? 'text-red-500' : ''}>
              {t('orders.header.due', { date: order.due_date ? shortDate(order.due_date) : '—' })}
              {overdue && ` · ${t('orders.header.overdue')}`}
            </span>
            <span data-fact="responsible" className="inline-flex items-center">
              <span className="sr-only">{t('orders.header.responsible')} </span>
              {order.responsible_name ? (
                <ResponsibleName name={order.responsible_name} />
              ) : (
                <span className="text-bambu-gray">{t('orders.header.noResponsible')}</span>
              )}
            </span>
            {order.price != null && (
              <span data-fact="price">
                {t('orders.header.price')}{' '}
                <span className="text-white tabular-nums">{formatMoney(order.price, settings?.currency)}</span>
                {' · '}
                {t('orders.header.marginShort')}{' '}
                {margin != null ? (
                  <b data-testid="order-margin" className={`font-semibold tabular-nums ${margin < 0 ? 'text-red-500' : 'text-bambu-green'}`}>
                    {formatMoney(margin, settings?.currency)}
                  </b>
                ) : (
                  <span data-testid="order-margin" title={t('orders.header.marginUnknown')}>
                    —<span className="sr-only"> ({t('orders.header.marginUnknown')})</span>
                  </span>
                )}
              </span>
            )}
            {order.url && (
              <a
                data-fact="url"
                href={order.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-bambu-green hover:underline"
              >
                <ExternalLink className="w-4 h-4" />
                {t('orders.header.url')}
              </a>
            )}
            {tags.length > 0 && (
              <span data-fact="tags" className="inline-flex flex-wrap gap-x-2 text-xs text-blue-700 dark:text-blue-400">
                {tags.map((tag) => (
                  <span key={tag}>#{tag}</span>
                ))}
              </span>
            )}
          </div>

          {/* The description was stored and edited but shown nowhere (spec workshop-lists, rule 17). */}
          {order.description?.trim() && (
            <p data-testid="order-description" className="mt-2.5 text-sm leading-5 text-bambu-gray-light whitespace-pre-line">
              {order.description}
            </p>
          )}
        </div>
      </div>

      <div data-testid="order-actions" className="flex flex-wrap items-center gap-2">
        {embedded && (
          <Link
            to={openHref ?? `/projects/${order.id}`}
            aria-label={t('orders.header.openFull', { code: order.code })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-tertiary px-3 py-1.5 text-sm font-medium text-white hover:bg-bambu-gray-dark"
          >
            <ExternalLink className="w-4 h-4" />
            {t('orders.header.open')}
          </Link>
        )}
        {canUpdate && (
          <Button variant="secondary" size="sm" onClick={onEdit}>
            <Pencil className="w-4 h-4" />
            {t('orders.header.edit')}
          </Button>
        )}
        {canUpdate && active && fulfilment && (
          <Button
            variant={fulfilment.primary ? 'primary' : 'secondary'}
            size="sm"
            data-testid="order-fulfilment"
            onClick={fulfilment.onOpen}
          >
            <PackageCheck className="w-4 h-4" />
            {t('orders.header.fulfil')}
          </Button>
        )}
        {canUpdate && bankable > 0 && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="order-bank-surplus"
            onClick={onBankSurplus}
            disabled={bankingSurplus}
            title={t('orders.header.bankHint')}
          >
            <PackagePlus className="w-4 h-4" />
            {t('stock.bank.actionCount', { count: bankable })}
          </Button>
        )}
        {(canUpdate || canCreate || canDelete) && (
          <CardActionMenu label={t('orders.header.menu', { code: order.code })} width="max-content" estimatedHeight={280}>
            {(close) => (
              <>
                {canUpdate && (
                  <CardActionMenuItem onSelect={() => { close(); onEdit(); }}>
                    <Pencil className="w-4 h-4" />
                    {t('orders.header.edit')}
                  </CardActionMenuItem>
                )}
                {canCreate && (
                  <CardActionMenuItem onSelect={() => { close(); onDuplicate(); }}>
                    <Copy className="w-4 h-4" />
                    {t('orders.header.duplicate')}
                  </CardActionMenuItem>
                )}
                {canUpdate && active && (
                  <>
                    <CardActionMenuItem onSelect={() => { close(); onSetStatus('completed'); }}>
                      <CheckCircle2 className="w-4 h-4" />
                      {t('orders.header.complete')}
                    </CardActionMenuItem>
                    <CardActionMenuItem onSelect={() => { close(); onSetStatus('cancelled'); }}>
                      <Ban className="w-4 h-4" />
                      {t('orders.header.cancel')}
                    </CardActionMenuItem>
                  </>
                )}
                {canUpdate && !active && (
                  <CardActionMenuItem onSelect={() => { close(); onSetStatus('active'); }}>
                    <RotateCcw className="w-4 h-4" />
                    {t('orders.header.reopen')}
                  </CardActionMenuItem>
                )}
                {canUpdate && (
                  <CardActionMenuItem onSelect={() => { close(); onCover(); }}>
                    <ImageIcon className="w-4 h-4" />
                    {t('orders.header.cover')}
                  </CardActionMenuItem>
                )}
                {canDelete && (
                  <>
                    {(canUpdate || canCreate) && <div role="separator" className="my-1 border-t border-bambu-dark-tertiary" />}
                    <CardActionMenuItem danger onSelect={() => { close(); onDelete(); }}>
                      <Trash2 className="w-4 h-4" />
                      {t('orders.header.delete')}
                    </CardActionMenuItem>
                  </>
                )}
              </>
            )}
          </CardActionMenu>
        )}
      </div>
    </header>
  );
}
