import { useState } from 'react';
import { Package } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProductListItem } from '../../../api/client';

const BOX = {
  table: 'h-10 w-10 flex-shrink-0',
  card: 'h-[120px] w-full',
} as const;

/**
 * The picture itself — keyed by its address, so a failure belongs to that picture alone.
 * A request sent before the media token arrived fails for want of it, and the token's
 * retrofit stamps it on the `<img>` that is still there — so only a picture that failed
 * WITH its token is taken for a failed one (final review M4).
 */
function Cover({ src, variant }: { src: string; variant: 'table' | 'card' }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Placeholder variant={variant} />;
  return (
    <img
      data-testid="product-cover"
      src={src}
      alt=""
      onError={(e) => {
        if (new URL(e.currentTarget.src, window.location.href).searchParams.has('token')) setFailed(true);
      }}
      className={`${BOX[variant]} rounded-lg object-contain bg-bambu-dark`}
    />
  );
}

function Placeholder({ variant }: { variant: 'table' | 'card' }) {
  return (
    <div
      data-testid="product-cover-placeholder"
      className={`${BOX[variant]} rounded-lg bg-bambu-dark-tertiary/60 flex items-center justify-center`}
    >
      <Package className={variant === 'card' ? 'h-8 w-8 text-bambu-gray' : 'h-[18px] w-[18px] text-bambu-gray'} aria-hidden="true" />
    </div>
  );
}

/**
 * A product's picture in the catalog (WS-13 E8 B07): the effective cover
 * (`has_cover` — the explicit one or the first picture; never the column alone)
 * through the media token, shown whole; otherwise the placeholder of the same
 * size — and the placeholder too when the picture fails to load. The failure is
 * the picture's (keyed by its address, E5-V02), never carried to another product.
 */
export function ProductThumb({
  product,
  variant,
}: {
  product: Pick<ProductListItem, 'id' | 'has_cover'>;
  variant: 'table' | 'card';
}) {
  if (!product.has_cover) return <Placeholder variant={variant} />;
  const src = api.getProductCoverImageUrl(product.id);
  return <Cover key={src} src={src} variant={variant} />;
}
