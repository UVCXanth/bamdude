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
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { ProductListItem } from '../../../api/client';
import { ProductsPage } from '../../../pages/products/ProductsPage';
import { PRODUCT_ROW_DEFAULTS } from '../../wireDefaults';

// Every field the server sends with a row (E1) — the parts of a row read them all.
const wire = {
  ...PRODUCT_ROW_DEFAULTS,
  sku: null,
  version: null,
  category: null,
  status: 'ready',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  finished_available: 0,
  materials: [],
  colors: [],
  models: [],
  sliced: true,
};
const rows = [
  { ...wire, id: 1, code: 'PR-0001', name: 'Flask', is_active: true, cover_image_filename: null, has_cover: true, parts_count: 2, plates_count: 1, lines_count: 3, kits_available: 0 },
  { ...wire, id: 2, code: 'PR-0002', name: 'Old lid', is_active: false, cover_image_filename: null, has_cover: false, parts_count: 1, plates_count: 1, lines_count: 0, kits_available: 0 },
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

  it('asks for page 1 of 24 catalog products by name, and for the hidden ones too when «hidden» is on (WS-13 E8 C04)', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(get).toHaveBeenLastCalledWith({ active: true, sort_by: 'name-asc', page: 1, per_page: 24 });
    const hidden = screen.getByRole('checkbox', { name: 'hidden' });
    expect(hidden).not.toBeChecked();
    fireEvent.click(hidden);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ sort_by: 'name-asc', page: 1, per_page: 24 }));
    // The URL keeps its old meaning — `catalog=0` is «hidden ones too», as it always was.
    expect(window.location.search).toBe('?catalog=0');
    fireEvent.click(screen.getByRole('checkbox', { name: 'hidden' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ active: true, sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('');
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
    fireEvent.click(screen.getByRole('button', { name: /Composition/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'printed_parts-desc', page: 1 })));
    expect(window.location.search).toContain('sort=printed_parts-desc');
  });

  it('an empty search result offers to reset, and the reset clears it', async () => {
    window.history.pushState({}, '', '/products?q=zzz&catalog=0');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([]));
    render(<ProductsPage />);
    // The mockup's panel (WS-13 E8 C08) — and one Reset, its own (C05).
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.getByText('Try a shorter query or remove filters.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ active: true, sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('');
  });

  it('draws the cards in the mockup grid, each with its picture or the tile (WS-13 E8 E01)', async () => {
    localStorage.setItem('bamdude-products-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    // `has_cover` decides per card: the effective cover for one, the neutral tile for the other.
    expect(screen.getAllByTestId('product-cover')).toHaveLength(1);
    expect(screen.getAllByTestId('product-cover-placeholder')).toHaveLength(1);
    // The orders are the table's to say (E03).
    expect(screen.queryByText(/in 3 orders/i)).not.toBeInTheDocument();
    expect(screen.getByText(/not in catalog/i)).toBeInTheDocument();
    const grid = screen.getByTestId('product-1-card').parentElement as HTMLElement;
    expect(grid.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))]');
  });

  it('a 409 on delete stays in the confirmation, as the server said it (WS-13 E8 F07)', async () => {
    localStorage.setItem('bamdude-products-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    vi.spyOn(api, 'deleteProduct').mockRejectedValue(new Error('Product is used by an order line'));
    render(<ProductsPage />);
    fireEvent.click((await screen.findAllByTestId('product-menu'))[0]);
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete product?' });
    fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/used by an order line/i);
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
    expect(screen.queryByText('Nothing found')).toBeNull();
    // «hidden» is a condition all the same — the toolbar's Reset takes it off (C05).
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
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
    expect(within(panel).getByRole('button', { name: /^All products/ })).toHaveAttribute('aria-pressed', 'true');
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
    fireEvent.change(screen.getByLabelText('Readiness'), { target: { value: 'draft' } });
    fireEvent.change(screen.getByLabelText('Stock'), { target: { value: 'kits' } });
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        expect.objectContaining({ material: 'PETG', model: 'P1S', status: 'draft', stock: 'kits' }),
      ),
    );
    fireEvent.change(screen.getByLabelText('Colour'), { target: { value: '#FF0000' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ color: '#FF0000' })));
    for (const part of ['material=PETG', 'model=P1S', 'status=draft', 'stock=kits']) {
      expect(window.location.search).toContain(part);
    }
    expect(window.location.search).not.toContain('page=');
  });

  it('shows the code, SKU, version, category and the status in the table (WS-13 E8 D01)', async () => {
    localStorage.setItem('bamdude-products-view', 'table');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(
      envelope([
        { ...rows[0], code: 'PR-0001', sku: 'LMP-1', version: '2', category: { id: 3, name: 'Hooks' }, status: 'draft' },
        { ...rows[1], code: 'PR-0002', sku: null, version: null, category: null, status: 'ready', plates_count: 0 },
      ]),
    );
    render(<ProductsPage />);
    const table = await screen.findByRole('table');
    const identities = within(table).getAllByTestId('product-identity');
    expect(identities[0]).toHaveTextContent('PR-0001 · LMP-1 2 · Hooks');
    expect(identities[1]).toHaveTextContent('PR-0002 · — · no category');
    expect(within(table).getByText('Draft')).toBeInTheDocument();
    // Ready, but it lost its plates since: said, not silently demoted.
    expect(within(table).getByText('Incomplete')).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
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

// WS-13 E8 C: the page of the mockup — heading, the wide search, the row of filters,
// the categories and the results line, and every state of the read.
describe('ProductsPage — the mockup page (WS-13 E8 C)', () => {
  const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.pushState({}, '', '/products');
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: ['PETG'], colors: ['#FF0000'], models: ['P1S'] });
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([{ id: 3, name: 'Hooks', products_count: 2 }]);
  });

  it('C01 the subtitle counts the catalog: no figure before the first answer, then the server’s', async () => {
    let answer: (v: unknown) => void = () => {};
    vi.spyOn(api, 'getProductsPaged').mockImplementation(
      () =>
        new Promise((r) => {
          answer = r as (v: unknown) => void;
        }),
    );
    render(<ProductsPage />);
    const header = await screen.findByTestId('list-page-header');
    expect(header).toHaveTextContent('Search by name, SKU, part, file or parameters');
    expect(header).not.toHaveTextContent(/\d/);
    await act(async () => answer({ ...pageOf(rows), catalog_total: 104 }));
    expect(header).toHaveTextContent('104 products in the catalog · search by name, SKU, part, file or parameters');
  });

  it('C01 a failed first read puts «—» where the figure goes', async () => {
    vi.spyOn(api, 'getProductsPaged').mockRejectedValue(new Error('down'));
    render(<ProductsPage />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByTestId('list-page-header')).toHaveTextContent('— products in the catalog · search by name');
  });

  it('C02 the search is its own wide row, above the filters, the categories and the results', async () => {
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    const box = await screen.findByRole('searchbox', { name: 'Name, SKU, material, colour, part or file…' });
    expect(box.closest('[data-layout="wide"]')).toBeTruthy();
    expect(box.compareDocumentPosition(screen.getByLabelText('Material')) & FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Material').compareDocumentPosition(screen.getByRole('navigation', { name: 'Categories' })) & FOLLOWING).toBeTruthy();
  });

  it.each([
    ['/products', { active: true }, []],
    ['/products?catalog=1', { active: true }, []],
    ['/products?catalog=yes', { active: true }, []],
    ['/products?catalog=0', {}, ['active']],
    ['/products?adhoc=1', { active: true, include_adhoc: true }, []],
    ['/products?adhoc=yes', { active: true }, ['include_adhoc']],
    ['/products?stock=1', { active: true, stock: 'kits' }, ['in_stock']],
    ['/products?stock=finished', { active: true, stock: 'finished' }, []],
    ['/products?stock=low', { active: true, stock: 'below_min' }, []],
    ['/products?stock=zzz', { active: true }, ['stock', 'in_stock']],
    ['/products?status=archived', { active: true }, ['status']],
    ['/products?model=none', { active: true, sliced: false }, ['model']],
    ['/products?model=A1', { active: true, model: 'A1' }, ['sliced']],
  ])('C04 %s is asked of the server as it reads, and opening it rewrites nothing', async (url, want, absent) => {
    window.history.pushState({}, '', url);
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    const sent = get.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(sent).toEqual(expect.objectContaining(want));
    for (const key of absent) expect(sent).not.toHaveProperty(key);
    expect(window.location.pathname + window.location.search).toBe(url);
  });

  it('C04 the fields read the URL: «hidden» from catalog=0, part kits from the old stock=1, «any» for an unknown readiness', async () => {
    window.history.pushState({}, '', '/products?catalog=0&stock=1&status=archived&adhoc=1&model=none');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(screen.getByRole('checkbox', { name: 'hidden' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'one-off' })).toBeChecked();
    expect(screen.getByLabelText('Stock')).toHaveValue('kits');
    expect(screen.getByLabelText('Readiness')).toHaveValue('');
    expect(screen.getByLabelText('Printer model')).toHaveValue('none');
  });

  it('C04 «below minimum» writes low to the URL and below_min to the server; «not sliced» writes none', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    fireEvent.change(screen.getByLabelText('Stock'), { target: { value: 'low' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ stock: 'below_min' })));
    expect(window.location.search).toBe('?stock=low');
    fireEvent.change(screen.getByLabelText('Printer model'), { target: { value: 'none' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sliced: false })));
    expect(get.mock.calls.at(-1)![0]).not.toHaveProperty('model');
    expect(window.location.search).toBe('?stock=low&model=none');
  });

  it('C05 Reset only while a condition holds: one write, the sort kept, focus in the search, no history entry', async () => {
    window.history.pushState({}, '', '/products?sort=updated-desc&status=archived');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    // An unknown readiness filters nothing, but it is in the address: Reset can take it away (E8-V03).
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
    const entries = window.history.length;
    fireEvent.click(screen.getByRole('checkbox', { name: 'one-off' }));
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Categories' })).getByRole('button', { name: /^Hooks/ }));
    await waitFor(() => expect(window.location.search).toContain('category=3'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(window.location.search).toBe('?sort=updated-desc'));
    expect(get).toHaveBeenLastCalledWith({ active: true, sort_by: 'updated-desc', page: 1, per_page: 24 });
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
    expect(window.history.length).toBe(entries);
  });

  it('C06 «All products» carries the server’s figure for every filter but the category', async () => {
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue({
      ...pageOf(rows),
      categories: [{ id: 3, name: 'Hooks', count: 2 }],
      uncategorized: 1,
      all_categories: 9,
    });
    render(<ProductsPage />);
    const nav = await screen.findByRole('navigation', { name: 'Categories' });
    expect(await within(nav).findByRole('button', { name: /^All products\s*9$/ })).toBeInTheDocument();
  });

  it('C07 the results line names the category and counts the server’s total', async () => {
    window.history.pushState({}, '', '/products?category=3');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue({
      ...pageOf(rows, { total: 42 }),
      categories: [{ id: 3, name: 'Hooks', count: 42 }],
    });
    render(<ProductsPage />);
    const heading = await screen.findByRole('heading', { level: 3, name: /^Hooks/ });
    await waitFor(() => expect(within(heading).getByTestId('results-count')).toHaveTextContent('42'));
    expect(screen.queryByText('0 results')).not.toBeInTheDocument();
  });

  it('C07 «All products» and «Uncategorized» head the results; «0 results» comes only from an answer', async () => {
    window.history.pushState({}, '', '/products?q=zzz');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([]));
    render(<ProductsPage />);
    const heading = await screen.findByRole('heading', { level: 3, name: /^All products/ });
    expect(await screen.findByText('0 results')).toBeInTheDocument();
    expect(within(heading).getByTestId('results-count')).toHaveTextContent('0');
  });

  it('C08 the first read draws the skeleton of the view — never «No products yet»', async () => {
    vi.spyOn(api, 'getProductsPaged').mockImplementation(() => new Promise(() => {}));
    render(<ProductsPage />);
    const skeleton = await screen.findByTestId('products-skeleton');
    expect(skeleton).toHaveAttribute('data-shape', 'table');
    expect(screen.queryByText('No products yet')).not.toBeInTheDocument();
    expect(within(screen.getByRole('heading', { level: 3 })).getByTestId('results-count')).toHaveTextContent('…');
  });

  it('C08 a failed key is an alert with a retry of the same key — the URL does not move', async () => {
    window.history.pushState({}, '', '/products?q=lid');
    const get = vi.spyOn(api, 'getProductsPaged').mockRejectedValue(new Error('down'));
    render(<ProductsPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the products');
    expect(screen.queryByText('Nothing found')).not.toBeInTheDocument();
    expect(within(screen.getByRole('heading', { level: 3 })).getByTestId('results-count')).toHaveTextContent('—');
    get.mockResolvedValue(pageOf(rows));
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Flask')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'lid', page: 1 }));
    expect(window.location.search).toBe('?q=lid');
  });

  it('C08 a failed re-read keeps the rows and says so; of an empty answer, the explanation stays', async () => {
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    const reread = async () => {
      await act(async () => {
        window.dispatchEvent(new Event('visibilitychange'));
      });
    };
    get.mockRejectedValue(new Error('down'));
    await reread();
    expect(await screen.findByText('Could not refresh')).toBeInTheDocument();
    expect(screen.getByText('Flask')).toBeInTheDocument();
    get.mockResolvedValue(pageOf([]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No products yet')).toBeInTheDocument();
    get.mockRejectedValue(new Error('down'));
    await reread();
    expect(await screen.findByText('Could not refresh')).toBeInTheDocument();
    expect(screen.getByText('No products yet')).toBeInTheDocument();
  });

  it('C09 the facets failed: the filters stay usable and a note offers a retry', async () => {
    vi.mocked(api.getProductFacets).mockRejectedValue(new Error('down'));
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(await screen.findByText('Could not load the filter values')).toBeInTheDocument();
    expect(screen.getByLabelText('Material')).toBeEnabled();
  });
});


// WS-13 E8 D03 (R05): every sort key stays; a key no header carries is named above the table.
describe('ProductsPage — sorting beyond the headers (WS-13 E8 D03)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
  });

  it.each([
    ['parts-desc', 'Sorted by: All parts ↓'],
    ['plates-asc', 'Sorted by: Plates ↑'],
    ['kits-desc', 'Sorted by: Part kits ↓'],
    ['updated-desc', 'Sorted by: Last updated ↓'],
  ])('the table sorts by %s as asked and names it, with a way back', async (sort, chip) => {
    window.history.pushState({}, '', `/products?sort=${sort}&page=2`);
    localStorage.setItem('bamdude-products-view', 'table');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows, { total: 30, last_page: 2, current_page: 2 }));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: sort }));
    expect(screen.getByTestId('products-sort-chip')).toHaveTextContent(chip);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the table’s default order' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'name-asc', page: 1 })));
    expect(window.location.search).toBe('');
    expect(screen.queryByTestId('products-sort-chip')).not.toBeInTheDocument();
  });

  it('a key a header carries needs no chip', async () => {
    window.history.pushState({}, '', '/products?sort=finished-desc');
    localStorage.setItem('bamdude-products-view', 'table');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(screen.queryByTestId('products-sort-chip')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Stock/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('the cards sort by every key, all parts and printed parts apart', async () => {
    window.history.pushState({}, '', '/products?sort=parts-asc');
    localStorage.setItem('bamdude-products-view', 'cards');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    render(<ProductsPage />);
    await screen.findByText('Flask');
    const select = screen.getByLabelText('Sort by');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Name',
      'Printed parts',
      'All parts',
      'Plates',
      'Finished in stock',
      'Part kits',
      'Active orders',
      'SKU',
      'Category',
      'Status',
      'Last updated',
      'Created',
    ]);
    expect(select).toHaveValue('parts');
    // No chip in the cards: their own control names the order.
    expect(screen.queryByTestId('products-sort-chip')).not.toBeInTheDocument();
  });
});

