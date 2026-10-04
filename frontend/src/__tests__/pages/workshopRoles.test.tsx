/**
 * The Workshop's role sets (WS-13 E13 O05, O19): each set gets the actions its rights allow and
 * sends no request its rights would refuse — a hidden 403 is a scenario that does not work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { api } from '../../api/client';
import type { Permission, StockFigures, StockItemsPage, StockListPage } from '../../api/client';
import { StockPage } from '../../pages/stock/StockPage';
import { OrderModal } from '../../components/projects/OrderModal';
import { STOCK_ROW_DEFAULTS } from '../wireDefaults';

const auth = vi.hoisted(() => ({ granted: new Set<string>(), userId: 5 }));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
    }),
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('a storekeeper — stock:read + stock:move, no stock:adjust, no products:read', () => {
  beforeEach(() => {
    auth.granted = new Set(['stock:read', 'stock:move']);
    window.history.pushState({}, '', '/stock');
    vi.spyOn(api, 'getStockItems').mockResolvedValue({
      items: [],
      meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 },
    } as StockItemsPage);
    vi.spyOn(api, 'getStockItemsSummary').mockResolvedValue({ on_hand: 0, reserved: 0, available: 0, tracked: 0, below_min: 0 });
    vi.spyOn(api, 'getStockPaged').mockResolvedValue({
      items: [{ ...STOCK_ROW_DEFAULTS, id: 1, name: 'Lamp', is_active: true, sku: null, version: null, category: null, status: 'ready', origin: 'catalog', kits_available: 3, reserved_kits: 0, parts: [], reservations: [] }],
      meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
    } as unknown as StockListPage);
    vi.spyOn(api, 'getStockFigures').mockResolvedValue({ kits: 3, kit_products: 1, parts: 8, reserved_kits: 0, incomplete: 0 } as StockFigures);
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 1, last_page: 1 } } as never);
  });

  it('receives from the header, picking from the stock catalog — never the product catalog', async () => {
    const catalog = vi.spyOn(api, 'getStockCatalog').mockResolvedValue([
      { id: 1, code: 'PR-0001', name: 'Lamp', sku: null, origin: 'catalog', is_active: true, has_cover: false, variant_groups: [] },
    ]);
    const products = vi.spyOn(api, 'getProducts');
    render(<StockPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Receipt' }));
    expect(await screen.findByRole('button', { name: /PR-0001|Lamp/ })).toBeInTheDocument();
    await waitFor(() => expect(catalog).toHaveBeenCalled());
    expect(products).not.toHaveBeenCalled();
  });
});

describe('an order clerk — orders:read + orders:create + customers:create, no customers:read', () => {
  it('names a customer and creates one from the order form, reading no directory', async () => {
    auth.granted = new Set(['orders:read', 'orders:create', 'customers:create']);
    const directory = vi.spyOn(api, 'getCustomers');
    vi.spyOn(api, 'getCustomerOptions').mockResolvedValue([{ id: 1, code: 'CU-0001', name: 'ACME' }]);
    vi.spyOn(api, 'getContactOptions').mockResolvedValue([]);
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
    render(<OrderModal onClose={() => {}} />);
    expect(await screen.findByRole('option', { name: 'CU-0001 · ACME' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /new customer/i })).toBeInTheDocument();
    expect(directory).not.toHaveBeenCalled();
  });
});
