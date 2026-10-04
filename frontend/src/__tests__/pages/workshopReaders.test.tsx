/**
 * A READER of the Workshop (WS-13 E13 G02) — the four Workshop reads and the read rights a page
 * needs to render, and none of the Workshop's create / update / delete rights —
 * is offered no write action. A control the reader may not use is ABSENT, not merely
 * greyed: a hidden control is never reachable by the keyboard either. Each target also
 * gets its positive control, so a test that finds nothing proves something.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useRef } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { render } from '../utils';
import { api } from '../../api/client';
import type {
  Customer,
  DispatchNote,
  Permission,
  ProductListItem,
  StockFigures,
  StockItem,
  StockItemsPage,
  StockListPage,
} from '../../api/client';
import { StockPage } from '../../pages/stock/StockPage';
import { DispatchNotePage } from '../../pages/stock/DispatchNotePage';
import { ProductsPage } from '../../pages/products/ProductsPage';
import { OrdersPage } from '../../pages/orders/OrdersPage';
import { CustomersTable } from '../../components/customers/CustomersTable';
import { useCustomerActions } from '../../components/customers/useCustomerActions';
import { WaybillEditor } from '../../components/stock/WaybillEditor';
import { ORDER_ROW_DEFAULTS, PRODUCT_ROW_DEFAULTS, STOCK_ROW_DEFAULTS } from '../wireDefaults';

const auth = vi.hoisted(() => ({ granted: new Set<string>(), userId: 5 }));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
      canModify: (resource: string, action: string, createdById: number | null | undefined) => {
        if (auth.granted.has(`${resource}:${action}_all`)) return true;
        if (auth.granted.has(`${resource}:${action}_own`)) return createdById != null && createdById === auth.userId;
        return false;
      },
    }),
  };
});

/** What a reader holds: the Workshop and the pages it reads beside it, nothing that writes. */
const READER = ['orders:read', 'products:read', 'customers:read', 'stock:read', 'library:read_all', 'archives:read_all', 'printers:read', 'inventory:read'];

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  auth.granted = new Set(READER);
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

// ---------------------------------------------------------------- StockPage

const position: StockItem = {
  id: 3,
  code: 'SK-0003',
  product: { id: 1, name: 'Lamp', sku: null, has_cover: false },
  configuration: { choices: [], changed_parts: [] },
  location: null,
  on_hand: 4,
  reserved: 1,
  available: 3,
  min_qty: 0,
  below_min: false,
  short_by: 0,
  can_assemble: 0,
};
const figures: StockFigures = { kits: 3, kit_products: 1, parts: 8, reserved_kits: 2, incomplete: 1 };

function mockStock() {
  vi.spyOn(api, 'getStockItems').mockResolvedValue({
    items: [position],
    meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
  } as StockItemsPage);
  vi.spyOn(api, 'getStockItemsSummary').mockResolvedValue({ on_hand: 4, reserved: 1, available: 3, tracked: 1, below_min: 0 });
  vi.spyOn(api, 'getStockPaged').mockResolvedValue({
    items: [{ ...STOCK_ROW_DEFAULTS, id: 1, name: 'Lamp', is_active: true, sku: null, version: null, category: null, status: 'ready', origin: 'catalog', kits_available: 3, reserved_kits: 0, parts: [], reservations: [] }],
    meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
  } as unknown as StockListPage);
  vi.spyOn(api, 'getStockFigures').mockResolvedValue(figures);
  vi.spyOn(api, 'getStockJournal').mockResolvedValue({ items: [], next_cursor: null, meta: null });
  vi.spyOn(api, 'getSettings').mockResolvedValue({ date_format: 'system' } as never);
  vi.spyOn(api, 'getProducts').mockResolvedValue([]);
  vi.spyOn(api, 'getDispatchNotes').mockResolvedValue({
    items: [],
    meta: { total: 0, current_page: 1, per_page: 1, last_page: 1 },
  } as never);
}

