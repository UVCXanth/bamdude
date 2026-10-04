/**
 * The product page (WS-13 E9): the header, the side panel of facts, the five tabs — and
 * the states of each. The `render` helper has no route option — the page reads
 * `useParams` / `useSearchParams`, so the URL is set with pushState and the page is
 * mounted under a matching `<Route>` inside the helper's own BrowserRouter.
 *
 * The catalog switch is asserted on the wire, because `is_active` explicitly-null is a
 * 422 and a toggle that sent the wrong shape would look identical on screen until the
 * server refused it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, Routes, Route } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { Permission, Product, ProductEstimate, StockItem, StockItemsPage } from '../../../api/client';
import { ProductPage } from '../../../pages/products/ProductPage';
import { createAppQueryClient } from '../../../utils/appQueryClient';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));

// Only the hook is replaced, and only when a test asks: `null` falls through to
// the admin the render helper's real `AuthProvider` resolves.
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? real.hasPermission(p) };
    },
  };
});

const product: Product = {
  id: 1,
  code: 'PR-0001',
  name: 'Flask',
  is_active: true,
  sku: null,
  version: 'v2',
  category: null,
  status: 'draft',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 2,
  plates_count: 3,
  lines_count: 0,
  kits_available: 3,
  finished_available: 2,
  materials: ['PLA'],
  colors: [],
  models: ['X1C'],
  sliced: true,
  printed_parts_count: 2,
  purchased_parts_count: 0,
  variant_group_names: [],
  variant_groups: [],
  active_orders_count: 0,
  finished_positions: 1,
  finished_below_min: 0,
  description: null,
  notes: null,
  designer: 'Ada',
  license: 'CC-BY',
  source_url: null,
  design_id: null,
  attachments: [],
  parts: [],
  variants_revision: 'r0',
  library_file_ids: [],
  library_folder_ids: [],
  units_printed_total: 12,
  documents_count: 4,
  orders_count: 5,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const estimate: ProductEstimate = {
  prints: 2,
  print_time_seconds: 4800,
  filament_grams: 85,
  filament_cost: null,
  surplus: [],
  purchased_cost: null,
  purchased_known_cost: 0,
  purchased_partial: false,
  complete: true,
  reasons: [],
};

function position(id: number, option: string, available: number): StockItem {
  return {
    id,
    code: `SK-000${id}`,
    product: { id: 1, name: 'Flask', sku: null, has_cover: false },
    configuration: {
      choices: [{ group_id: 1, group_name: 'Lid', option_id: id, option_name: option, is_default: option === 'Glass' }],
      changed_parts: [],
    },
    location: null,
    on_hand: available,
    reserved: 0,
    available,
    min_qty: 0,
    below_min: false,
    short_by: 0,
    can_assemble: 0,
  };
}

function positions(items: StockItem[]): StockItemsPage {
  return { items, meta: { total: items.length, current_page: 1, per_page: items.length, last_page: 1 } } as StockItemsPage;
}

afterEach(() => {
  window.history.pushState({}, '', '/');
});

function mountAt(path: string | number = 1) {
  window.history.pushState({}, '', typeof path === 'number' ? `/products/${path}` : path);
  render(
    <>
      <Link to="/products/2">next product</Link>
      <Routes>
        <Route path="/products/:id" element={<ProductPage />} />
        <Route path="/products" element={<p>product list</p>} />
      </Routes>
    </>,
  );
}

function withProduct(over: Partial<Product>) {
  vi.spyOn(api, 'getProduct').mockResolvedValue({ ...product, ...over });
}

const side = () => screen.getByTestId('product-side');

describe('ProductPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = null;
    vi.spyOn(api, 'getProduct').mockResolvedValue(product);
    vi.spyOn(api, 'getProductEstimate').mockResolvedValue(estimate);
    vi.spyOn(api, 'getStockItems').mockResolvedValue(positions([]));
    vi.spyOn(api, 'getProductSources').mockResolvedValue({ parts: [] });
    vi.spyOn(api, 'getProductStock').mockResolvedValue({ kits_by_option: [], balances: [], kits_available: 0, movements: [] });
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue({ files: [], hidden_files: 0, folders: [] });
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 }, totals: { active: 0, completed: 0, cancelled: 0, all: 0, stages: {} } } as never);
  });

  describe('the page (B05, C01, C04)', () => {
    it('opens its heading outline with the product’s own h1, before any h2', async () => {
      mountAt();
      const first = (await screen.findAllByRole('heading'))[0];
      expect(first.tagName).toBe('H1');
      expect(first).toHaveTextContent('Flask');
    });

    it('lays out the side panel and the main panel, the tabs in the main one', async () => {
      mountAt();
      const layout = await screen.findByTestId('product-layout');
      expect(within(layout).getByTestId('product-side')).toBeInTheDocument();
      expect(within(within(layout).getByTestId('product-main')).getByRole('tablist')).toBeInTheDocument();
      // ≤ 760 one column, the side panel first in the document — so ABOVE the tabs (K2).
      expect(layout.className).toContain('max-[761px]:grid-cols-1');
      expect(layout.firstElementChild).toBe(within(layout).getByTestId('product-side'));
    });

    it('shows the description and, muted under it, the notes — only when there are any', async () => {
      withProduct({ description: 'Tall flask\nwith a lid', notes: 'Keep dry' });
      mountAt();
      expect(await screen.findByTestId('product-description')).toHaveTextContent('Tall flask with a lid');
      expect(screen.getByTestId('product-notes')).toHaveTextContent('Keep dry');
    });

    it('shows neither when both are empty', async () => {
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      expect(screen.queryByTestId('product-description')).not.toBeInTheDocument();
      expect(screen.queryByTestId('product-notes')).not.toBeInTheDocument();
    });

    it('reads first with the page’s own shape, not a spinner', async () => {
      vi.spyOn(api, 'getProduct').mockReturnValue(new Promise(() => {}));
      mountAt();
      expect(await screen.findByTestId('product-page-skeleton')).toBeInTheDocument();
      expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    });

    it('a failure with nothing to show names the error and retries', async () => {
      const get = vi.spyOn(api, 'getProduct').mockRejectedValue(new Error('Gateway timeout'));
      mountAt();
      expect(await screen.findByText(/could not load this product: gateway timeout/i)).toBeInTheDocument();
      get.mockResolvedValue(product);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
    });

    it('a 404 is «not found» with the way back to the catalog', async () => {
      vi.spyOn(api, 'getProduct').mockRejectedValue(new ApiError('Product not found', 404));
      mountAt();
      expect(await screen.findByText('Product not found')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'To the catalog' })).toHaveAttribute('href', '/products');
    });

    it('keeps the rendered page when a background refetch fails', async () => {
      // TanStack v5 turns the query's status to "error" on ANY failed fetch and keeps
      // `data` while it does; one that fails must not replace a cached product.
      const get = vi.spyOn(api, 'getProduct').mockResolvedValueOnce(product).mockRejectedValue(new Error('Gateway timeout'));
      vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...product, is_active: false });
      mountAt();

      expect(await screen.findByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: /in the catalog/i }));
      await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

      expect(screen.getByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      expect(screen.queryByText(/could not load/i)).not.toBeInTheDocument();
    });

    it('says once that it could not refresh, and keeps the product on screen', async () => {
      const client = createAppQueryClient();
      client.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
      vi.spyOn(api, 'getProduct').mockResolvedValueOnce(product).mockRejectedValue(new Error('Gateway timeout'));
      vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...product, is_active: false });

      window.history.pushState({}, '', '/products/1');
      render(
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/products/:id" element={<ProductPage />} />
          </Routes>
        </QueryClientProvider>,
      );

      expect(await screen.findByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('checkbox', { name: /in the catalog/i }));

      expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      expect(screen.getAllByText(/could not refresh/i)).toHaveLength(1);
    });

    it('still says it could not refresh while the card dialog is open over it', async () => {
      // ⚠️ The dialog watches `['product', id]` TOO; both read through `useProductDetail`,
      // so the options are the same set whoever wins (see `detailQueryKeys.test.ts`).
      const client = createAppQueryClient();
      client.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });
      vi.spyOn(api, 'getProduct').mockResolvedValueOnce(product).mockRejectedValue(new Error('Gateway timeout'));

      window.history.pushState({}, '', '/products/1');
      render(
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/products/:id" element={<ProductPage />} />
          </Routes>
        </QueryClientProvider>,
      );

      expect(await screen.findByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^edit$/i }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();

      await client.invalidateQueries({ queryKey: ['product', 1] });

      expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
      expect(screen.getAllByText(/could not refresh/i)).toHaveLength(1);
      expect(screen.getByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
    });

    it('forgets the deleted product, so a Back inside staleTime cannot render it', async () => {
      const client = createAppQueryClient();
      const get = vi.spyOn(api, 'getProduct').mockResolvedValue(product);
      vi.spyOn(api, 'deleteProduct').mockResolvedValue(undefined as never);

      window.history.pushState({}, '', '/products/1');
      render(
        <QueryClientProvider client={client}>
          <Routes>
            <Route path="/products/:id" element={<ProductPage />} />
            <Route path="/products" element={<p>product list</p>} />
          </Routes>
        </QueryClientProvider>,
      );

      expect(await screen.findByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

      expect(await screen.findByText('product list')).toBeInTheDocument();
      await waitFor(() => expect(client.getQueryData(['product', 1])).toBeUndefined());
      // Nothing was refetched on the way out — that would have been a 404 in the query
      // of a page already leaving.
      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  describe('the side panel’s facts (B07–B09)', () => {
    it('lists the facts in the mockup’s order, a label over each value', async () => {
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      const labels = within(side()).getAllByRole('term').map((dt) => dt.textContent);
      expect(labels).toEqual([
        'Readiness',
        'Sliced for',
        'Material / colour (from plates)',
        'Estimate per unit (standard configuration)',
        'Stock',
        'Model designer · license',
      ]);
      expect(within(side()).getByText('Draft')).toBeInTheDocument();
      expect(within(side()).getByTestId('product-model-chip')).toHaveTextContent('X1C');
      expect(within(side()).getByText('PLA')).toBeInTheDocument();
      expect(within(side()).getByText('Ada')).toBeInTheDocument();
      expect(within(side()).getByText(/CC-BY/)).toBeInTheDocument();
    });

    it('the model ID and the source when there are any — the source a link of its own, in a new tab', async () => {
      withProduct({ design_id: 'MW-123', source_url: 'https://makerworld.com/models/1/', designer: null, license: null });
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      expect(within(side()).queryByText('Model designer · license')).not.toBeInTheDocument();
      expect(within(side()).getByText('MW-123')).toBeInTheDocument();
      const link = within(side()).getByRole('link', { name: /makerworld\.com\/models\/1$/ });
      expect(link).toHaveAttribute('href', 'https://makerworld.com/models/1/');
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    });

    it('a source that is no web address stays text', async () => {
      withProduct({ source_url: 'javascript:alert(1)' });
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      expect(within(side()).queryByRole('link')).not.toBeInTheDocument();
      expect(within(side()).getByTestId('product-source')).toHaveTextContent('javascript:alert(1)');
    });

    it('the estimate: time and filament of one unit', async () => {
      mountAt();
      expect(await within(await screen.findByTestId('product-side')).findByText('1h 20m · 85g')).toBeInTheDocument();
      expect(api.getProductEstimate).toHaveBeenCalledWith(1);
    });

    it('R11: a part without a plate is not a 0 g — both figures unknown, the reason under them', async () => {
      vi.spyOn(api, 'getProductEstimate').mockResolvedValue({
        ...estimate,
        prints: 0,
        print_time_seconds: null,
        filament_grams: 0,
        complete: false,
        reasons: [{ code: 'no_plate', count: 1 }],
      });
      mountAt();
      const fact = await screen.findByTestId('product-estimate');
      await within(fact).findByText('— · —');
      expect(within(fact).getByText('Parts on no plate: 1')).toBeInTheDocument();
    });

    it('a lower bound says «at least»; only purchased parts is «no printing»', async () => {
      vi.spyOn(api, 'getProductEstimate').mockResolvedValue({ ...estimate, complete: false, reasons: [{ code: 'truncated', count: null }] });
      mountAt();
      expect(await screen.findByText('at least 1h 20m · at least 85g')).toBeInTheDocument();
    });

    it('«no printing» for a kit of purchased parts', async () => {
      vi.spyOn(api, 'getProductEstimate').mockResolvedValue({ ...estimate, prints: 0, print_time_seconds: 0, filament_grams: 0 });
      mountAt();
      expect(await screen.findByText('no printing')).toBeInTheDocument();
    });

    it('the estimate’s first read is «…»; a failure is «—» and a retry', async () => {
      let fail: (e: Error) => void = () => {};
      vi.spyOn(api, 'getProductEstimate').mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
      mountAt();
      const fact = await screen.findByTestId('product-estimate');
      expect(fact).toHaveTextContent('…');
      await act(async () => fail(new Error('boom')));
      expect(await screen.findByText('Could not load the estimate')).toBeInTheDocument();
      expect(screen.getByTestId('product-estimate')).toHaveTextContent('—');
      fireEvent.click(within(screen.getByTestId('product-estimate')).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('1h 20m · 85g')).toBeInTheDocument();
    });

    it('the stock: free ready units and kits, «below minimum» when a position is under it', async () => {
      withProduct({ finished_below_min: 1 });
      mountAt();
      const fact = await screen.findByTestId('product-stock-fact');
      expect(fact).toHaveTextContent('2 finished · 3 kits');
      expect(within(fact).getByText('below minimum')).toBeInTheDocument();
      // One position: no breakdown, and nothing asked for it.
      expect(within(fact).queryByTestId('product-stock-breakdown')).not.toBeInTheDocument();
      expect(api.getStockItems).not.toHaveBeenCalled();
    });

    it('several positions: the breakdown by configuration, from the Stock tab’s own question', async () => {
      withProduct({ finished_positions: 2 });
      vi.spyOn(api, 'getStockItems').mockResolvedValue(positions([position(1, 'Glass', 1), position(2, 'Cork', 1)]));
      mountAt();
      const breakdown = await screen.findByTestId('product-stock-breakdown');
      await waitFor(() => expect(breakdown).toHaveTextContent('standard: 1 · Lid: Cork: 1'));
      expect(api.getStockItems).toHaveBeenCalledWith({ product_id: 1, mode: 'all', all: true });
    });

    it('the breakdown’s own states — «…», then its sentence and a retry; the figures stay', async () => {
      withProduct({ finished_positions: 2 });
      let fail: (e: Error) => void = () => {};
      vi.spyOn(api, 'getStockItems').mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
      mountAt();
      expect(await screen.findByTestId('product-stock-breakdown')).toHaveTextContent('…');
      await act(async () => fail(new Error('boom')));
      expect(await screen.findByText('Could not load the breakdown by position')).toBeInTheDocument();
      expect(screen.getByTestId('product-stock-fact')).toHaveTextContent('2 finished · 3 kits');
    });
  });

  describe('«In the catalog» (B10)', () => {
    it('takes a catalog product out of the catalog', async () => {
      const update = vi.spyOn(api, 'updateProduct').mockResolvedValue({ ...product, is_active: false });
      mountAt();
      fireEvent.click(await screen.findByRole('checkbox', { name: /in the catalog/i }));
      await waitFor(() => expect(update).toHaveBeenCalledWith(1, { is_active: false }));
    });

    it('is held while its request runs — one click, one request', async () => {
      const update = vi.spyOn(api, 'updateProduct').mockReturnValue(new Promise(() => {}));
      mountAt();
      const box = await screen.findByRole('checkbox', { name: /in the catalog/i });
      fireEvent.click(box);
      await waitFor(() => expect(box).toBeDisabled());
      fireEvent.click(box);
      expect(update).toHaveBeenCalledTimes(1);
    });

    it('is disabled for somebody who may not change the product', async () => {
      auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read']);
      mountAt();
      expect(await screen.findByRole('checkbox', { name: /in the catalog/i })).toBeDisabled();
    });

    it.each([
      [true, true],
      [false, false],
    ])('a one-off product shows its real is_active (%s), always disabled, and says how to list it', async (active, checked) => {
      withProduct({ origin: 'adhoc_job', is_active: active });
      mountAt();
      const box = await screen.findByRole('checkbox', { name: /in the catalog/i });
      expect(box).toBeDisabled();
      if (checked) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
      expect(box).toHaveAccessibleDescription(/one-off product.*add to catalog/i);
    });
  });

  describe('the visual field and its pictures (B06)', () => {
    it('without a cover: the package and «{code} · {version}»', async () => {
      mountAt();
      const visual = await screen.findByTestId('product-visual');
      expect(within(visual).getByTestId('product-cover-placeholder')).toHaveTextContent('PR-0001 · v2');
    });

    it('«Pictures…» opens the gallery in a dialog of its own — the page’s body has none', async () => {
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      expect(screen.queryByTestId('product-gallery')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Pictures…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pictures' });
      expect(within(dialog).getByTestId('product-gallery')).toBeInTheDocument();
      // The dialog names it; the gallery has no heading of its own there.
      expect(within(dialog).getAllByRole('heading').filter((h) => h.textContent === 'Pictures')).toHaveLength(1);
    });

    // The owner's F6 (2026-10-03): on the product page a new cover shows at once — the
    // visual field and the dialog's gallery address the cover with the product's version;
    // every other renderer keeps the bare address.
    it('a cover chosen in «Pictures…» shows in the visual field at once', async () => {
      const picture = (filename: string, sort_order: number) => ({
        category: 'pictures' as const,
        filename,
        original_name: filename,
        size: 1,
        sort_order,
        source: 'manual' as const,
        source_file_id: null,
        uploaded_at: null,
      });
      const pictures = [picture('a.png', 0), picture('b.png', 1)];
      withProduct({ has_cover: true, cover_image_filename: null, attachments: pictures, updated_at: '2026-10-03T10:00:00Z' });
      vi.spyOn(api, 'setProductCover').mockImplementation(async () => {
        withProduct({ has_cover: true, cover_image_filename: 'b.png', attachments: pictures, updated_at: '2026-10-03T10:00:05Z' });
        return { status: 'success', filename: 'b.png' } as never;
      });
      mountAt();
      const coverSrc = () => within(screen.getByTestId('product-visual')).getByTestId('product-cover').getAttribute('src') ?? '';
      await waitFor(() => expect(within(screen.getByTestId('product-visual')).getByTestId('product-cover')).toBeInTheDocument());
      const before = coverSrc();
      expect(before).toMatch(/\/products\/1\/cover-image\?v=/);
      fireEvent.click(screen.getByRole('button', { name: 'Pictures…' }));
      const dialog = await screen.findByRole('dialog', { name: 'Pictures' });
      expect(within(dialog).getByTestId('product-gallery-cover').getAttribute('src')).toBe(before);
      fireEvent.click(within(dialog).getByRole('button', { name: /set as cover: b\.png/i }));
      await waitFor(() => expect(coverSrc()).not.toBe(before));
      expect(coverSrc()).toMatch(/\/products\/1\/cover-image\?v=/);
      expect(within(dialog).getByTestId('product-gallery-cover').getAttribute('src')).toBe(coverSrc());
    });

    it('a click on the cover opens the same dialog', async () => {
      withProduct({ has_cover: true });
      mountAt();
      fireEvent.click(await screen.findByRole('button', { name: 'Open the product’s pictures' }));
      expect(await screen.findByRole('dialog', { name: 'Pictures' })).toBeInTheDocument();
    });

    it('Escape closes the topmost layer only, and the focus goes back to what opened each', async () => {
      withProduct({
        attachments: [
          {
            category: 'pictures',
            filename: 'a.png',
            original_name: 'a.png',
            size: 1,
            sort_order: 0,
            source: 'manual',
            source_file_id: null,
            uploaded_at: null,
          },
        ],
      });
      mountAt();
      const opener = await screen.findByRole('button', { name: 'Pictures…' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog', { name: 'Pictures' });
      const tile = within(dialog).getByTestId('gallery-picture-a.png');
      tile.focus();
      fireEvent.click(tile);
      expect(await screen.findByRole('dialog', { name: 'Picture viewer' })).toBeInTheDocument();

      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Picture viewer' })).not.toBeInTheDocument());
      expect(screen.getByRole('dialog', { name: 'Pictures' })).toBeInTheDocument();
      await waitFor(() => expect(within(screen.getByRole('dialog', { name: 'Pictures' })).getByTestId('gallery-picture-a.png')).toHaveFocus());

      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Pictures' })).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Pictures…' })).toHaveFocus());
    });
  });

  describe('the tabs (C02, C03, C05)', () => {
    it('counts what the server counted; «Stock» has no number', async () => {
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Composition (2)',
        'Plates and files (3)',
        'Stock',
        'Documents (4)',
        'Orders (5)',
      ]);
    });

    it('opens on the composition', async () => {
      mountAt();
      expect(await screen.findByRole('tab', { name: 'Composition (2)', selected: true })).toBeInTheDocument();
      expect(await screen.findByTestId('composition-variants')).toBeInTheDocument();
    });

    it('opens the tab its address names', async () => {
      mountAt('/products/1?tab=orders');
      expect(await screen.findByRole('tab', { name: 'Orders (5)', selected: true })).toBeInTheDocument();
      expect(await screen.findByText(/no order needs this product yet/i)).toBeInTheDocument();
      expect(screen.getByTestId('product-units-printed-total')).toHaveTextContent('12');
      expect(screen.getByText(/printed for orders/i)).toBeInTheDocument();
    });

    // WS-13 E13 O19: the stock's and the orders' tabs are their reads' — a catalog editor
    // without them is shown neither (each would only answer 403), and an address that names
    // one opens the composition.
    it('a catalog editor without the stock’s and the orders’ reads gets neither tab and asks neither', async () => {
      auth.granted = new Set(['products:read', 'products:update']);
      mountAt('/products/1?tab=stock');
      expect(await screen.findByRole('tab', { name: 'Composition (2)', selected: true })).toBeInTheDocument();
      expect(screen.queryByRole('tab', { name: /^Stock/ })).toBeNull();
      expect(screen.queryByRole('tab', { name: /^Orders/ })).toBeNull();
      await new Promise((r) => setTimeout(r, 50));
      expect(api.getStockItems).not.toHaveBeenCalled();
      expect(api.getProductStock).not.toHaveBeenCalled();
      expect(api.getOrdersPaged).not.toHaveBeenCalled();
    });

    it('an unknown tab reads as the composition and the address is not rewritten', async () => {
      mountAt('/products/1?tab=nonsense');
      expect(await screen.findByRole('tab', { name: 'Composition (2)', selected: true })).toBeInTheDocument();
      expect(window.location.search).toBe('?tab=nonsense');
    });

    it('a change replaces the address entry; the composition is never written', async () => {
      mountAt();
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      const entries = window.history.length;
      fireEvent.click(screen.getByRole('tab', { name: 'Documents (4)' }));
      await waitFor(() => expect(window.location.search).toBe('?tab=docs'));
      fireEvent.click(screen.getByRole('tab', { name: 'Composition (2)' }));
      await waitFor(() => expect(window.location.search).toBe(''));
      expect(window.history.length).toBe(entries);
    });

    it('a tab nobody opened asks nothing; a visited one stays mounted and is not asked again', async () => {
      mountAt();
      await screen.findByTestId('composition-variants');
      expect(api.getProductFileGroups).not.toHaveBeenCalled();
      expect(api.getOrdersPaged).not.toHaveBeenCalled();
      expect(api.getProductStock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('tab', { name: 'Plates and files (3)' }));
      expect(await screen.findByText(/no files yet/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Composition (2)' }));
      // Hidden, still there.
      expect(screen.getByText(/no files yet/i)).not.toBeVisible();
      fireEvent.click(screen.getByRole('tab', { name: 'Plates and files (3)' }));
      expect(screen.getByText(/no files yet/i)).toBeVisible();
      expect(api.getProductFileGroups).toHaveBeenCalledTimes(1);
    });

    it('the stock tab shows the shelf it reads', async () => {
      vi.spyOn(api, 'getProductStock').mockResolvedValue({
        kits_by_option: [],
        balances: [{ part_id: 1, name: 'lid', qty_per_unit: 1, balance: 3 }],
        kits_available: 3,
        movements: [],
      });
      mountAt('/products/1?tab=stock');
      expect(await screen.findByTestId('product-stock')).toBeInTheDocument();
      expect(await screen.findByTestId('stock-kits')).toHaveTextContent('3');
      await waitFor(() => expect(api.getProductStock).toHaveBeenCalledWith(1));
    });

    it('a failing tab leaves the header, the side panel and the other tabs alone', async () => {
      vi.spyOn(api, 'getProductFileGroups').mockRejectedValue(new Error('files down'));
      mountAt('/products/1?tab=plates');
      await screen.findByRole('tab', { name: 'Plates and files (3)', selected: true });
      await waitFor(() => expect(api.getProductFileGroups).toHaveBeenCalled());
      expect(screen.getByRole('heading', { level: 1, name: /^Flask/ })).toBeInTheDocument();
      expect(await screen.findByText('1h 20m · 85g')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: 'Composition (2)' }));
      expect(await screen.findByTestId('composition-variants')).toBeVisible();
    });

    it('another product starts from nothing — its own composition tab, nothing visited', async () => {
      vi.spyOn(api, 'getProduct').mockImplementation(async (id: number) =>
        id === 2 ? { ...product, id: 2, code: 'PR-0002', name: 'Jar' } : product,
      );
      mountAt('/products/1?tab=plates');
      expect(await screen.findByText(/no files yet/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('link', { name: 'next product' }));
      expect(await screen.findByRole('heading', { level: 1, name: /^Jar/ })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Composition (2)', selected: true })).toBeInTheDocument();
      expect(screen.queryByText(/no files yet/i)).not.toBeInTheDocument();
    });
  });

  describe('the one-off banner and «Add to order» (B01, B04)', () => {
    it('shows the adhoc banner and promotes to the catalogue', async () => {
      const adhocProduct = { ...product, id: 9, origin: 'adhoc_job' as const };
      const patched = vi.fn();
      vi.spyOn(api, 'getProduct').mockResolvedValue(adhocProduct);
      vi.spyOn(api, 'updateProduct').mockImplementation(async (_pid, data) => {
        patched(data);
        return { ...adhocProduct, ...data, origin: 'catalog' } as never;
      });
      mountAt(9);
      expect(await screen.findByText(/one-off product, created for an order/i)).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Add to catalog' }));
      // The banner asks first — the same confirmation as the catalog menu's (WS-13 E8 F06, R04).
      const dialog = await screen.findByRole('dialog', { name: 'Add the product to the catalog?' });
      expect(patched).not.toHaveBeenCalled();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Add to catalog' }));
      await waitFor(() => expect(patched).toHaveBeenCalledWith({ origin: 'catalog' }));
    });

    it('adds a catalog product to an order it asks for', async () => {
      vi.spyOn(api, 'getProductsPaged').mockResolvedValue({
        items: [],
        meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 },
        categories: [],
        uncategorized: 0,
        all_categories: 0,
        catalog_total: 0,
      });
      vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
      vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
      const orders = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
        items: [],
        meta: { total: 0, current_page: 1, per_page: 20, last_page: 1 },
        totals: { active: 0, completed: 0, cancelled: 0, all: 0, stages: {} },
      } as never);
      mountAt();
      fireEvent.click(await screen.findByRole('button', { name: 'Add to order' }));
      expect(await screen.findByRole('dialog', { name: 'Add to order' })).toBeInTheDocument();
      expect(screen.getByLabelText('Order')).toBeInTheDocument();
      await waitFor(() =>
        expect(api.getProductsPaged).toHaveBeenLastCalledWith({ page: 1, per_page: 24, active: true, q: 'PR-0001' }),
      );
      await waitFor(() => expect(orders).toHaveBeenCalledWith({ status: 'active', page: 1, per_page: 20 }));
      expect(screen.getByRole('button', { name: 'Add lines (1)' })).toBeDisabled();
    });

    it('offers no «Add to order» for a hidden product — the dialog lists active products only (WS-13 E5 G01)', async () => {
      withProduct({ id: 8, is_active: false });
      mountAt(8);
      await screen.findByRole('heading', { level: 1, name: /^Flask/ });
      expect(screen.queryByRole('button', { name: 'Add to order' })).not.toBeInTheDocument();
    });

    it('offers no «Add to order» for a one-off product', async () => {
      withProduct({ id: 9, origin: 'adhoc_job' });
      mountAt(9);
      expect(await screen.findByText(/one-off product, created for an order/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add to order' })).not.toBeInTheDocument();
    });
  });
});
