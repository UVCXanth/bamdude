import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../utils';
import type { ProductListItem } from '../../../api/client';
import { ProductsTable, TABLE_SORT_KEYS } from '../../../components/products/ProductsTable';
import { useProductActions } from '../../../components/products/productActions/useProductActions';
import { PRODUCT_ROW_DEFAULTS } from '../../wireDefaults';

const row: ProductListItem = {
  ...PRODUCT_ROW_DEFAULTS,
  id: 8,
  code: 'PR-0008',
  name: 'Gear',
  is_active: true,
  sku: 'EDU-08',
  version: 'v1.0',
  category: { id: 3, name: 'Models' },
  status: 'draft',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 3,
  plates_count: 2,
  lines_count: 0,
  kits_available: 4,
  finished_available: 6,
  materials: ['PLA'],
  colors: ['#1D1D1D'],
  models: ['P1S'],
  sliced: true,
  printed_parts_count: 2,
  purchased_parts_count: 1,
  finished_positions: 1,
  finished_below_min: 0,
  active_orders_count: 2,
};

function Table({ sort = 'name-asc', onSortChange = () => {} }: { sort?: string; onSortChange?: (s: string) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useProductActions<ProductListItem>({ context: 'catalog', onEdit: () => {}, fallbackFocusRef: heading });
  return <ProductsTable products={[row]} sort={sort} onSortChange={onSortChange} actions={actions} />;
}

// WS-13 E8 D: the mockup's table — six columns, three of them sorting, every cell a part of B.
describe('ProductsTable', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('D01 has exactly the mockup’s six columns, in its order', () => {
    render(<Table />);
    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(6);
    expect(headers.map((h) => h.textContent?.replace(/[▲▼]/g, '').trim())).toEqual([
      'Product / SKU',
      'Composition',
      'Printers',
      'Material / colour',
      'Stock',
      'Actions',
    ]);
    expect(headers[0].className).toContain('w-[36%]');
  });

  it('D01 draws each cell from the row parts', () => {
    render(<Table />);
    const cells = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
    expect(cells).toHaveLength(6);
    expect(within(cells[0]).getByRole('link', { name: 'Gear' })).toHaveAttribute('href', '/products/8');
    expect(within(cells[0]).getByText('Draft')).toBeInTheDocument();
    expect(within(cells[0]).getByTestId('product-identity')).toHaveTextContent('PR-0008 · EDU-08 v1.0 · Models');
    expect(within(cells[0]).getByTestId('product-cover-placeholder')).toBeInTheDocument();
    expect(within(cells[1]).getByTestId('product-composition')).toHaveTextContent('in 2 active orders');
    expect(within(cells[2]).getByTestId('product-models')).toHaveTextContent('P1S');
    expect(within(cells[3]).getByTestId('product-materials')).toHaveTextContent('PLA');
    expect(within(cells[4]).getByTestId('product-stock')).toHaveTextContent('6 finished');
    expect(within(cells[5]).getByTestId('product-8-row-menu')).toBeInTheDocument();
  });

  it('D02 three headers sort: the name A→Z first, the composition and the stock largest first', () => {
    const onSortChange = vi.fn();
    render(<Table onSortChange={onSortChange} />);
    expect(TABLE_SORT_KEYS).toEqual(['name', 'printed_parts', 'finished']);
    fireEvent.click(screen.getByRole('button', { name: /Composition/ }));
    expect(onSortChange).toHaveBeenLastCalledWith('printed_parts-desc');
    fireEvent.click(screen.getByRole('button', { name: /Stock/ }));
    expect(onSortChange).toHaveBeenLastCalledWith('finished-desc');
    fireEvent.click(screen.getByRole('button', { name: /Product \/ SKU/ }));
    expect(onSortChange).toHaveBeenLastCalledWith('name-desc');
    // «Printers» and «Material / colour» have nothing to sort by on the server (PC5).
    expect(screen.queryByRole('button', { name: /Printers/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Material/ })).not.toBeInTheDocument();
  });

  it('D04 scrolls inside its own named region, never the page', () => {
    render(<Table />);
    const region = screen.getByRole('region', { name: 'Product catalog' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region.querySelector('table')).toBeTruthy();
  });
});
