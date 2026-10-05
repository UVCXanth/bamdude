/**
 * The Workshop's role sets (WS-13 E13 O05, O19): each set gets the actions its rights allow and
 * sends no request its rights would refuse — a hidden 403 is a scenario that does not work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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

  it('saves an order for a new customer with a contact and a delivery method (O19, Codex E13-V06)', async () => {
    auth.granted = new Set(['orders:read', 'orders:create', 'customers:create']);
    window.history.pushState({}, '', '/projects');
    const directory = vi.spyOn(api, 'getCustomers');
    // The server's lists as they stand: the new customer is in the options once it is made.
    const options = [{ id: 1, code: 'CU-0001', name: 'ACME' }];
    vi.spyOn(api, 'getCustomerOptions').mockImplementation(async () => [...options]);
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([{ id: 7, name: 'Courier' }] as never);
    const madeCustomer = vi.spyOn(api, 'createCustomer').mockImplementation(async () => {
      options.push({ id: 42, code: 'CU-0042', name: 'Clerk Made' });
      return { id: 42, code: 'CU-0042', name: 'Clerk Made', kind: 'company', notes: null, contacts: [] } as never;
    });
    const contacts = vi.spyOn(api, 'getContactOptions').mockImplementation(async (id: number) =>
      (id === 42 ? [{ id: 5, code: 'CT-0005', name: 'Bo', role: null }] : []) as never,
    );
    const madeOrder = vi.spyOn(api, 'createOrder').mockResolvedValue({ id: 77 } as never);
    render(<OrderModal onClose={() => {}} />);

    await screen.findByRole('option', { name: 'CU-0001 · ACME' });
    // The order is named first: the customer's form must not send the order under it.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clerk order' } });
    fireEvent.change(screen.getByLabelText('Customer'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByPlaceholderText('Customer name'), { target: { value: 'Clerk Made' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add contact and delivery…' }));

    const form = await screen.findByRole('dialog', { name: 'New customer' });
    expect(within(form).getByLabelText('Name')).toHaveValue('Clerk Made');
    fireEvent.change(within(form).getByLabelText('Contact name'), { target: { value: 'Bo' } });
    await within(form).findByRole('option', { name: 'Courier' });
    fireEvent.change(within(form).getByLabelText('Delivery method'), { target: { value: '7' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save customer' }));

    await waitFor(() =>
      expect(madeCustomer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Clerk Made',
          contacts: [expect.objectContaining({ name: 'Bo', delivery_method_id: 7 })],
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New customer' })).not.toBeInTheDocument());
    // Saving the customer is not saving the order the form sits in.
    expect(madeOrder).not.toHaveBeenCalled();
    // The order form names the new customer and its main contact — no page of the directory.
    await waitFor(() => expect(screen.getByLabelText('Customer')).toHaveValue('42'));
    await waitFor(() => expect(screen.getByLabelText('Contact person')).toHaveValue('5'));
    expect(contacts).toHaveBeenCalledWith(42);
    expect(window.location.pathname).toBe('/projects');

    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(madeOrder).toHaveBeenCalledWith(expect.objectContaining({ name: 'Clerk order', customer_id: 42, contact_id: 5 })),
    );
    expect(directory).not.toHaveBeenCalled();
  });
});
