/**
 * The Stock tab over mocked API calls. `render` from `__tests__/utils` wraps
 * the providers and a BrowserRouter; the URL is set with pushState first, the
 * way `ProductsPage.test.tsx` does.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { StockFigures, StockItem, StockItemsPage, StockListPage } from '../../../api/client';
import { StockPage } from '../../../pages/stock/StockPage';
import { PRODUCT_ROW_DEFAULTS, STOCK_ROW_DEFAULTS } from '../../wireDefaults';

const lamp = {
  ...STOCK_ROW_DEFAULTS,
  id: 1, name: 'Lamp', is_active: true, sku: null, version: null, category: null, status: 'ready', origin: 'catalog', kits_available: 3, reserved_kits: 2,
  parts: [
    { part_id: 11, name: 'lid', qty_per_unit: 1, balance: 5 },
    { part_id: 12, name: 'base', qty_per_unit: 1, balance: 3 },
  ],
  reservations: [{ line_id: 7, order_id: 42, order_code: 'OR-0042', order_name: 'Order for Ivan', kits: 2 }],
};
const vase = { ...STOCK_ROW_DEFAULTS, id: 2, name: 'Old vase', is_active: false, sku: null, version: null, category: null, status: 'ready', origin: 'catalog', kits_available: 0, reserved_kits: 0, parts: [{ part_id: 21, name: 'body', qty_per_unit: 1, balance: 0 }], reservations: [] };
const pageOf = (items: unknown[], total = items.length): StockListPage =>
  ({ items, meta: { total, current_page: 1, per_page: 24, last_page: Math.max(1, Math.ceil(total / 24)) } }) as StockListPage;
const figures: StockFigures = { kits: 3, kit_products: 1, parts: 8, reserved_kits: 2, incomplete: 1 };

const position: StockItem = {
  id: 3, code: 'SK-0003', product: { id: 1, name: 'Lamp', sku: null, has_cover: false },
  configuration: { choices: [], changed_parts: [] }, location: null,
  on_hand: 4, reserved: 1, available: 3, min_qty: 0, below_min: false, short_by: 0, can_assemble: 0,
};
const itemsOf = (items: StockItem[]): StockItemsPage =>
  ({ items, meta: { total: items.length, current_page: 1, per_page: 24, last_page: 1 } });

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('StockPage', () => {
  let getPage: ReturnType<typeof vi.spyOn>;
  let getJournal: ReturnType<typeof vi.spyOn>;
  let getProducts: ReturnType<typeof vi.spyOn>;
  let getItems: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    // The parts tab is the one these tests grew up on; the finished tab and the
    // journal set their own URL.
    window.history.pushState({}, '', '/stock?tab=parts');
    getItems = vi.spyOn(api, 'getStockItems').mockResolvedValue(itemsOf([position]));
    vi.spyOn(api, 'getStockItemsSummary').mockResolvedValue({ on_hand: 4, reserved: 1, available: 3, tracked: 1, below_min: 0 });
    getPage = vi.spyOn(api, 'getStockPaged').mockResolvedValue(pageOf([lamp, vase]));
    vi.spyOn(api, 'getStockFigures').mockResolvedValue(figures);
    getJournal = vi.spyOn(api, 'getStockJournal').mockResolvedValue({ items: [], next_cursor: null, meta: null });
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'system' } as never);
    getProducts = vi.spyOn(api, 'getProducts').mockResolvedValue([
      { ...PRODUCT_ROW_DEFAULTS, id: 1, code: 'PR-0001', name: 'Lamp', is_active: true, sku: null, version: null, category: null, status: 'ready', origin: 'catalog', origin_file_id: null, origin_plate_index: null, cover_image_filename: null, has_cover: false, parts_count: 2, plates_count: 1, lines_count: 0, kits_available: 3, finished_available: 0, materials: [], colors: [], models: [] },
      { ...PRODUCT_ROW_DEFAULTS, id: 2, code: 'PR-0002', name: 'Old vase', is_active: false, sku: null, version: null, category: null, status: 'ready', origin: 'catalog', origin_file_id: null, origin_plate_index: null, cover_image_filename: null, has_cover: false, parts_count: 1, plates_count: 1, lines_count: 0, kits_available: 0, finished_available: 0, materials: [], colors: [], models: [] },
    ]);
  });

  it('lists products with their kits and reservations and marks one that is out of the catalog', async () => {
    render(<StockPage />);
    const row = await screen.findByTestId('stock-row-1');
    expect(within(row).getByText('Lamp')).toBeInTheDocument();
    expect(within(row).getByTestId('stock-kits-1')).toHaveTextContent('3');
    expect(within(row).getByTestId('stock-reserved-1')).toHaveTextContent('2');
    expect(within(screen.getByTestId('stock-row-2')).getByText(/not in the catalog/i)).toBeInTheDocument();
    expect(getPage).toHaveBeenLastCalledWith({ sort_by: 'kits-desc', page: 1, per_page: 24 });
  });

  it('opens on the finished goods, asking for the positions on record', async () => {
    window.history.pushState({}, '', '/stock');
    render(<StockPage />);
    expect(await screen.findByTestId('finished-row-3')).toBeInTheDocument();
    expect(getItems).toHaveBeenLastCalledWith({ mode: 'tracked', sort_by: 'product-asc', page: 1, per_page: 24 });
    expect(screen.getByRole('tab', { name: 'Finished goods' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('finished-tile-on-hand')).toHaveTextContent('4');
    expect(getPage).not.toHaveBeenCalled();
  });

  it('keeps the mode in the URL and asks the server for it', async () => {
    window.history.pushState({}, '', '/stock');
    render(<StockPage />);
    await screen.findByTestId('finished-row-3');
    fireEvent.click(screen.getByRole('button', { name: 'Below minimum' }));
    await waitFor(() => expect(getItems).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'low' })));
    expect(window.location.search).toContain('mode=low');
  });

  it('shows the free parts and the journal on their own tabs', async () => {
    render(<StockPage />);
    expect(await screen.findByTestId('stock-row-1')).toBeInTheDocument();
    expect(getItems).not.toHaveBeenCalled();
    expect(screen.queryByTestId('stock-journal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Movements' }));
    expect(await screen.findByTestId('stock-journal')).toBeInTheDocument();
    expect(screen.queryByTestId('stock-row-1')).not.toBeInTheDocument();
  });

  it('a tab switch starts the new tab clean — no page, search or sort carried over', async () => {
    window.history.pushState({}, '', '/stock?q=lamp&page=2&sort=code-desc');
    render(<StockPage />);
    await screen.findByTestId('finished-row-3');
    fireEvent.click(screen.getByRole('tab', { name: 'Free parts' }));
    await waitFor(() => expect(window.location.search).toBe('?tab=parts'));
    await waitFor(() => expect(getPage).toHaveBeenLastCalledWith({ sort_by: 'kits-desc', page: 1, per_page: 24 }));
    fireEvent.click(screen.getByRole('tab', { name: 'Finished goods' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('draws no section tabs — the sidebar carries them', async () => {
    render(<StockPage />);
    await screen.findByTestId('list-page-header');
    expect(screen.queryByRole('navigation', { name: 'Projects' })).not.toBeInTheDocument();
  });

  it('re-queries when the toggle and the search change, keeping both in the URL', async () => {
    render(<StockPage />);
    await screen.findByTestId('stock-row-1');
    fireEvent.click(screen.getByLabelText(/only with stock/i));
    await waitFor(() =>
      expect(getPage).toHaveBeenLastCalledWith({ with_stock: false, sort_by: 'kits-desc', page: 1, per_page: 24 }),
    );
    expect(window.location.search).toContain('stock=0');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lamp' } });
    await waitFor(() =>
      expect(getPage).toHaveBeenLastCalledWith({ with_stock: false, q: 'lamp', sort_by: 'kits-desc', page: 1, per_page: 24 }),
    );
    expect(window.location.search).toContain('q=lamp');
  });

  it('sorts from the headers on the server', async () => {
    render(<StockPage />);
    await screen.findByTestId('stock-row-1');
    fireEvent.click(screen.getByRole('button', { name: /^Reserved/ }));
    await waitFor(() => expect(getPage).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'reserved-desc' })));
    expect(window.location.search).toContain('sort=reserved-desc');
  });

  it('draws the shelf tiles and the page bar', async () => {
    getPage.mockResolvedValue(pageOf([lamp], 30));
    render(<StockPage />);
    expect(await screen.findByTestId('stock-tile-kits')).toHaveTextContent('3');
    expect(screen.getByTestId('stock-tile-incomplete')).toHaveTextContent('1');
    expect((await screen.findAllByText(/30/)).length).toBeGreaterThan(0); // the page bar's «… of 30»
  });

  it('a search that matches nothing offers a reset', async () => {
    getPage.mockResolvedValue(pageOf([]));
    window.history.pushState({}, '', '/stock?tab=parts&q=zzz');
    render(<StockPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(window.location.search).not.toContain('q='));
  });

  it('a bookmark past the last page is clamped', async () => {
    getPage.mockResolvedValue({ items: [lamp], meta: { total: 1, current_page: 5, per_page: 24, last_page: 1 } } as StockListPage);
    window.history.pushState({}, '', '/stock?tab=parts&page=5');
    render(<StockPage />);
    await waitFor(() => expect(window.location.search).not.toContain('page=5'));
  });

  it('expands a row into its parts and the orders holding its kits', async () => {
    render(<StockPage />);
    const row = await screen.findByTestId('stock-row-1');
    fireEvent.click(within(row).getByRole('button', { name: /show parts/i }));
    const details = await screen.findByTestId('stock-details-1');
    expect(within(details).getByTestId('stock-balance-11')).toHaveTextContent('5');
    const link = within(details).getByRole('link', { name: 'Order for Ivan' });
    expect(link).toHaveAttribute('href', '/projects/42');
    expect(within(details).getByText('2 kits')).toBeInTheDocument();
  });

  it('opens the adjust dialog from a row', async () => {
    render(<StockPage />);
    const row = await screen.findByTestId('stock-row-1');
    fireEvent.click(within(row).getByRole('button', { name: /adjust/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('stock-adjust-submit')).toBeInTheDocument();
  });

  it('the notes tab asks the server for one page and searches there', async () => {
    // spec workshop-dispatch-notes, rule 20.
    const getNotes = vi.spyOn(api, 'getDispatchNotes').mockResolvedValue({
      items: [{
        id: 7, code: 'DN-0007', created_at: '2026-09-28T10:00:00', project_id: 1, order_code: 'OR-0001',
        order_name: 'Flasks', customer_id: 2, customer_name: 'ACME', units: 2, lines_count: 1,
        summary: [{ product_name: 'Flask', part_name: null, quantity: 2 }], recipient_name: null,
        recipient_phone: null, delivery_method: null, delivery_details: null, waybill: null, note: null,
        created_by_name: 'olena',
      }],
      meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
    });
    window.history.pushState({}, '', '/stock?tab=notes');
    render(<StockPage />);
    expect(await screen.findByRole('link', { name: 'DN-0007' })).toHaveAttribute('href', '/stock/dispatch-notes/7');
    expect(screen.getByRole('tab', { name: 'Dispatch notes' })).toHaveAttribute('aria-selected', 'true');
    expect(getNotes).toHaveBeenLastCalledWith({ sort_by: 'created-desc', page: 1, per_page: 24 });
    fireEvent.change(screen.getByPlaceholderText(/Note, order, customer/), { target: { value: 'acme' } });
    await waitFor(() => expect(getNotes).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'acme', page: 1 })));
  });

  it('the journal tab reads both ledgers through the one endpoint', async () => {
    window.history.pushState({}, '', '/stock?tab=journal');
    render(<StockPage />);
    expect(await screen.findByTestId('stock-journal')).toBeInTheDocument();
    await waitFor(() => expect(getJournal).toHaveBeenLastCalledWith({ book: 'both', cursor: null, limit: 50 }));
    // The product filter comes from the catalog, one-offs included.
    expect(getProducts).toHaveBeenCalledWith({ include_adhoc: true });
  });

  it('the header opens a receipt and the assembly; a row menu opens its movement', async () => {
    window.history.pushState({}, '', '/stock');
    render(<StockPage />);
    await screen.findByTestId('finished-row-3');
    fireEvent.click(screen.getByRole('button', { name: 'Receipt' }));
    expect(await screen.findByRole('dialog', { name: 'Receipt' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Assemble from parts…' }));
    expect(await screen.findByRole('dialog', { name: 'Assemble from parts' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByTestId('finished-3-menu'));
    fireEvent.click(within(screen.getByTestId('finished-3-menu-panel')).getByRole('menuitem', { name: 'Stocktake' }));
    expect(await screen.findByRole('dialog', { name: 'Stocktake' })).toBeInTheDocument();
    expect(within(screen.getByRole('dialog')).getByText('SK-0003')).toBeInTheDocument();
  });
});
