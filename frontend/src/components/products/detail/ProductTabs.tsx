import { useId, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Product } from '../../../api/client';
import { useAuth } from '../../../contexts/AuthContext';
import { useSectionScrollMemory } from '../../../hooks/useSectionScrollMemory';
import { PRODUCT_SECTIONS, type ProductSection } from '../../../pages/products/productSections';
import { ProductAttachments } from '../ProductAttachments';
import { ProductOrders } from '../ProductOrders';
import { ProductStock } from '../ProductStock';
import { WorkshopTabPanel, WorkshopTabs } from '../../workshop/WorkshopTabs';
import { CompositionTab } from './CompositionTab';
import { PlatesFilesTab } from './PlatesFilesTab';

/** The server's count of each tab (C02) — «Stock» has none. */
function countOf(product: Product, section: ProductSection): number | undefined {
  switch (section) {
    case 'composition':
      return product.parts_count;
    case 'plates':
      return product.plates_count;
    case 'docs':
      return product.documents_count;
    case 'orders':
      return product.orders_count;
    case 'stock':
      return undefined;
  }
}

/**
 * The product page's five tabs (WS-13 E9 C02–C05).
 *
 * The open tab is the owner's (its URL, C03); this strip only reports a change. A tab is
 * mounted on its first visit and KEPT, hidden, until the product changes (the page keys
 * this by id): coming back starts no new reader and remounts nothing, and an invalidation
 * re-reads a hidden visited tab too, because its queries stay observed. Each tab reads its
 * own slice and fails alone (C05). The document keeps one place per tab
 * (`useSectionScrollMemory`).
 */
export function ProductTabs({
  product,
  section,
  onSection,
  headingRef,
  onReread,
}: {
  product: Product;
  section: ProductSection;
  onSection: (section: ProductSection) => void;
  /** The page's h1 — where the focus goes when the row that held it leaves (B11). */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** Opens the page's «Re-read the card from a file…» dialog (B03 / E01). */
  onReread: () => void;
}) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('projects:update');
  const idBase = useId();
  const strip = useRef<HTMLDivElement>(null);
  const [visited, setVisited] = useState<ReadonlySet<ProductSection>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));
  useSectionScrollMemory(section, strip);

  function body(value: ProductSection) {
    switch (value) {
      case 'composition':
        return <CompositionTab product={product} headingRef={headingRef} />;
      case 'plates':
        return <PlatesFilesTab product={product} headingRef={headingRef} onReread={onReread} />;
      case 'stock':
        return <ProductStock productId={product.id} canEdit={canEdit} />;
      case 'docs':
        return <ProductAttachments product={product} canEdit={canEdit} />;
      case 'orders':
        return (
          <div className="space-y-2">
            <ProductOrders productId={product.id} />
            {/* ⚠️ Units DELIVERED against orders — every order status, capped at each
                line's need. Not "units ever printed": a print nobody ordered is not in it. */}
            <p className="text-sm text-bambu-gray">
              {t('products.card.unitsPrintedTotal')}:{' '}
              <span className="text-white" data-testid="product-units-printed-total">
                {product.units_printed_total}
              </span>
            </p>
          </div>
        );
    }
  }

  return (
    <div>
      <div ref={strip}>
        <WorkshopTabs
          idBase={idBase}
          ariaLabel={t('products.detail.tabs.label')}
          value={section}
          items={PRODUCT_SECTIONS.map((value) => ({
            value,
            label: t(`products.detail.tabs.${value}`),
            count: countOf(product, value),
          }))}
          onChange={onSection}
          size="detail"
          panels="all"
        />
      </div>
      {PRODUCT_SECTIONS.map((value) => (
        <WorkshopTabPanel key={value} idBase={idBase} value={value} hidden={value !== section} className="pt-4">
          {visited.has(value) && body(value)}
        </WorkshopTabPanel>
      ))}
    </div>
  );
}
