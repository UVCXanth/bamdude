/**
 * The «Stock» tab of the product page (WS-13 E9 F01–F05): the finished positions by
 * configuration, the free parts with the kits they make, and the doors — a receipt, an
 * assembly, an adjustment — each card with states of its own.
 *
 * R03: the standard kit count is ONE configuration and each `kits_by_option` row changes
 * ONE option; neither proves that nothing can be assembled. So «Assemble…» is closed only
 * for a product without variants whose shelf has answered 0; the dialog decides the rest.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import type { Permission, Product, ProductStock, StockItem, StockItemsPage } from '../../../../api/client';
import { ProductStockTab } from '../../../../components/products/detail/ProductStockTab';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? real.hasPermission(p) };
    },
  };
});

function position(id: number, option: string | null, over: Partial<StockItem> = {}): StockItem {
  return {
    id,
    code: `SK-000${id}`,
    product: { id: 7, name: 'Flask', sku: null, has_cover: false },
    configuration: {
      choices: option ? [{ group_id: 1, group_name: 'Lid', option_id: id, option_name: option, is_default: false }] : [],
      changed_parts: [],
    },
    location: null,
    on_hand: 3,
    reserved: 1,
    available: 2,
    min_qty: 0,
    below_min: false,
    short_by: 0,
    can_assemble: 0,
    ...over,
  };
}

function positions(items: StockItem[]): StockItemsPage {
  return { items, meta: { total: items.length, current_page: 1, per_page: Math.max(1, items.length), last_page: 1 } } as StockItemsPage;
}

const shelf: ProductStock = {
  kits_available: 0,
  kits_by_option: [],
  balances: [
    { part_id: 1, name: 'Body', qty_per_unit: 1, balance: 4, held_for_orders: 1 },
    { part_id: 2, name: 'Spare lid', qty_per_unit: 0, balance: 2, held_for_orders: 0 },
  ],
  movements: [],
} as ProductStock;

const plain = { id: 7, code: 'PR-0007', name: 'Flask', variant_groups: [] } as unknown as Product;
const withVariants = {
  ...plain,
  variant_groups: [{ id: 1, name: 'Lid', default_option_id: 10, options: [{ id: 10, name: 'Glass' }, { id: 11, name: 'Cork' }] }],
} as unknown as Product;

describe('ProductStockTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = new Set(['projects:read', 'projects:update']);
    vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'iso' } as never);
    vi.spyOn(api, 'getStockItems').mockResolvedValue(positions([position(3, 'Cork'), position(4, null, { location: 'A-1', below_min: true, min_qty: 5 })]));
    vi.spyOn(api, 'getProductStock').mockResolvedValue(shelf);
    vi.spyOn(api, 'getStockJournal').mockResolvedValue({ items: [], next_cursor: null, meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } });
    vi.spyOn(api, 'getProduct').mockResolvedValue(withVariants);
    vi.spyOn(api, 'lookupStockItem').mockResolvedValue({ item: null, configuration: { choices: [], changed_parts: [] }, parts: [], can_assemble: 0 } as never);
  });

  describe('F01 finished positions by configuration', () => {
    it('one row per position from the side panel’s own question', async () => {
      render(<ProductStockTab product={withVariants} />);
      const table = await screen.findByTestId('stock-positions');
      expect(api.getStockItems).toHaveBeenCalledWith({ product_id: 7, mode: 'all', all: true });
      const first = within(table).getByTestId('stock-position-3');
      expect(within(first).getByRole('link', { name: 'Lid: Cork' })).toHaveAttribute('href', '/stock/3');
      expect(first).toHaveTextContent('—');
      const second = within(table).getByTestId('stock-position-4');
      expect(within(second).getByRole('link', { name: 'SK-0004' })).toBeInTheDocument();
      expect(second).toHaveTextContent('A-1');
      expect(within(second).getByTestId('stock-position-available').className).toMatch(/amber/);
    });

    it('none: the mockup’s sentence', async () => {
      vi.spyOn(api, 'getStockItems').mockResolvedValue(positions([]));
      render(<ProductStockTab product={plain} />);
      expect(await screen.findByText(/no finished units on the shelf yet/i)).toBeInTheDocument();
    });

    it('a failure is its own: a sentence and a retry; the parts card stands', async () => {
      vi.spyOn(api, 'getStockItems').mockRejectedValue(new Error('boom'));
      render(<ProductStockTab product={plain} />);
      expect(await screen.findByText('Could not load the positions')).toBeInTheDocument();
      expect(await screen.findByTestId('stock-balance-1')).toHaveTextContent('4');
    });

    it('«Receipt» opens the receipt for THIS product', async () => {
      render(<ProductStockTab product={plain} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Receipt' }));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      await waitFor(() => expect(api.lookupStockItem).toHaveBeenCalledWith(7, []));
    });
  });

  describe('F02 the free parts', () => {
    it('without variants: one kit count, the table, the out-of-kit group', async () => {
      vi.spyOn(api, 'getProductStock').mockResolvedValue({ ...shelf, kits_available: 3 });
      render(<ProductStockTab product={plain} />);
      expect(await screen.findByTestId('stock-kits')).toHaveTextContent('3');
      expect(screen.getByTestId('stock-balance-1')).toHaveTextContent('4');
      expect(screen.getByTestId('stock-held-1')).toHaveTextContent('1');
      expect(within(screen.getByTestId('stock-out-of-kit')).getByText('Spare lid')).toBeInTheDocument();
    });

    it('with variants: a row per option, and a note that the numbers do not add up', async () => {
      vi.spyOn(api, 'getProductStock').mockResolvedValue({
        ...shelf,
        kits_by_option: [
          { group_id: 1, group_name: 'Lid', option_id: 10, option_name: 'Glass', is_default: true, kits: 0 },
          { group_id: 1, group_name: 'Lid', option_id: 11, option_name: 'Cork', is_default: false, kits: 2 },
        ],
      });
      render(<ProductStockTab product={withVariants} />);
      const kits = await screen.findByTestId('stock-kits-by-option');
      expect(within(kits).getByText('Kits · Lid: Glass')).toBeInTheDocument();
      expect(within(kits).getByText('Kits · Lid: Cork')).toBeInTheDocument();
      expect(screen.getByText(/numbers do not add up/i)).toBeInTheDocument();
    });

    it('R03 without variants and 0 kits: «Assemble…» is closed, and says why', async () => {
      render(<ProductStockTab product={plain} />);
      const button = await screen.findByRole('button', { name: 'Assemble finished units from parts…' });
      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAttribute('title', 'Not one whole kit');
    });

    it('R03 with variants it never closes — the dialog decides, for THIS product', async () => {
      render(<ProductStockTab product={withVariants} />);
      await screen.findByTestId('stock-balance-1');
      const button = screen.getByRole('button', { name: 'Assemble finished units from parts…' });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      await waitFor(() => expect(api.lookupStockItem).toHaveBeenCalledWith(7, []));
    });

    it('R03 a shelf not yet read, or failed, is not a zero — the door stays open', async () => {
      let fail: (e: Error) => void = () => {};
      vi.spyOn(api, 'getProductStock').mockReturnValue(new Promise((_, reject) => (fail = reject)));
      render(<ProductStockTab product={plain} />);
      const button = screen.getByRole('button', { name: 'Assemble finished units from parts…' });
      expect(button).toBeEnabled();
      await act(async () => fail(new Error('boom')));
      expect(await screen.findByTestId('stock-error')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Assemble finished units from parts…' })).toBeEnabled();
    });

    it('a reader has no door', async () => {
      auth.granted = new Set(['projects:read']);
      render(<ProductStockTab product={plain} />);
      await screen.findByTestId('stock-balance-1');
      expect(screen.queryByRole('button', { name: 'Receipt' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Adjust' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /assemble/i })).not.toBeInTheDocument();
    });
  });

  it('F05 two cards in the mockup’s grid, one column below 1101 px, and the movements under them', async () => {
    render(<ProductStockTab product={plain} />);
    const grid = await screen.findByTestId('stock-cards');
    expect(grid.className).toContain('minmax(min(420px,100%),1fr)');
    expect(grid.className).toContain('max-[1101px]:grid-cols-1');
    expect(screen.getByTestId('product-journal')).toBeInTheDocument();
  });
});
