import { Link } from 'react-router';
import type { ProductListItem } from '../../api/client';
import { ProductActionMenu } from './ProductActionMenu';
import type { ProductActionsHost } from './productActions/useProductActions';
import { ProductBadges } from './productRow/ProductBadges';
import { ProductComposition } from './productRow/ProductComposition';
import { ProductIdentity } from './productRow/ProductIdentity';
import { ProductMaterials } from './productRow/ProductMaterials';
import { ProductModels } from './productRow/ProductModels';
import { ProductStock } from './productRow/ProductStock';
import { ProductThumb } from './productRow/ProductThumb';

interface ProductCardProps {
  product: ProductListItem;
  /** The page's action host (WS-13 E8 F01) — the menu's items and what they do. */
  actions: ProductActionsHost<ProductListItem>;
}

/**
 * One product in the grid — the mockup's vertical card (WS-13 E8 E01): the picture as
 * a 120 px field across the card, the identity line with the menu, the name and its
 * badges, the composition, the printer models with the colour swatches, and the stock in
 * a footer under a rule. The card is a flex column with the footer pushed down, so the
 * footers of one row line up. Every part is `productRow/`'s and draws the row's own
 * fields; the active orders and the kits pill are not here — the table carries the one,
 * the footer the other (E03).
 *
 * ⚠️ **The tile reads `has_cover`, never `cover_image_filename`** (`ProductThumb`): the
 * effective cover — the explicit column OR the first picture.
 *
 * ⚠️ **The link is an OVERLAY, not the card's wrapper** — same trap and same fix as
 * `OrderCard`: the menu was a `<button>` inside an `<a>` and every item had to undo the
 * navigation its own click caused. The menu, the badges (the «Incomplete» reason) and the
 * swatches' tooltips sit above it (`relative z-10`).
 */
export function ProductCard({ product, actions }: ProductCardProps) {
  return (
    <div
      data-testid={`product-${product.id}-card`}
      className="relative flex h-full flex-col rounded-xl bg-bambu-dark-secondary border border-bambu-dark-tertiary hover:border-bambu-green/50 overflow-hidden"
    >
      <div className="flex flex-1 flex-col p-4">
        <div className="mb-3">
          <ProductThumb product={product} variant="card" />
        </div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <ProductIdentity product={product} variant="card" />
          </div>
          {/* Above the overlay link, so the trigger is clickable at all. */}
          <div className="relative z-10 flex-shrink-0">
            <ProductActionMenu product={product} actions={actions} />
          </div>
        </div>
        <h3 className="mt-1 text-base font-semibold text-white">
          <span data-testid="product-name" className="wrap-anywhere">
            {product.name}
          </span>{' '}
          {/* Above the overlay link: «Incomplete» carries its reason in a title (E02). */}
          <span className="relative z-10">
            <ProductBadges product={product} />
          </span>
        </h3>
        <div className="mt-1">
          <ProductComposition product={product} variant="card" />
        </div>
        <div className="mt-2 mb-3 flex flex-wrap items-center gap-1.5">
          <ProductModels product={product} />
          <ProductMaterials product={product} variant="card" />
        </div>
        <div data-part="footer" className="mt-auto border-t border-bambu-dark-tertiary pt-2.5">
          <ProductStock product={product} />
        </div>
      </div>

      <Link
        to={`/products/${product.id}`}
        aria-label={product.name}
        className="absolute inset-0 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-bambu-green"
      />
    </div>
  );
}