describe('StockPage — a reader moves nothing', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/stock');
    mockStock();
  });

  it('offers neither «Assemble from parts…» nor «Receipt», and a position only opens', async () => {
    render(<StockPage />);
    fireEvent.click(await screen.findByTestId('finished-3-menu'));
    const items = within(screen.getByTestId('finished-3-menu-panel')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Open position']);
    expect(screen.queryByRole('button', { name: 'Assemble from parts…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Receipt' })).toBeNull();
  });

  it('offers them with the right to change orders', async () => {
    auth.granted = new Set([...READER, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    render(<StockPage />);
    expect(await screen.findByRole('button', { name: 'Assemble from parts…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receipt' })).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('finished-3-menu'));
    expect(within(screen.getByTestId('finished-3-menu-panel')).getAllByRole('menuitem').length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------- DispatchNotePage + WaybillEditor

const note: DispatchNote = {
  id: 42,
  code: 'DN-0042',
  created_at: '2026-09-28T09:30:00',
  project_id: 5,
  order_code: 'OR-0005',
  order_name: 'Hall lights',
  customer_id: 2,
  customer_name: 'ACME',
  units: 3,
  lines_count: 1,
  summary: [],
  recipient_name: 'Ivan',
  recipient_phone: '+380',
  delivery_method: 'Nova Poshta',
  delivery_details: 'Kyiv, branch 5',
  waybill: '2045',
  note: null,
  created_by_name: 'olena',
  supplier: { name: 'BamDude Workshop', address: 'Kyiv', phone: '', code: '1234', iban: '' },
  lines: [
    {
      position: 1,
      product_id: 1,
      product_name: 'Lamp',
      sku: null,
      configuration: { choices: [], changed_parts: [] },
      part_name: null,
      quantity: 3,
    },
  ],
};

function renderNote() {
  window.history.pushState({}, '', '/stock/dispatch-notes/42');
  return render(
    <Routes>
      <Route path="/stock/dispatch-notes/:id" element={<DispatchNotePage />} />
    </Routes>,
  );
}

describe('DispatchNotePage — a reader reads and prints the note, and edits no waybill', () => {
  beforeEach(() => {
    vi.spyOn(api, 'getDispatchNote').mockResolvedValue(note);
  });

  it('shows the waybill and «Print», with no pencil', async () => {
    renderNote();
    await screen.findByTestId('dispatch-note-sheet');
    const controls = screen.getByTestId('dispatch-note-controls');
    expect(within(controls).getByText('Waybill 2045')).toBeInTheDocument();
    expect(within(controls).getByRole('button', { name: /Print/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit the waybill' })).toBeNull();
  });

  it('offers the pencil with the right to change orders', async () => {
    auth.granted = new Set([...READER, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    renderNote();
    expect(await screen.findByRole('button', { name: 'Edit the waybill' })).toBeInTheDocument();
  });
});

describe('WaybillEditor — read-only is a sentence, not a disabled field', () => {
  it('without the right it says the waybill and offers nothing to press', () => {
    render(<WaybillEditor noteId={42} waybill="2045" canEdit={false} />);
    expect(screen.getByText('Waybill 2045')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('says there is none, still with nothing to press', () => {
    render(<WaybillEditor noteId={42} waybill={null} canEdit={false} />);
    expect(screen.getByText('No waybill')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('with the right offers the pencil, which opens the field', () => {
    render(<WaybillEditor noteId={42} waybill="2045" canEdit />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit the waybill' }));
    expect(screen.getByRole('textbox', { name: 'Waybill no.' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- ProductsPage

const productRow = {
  ...PRODUCT_ROW_DEFAULTS,
  id: 1,
  code: 'PR-0001',
  name: 'Flask',
  is_active: true,
  sku: null,
  version: null,
  category: null,
  status: 'ready',
  origin: 'catalog',
  origin_file_id: null,
  origin_plate_index: null,
  cover_image_filename: null,
  has_cover: false,
  parts_count: 2,
  plates_count: 1,
  lines_count: 0,
  kits_available: 0,
  finished_available: 0,
  materials: [],
  colors: [],
  models: [],
  sliced: true,
};

function mockProducts() {
  vi.spyOn(api, 'getProductsPaged').mockResolvedValue({
    items: [productRow] as unknown as ProductListItem[],
    meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
    categories: [],
    uncategorized: 0,
    all_categories: 1,
    catalog_total: 1,
  } as never);
}

describe('ProductsPage — a reader exports, and creates or changes nothing', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/products');
    mockProducts();
  });

  it('no «New product», «From file…», «Import…» or «Manage categories»; a row only exports', async () => {
    render(<ProductsPage />);
    fireEvent.click(await screen.findByTestId('product-1-row-menu'));
    const items = within(screen.getByTestId('product-1-row-menu-panel')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Export ZIP']);
    expect(screen.queryByRole('button', { name: /New product/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /From file…/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import…/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Manage categories/ })).toBeNull();
  });

  it('with the rights to create and to change, they are offered', async () => {
    auth.granted = new Set([...READER, 'orders:create', 'products:create', 'customers:create', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    render(<ProductsPage />);
    expect(await screen.findByRole('button', { name: /New product/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Manage categories/ })).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('product-1-row-menu'));
    const items = within(screen.getByTestId('product-1-row-menu-panel')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(expect.arrayContaining(['Edit', 'Duplicate']));
  });
});

// ---------------------------------------------------------------- OrdersPage

const orderRow = {
  ...ORDER_ROW_DEFAULTS,
  id: 1,
  code: 'OR-0001',
  name: 'A',
  status: 'active',
  customer_id: 1,
  customer_name: 'ACME',
  ordered: 2,
  printed: 1,
  covered_units: 1,
  remaining: 1,
  from_stock_units: 0,
  progress: 0.5,
  lines_count: 1,
  priority: 'normal',
  line_products: [],
};

function mockOrders() {
  vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 1, name: 'ACME', figures: {} }] as never);
  vi.spyOn(api, 'getOrdersFilament').mockResolvedValue({
    rows: [],
    orders_count: 0,
    unknown_prints: 0,
    stock_unavailable: false,
    assumptions: ['slicer_estimate'],
  });
  vi.spyOn(api, 'getOrdersSummary').mockResolvedValue({
    active: 1,
    overdue: 0,
    urgent: 0,
    printing: 0,
    queued: 0,
    remaining: 1,
    all_covered: 0,
    qc: 0,
  });
  vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
  vi.spyOn(api, 'getOrderBoard').mockResolvedValue({
    prep: { items: [], total: 0 },
    printing: { items: [], total: 0 },
    qc: { items: [], total: 0 },
    done: { items: [], total: 0 },
  } as never);
  vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
    items: [orderRow],
    meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
    totals: { active: 1, completed: 0, cancelled: 0, all: 1 },
  } as never);
}

describe('OrdersPage — a reader opens orders, and creates or changes none', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/projects');
    mockOrders();
  });

  it('no «New order», and a row carries no actions menu', async () => {
    render(<OrdersPage />);
    await screen.findByText('A');
    expect(screen.queryByTestId('order-1-menu')).toBeNull();
    expect(screen.queryByRole('button', { name: /New order/ })).toBeNull();
  });

  it('with the rights to create and to change, they are offered', async () => {
    auth.granted = new Set([...READER, 'orders:create', 'products:create', 'customers:create', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    render(<OrdersPage />);
    expect(await screen.findByRole('button', { name: /New order/ })).toBeInTheDocument();
    expect(await screen.findByTestId('order-1-menu')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- CustomersTable + useCustomerActions

const acme = {
  id: 1,
  code: 'CU-0001',
  name: 'ACME',
  kind: 'regular',
  notes: null,
  contacts: [],
  figures: { projects: 1, active: 1, completed: 0, cancelled: 0, total_price: 10 },
} as unknown as Customer;

/** The list's own wiring: the host's rights decide the row menu. */
function CustomersHost() {
  const heading = useRef<HTMLHeadingElement>(null);
  const actions = useCustomerActions({ context: 'list', fallbackFocusRef: heading });
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Customers
      </h1>
      <CustomersTable customers={[acme]} actions={actions} sort="name-asc" onSortChange={() => {}} />
      {actions.host}
    </>
  );
}

describe('CustomersTable — a reader gets no actions column', () => {
  it('no «Actions» header and no row menu', async () => {
    render(<CustomersHost />);
    const region = await screen.findByRole('region', { name: 'Customers' });
    const headers = within(region)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[▲▼]/g, '').trim());
    expect(headers).not.toContain('Actions');
    expect(screen.queryByTestId('customer-1-menu')).toBeNull();
  });

  it('with the right to change customers the column and the menu are there', async () => {
    auth.granted = new Set([...READER, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    render(<CustomersHost />);
    const region = await screen.findByRole('region', { name: 'Customers' });
    const headers = within(region)
      .getAllByRole('columnheader')
      .map((th) => th.textContent?.replace(/[▲▼]/g, '').trim());
    expect(headers).toContain('Actions');
    expect(screen.getByTestId('customer-1-menu')).toBeInTheDocument();
  });
});

describe('useCustomerActions — the menu offers exactly what the rights allow', () => {
  const menuOf = () => {
    fireEvent.click(screen.getByTestId('customer-1-menu'));
    return within(screen.getByTestId('customer-1-menu-panel'))
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
  };

  it('a reader is offered nothing', async () => {
    render(<CustomersHost />);
    await screen.findByRole('region', { name: 'Customers' });
    expect(screen.queryByTestId('customer-1-menu')).toBeNull();
  });

  it('the right to create offers «New order» alone', async () => {
    auth.granted = new Set([...READER, 'orders:create', 'products:create', 'customers:create']);
    render(<CustomersHost />);
    await screen.findByRole('region', { name: 'Customers' });
    expect(menuOf()).toEqual(['New order']);
  });

  it('the right to delete offers «Delete» alone', async () => {
    auth.granted = new Set([...READER, 'orders:delete', 'products:delete', 'customers:delete']);
    render(<CustomersHost />);
    await screen.findByRole('region', { name: 'Customers' });
    expect(menuOf()).toEqual(['Delete']);
  });

  it('every right offers every action, in the menu’s order', async () => {
    auth.granted = new Set([...READER, 'orders:create', 'products:create', 'customers:create', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'orders:delete', 'products:delete', 'customers:delete']);
    render(<CustomersHost />);
    await screen.findByRole('region', { name: 'Customers' });
    expect(menuOf()).toEqual(['Edit', 'New order', 'Delete']);
  });
});
