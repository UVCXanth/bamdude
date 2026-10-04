import type { RefObject } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Pencil, Plus } from 'lucide-react';
import type { Product } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { Button } from '../../Button';
import { ProductActionMenu } from '../ProductActionMenu';
import type { ProductActionsHost } from '../productActions/useProductActions';
import { ProductBadges } from '../productRow/ProductBadges';
import { ProductIdentity } from '../productRow/ProductIdentity';

/** The page shows these two as buttons; the menu holds the rest (WS-13 E9 B02). */
const AS_BUTTONS = ['edit', 'toOrder'] as const;

/**
 * The product page's header (WS-13 E9 B01–B02) — the mockup's: breadcrumbs, the name with
 * the catalog's badges, the identity line (the code first — P11 / WS-03; the mockup has
 * the SKU alone), and on the right «+ Add to order», «Edit» and «⋮». Every whole-product
 * action runs through the page's host (E8 F01), so the rights, refusals and invalidations
 * are the catalog's. «Re-read the card from a file…» is the page's own item, for somebody
 * who may change the product; it opens the page's dialog (`onReread`).
 *
 * The facts, the catalog switch and the description live in the side panel and above the
 * tabs (B07–B10, C01), not here. On a narrow screen the buttons wrap under the title.
 */
export function ProductDetailHeader({
  product,
  actions,
  headingRef,
  onReread,
}: {
  product: Product;
  actions: ProductActionsHost<Product>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onReread: () => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const offered = actions.available(product);

  return (
    <header className="space-y-1">
      <nav aria-label={t('products.detail.breadcrumbLabel')} className="flex items-center gap-1 text-sm text-bambu-gray min-w-0">
        <Link to="/products" className="hover:text-white transition-colors flex-shrink-0">
          {t('products.header.breadcrumb')}
        </Link>
        <ChevronRight className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
        <span className="text-white truncate">{product.name}</span>
      </nav>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 space-y-1">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-semibold text-white outline-none wrap-anywhere"
          >
            {product.name} <ProductBadges product={product} />
          </h1>
          <ProductIdentity product={product} variant="table" />
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {offered.includes('toOrder') && (
            <Button variant="secondary" onClick={() => actions.run('toOrder', product)}>
              <Plus className="w-4 h-4" />
              {t('products.header.addToOrder')}
            </Button>
          )}
          {offered.includes('edit') && (
            <Button variant="secondary" onClick={() => actions.run('edit', product)}>
              <Pencil className="w-4 h-4" />
              {t('products.header.edit')}
            </Button>
          )}
          <ProductActionMenu
            product={product}
            actions={actions}
            testId="product-page-menu"
            exclude={AS_BUTTONS}
            reread={hasPermission('products:update') ? onReread : undefined}
          />
        </div>
      </div>
    </header>
  );
}
