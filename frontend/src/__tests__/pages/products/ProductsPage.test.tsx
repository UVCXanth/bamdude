/**
 * `render` from `__tests__/utils` wraps in a BrowserRouter with no route
 * option — route-aware tests set the URL with pushState first, the way
 * `OrdersPage.test.tsx` does.
 *
 * The page asks `getProductsPaged` (spec projects-lists-parity): the place in
 * the list — page, search, sort, the catalog toggle — lives in the URL; the
 * view mode and the page size are preferences in localStorage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { ProductListItem } from '../../../api/client';
import { ProductsPage } from '../../../pages/products/ProductsPage';

const rows = [
  { id: 1, name: 'Flask', is_active: true, cover_image_filename: null, has_cover: true, parts_count: 2, plates_count: 1, lines_count: 3, kits_available: 0 },
  { id: 2, name: 'Old lid', is_active: false, cover_image_filename: null, has_cover: false, parts_count: 1, plates_count: 1, lines_count: 0, kits_available: 0 },
];

const pageOf = (items: unknown[], meta: Partial<{ total: number; current_page: number; per_page: number; last_page: number }> = {}) => ({
  items: items as ProductListItem[],
  meta: { total: items.length, current_page: 1, per_page: 24, last_page: 1, ...meta },
  categories: [],
  uncategorized: 0,
  all_categories: items.length,
  catalog_total: items.length,
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('ProductsPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/products');
  });

  it('puts the view switch in the page header, beside the title', async () => {
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    const header = await screen.findByTestId('list-page-header');
    expect(within(header).getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(within(header).getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('draws no section tabs — the sidebar carries them', async () => {
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByTestId('list-page-header');
    expect(screen.queryByRole('navigation', { name: 'Projects' })).not.toBeInTheDocument();
  });

  it('falls back to the table when the stored view is not a mode, or when nothing was chosen (WS-13 E2 B05)', async () => {
    localStorage.setItem('bamdude-products-view', 'kanban');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    expect(await screen.findByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens as a table by name when nothing was chosen, and keeps a stored cards view (WS-13 E2 B05)', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    const { unmount } = render(<ProductsPage />);
    expect(await screen.findByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    // The catalog's order does not depend on the view.
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'name-asc' }));
    unmount();
    localStorage.setItem('bamdude-products-view', 'cards');
    render(<ProductsPage />);
    expect(await screen.findByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('asks for page 1 of 24 catalog products by name, and for everything when the toggle is off', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(get).toHaveBeenLastCalledWith({ active: true, sort_by: 'name-asc', page: 1, per_page: 24 });
    fireEvent.click(screen.getByLabelText(/in catalog/i));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toContain('catalog=0');
  });

  it('searches with the typed text, puts it in the URL and goes back to page 1', async () => {
    window.history.pushState({}, '', '/products?page=3');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows, { current_page: 3, last_page: 3, total: 60 }));
    render(<ProductsPage />);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })));
    fireEvent.change(await screen.findByRole('searchbox'), { target: { value: 'lid' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ active: true, q: 'lid', sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toContain('q=lid');
    expect(window.location.search).not.toContain('page=');
  });

  it('draws the pagination bar from meta and turns the page', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows, { total: 30, last_page: 2 }));
    render(<ProductsPage />);
    expect(await screen.findByText('Showing 1-24 of 30 products')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    expect(window.location.search).toContain('page=2');
  });

  it('switches to the table, remembers it, and sorts by a column on the server', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Table' }));
    expect(await screen.findByRole('columnheader', { name: /Product/ })).toBeInTheDocument();
    expect(localStorage.getItem('bamdude-products-view')).toBe('table');
    fireEvent.click(screen.getByRole('button', { name: /Parts/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'parts-desc', page: 1 })));
    expect(window.location.search).toContain('sort=parts-desc');
  });

  it('an empty search result offers to reset, and the reset clears it', async () => {
    window.history.pushState({}, '', '/products?q=zzz&catalog=0');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([]));
    render(<ProductsPage />);
    expect(await screen.findByText('Nothing matches your search or filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ active: true, sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('');
  });

  it('shows the card figures and says nothing about a product no order uses', async () => {
    localStorage.setItem('bamdude-products-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    // `has_cover` decides per card: the effective cover for one, the neutral tile for the other.
    expect(screen.getAllByTestId('product-cover')).toHaveLength(1);
    expect(screen.getAllByTestId('product-cover-placeholder')).toHaveLength(1);
    expect(screen.getByText(/in 3 orders/i)).toBeInTheDocument();
    // `lines_count: 0` must not leak a bare "in 0 orders" row.
    expect(screen.queryByText(/in 0 orders/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not in catalog/i)).toBeInTheDocument();
  });

  it('a 409 on delete becomes a toast, not a crash', async () => {
    localStorage.setItem('bamdude-products-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    vi.spyOn(api, 'deleteProduct').mockRejectedValue(new Error('Product is used by an order line'));
    render(<ProductsPage />);
    fireEvent.click((await screen.findAllByTestId('product-menu'))[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i })); // ConfirmModal
    expect(await screen.findByText(/used by an order line/i)).toBeInTheDocument();
    // The grid survives the failure.
    expect(screen.getByText('Flask')).toBeInTheDocument();
  });

  it('sorts from the toolbar too — every key the server knows, both ways', async () => {
    localStorage.setItem('bamdude-products-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'updated' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'updated-desc', page: 1 })));
    fireEvent.click(screen.getByRole('button', { name: 'Descending' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'updated-asc' })));
    expect(window.location.search).toContain('sort=updated-asc');
  });

  it('in the table, the page bar sits inside the table card', async () => {
    localStorage.setItem('bamdude-products-view', 'table');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows, { total: 30, last_page: 2 }));
    render(<ProductsPage />);
    const range = await screen.findByText('Showing 1-24 of 30 products');
    expect(range.closest('.rounded-xl')?.querySelector('table')).toBeTruthy();
  });

  it('marks the list busy while the next page is on its way', async () => {
    let release: () => void = () => {};
    vi.spyOn(api, 'getProductsPaged').mockImplementation((params) =>
      params.page === 2
        ? new Promise((r) => {
            release = () => r(pageOf(rows, { total: 30, last_page: 2, current_page: 2 }));
          })
        : Promise.resolve(pageOf(rows, { total: 30, last_page: 2 })),
    );
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'true'));
    release();
    await waitFor(() => expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'false'));
  });

  it('with the catalog toggle off and nothing at all, it says the catalog is empty — not «nothing matches»', async () => {
    window.history.pushState({}, '', '/products?catalog=0');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([]));
    render(<ProductsPage />);
    expect(await screen.findByText('No products yet')).toBeInTheDocument();
    expect(screen.queryByText('Nothing matches your search or filters.')).toBeNull();
  });
  it('Back to a later page is not clamped by the previous answer still on screen', async () => {
    window.history.pushState({}, '', '/products?q=lid');
    let release: () => void = () => {};
    const get = vi.spyOn(api, 'getProductsPaged').mockImplementation((params) =>
      params.page === 3
        ? new Promise((r) => {
            release = () => r(pageOf(rows, { total: 60, last_page: 3, current_page: 3 }));
          })
        : Promise.resolve(pageOf(rows)),
    );
    render(<ProductsPage />);
    await screen.findByText('Flask');
    // The browser's Back lands on page 3 of the unfiltered list; the answer on
    // screen (the search's, one page long) must not pull it back to page 1.
    window.history.pushState({}, '', '/products?page=3');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })));
    release();
    expect(await screen.findByText('Showing 49-60 of 60 products')).toBeInTheDocument();
    expect(window.location.search).toContain('page=3');
  });
});

describe('ProductsPage — the catalog (spec workshop-product-catalog)', () => {
  const envelope = (items: unknown[]) => ({
    ...pageOf(items),
    categories: [{ id: 3, name: 'Hooks', count: 2 }],
    uncategorized: 1,
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/products');
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: ['PETG'], colors: ['#FF0000'], models: ['P1S'] });
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([
      { id: 3, name: 'Hooks', products_count: 2 },
      { id: 4, name: 'Vases', products_count: 0 },
    ]);
  });

  it('lists the categories with the server counts and filters by one through the URL', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(envelope(rows));
    render(<ProductsPage />);
    const panel = await screen.findByRole('navigation', { name: 'Categories' });
    expect(within(panel).getByRole('button', { name: 'All products' })).toHaveAttribute('aria-pressed', 'true');
    expect(await within(panel).findByRole('button', { name: /^Uncategorized\s*1$/ })).toBeInTheDocument();
    // A category with nothing under the filters is still listed — with 0.
    expect(await within(panel).findByRole('button', { name: /^Vases\s*0$/ })).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: /^Hooks\s*2$/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ category: '3', page: 1 })));
    expect(window.location.search).toContain('category=3');
    fireEvent.click(within(panel).getByRole('button', { name: /^Uncategorized/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'none' })));
  });

  it('drops the category from the URL when that category is deleted', async () => {
    window.history.pushState({}, '', '/products?category=3');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(envelope(rows));
    vi.spyOn(api, 'deleteProductCategory').mockResolvedValue({ message: 'ok', uncategorized: 2 });
    render(<ProductsPage />);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ category: '3' })));
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Categories' })).getByRole('button', { name: 'Manage categories' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Hooks' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(window.location.search).not.toContain('category='));
  });

  it('sends each filter, keeps it in the URL and goes back to page 1', async () => {
    window.history.pushState({}, '', '/products?page=2');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(envelope(rows));
    render(<ProductsPage />);
    await screen.findByRole('option', { name: 'PETG' });
    fireEvent.change(screen.getByLabelText('Material'), { target: { value: 'PETG' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ material: 'PETG', page: 1 })));
    fireEvent.change(screen.getByLabelText('Printer model'), { target: { value: 'P1S' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'draft' } });
    fireEvent.click(screen.getByLabelText('In stock'));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        expect.objectContaining({ material: 'PETG', model: 'P1S', status: 'draft', in_stock: true }),
      ),
    );
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#FF0000' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ color: '#FF0000' })));
    for (const part of ['material=PETG', 'model=P1S', 'status=draft', 'stock=1']) {
      expect(window.location.search).toContain(part);
    }
    expect(window.location.search).not.toContain('page=');
  });

  it('shows SKU, version, category and the status in the table', async () => {
    localStorage.setItem('bamdude-products-view', 'table');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(
      envelope([
        { ...rows[0], sku: 'LMP-1', version: '2', category: { id: 3, name: 'Hooks' }, status: 'draft' },
        { ...rows[1], sku: null, version: null, category: null, status: 'ready', plates_count: 0 },
      ]),
    );
    render(<ProductsPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('LMP-1')).toBeInTheDocument();
    expect(within(table).getByText('Hooks')).toBeInTheDocument();
    expect(within(table).getByText('Draft')).toBeInTheDocument();
    // Ready, but it lost its plates since: said, not silently demoted.
    expect(within(table).getByText('Incomplete')).toBeInTheDocument();
    for (const header of ['SKU', 'Version', 'Category', 'Status']) {
      expect(within(table).getByRole('columnheader', { name: new RegExp(header) })).toBeInTheDocument();
    }
  });

  it('the card says Draft and shows the SKU', async () => {
    localStorage.setItem('bamdude-products-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(
      envelope([{ ...rows[0], sku: 'LMP-1', version: null, category: null, status: 'draft' }]),
    );
    render(<ProductsPage />);
    const card = await screen.findByTestId('product-1-card');
    expect(within(card).getByText('Draft')).toBeInTheDocument();
    expect(within(card).getByText(/LMP-1/)).toBeInTheDocument();
  });
});
