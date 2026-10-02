import { useTranslation } from 'react-i18next';
import { BookPlus, ClipboardPlus, Copy, Download, Eye, EyeOff, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { CardActionMenu, CardActionMenuItem } from '../CardActionMenu';
import type { ProductAction, ProductActionsHost, ProductRef } from './productActions/useProductActions';

const ICON: Record<ProductAction, ReactNode> = {
  edit: <Pencil className="w-4 h-4" />,
  toOrder: <ClipboardPlus className="w-4 h-4" />,
  duplicate: <Copy className="w-4 h-4" />,
  export: <Download className="w-4 h-4" />,
  hide: <EyeOff className="w-4 h-4" />,
  show: <Eye className="w-4 h-4" />,
  promote: <BookPlus className="w-4 h-4" />,
  delete: <Trash2 className="w-4 h-4" />,
};

/** The actions that are one request with no dialog — while one runs, none of them is sent. */
const REQUESTS: ReadonlySet<ProductAction> = new Set(['duplicate', 'export', 'hide', 'show']);

/** The product page's own «Re-read…» goes before these (the mockup's order, WS-13 E9 B02). */
const AFTER_REREAD: ReadonlySet<ProductAction> = new Set(['hide', 'show', 'promote', 'delete']);

/**
 * The one menu of a catalog product (WS-13 E8 F02) — the card and the table row both
 * render THIS, and every item is the page's action host (`useProductActions`): which
 * items a product offers to this user, what each does, and that a request still running
 * makes its item say so and send nothing more.
 *
 * The product page (WS-13 E9 B02) shows «Edit» and «Add to order» as buttons, so its menu
 * leaves them out (`exclude`), and adds its own «Re-read the card from a file…» (`reread`,
 * given only to somebody who may change the product) after «Export ZIP».
 */
export function ProductActionMenu<P extends ProductRef>({
  product,
  actions,
  testId = 'product-menu',
  exclude = [],
  reread,
}: {
  product: P;
  actions: ProductActionsHost<P>;
  testId?: string;
  exclude?: readonly ProductAction[];
  reread?: () => void;
}) {
  const { t } = useTranslation();
  const pending = actions.pending(product);
  const label = (action: ProductAction) => {
    if (action === 'duplicate' && pending === 'duplicate') return t('products.actions.duplicating');
    return t(`products.card.menu.${action}`);
  };

  const items = actions.available(product).filter((action) => !exclude.includes(action));
  // Before the first of hide / show / promote / delete — or last, when none of them is offered.
  const firstAfter = items.findIndex((action) => AFTER_REREAD.has(action));
  const rereadAt = reread ? (firstAfter === -1 ? items.length : firstAfter) : -1;

  return (
    // The page's menu carries «Re-read the card from a file…», longer than the catalog's 180 px:
    // a fixed width clipped it and squeezed its icon away (WS-13 E9 runner, 1440).
    <CardActionMenu label={t('common.actions')} testId={testId} width={reread ? 'max-content' : undefined}>
      {(close) => (
        <>
          {items.map((action, i) => [
            i === rereadAt && reread && (
              <CardActionMenuItem
                key="reread"
                onSelect={() => {
                  close();
                  reread();
                }}
              >
                <RefreshCw className="w-4 h-4" />
                {t('products.detail.menu.reread')}
              </CardActionMenuItem>
            ),
            <CardActionMenuItem
              key={action}
              danger={action === 'delete'}
              // A request of this product's still running: the request items wait (F03, F04).
              disabled={pending != null && REQUESTS.has(action)}
              onSelect={() => {
                close();
                actions.run(action, product);
              }}
            >
              {ICON[action]}
              {label(action)}
            </CardActionMenuItem>,
          ])}
          {rereadAt === items.length && reread && (
            <CardActionMenuItem
              key="reread"
              onSelect={() => {
                close();
                reread();
              }}
            >
              <RefreshCw className="w-4 h-4" />
              {t('products.detail.menu.reread')}
            </CardActionMenuItem>
          )}
        </>
      )}
    </CardActionMenu>
  );
}
