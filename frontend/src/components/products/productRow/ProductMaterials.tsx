import type { ProductListItem } from '../../../api/client';
import { getColorName, hexForColorName } from '../../../utils/colors';

/** A facet colour is a hex (E1: `product_composition.plate_colors`); anything else is named as it is. */
function colourOf(value: string): { swatch: string | null; name: string } {
  const swatch = hexForColorName(value);
  const isHex = /^#?[0-9a-f]{6}$/i.test(value.trim());
  return { swatch, name: isHex && swatch ? getColorName(swatch) : value };
}

/**
 * The product's materials and colours (WS-13 E8 B05), read from its plates (the
 * stored facets). The table names each colour beside its swatch — names from the
 * colour catalog, like the filter; the card keeps the swatches and puts the name
 * in a tooltip (the card lifts it above its overlay link).
 */
export function ProductMaterials({
  product,
  variant,
}: {
  product: Pick<ProductListItem, 'materials' | 'colors'>;
  variant: 'table' | 'card';
}) {
  const colours = product.colors.map(colourOf);
  if (variant === 'card') {
    return (
      <span data-testid="product-materials" className="inline-flex flex-wrap items-center gap-1">
        {colours.map(({ swatch, name }) =>
          swatch ? (
            <span
              key={name + swatch}
              data-swatch
              title={name}
              className="relative z-10 inline-block h-2.5 w-2.5 rounded-full border border-bambu-gray/60"
              style={{ backgroundColor: swatch }}
            />
          ) : null,
        )}
      </span>
    );
  }
  return (
    <div data-testid="product-materials">
      <span className="text-white">{product.materials.join(', ') || '—'}</span>
      {colours.length > 0 && (
        <small className="flex flex-wrap items-center gap-x-2 text-xs text-bambu-gray">
          {colours.map(({ swatch, name }) => (
            <span key={name + (swatch ?? '')} className="inline-flex items-center gap-1">
              {swatch && (
                <span
                  data-swatch
                  aria-hidden="true"
                  className="inline-block h-2.5 w-2.5 rounded-full border border-bambu-gray/60"
                  style={{ backgroundColor: swatch }}
                />
              )}
              {name}
            </span>
          ))}
        </small>
      )}
    </div>
  );
}
