import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import type { Product } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { ProductStatusBadge } from '../ProductStatusBadge';
import { ProductMaterials } from '../productRow/ProductMaterials';
import { ProductModels } from '../productRow/ProductModels';
import type { ProductActionsHost } from '../productActions/useProductActions';
import { WorkshopPanel } from '../../workshop/WorkshopPanel';
import { ProductEstimateFact } from './ProductEstimateFact';
import { ProductStockFact } from './ProductStockFact';
import { ProductVisual } from './ProductVisual';

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1 text-xs text-bambu-gray">{label}</dt>
      <dd className="min-w-0 text-sm text-white">{children}</dd>
    </div>
  );
}

/** A link only for a web address — `javascript:` and the like stay text. A bare
 *  `host/path` (the mockup's form) is a web address too. */
function sourceHref(raw: string): string | null {
  const value = raw.trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(value)) return `https://${value}`;
  return null;
}

/**
 * The product page's side panel (WS-13 E9 B06–B10): the visual field, then the facts in
 * the mockup's order — a label over each value — and «In the catalog».
 *
 * «In the catalog» (B10, R09) is the action host's `hide` / `show` for a catalog product,
 * held while its request runs. A one-off product is not the catalog's to list: the box
 * shows its real `is_active`, is always disabled, and says how to list it; promoted, the
 * box opens (K10) — and a hidden product stays hidden (E8-R04).
 */
export function ProductSidePanel({ product, actions }: { product: Product; actions: ProductActionsHost<Product> }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const hintId = useId();
  const catalog = product.origin === 'catalog';
  const toggle = actions.available(product).find((a) => a === 'hide' || a === 'show');
  const busy = actions.pending(product) != null;
  const href = product.source_url ? sourceHref(product.source_url) : null;
  const sourceText = product.source_url?.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');

  return (
    <WorkshopPanel flush data-testid="product-side" className="min-w-0">
      <ProductVisual product={product} canEdit={hasPermission('products:update')} />
      <dl aria-label={t('products.detail.facts.label')} className="grid gap-3.5 p-4">
        <Fact label={t('products.detail.facts.readiness')}>
          <ProductStatusBadge product={product} showReady />
        </Fact>
        <Fact label={t('products.detail.facts.slicedFor')}>
          <ProductModels product={product} />
        </Fact>
        <Fact label={t('products.detail.facts.materials')}>
          <ProductMaterials product={product} variant="table" />
        </Fact>
        <Fact label={t('products.detail.facts.estimate')}>
          <ProductEstimateFact productId={product.id} />
        </Fact>
        <Fact label={t('products.detail.facts.stock')}>
          <ProductStockFact product={product} />
        </Fact>
        {(product.designer || product.license) && (
          <Fact label={t('products.detail.facts.designer')}>
            {product.designer && <b className="font-medium">{product.designer}</b>}
            {product.designer && product.license && ' · '}
            {product.license}
          </Fact>
        )}
        {product.design_id && (
          <Fact label={t('products.detail.facts.designId')}>
            <span className="wrap-anywhere">{product.design_id}</span>
          </Fact>
        )}
        {product.source_url && (
          <Fact label={t('products.detail.facts.source')}>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="product-source"
                className="inline text-bambu-green hover:underline wrap-anywhere"
              >
                {sourceText}
                <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-2px]" aria-hidden="true" />
              </a>
            ) : (
              <span data-testid="product-source" className="wrap-anywhere">
                {product.source_url}
              </span>
            )}
          </Fact>
        )}
      </dl>
      <div className="px-4 pb-4">
        <label className="inline-flex items-center gap-2 text-sm text-bambu-gray-light cursor-pointer has-[:disabled]:cursor-default">
          <input
            type="checkbox"
            className="accent-bambu-green"
            checked={product.is_active}
            disabled={!catalog || !toggle || busy}
            aria-describedby={catalog ? undefined : hintId}
            onChange={() => toggle && actions.run(toggle, product)}
          />
          {t('products.detail.facts.inCatalog')}
        </label>
        {!catalog && (
          <p id={hintId} className="mt-1 text-xs text-bambu-gray">
            {t('products.detail.facts.adhocHint')}
          </p>
        )}
      </div>
    </WorkshopPanel>
  );
}
