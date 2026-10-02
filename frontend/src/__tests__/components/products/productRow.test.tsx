import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../../utils';
import type { ProductListItem } from '../../../api/client';
import { ProductBadges } from '../../../components/products/productRow/ProductBadges';
import { ProductIdentity } from '../../../components/products/productRow/ProductIdentity';
import { ProductComposition } from '../../../components/products/productRow/ProductComposition';
import { ProductModels } from '../../../components/products/productRow/ProductModels';
import { ProductMaterials } from '../../../components/products/productRow/ProductMaterials';
import { ProductStock } from '../../../components/products/productRow/ProductStock';
import { ProductThumb } from '../../../components/products/productRow/ProductThumb';
import { __resetColorCatalogForTests, setColorCatalog } from '../../../utils/colors';
import { setMediaToken } from '../../../api/client';

const product = (over: Partial<ProductListItem> = {}): ProductListItem =>
  ({
    id: 8, code: 'PR-0008', name: 'Gear', is_active: true, sku: 'EDU-08', version: 'v1.0',
    category: { id: 3, name: 'Models' }, status: 'ready', origin: 'catalog', origin_file_id: null,
    origin_plate_index: null, cover_image_filename: null, has_cover: false, parts_count: 3, plates_count: 2,
    lines_count: 0, kits_available: 4, finished_available: 6, materials: ['PLA'], colors: ['#1D1D1D'],
    models: ['A1 Mini', 'P1S'], sliced: true, printed_parts_count: 2, purchased_parts_count: 1,
    variant_group_names: [], variant_groups: [], active_orders_count: 0, finished_positions: 1, finished_below_min: 0,
    ...over,
  }) as ProductListItem;

