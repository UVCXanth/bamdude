import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import type { Product } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../../components/Button';
import { ProductGallery } from '../../components/products/ProductGallery';
import { ProductHeader } from '../../components/products/ProductHeader';
import { CompositionTable } from '../../components/products/CompositionTable';
import { ProductVariants } from '../../components/products/ProductVariants';
import { ProductStock } from '../../components/products/ProductStock';
import { PlatesByFile } from '../../components/products/PlatesByFile';
import { ProductAttachments } from '../../components/products/ProductAttachments';
import { LinkedFiles } from '../../components/products/LinkedFiles';
import { ProductOrders } from '../../components/products/ProductOrders';
import { ProductCardDialog } from '../../components/products/ProductCardDialog';
import { useProductActions } from '../../components/products/productActions/useProductActions';
import { useForgetOnUnmount } from '../../hooks/useForgetOnUnmount';
import { useProductDetail } from '../../hooks/useProductDetail';

/**
 * One product: what it is, what it is made of, what prints it, and who wants it.
 *
 * The page composes sections and owns nothing but dialog state and the three
 * whole-product actions. Everything below the header fetches its own slice, so
 * a slow plate walk never holds up the composition table.
 *
 * ⚠️ **A delete can be refused.** A product an order line uses answers 409, and
 * the operator is meant to take it out of the catalog instead — so the refusal
 * stays in the confirmation over an untouched page, never a navigation away from
 * a product that still exists.
 *
 * The whole-product actions are the shared host's (WS-13 E8 F01, `context: 'detail'`):
 * the header's buttons and the one-off banner run the catalog menu's own code.
 */
export function ProductPage() {
  const { t } = useTranslation();
  const { id: idParam } = useParams<{ id: string }>();
  const id = Number(idParam);
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const forgetProduct = useForgetOnUnmount(['product', id]);

  const [editing, setEditing] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useProductActions<Product>({
    context: 'detail',
    onEdit: () => setEditing(true),
    // ⚠️ The deleted product's entry goes when this page UNMOUNTS, not here: a
    // `removeQueries` now would run while the page is still mounted (React has only
    // scheduled the route change) and its own observer would refetch the product that
    // was just deleted. Armed here, dropped on unmount — see `useForgetOnUnmount`.
    // Without it a Back inside the 60 s `staleTime` renders the deleted product.
    onDeleted: () => {
      forgetProduct();
      navigate('/products');
    },
    fallbackFocusRef: heading,
  });

  // The shared hook owns this query's options — including the refresh toast.
  // A second `useQuery` on the same key anywhere (the card dialog that opens
  // over this page had one) takes them over: see `useProductDetail`.
  const { data: product, isLoading, isError, error } = useProductDetail(Number.isFinite(id) ? id : null);

  if (isLoading) {
    return (
      <div className="p-4 flex items-center gap-2 text-bambu-gray">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t('common.loading')}
      </div>
    );
  }
  // ⚠️ **Data presence is asked FIRST, and that order is load-bearing.**
  // TanStack v5 flips `status` to "error" on ANY failed fetch — a background
  // REFETCH of a query that still holds good data included — and it keeps
  // `data` while it does. This page invalidates `['product', id]` on every
  // mutation it and its sections make (the catalog toggle, part create / edit /
  // delete / merge, both alias calls, both unlinks), so a refetch is in flight
  // routinely; one that fails would, on an `isError`-first check, throw the
  // whole rendered page away and show a load error over a product still sitting
  // in the cache.
  //
  // With no data, the two cases still read apart: a fetch that FAILED is not a
  // product that is gone. "This product no longer exists" over an expired
  // session, a proxy hiccup or a 500 sends the operator hunting for a deletion
  // nobody performed, so the server's own sentence is shown instead.
  if (!product) {
    return isError ? (
      <div className="p-4 text-sm text-red-500">
        {t('products.page.loadFailed')} {(error as Error)?.message}
      </div>
    ) : (
      <div className="p-4 text-bambu-gray text-sm">{t('products.page.notFound')}</div>
    );
  }

  const canEdit = hasPermission('projects:update');

  // ⚠️ **A flex column with `gap`, not `space-y`** — because the gallery below
  // is moved by `order`, and `space-y-*` hangs its margins on DOM siblings,
  // which after a reorder are not the visual ones.
  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Top-down, per the parent spec: what the thing LOOKS like, then what it
          is, then what it is made of, then what prints it, then its papers,
          then its files, then who wants it.
          ⚠️ **The header comes FIRST in the document and the gallery is put
          above it with `order-first`.** The visual order is the spec's; the
          document order is the heading outline's, and the gallery's `<h2>`
          standing before the product's `<h1>` opened that outline at level 2.
          The alternative — a visually-hidden `<h1>` at the top with the visible
          title demoted — gives a screen reader two names for the same thing and
          leaves the one people can see outranked by one they cannot.
          ⚠️ **This is a trade, not a free win.** CSS `order` moves the PICTURE
          only: the DOM — and with it the tab order and the reading order of a
          screen reader — goes header, then gallery, so the first thing a
          keyboard reaches is the title and its buttons while the first thing an
          eye lands on is the picture above them. Outline correctness won
          because a document that opens at `<h2>` misreports the page's own
          name, which no visual ordering can repair. */}
      {/* A one-off product is added with its plate, from the order (spec
          workshop-add-to-order, rule 25) — «Add to order» is the catalog's, and the
          host offers it to a listed catalog product only (WS-13 E5 G01). */}
      <ProductHeader product={product} actions={actions} headingRef={heading} />

      {product.origin !== 'catalog' && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200" data-testid="product-adhoc-banner">
          <span>{t('products.page.adhocBanner')}</span>
          {/* R04: the same confirmation as the catalog menu's «Add to catalog…». */}
          {actions.available(product).includes('promote') && (
            <Button size="sm" variant="secondary" onClick={() => actions.run('promote', product)}>
              {t('products.page.promote')}
            </Button>
          )}
        </div>
      )}

      <div className="order-first">
        <ProductGallery product={product} canEdit={canEdit} />
      </div>

      <CompositionTable product={product} canEdit={canEdit} />
      <ProductVariants product={product} canEdit={canEdit} />

      {/* Directly under the composition, because it is the same list of parts
          seen from the shelf rather than from the design. Reading the shelf is
          `projects:read` and correcting it is `projects:update` (Decision 7) —
          no new permission: whoever may change an order's lines may change the
          stock those lines draw on. */}
      {hasPermission('projects:read') && <ProductStock productId={product.id} canEdit={canEdit} />}

      <PlatesByFile productId={product.id} />

      <ProductAttachments product={product} canEdit={canEdit} />

      <LinkedFiles product={product} canEdit={canEdit} />

      <div className="space-y-2">
        <ProductOrders productId={product.id} />
        {/* ⚠️ Units DELIVERED against orders — every order status, capped at
            each line's need. Not "units ever printed": a print nobody ordered
            is not in it, and neither is the eleventh of ten. */}
        <p className="text-sm text-bambu-gray">
          {t('products.card.unitsPrintedTotal')}:{' '}
          <span className="text-white" data-testid="product-units-printed-total">
            {product.units_printed_total}
          </span>
        </p>
      </div>

      {editing && <ProductCardDialog product={product} onClose={() => setEditing(false)} />}

      {actions.host}
    </div>
  );
}
