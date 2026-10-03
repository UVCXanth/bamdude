import { useState } from 'react';
import { Package } from 'lucide-react';
import { api } from '../../../api/client';
import type { ProductListItem } from '../../../api/client';
import { mediaRetryStarted } from '../../../hooks/useCameraStreamToken';

const BOX = {
  table: 'h-10 w-10 flex-shrink-0 rounded-lg',
  card: 'h-[120px] w-full rounded-lg',
  // The product page's visual field (WS-13 E9 B06): the top of its panel, edge to edge.
  visual: 'h-[200px] w-full',
} as const;

type Variant = keyof typeof BOX;

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
function Cover({ src, variant, caption }: { src: string; variant: Variant; caption?: string }) {
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
        className={`${BOX[variant]} object-contain bg-bambu-dark`}
      />
      {failed && <Placeholder variant={variant} caption={caption} />}
    </>
  );
}

function Placeholder({ variant, caption }: { variant: Variant; caption?: string }) {
  if (variant === 'visual') {
    return (
      <div
        data-testid="product-cover-placeholder"
        className={`${BOX.visual} bg-bambu-dark-tertiary/60 flex flex-col items-center justify-center gap-4 text-bambu-gray`}
      >
        <Package className="h-16 w-16" aria-hidden="true" />
        {caption && <span className="text-xs">{caption}</span>}
      </div>
    );
  }
  return (
    <div
      data-testid="product-cover-placeholder"
      className={`${BOX[variant]} bg-bambu-dark-tertiary/60 flex items-center justify-center`}
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
  caption,
  coverVersion,
}: {
  product: Pick<ProductListItem, 'id' | 'has_cover'>;
  variant: Variant;
  /** Under the placeholder's icon — the visual field's «{code} · {version}» only. */
  caption?: string;
  /** The product page's cover version (`getProductCoverImageUrl`): a new cover is a new
   *  address there, so it shows at once. The catalog passes none. */
  coverVersion?: string;
}) {
  if (!product.has_cover) return <Placeholder variant={variant} caption={caption} />;
  const src = api.getProductCoverImageUrl(product.id, coverVersion);
  return <Cover key={src} src={src} variant={variant} caption={caption} />;
}