// WS-13 E8 B: the parts a catalog row and a card are made of — each draws the row's
// fields and counts nothing of its own.
describe('product row parts', () => {
  beforeEach(() => setColorCatalog({ '1d1d1d': 'Charcoal' }));
  afterEach(() => __resetColorCatalogForTests());

  it('B01 badges: draft, incomplete, not in catalog, one-off', () => {
    const { unmount } = render(<ProductBadges product={product({ status: 'draft' })} />);
    expect(screen.getByText('Draft')).toBeInTheDocument();
    unmount();
    const r2 = render(<ProductBadges product={product({ parts_count: 0 })} />);
    expect(screen.getByText('Incomplete')).toBeInTheDocument();
    r2.unmount();
    const r3 = render(<ProductBadges product={product({ is_active: false })} />);
    expect(screen.getByText('not in catalog')).toBeInTheDocument();
    r3.unmount();
    render(<ProductBadges product={product({ origin: 'adhoc_plate', is_active: false })} />);
    expect(screen.getByText('one-off')).toBeInTheDocument();
    // «not in catalog» is the catalogue's own state; a one-off is not hidden from it.
    expect(screen.queryByText('not in catalog')).not.toBeInTheDocument();
  });

  it('B02 identity: the code first, then SKU, version and category — both shown', () => {
    const { unmount } = render(<ProductIdentity product={product()} variant="table" />);
    expect(screen.getByTestId('product-identity')).toHaveTextContent('PR-0008 · EDU-08 v1.0 · Models');
    unmount();
    const r2 = render(<ProductIdentity product={product({ sku: null, version: null, category: null })} variant="table" />);
    expect(screen.getByTestId('product-identity')).toHaveTextContent('PR-0008 · — · no category');
    r2.unmount();
    render(<ProductIdentity product={product()} variant="card" />);
    expect(screen.getByTestId('product-identity')).toHaveTextContent('PR-0008 · EDU-08 · v1.0');
    expect(screen.getByTestId('product-identity')).not.toHaveTextContent('Models');
  });

  it('B03 composition: printed and bought parts, plates, variants, active orders — only when there are any', () => {
    const { unmount } = render(
      <ProductComposition product={product({ variant_group_names: ['Size', 'Colour'], active_orders_count: 2 })} variant="table" />,
    );
    const cell = screen.getByTestId('product-composition');
    expect(cell).toHaveTextContent('2 parts + 1 bought · 2 plates');
    expect(cell).toHaveTextContent('variants: Size, Colour');
    expect(cell).toHaveTextContent('in 2 active orders');
    unmount();
    const r2 = render(<ProductComposition product={product({ purchased_parts_count: 0 })} variant="table" />);
    expect(screen.getByTestId('product-composition')).toHaveTextContent('2 parts · 2 plates');
    expect(screen.getByTestId('product-composition')).not.toHaveTextContent('bought');
    expect(screen.getByTestId('product-composition')).not.toHaveTextContent('variants');
    expect(screen.getByTestId('product-composition')).not.toHaveTextContent('active order');
    r2.unmount();
    render(<ProductComposition product={product({ variant_group_names: ['Size'], active_orders_count: 3 })} variant="card" />);
    expect(screen.getByTestId('product-composition')).toHaveTextContent('2 parts · 2 plates · variants: Size');
    expect(screen.getByTestId('product-composition')).not.toHaveTextContent('active order');
  });

  it('B04 models: chips, «not sliced» when nothing printable, a dash when sliced without a model', () => {
    const { unmount } = render(<ProductModels product={product()} />);
    expect(screen.getAllByTestId('product-model-chip').map((c) => c.textContent)).toEqual(['A1 Mini', 'P1S']);
    unmount();
    const r2 = render(<ProductModels product={product({ sliced: false, models: [] })} />);
    expect(screen.getByText('not sliced')).toBeInTheDocument();
    r2.unmount();
    render(<ProductModels product={product({ sliced: true, models: [] })} />);
    expect(screen.getByTestId('product-models')).toHaveTextContent('—');
  });

  it('B05 materials and colours: a hex is its own swatch, named by the colour catalog', () => {
    const { unmount } = render(<ProductMaterials product={product({ materials: ['PLA', 'PETG'] })} variant="table" />);
    const cell = screen.getByTestId('product-materials');
    expect(cell).toHaveTextContent('PLA, PETG');
    expect(cell).toHaveTextContent('Charcoal');
    expect((cell.querySelector('[data-swatch]') as HTMLElement).style.backgroundColor).toBe('rgb(29, 29, 29)');
    unmount();
    const r2 = render(<ProductMaterials product={product({ materials: [], colors: [] })} variant="table" />);
    expect(screen.getByTestId('product-materials')).toHaveTextContent('—');
    r2.unmount();
    render(<ProductMaterials product={product()} variant="card" />);
    const swatch = screen.getByTestId('product-materials').querySelector('[data-swatch]') as HTMLElement;
    expect(swatch).toHaveAttribute('title', 'Charcoal');
    expect(screen.getByTestId('product-materials')).not.toHaveTextContent('Charcoal');
  });

  it('B06 stock: finished in green, configurations only above one, below the minimum, kits', () => {
    const { unmount } = render(<ProductStock product={product()} />);
    const cell = screen.getByTestId('product-stock');
    expect(cell).toHaveTextContent('6 finished');
    expect(cell).not.toHaveTextContent('configs');
    expect(cell).not.toHaveTextContent('below minimum');
    expect(cell).toHaveTextContent('4 part kits');
    expect(cell.querySelector('b')?.className).toContain('text-bambu-green');
    unmount();
    render(<ProductStock product={product({ finished_available: 0, finished_positions: 3, finished_below_min: 2, kits_available: 1 })} />);
    const low = screen.getByTestId('product-stock');
    expect(low).toHaveTextContent('0 finished in 3 configs · below minimum');
    expect(low).toHaveTextContent('1 part kit');
    expect(low.querySelector('b')?.className).not.toContain('text-bambu-green');
    expect(screen.getByText('below minimum').className).toContain('text-amber-700');
  });

  it('B07 thumb: the cover when there is one, the placeholder otherwise and on a failed picture', () => {
    // A failure counts once the picture was asked WITH its token (M4 below).
    setMediaToken('media-fake');
    const { rerender } = render(<ProductThumb product={product({ has_cover: true })} variant="table" />);
    const img = screen.getByTestId('product-cover') as HTMLImageElement;
    expect(img.getAttribute('src')).toContain('/products/8/cover-image');
    fireEvent.error(img);
    expect(screen.getByTestId('product-cover-placeholder')).toBeInTheDocument();
    // The <img> stays (hidden) for the shared token recovery to retry into (E8-V01); a load takes
    // the placeholder away again.
    expect(img).toBeInTheDocument();
    expect(img).not.toBeVisible();
    fireEvent.load(img);
    expect(screen.queryByTestId('product-cover-placeholder')).not.toBeInTheDocument();
    expect(img).toBeVisible();
    // The failure belonged to that product's picture — another product's is tried afresh.
    rerender(<ProductThumb product={product({ id: 9, has_cover: true })} variant="table" />);
    expect(screen.getByTestId('product-cover')).toBeInTheDocument();
    rerender(<ProductThumb product={product({ id: 9, has_cover: false })} variant="card" />);
    expect(screen.getByTestId('product-cover-placeholder')).toBeInTheDocument();
  });
});

// Final review M4: the list can answer before the media token; the first request of a
// picture then has no token and fails — the retrofit stamps the token on the <img> that is
// still there. Only a picture that failed WITH its token is a failure.
describe('ProductThumb — the media token', () => {
  afterEach(() => setMediaToken(null));

  it('keeps the picture when it failed before the token arrived', () => {
    setMediaToken(null);
    render(<ProductThumb product={product({ has_cover: true })} variant="table" />);
    fireEvent.error(screen.getByTestId('product-cover'));
    expect(screen.getByTestId('product-cover')).toBeInTheDocument();
    expect(screen.queryByTestId('product-cover-placeholder')).not.toBeInTheDocument();
  });

  it('takes the placeholder when the picture failed with its token', () => {
    setMediaToken('media-fake');
    render(<ProductThumb product={product({ has_cover: true })} variant="table" />);
    fireEvent.error(screen.getByTestId('product-cover'));
    expect(screen.getByTestId('product-cover-placeholder')).toBeInTheDocument();
  });
});
