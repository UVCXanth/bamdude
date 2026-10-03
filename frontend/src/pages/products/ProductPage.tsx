import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import type { Product } from '../../api/client';
import { Button } from '../../components/Button';
import { ProductCardDialog } from '../../components/products/ProductCardDialog';
import { ProductDetailHeader } from '../../components/products/detail/ProductDetailHeader';
import { ProductPageSkeleton } from '../../components/products/detail/ProductPageSkeleton';
import { ProductRereadDialog } from '../../components/products/detail/ProductRereadDialog';
import { ProductSidePanel } from '../../components/products/detail/ProductSidePanel';
import { ProductTabs } from '../../components/products/detail/ProductTabs';
import { useProductActions } from '../../components/products/productActions/useProductActions';
import { LoadFailedNote } from '../../components/workshop/LoadFailedNote';
import { WorkshopPanel } from '../../components/workshop/WorkshopPanel';
import { useForgetOnUnmount } from '../../hooks/useForgetOnUnmount';
import { useProductDetail } from '../../hooks/useProductDetail';
import { parseProductSection, sectionParam, type ProductSection } from './productSections';
import { DETAIL_COLUMNS } from '../../components/workshop/detailLayout';

/**
 * The mockup's two columns (WS-13 E9 B05) — shared with the customer's page (E11 E02):
 * ≤ 760 one column with the side panel ABOVE the tabs (K2 — the mockup hides it there).
 */
const PRODUCT_LAYOUT = DETAIL_COLUMNS;

/**
 * One product (WS-13 E9): the header, the side panel of what it is, and the tabs of what
 * it is made of, prints from, holds, carries and was ordered in.
 *
 * Keyed by the product's id (the route), so another product starts from nothing — its
 * tabs, their places, drafts and dialogs (C03). The whole-product actions are the shared
 * host's (E8 F01, `context: 'detail'`).
 *
 * ⚠️ **A delete can be refused.** A product an order line uses answers 409, and the
 * operator is meant to take it out of the catalog instead — so the refusal stays in the
 * confirmation over an untouched page, never a navigation away from a product that still
 * exists.
 */
function ProductView({
  id,
  section,
  onSection,
}: {
  id: number;
  section: ProductSection;
  onSection: (section: ProductSection) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const forgetProduct = useForgetOnUnmount(['product', id]);
  const [editing, setEditing] = useState(false);
  const [rereading, setRereading] = useState(false);
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
  const detail = useProductDetail(Number.isFinite(id) ? id : null);
  const product = detail.data;

  // ⚠️ **Data presence is asked FIRST, and that order is load-bearing.** TanStack v5
  // flips `status` to "error" on ANY failed fetch — a background REFETCH of a query that
  // still holds good data included — and keeps `data` while it does. This page
  // invalidates `['product', id]` on every mutation it and its tabs make, so a refetch is
  // in flight routinely; one that fails keeps the page (and the refresh toast says so).
  //
  // With no data, the cases still read apart: a fetch that FAILED is not a product that
  // is gone. Only the server's 404 is «not found»; an expired session, a proxy hiccup or
  // a 500 shows its own sentence and a retry.
  if (!product) {
    if (detail.isLoading) return <ProductPageSkeleton layoutClass={PRODUCT_LAYOUT} />;
    const missing = !detail.isError || (detail.error instanceof ApiError && detail.error.status === 404);
    if (missing) {
      return (
        <div data-testid="product-not-found" className="space-y-2 py-8 text-center">
          <p className="text-white">{t('products.page.notFound')}</p>
          <Link to="/products" className="text-sm text-bambu-green hover:underline">
            {t('products.page.toCatalog')}
          </Link>
        </div>
      );
    }
    return (
      <LoadFailedNote
        message={`${t('products.page.loadFailed')} ${(detail.error as Error).message}`}
        onRetry={() => detail.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ProductDetailHeader product={product} actions={actions} headingRef={heading} onReread={() => setRereading(true)} />

      {product.origin !== 'catalog' && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200"
          data-testid="product-adhoc-banner"
        >
          <span>{t('products.page.adhocBanner')}</span>
          {/* R04: the same confirmation as the catalog menu's «Add to catalog…». */}
          {actions.available(product).includes('promote') && (
            <Button size="sm" variant="secondary" onClick={() => actions.run('promote', product)}>
              {t('products.page.promote')}
            </Button>
          )}
        </div>
      )}

      <div data-testid="product-layout" className={PRODUCT_LAYOUT}>
        <ProductSidePanel product={product} actions={actions} />
        <WorkshopPanel data-testid="product-main" className="min-w-0">
          {(product.description || product.notes) && (
            <div className="mb-4 space-y-2">
              {product.description && (
                <p data-testid="product-description" className="whitespace-pre-wrap text-sm leading-5 text-bambu-gray-light">
                  {product.description}
                </p>
              )}
              {product.notes && (
                <p data-testid="product-notes" className="whitespace-pre-wrap text-sm leading-5 text-bambu-gray">
                  {product.notes}
                </p>
              )}
            </div>
          )}
          <ProductTabs
            product={product}
            section={section}
            onSection={onSection}
            headingRef={heading}
            onReread={() => setRereading(true)}
          />
        </WorkshopPanel>
      </div>

      {editing && <ProductCardDialog product={product} onClose={() => setEditing(false)} />}
      {rereading && <ProductRereadDialog product={product} onClose={() => setRereading(false)} />}
      {actions.host}
    </div>
  );
}

/**
 * The route `/products/:id`. The open tab lives in `?tab=` (C03): a change replaces the
 * entry (Back leaves the product, Forward comes back to the same tab), the composition is
 * never written, and an unknown value reads as the composition without being rewritten.
 * Another product without `tab` opens on the composition.
 */
export function ProductPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  // `workshop` — the section's text scope (WS-13 E2 B02), as the order page.
  return (
    <div className="workshop p-4">
      <ProductView
        key={idParam}
        id={Number(idParam)}
        section={parseProductSection(params.get('tab'))}
        onSection={(next) =>
          setParams(
            (prev) => {
              const out = new URLSearchParams(prev);
              if (sectionParam(next)) out.set('tab', next);
              else out.delete('tab');
              return out;
            },
            { replace: true },
          )
        }
      />
    </div>
  );
}
