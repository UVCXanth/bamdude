/**
 * A list offers no sort or filter on another domain's figures its reader does not read (WS-13
 * E13 O12, O19): the server refuses each with 403 `workshop_read_required`, so the control would
 * only turn the list into «could not load» — and an address carrying one (a shared link) is
 * read as the list's default, never sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../utils';
import { api } from '../../api/client';
import type { Permission, ProductListItem } from '../../api/client';
import { ProductsPage } from '../../pages/products/ProductsPage';
import { CustomersPage } from '../../pages/customers/CustomersPage';
import { PRODUCT_ROW_DEFAULTS } from '../wireDefaults';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
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

const product = {
  ...PRODUCT_ROW_DEFAULTS,
  id: 1,
  code: 'PR-0001',
  name: 'Flask',
  sku: null,
  version: null,
  category: null,
  status: 'ready',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  is_active: true,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 1,
  plates_count: 1,
  materials: [],
  colors: [],
  models: [],
  sliced: true,
};

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('the catalog for an editor without the stock’s and the orders’ reads', () => {
  beforeEach(() => {
    auth.granted = new Set(['products:read', 'products:update']);
  });

  it('a shared address asking stock and order figures is read as the default', async () => {
    window.history.pushState({}, '', '/products?sort=finished-desc&stock=kits&adhoc=1');
    const get = vi.spyOn(api, 'getProductsPaged').mockResolvedValue({
      items: [product] as unknown as ProductListItem[],
      meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
      categories: [],
      uncategorized: 0,
      all_categories: 1,
      catalog_total: 1,
    });
    render(<ProductsPage />);
    await screen.findByText('Flask');
    const asked = get.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(asked.sort_by).toBe('name-asc');
    expect(asked).not.toHaveProperty('stock');
    expect(asked).not.toHaveProperty('include_adhoc');
  });

  it('offers no stock filter, no one-off toggle, and no stock, kits or orders sort', async () => {
    window.history.pushState({}, '', '/products');
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue({
      items: [product] as unknown as ProductListItem[],
      meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
      categories: [],
      uncategorized: 0,
      all_categories: 1,
      catalog_total: 1,
    });
    render(<ProductsPage />);
    await screen.findByText('Flask');
    expect(screen.queryByRole('combobox', { name: 'Stock' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'one-off' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /^Stock/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    const sort = await screen.findByRole('combobox', { name: /sort/i });
    const options = [...(sort as HTMLSelectElement).options].map((o) => o.value);
    expect(options.some((v) => /^(finished|kits|orders)-/.test(v))).toBe(false);
  });
});

describe('the customers for a reader without the orders’ read', () => {
  beforeEach(() => {
    auth.granted = new Set(['customers:read']);
    vi.spyOn(api, 'getCustomersSummary').mockResolvedValue({ total: 0, with_active: null, active_orders: null, total_price: null } as never);
  });

  it('a shared address asking order figures is read as the default', async () => {
    window.history.pushState({}, '', '/customers?show=active&sort=orders-desc');
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } } as never);
    render(<CustomersPage />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    const asked = get.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(asked.sort_by).toBe('name-asc');
    expect(asked).not.toHaveProperty('with_active');
    expect(screen.queryByRole('tab', { name: 'With active orders' })).toBeNull();
  });

  it('the table sorts by name alone', async () => {
    window.history.pushState({}, '', '/customers');
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue({
      items: [{ id: 1, code: 'CU-0001', name: 'ACME', kind: 'company', notes: null, contacts: [], figures: null }],
      meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
    } as never);
    render(<CustomersPage />);
    await screen.findByText('ACME');
    expect(screen.queryByRole('button', { name: /^Orders/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Total price/ })).toBeNull();
  });
});
