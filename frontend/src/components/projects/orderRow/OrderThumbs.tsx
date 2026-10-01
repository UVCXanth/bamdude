import { useTranslation } from 'react-i18next';
import { Package } from 'lucide-react';
import { api } from '../../../api/client';
import type { OrderListItem } from '../../../api/client';

const MAX_TILES = 3;

/**
 * The picture strip of an order (WS-13 E7 B06): the order's own cover first — the
 * operator chose it to recognise the order — then its products (`products`, the
 * distinct products in line order, OR3), three tiles in all; «+N» names the
 * products left out, N being the server list's length minus what is drawn. A
 * product without a cover keeps a tile: the strip's length is a fact about the
 * order. Decorative pictures; the «+N» tile has a name.
 */
export function OrderThumbs({
  order,
  size = 32,
}: {
  order: Pick<OrderListItem, 'id' | 'cover_image_filename' | 'products'>;
  size?: number;
}) {
  const { t } = useTranslation();
  const products = order.products ?? [];
  const hasCover = !!order.cover_image_filename;
  if (!hasCover && products.length === 0) return null;
  const productTiles = products.slice(0, MAX_TILES - (hasCover ? 1 : 0));
  const more = products.length - productTiles.length;
  const box = { width: size, height: size };
  const tile = 'flex-shrink-0 rounded-md bg-bambu-dark overflow-hidden';
  return (
    <span data-testid={`order-${order.id}-thumbs`} className="flex items-center gap-1">
      {hasCover && (
        <img data-thumb src={api.getProjectCoverImageUrl(order.id)} alt="" style={box} className={`${tile} object-cover`} />
      )}
      {productTiles.map((p, i) =>
        p.has_cover ? (
          <img
            key={`${p.product_id}-${i}`}
            data-thumb
            data-testid="product-cover"
            src={api.getProductCoverImageUrl(p.product_id)}
            alt=""
            style={box}
            className={`${tile} object-contain`}
          />
        ) : (
          <span
            key={`${p.product_id}-${i}`}
            data-thumb
            data-testid="product-cover-placeholder"
            style={box}
            className={`${tile} flex items-center justify-center`}
          >
            <Package className="w-4 h-4 text-bambu-gray" aria-hidden="true" />
          </span>
        ),
      )}
      {more > 0 && (
        <span
          role="img"
          aria-label={t('orders.row.moreProducts', { count: more })}
          style={box}
          className={`${tile} flex items-center justify-center text-xs font-medium text-bambu-gray tabular-nums`}
        >
          +{more}
        </span>
      )}
    </span>
  );
}
