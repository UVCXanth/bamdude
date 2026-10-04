import { useId, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { Product } from '../../../api/client';
import { useSectionScrollMemory } from '../../../hooks/useSectionScrollMemory';
import { PRODUCT_SECTIONS, type ProductSection } from '../../../pages/products/productSections';
import { WorkshopTabPanel, WorkshopTabs } from '../../workshop/WorkshopTabs';
import { CompositionTab } from './CompositionTab';
import { DocumentsTab } from './DocumentsTab';
import { ProductOrdersTab } from './ProductOrdersTab';
import { PlatesFilesTab } from './PlatesFilesTab';
import { ProductStockTab } from './ProductStockTab';

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
      return product.orders_count ?? undefined; // masked without the orders' read (WS-13 E13 O12)
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
        return <ProductStockTab product={product} />;
      case 'docs':
        return <DocumentsTab product={product} headingRef={headingRef} />;
      case 'orders':
        return <ProductOrdersTab product={product} />;
    }
  }

  return (
    // At least a screen tall under the header (C03, measured in the browser): a first visit
    // mounts a skeleton, and a shorter document would clamp the page with the strip on screen —
    // then, as the data comes, the browser would put the old offset back, strip hidden again.
    // This tall, the strip can always come to rest under the header, and it is the top of the
    // screen while the tab fills in below it.
    <div data-testid="product-tabs" className="min-h-[calc(100dvh-var(--app-top,0px))]">
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
