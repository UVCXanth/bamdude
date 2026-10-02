import { useState } from 'react';
import { Package } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProductListItem } from '../../../api/client';
import { mediaRetryStarted } from '../../../hooks/useCameraStreamToken';

const BOX = {
  table: 'h-10 w-10 flex-shrink-0',
  card: 'h-[120px] w-full',
} as const;

/**
 * The picture itself — keyed by its address, so a failure belongs to that picture alone.
 *
 * ⚠️ **The `<img>` never leaves the page** (E8-V01): the app's one media-token recovery
 * (`useStreamTokenSync`) retries INTO it — a stamp of the token on a picture asked without
 * it, a rewrite of every `<img>` when a refreshed token arrives. A failure shows the
 * placeholder over the hidden `<img>`, and a load — the retry's — takes it away. No failure
 * is counted that a retry already answers (`mediaRetryStarted`), nor one asked before the
 * token existed: the token's arrival retries it.
 */
function Cover({ src, variant }: { src: string; variant: 'table' | 'card' }) {
  const [failed, setFailed] = useState(false);
  return (
    <>
      <img
        data-testid="product-cover"
        src={src}
        alt=""
        hidden={failed}
        onLoad={() => setFailed(false)}
        onError={(e) => {
          const el = e.currentTarget;
          if (mediaRetryStarted(el)) return;
          if (!new URL(el.getAttribute('src') ?? '', window.location.href).searchParams.has('token')) return;
          setFailed(true);
        }}
        className={`${BOX[variant]} rounded-lg object-contain bg-bambu-dark`}
      />
      {failed && <Placeholder variant={variant} />}
    </>
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