// Final review M8: an unknown key in the URL sorts by name on the server — the page says so.
describe('ProductsPage — an unknown sort key', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
  });

  it('names no sort the server did not apply, and the cards read it as the name', async () => {
    window.history.pushState({}, '', '/products?sort=zzz-asc');
    localStorage.setItem('bamdude-products-view', 'table');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
    const { unmount } = render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(screen.queryByTestId('products-sort-chip')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Product \/ SKU/ })).toHaveAttribute('aria-sort', 'ascending');
    unmount();
    localStorage.setItem('bamdude-products-view', 'cards');
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(screen.getByLabelText('Sort by')).toHaveValue('name');
  });
});

// Codex E8-V03: a readiness or stock the closed sets do not know filters nothing and is never sent
// (C04) — but it is in the address, so Reset can take it away, alone or together, in one write.
describe('ProductsPage — unknown readiness and stock', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
  });

  it.each([['status=unexpected'], ['stock=unexpected'], ['status=unexpected&stock=unexpected']])(
    '%s: Reset clears it in one write, keeping the sort and the view',
    async (query) => {
      window.history.pushState({}, '', `/products?${query}&sort=sku-asc`);
      localStorage.setItem('bamdude-products-view', 'table');
      const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf(rows));
      render(<ProductsPage />);
      await screen.findByText('Flask');
      // Opening the link rewrites nothing, and the server is never asked with the unknown value.
      expect(window.location.search).toBe(`?${query}&sort=sku-asc`);
      for (const [args] of get.mock.calls) {
        expect(args).not.toHaveProperty('status');
        expect(args).not.toHaveProperty('stock');
      }
      const entries = window.history.length;
      fireEvent.click(screen.getByRole('button', { name: /^Reset/ }));
      await waitFor(() => expect(window.location.search).toBe('?sort=sku-asc'));
      expect(window.history.length).toBe(entries);
      expect(screen.getByRole('table')).toBeInTheDocument();
    },
  );
});
