import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Product } from '../../../api/client';
import { Button } from '../../Button';
import { ProductGallery } from '../ProductGallery';
import { ProductThumb } from '../productRow/ProductThumb';
import { WorkshopDialog } from '../../workshop/WorkshopDialog';

/**
 * The visual field at the top of the side panel (WS-13 E9 B06, R07): the effective cover,
 * shown whole through the catalog's own picture (`ProductThumb`, its media-token recovery
 * included), or the mockup's placeholder — a package and «{code} · {version}».
 *
 * The pictures live in a dialog now, not in the page's body (K8): «Pictures…» under the
 * field — for every reader — and a click on the cover open the same outer dialog with the
 * existing gallery (managing it stays `projects:update`'s, the viewer is everyone's). The
 * gallery's viewer opens OVER that dialog: Escape closes only the topmost layer (the modal
 * stack), and each layer gives the focus back to what opened it.
 */
export function ProductVisual({ product, canEdit }: { product: Product; canEdit: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const caption = [product.code, product.version].filter(Boolean).join(' · ');
  return (
    <div data-testid="product-visual">
      {product.has_cover ? (
        <button
          type="button"
          aria-label={t('products.detail.visual.openCover')}
          onClick={() => setOpen(true)}
          className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bambu-green"
        >
          <ProductThumb product={product} variant="visual" caption={caption} />
        </button>
      ) : (
        <ProductThumb product={product} variant="visual" caption={caption} />
      )}
      <div className="px-4 pt-3">
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {t('products.detail.visual.open')}
        </Button>
      </div>
      {open && (
        <WorkshopDialog size="lg" title={t('products.gallery.title')} onClose={() => setOpen(false)}>
          <ProductGallery product={product} canEdit={canEdit} bare />
        </WorkshopDialog>
      )}
    </div>
  );
}
