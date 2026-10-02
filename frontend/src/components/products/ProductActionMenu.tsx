import { useTranslation } from 'react-i18next';
import { BookPlus, ClipboardPlus, Copy, Download, Eye, EyeOff, Pencil, Trash2 } from 'lucide-react';
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

/**
 * The one menu of a catalog product (WS-13 E8 F02) — the card and the table row both
 * render THIS, and every item is the page's action host (`useProductActions`): which
 * items a product offers to this user, what each does, and that a request still running
 * makes its item say so and send nothing more.
 */
export function ProductActionMenu<P extends ProductRef>({
  product,
  actions,
  testId = 'product-menu',
}: {
  product: P;
  actions: ProductActionsHost<P>;
  testId?: string;
}) {
  const { t } = useTranslation();
  const pending = actions.pending(product);
  const label = (action: ProductAction) => {
    if (action === 'duplicate' && pending === 'duplicate') return t('products.actions.duplicating');
    return t(`products.card.menu.${action}`);
  };

  return (
    <CardActionMenu label={t('common.actions')} testId={testId}>
      {(close) => (
        <>
          {actions.available(product).map((action) => (
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
            </CardActionMenuItem>
          ))}
        </>
      )}
    </CardActionMenu>
  );
}
