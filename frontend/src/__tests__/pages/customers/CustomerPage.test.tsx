/**
 * The `render` helper has no route/path option — the page reads `useParams`,
 * so the URL is set with pushState and the page is mounted under a matching
 * `<Route>` inside the helper's own BrowserRouter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Link, Routes, Route } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { api, ApiError } from '../../../api/client';
import { CustomerPage } from '../../../pages/customers/CustomerPage';
import { createAppQueryClient } from '../../../utils/appQueryClient';
import { ORDER_ROW_DEFAULTS } from '../../wireDefaults';

const blankContact = {
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
  orders_count: 0,
};
const customer = {
  id: 1,
  code: 'CU-0001',
  name: 'ACME',
  kind: 'company',
  notes: 'VIP',
  contacts: [
    {
      ...blankContact,
      id: 5,
      code: 'CT-0005',
      name: 'Olena',
      role: 'Accounting',
      phone: '+380 1',
      email: 'o@acme.ua',
      city: 'Kyiv',
      delivery_method_id: 1,
      delivery_method_name: 'Nova Poshta',
      delivery_details: 'branch 12',
      note: 'call first',
    },
    { ...blankContact, id: 6, code: 'CT-0006', name: 'Serhii' },
  ],
  figures: {
    projects: 2,
    active: 1,
    completed: 1,
    cancelled: 0,
    ordered: 12,
    printed: 7,
    covered_units: 9,
    total_cost: 30.5,
    total_price: 200,
  },
};

const orders = [
  {
    ...ORDER_ROW_DEFAULTS,
    id: 5,
    name: 'Flasks',
    status: 'active',
    customer_id: 1,
    customer_name: 'ACME',
    ordered: 10,
    printed: 5,
    covered_units: 5,
    remaining: 5,
    from_stock_units: 0,
    progress: 0.5,
    lines_count: 1,
    priority: 'normal',
    line_products: [],
  },
];

/** The paged envelope the page reads: tab counts are the server's `totals`. */
const ordersPage = {
  items: orders,
  meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
  totals: { active: 1, completed: 3, cancelled: 0, all: 4 },
};
const emptyPage = {
  items: [],
  meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 },
  totals: { active: 0, completed: 0, cancelled: 0, all: 0 },
};

/** A storage that refuses to read ONE key — the view's — and answers every other
 *  (the auth token, the theme) as usual. */
function refuseToRead(key: string) {
  const real = Storage.prototype.getItem;
  return vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
    if (k === key) throw new Error('storage denied');
    return real.call(this, k);
  });
}

function mountAt() {
  window.history.pushState({}, '', '/customers/1');
  render(
    <>
      <Link to="/customers/2">next customer</Link>
      <Routes>
        <Route path="/customers/:id" element={<CustomerPage />} />
      </Routes>
    </>,
  );
}

afterEach(() => {
  window.history.pushState({}, '', '/');
});

function asReader() {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 2,
        username: 'viewer',
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 2, name: 'Viewers' }],
        permissions: ['orders:read', 'products:read', 'customers:read', 'stock:read'],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

describe('CustomerPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    // The page lists the customer's issues too (spec workshop-order-issue, rule 30).
    vi.spyOn(api, 'getDispatchNotes').mockResolvedValue({
      items: [],
      meta: { total: 0, current_page: 1, per_page: 20, last_page: 1 },
    });
  });

  it("shows three tiles and one server page of the customer's orders", async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);

    mountAt();

    expect(await screen.findByText('Flasks')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith({ customer_id: 1, status: 'active', sort_by: 'due-asc', page: 1, per_page: 24 });
    // Tab counts are the server's totals, not the rows on this page.
    expect(screen.getByRole('tab', { name: /completed/i }).textContent).toContain('3');
    expect(screen.getByTestId('customer-tile-orders')).toHaveTextContent('2');
    // covered / ordered from the detail figures — the tile's own figure and a bar, never recomputed.
    const covered = screen.getByTestId('customer-tile-covered');
    expect(covered).toHaveTextContent('9 / 12');
    expect(covered).toHaveTextContent('printed: 7');
    expect(within(covered).getByTestId('customer-covered-fill')).toHaveStyle({ width: '75%' });
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it("counts nothing it does not know yet, and its orders list is the tab's panel (WS-13 E2 C02/C05)", async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    let answer!: (page: never) => void;
    vi.spyOn(api, 'getOrdersPaged').mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    mountAt();
    const completed = await screen.findByRole('tab', { name: /completed/i });
    expect(completed).toHaveTextContent('(—)');
    expect(completed).not.toHaveTextContent('(0)');
    answer(ordersPage as never);
    expect(await screen.findByText('Flasks')).toBeInTheDocument();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: /active/i }).id);
    expect(within(panel).getByText('Flasks')).toBeInTheDocument();
  });

  it("opens the customer's orders as a table by due date when nothing was chosen; a stored cards view keeps its order; a URL sort wins (WS-13 E2 B05/R03)", async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    expect(await screen.findByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'due-asc' })));
  });

  it('keeps a stored cards view with its own order, and a URL sort wins (WS-13 E2 B05/R03)', async () => {
    localStorage.setItem('bamdude-customer-orders-view', 'cards');
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    expect(await screen.findByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'updated-desc' })));
  });

  it('a storage that cannot be read still shows the orders, as a table (WS-13 E2 B05)', async () => {
    refuseToRead('bamdude-customer-orders-view');
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    expect(await screen.findByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Flasks')).toBeInTheDocument();
  });

  it('shows the code and kind under the name, and every contact', async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    expect(await screen.findByText('CU-0001 · Company')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Contacts' });
    expect(within(section).getByText('CT-0005')).toBeInTheDocument();
    expect(within(section).getAllByText('main')).toHaveLength(1);
    expect(within(section).getByText('Accounting')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'o@acme.ua' })).toHaveAttribute('href', 'mailto:o@acme.ua');
    expect(within(section).getByText('Kyiv · Nova Poshta · branch 12')).toBeInTheDocument();
    expect(within(section).getByText('call first')).toBeInTheDocument();
  });

  describe('the page as the mockup draws it (WS-13 E11 E)', () => {
    it('the header: «code · type», Edit, the primary New order, and a menu with Delete only — no note there', async () => {
      vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
      vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
      vi.spyOn(api, 'getCustomers').mockResolvedValue([customer] as never);
      mountAt();
      const header = await screen.findByTestId('customer-header');
      expect(within(header).getByRole('heading', { level: 1, name: 'ACME' })).toHaveAttribute('tabindex', '-1');
      expect(within(header).getByText('CU-0001 · Company')).toBeInTheDocument();
      expect(within(header).queryByText('VIP')).toBeNull();
      expect(within(header).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      fireEvent.click(within(header).getByRole('button', { name: 'Actions for ACME' }));
      expect(within(await screen.findByRole('menu')).getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual([
        'Delete',
      ]);
      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
      fireEvent.click(within(header).getByRole('button', { name: 'New order' }));
      const form = await screen.findByRole('dialog', { name: 'New order' });
      await waitFor(() => expect(within(form).getByLabelText('Customer')).toHaveValue('1'));
      // The orders section has no «new order» button of its own any more.
      expect(screen.queryByRole('button', { name: /New order for this customer/ })).toBeNull();
    });

    it('a reader sees the customer, with no Edit, no New order and no menu', async () => {
      asReader();
      vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
      vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
      mountAt();
      const header = await screen.findByTestId('customer-header');
      await waitFor(() => expect(within(header).queryByRole('button')).toBeNull());
    });

    it('two columns — the product page\'s grid; the left panel: avatar, contacts, team note', async () => {
      vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
      vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
      mountAt();
      const layout = await screen.findByTestId('customer-layout');
      expect(layout.className).toContain('grid-cols-[clamp(260px,17vw,360px)_minmax(0,1fr)]');
      expect(layout.className).toContain('max-[1101px]:grid-cols-[240px_minmax(0,1fr)]');
      expect(layout.className).toContain('max-[761px]:grid-cols-1');
      const left = within(layout).getByTestId('customer-side');
      expect(within(left).getByText('A')).toHaveAttribute('aria-hidden', 'true');
      expect(within(left).getByRole('heading', { level: 3, name: 'Contacts' })).toBeInTheDocument();
      expect(within(left).getByRole('heading', { level: 3, name: 'Team note' })).toBeInTheDocument();
      expect(within(left).getByText('VIP')).toHaveClass('whitespace-pre-wrap');
      const right = within(layout).getByTestId('customer-main');
      expect(within(right).getByTestId('customer-tile-orders')).toHaveTextContent('1 active · 1 completed · 0 cancelled');
      expect(within(right).getByRole('heading', { level: 2, name: 'Orders' })).toBeInTheDocument();
    });

    it('no note says so', async () => {
      vi.spyOn(api, 'getCustomer').mockResolvedValue({ ...customer, notes: null } as never);
      vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
      mountAt();
      expect(await screen.findByText('No notes.')).toBeInTheDocument();
    });

    it('the orders row: the heading, the status tabs and the view switch together', async () => {
      vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
      vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
      mountAt();
      const head = await screen.findByTestId('customer-orders-head');
      expect(within(head).getByRole('heading', { level: 2, name: 'Orders' })).toBeInTheDocument();
      expect(within(head).getByRole('tablist')).toBeInTheDocument();
      expect(within(head).getByRole('group', { name: 'View' })).toBeInTheDocument();
    });

    it('«Issues from stock» with its caption, the customer\'s notes keyed by the customer', async () => {
      vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
      vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
      mountAt();
      expect(await screen.findByRole('heading', { level: 2, name: 'Issues from stock' })).toBeInTheDocument();
      expect(screen.getByText('every dispatch note — with an order or without')).toBeInTheDocument();
    });
  });

  it('says so when there are no contacts', async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue({ ...customer, contacts: [] } as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    expect(await screen.findByText('No contacts')).toBeInTheDocument();
  });

  it('keeps tab and page in the URL', async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    fireEvent.click(await screen.findByRole('tab', { name: /completed/i }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed', page: 1 })));
    expect(window.location.search).toContain('tab=completed');
  });

  it('says «nothing ordered» instead of an empty covered tile', async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue({
      ...customer,
      figures: { ...customer.figures, ordered: 0, covered_units: 0 },
    } as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    mountAt();
    expect(await screen.findByTestId('customer-tile-covered')).toHaveTextContent('nothing ordered');
  });

  it("never shows the previous customer's orders while the next customer's load", async () => {
    vi.spyOn(api, 'getCustomer').mockImplementation(
      async (id: number) => ({ ...customer, id, name: id === 1 ? 'ACME' : 'Beta' }) as never,
    );
    let release: (value: never) => void = () => {};
    vi.spyOn(api, 'getOrdersPaged').mockImplementation((params) =>
      params.customer_id === 1
        ? Promise.resolve(ordersPage as never)
        : new Promise<never>((resolve) => {
            release = resolve;
          }),
    );
    mountAt();
    expect(await screen.findByText('Flasks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'next customer' }));
    expect(await screen.findByRole('heading', { name: 'Beta' })).toBeInTheDocument();
    expect(screen.queryByText('Flasks')).not.toBeInTheDocument();
    release(emptyPage as never);
  });

  it('names the error when there is no customer to fall back on', async () => {
    vi.spyOn(api, 'getCustomer').mockRejectedValue(new Error('Gateway timeout'));
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(emptyPage as never);

    mountAt();

    expect(await screen.findByText(/could not load this customer/i)).toBeInTheDocument();
    expect(screen.getByText(/gateway timeout/i)).toBeInTheDocument();
    expect(screen.queryByText(/customer not found/i)).not.toBeInTheDocument();
  });

  it('says a customer that does not exist is not found, with the way back to the list', async () => {
    // WS-13 E13 H05: a link to a deleted customer is a 404 — «not found», as a product and a
    // stock position say it, never the red «could not load», and never a dead end.
    vi.spyOn(api, 'getCustomer').mockRejectedValue(new ApiError('Customer not found', 404));
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(emptyPage as never);

    mountAt();

    expect(await screen.findByText('Customer not found')).toBeInTheDocument();
    expect(screen.queryByText(/could not load this customer/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'To customers' })).toHaveAttribute('href', '/customers');
  });

  it('keeps the rendered customer when a background refetch fails', async () => {
    localStorage.setItem('bamdude-customer-orders-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    // TanStack v5 turns the query's status to "error" on ANY failed fetch and
    // keeps `data` while it does. Every order action on this page invalidates
    // ['customer', id], so a refetch that fails must not replace a customer
    // that is still cached with a load error.
    const get = vi
      .spyOn(api, 'getCustomer')
      .mockResolvedValueOnce(customer as never)
      .mockRejectedValue(new Error('Gateway timeout'));
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    vi.spyOn(api, 'updateOrder').mockResolvedValue({ ...orders[0], status: 'cancelled' } as never);

    mountAt();

    expect(await screen.findByRole('heading', { name: 'ACME' })).toBeInTheDocument();

    // Cancelling the order invalidates ['customer', id]; that refetch fails.
    // The order's own menu — the customer's «Actions for …» is in the header (WS-13 E11 E01).
    fireEvent.click(await within(await screen.findByTestId('customer-main')).findByRole('button', { name: /actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    // Cancelling asks first (WS-13 E6 B05).
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    expect(screen.queryByText(/could not load this customer/i)).not.toBeInTheDocument();
  });
  it('says once that it could not refresh, and keeps the customer on screen', async () => {
    localStorage.setItem('bamdude-customer-orders-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    const client = createAppQueryClient();
    // The retry is the app's, the delay is not: an exponential backoff would put
    // the toast a second away for no gain.
    client.setDefaultOptions({ queries: { retry: false, staleTime: 60_000 } });

    vi.spyOn(api, 'getCustomer')
      .mockResolvedValueOnce(customer as never)
      .mockRejectedValue(new Error('Gateway timeout'));
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    vi.spyOn(api, 'updateOrder').mockResolvedValue({ ...orders[0], status: 'cancelled' } as never);

    window.history.pushState({}, '', '/customers/1');
    render(
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/customers/:id" element={<CustomerPage />} />
        </Routes>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    // The order's own menu — the customer's «Actions for …» is in the header (WS-13 E11 E01).
    fireEvent.click(await within(await screen.findByTestId('customer-main')).findByRole('button', { name: /actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel order' }));

    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    expect(screen.getAllByText(/could not refresh/i)).toHaveLength(1);
  });

  it('opens the issue dialog from «Mark completed» instead of closing the order', async () => {
    localStorage.setItem('bamdude-customer-orders-view', 'cards'); // a test about the cards (WS-13 E2 B05)
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    vi.spyOn(api, 'getFulfilment').mockResolvedValue({
      lines: [],
      ordered: 0,
      issued: 0,
      held: 0,
      fully_issued: true,
      closes_to_stock: false,
      can_complete: true,
      can_assemble: 0,
      can_receive: 0,
      can_issue: 0,
      recipient: { name: null, phone: null, delivery_method: null, delivery_details: null },
    });
    mountAt();
    expect(await screen.findByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    // The order's own menu — the customer's «Actions for …» is in the header (WS-13 E11 E01).
    fireEvent.click(await within(await screen.findByTestId('customer-main')).findByRole('button', { name: /actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark completed' }));
    expect(await screen.findByRole('dialog', { name: 'Stock & issue' })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('forgets the deleted customer, so a Back inside staleTime cannot render it', async () => {
    const client = createAppQueryClient();
    const get = vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);
    vi.spyOn(api, 'deleteCustomer').mockResolvedValue(undefined as never);

    window.history.pushState({}, '', '/customers/1');
    render(
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/customers/:id" element={<CustomerPage />} />
          <Route path="/customers" element={<p>customer list</p>} />
        </Routes>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for ACME' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog', { name: 'Delete customer?' });
    expect(confirm).toHaveTextContent('Its orders (2) stay, without a customer.');
    expect(confirm).toHaveTextContent('The active ones (1) will then close to stock instead of being issued.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('customer list')).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(['customer', 1])).toBeUndefined());
    expect(get).toHaveBeenCalledTimes(1);
  });
  // WS-13 E7 C05 (R03): a failed read of the customer's orders is not «no orders».
  it('says its orders could not be read instead of showing the empty tab', async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    const get = vi.spyOn(api, 'getOrdersPaged').mockRejectedValue(new Error('down'));
    mountAt();
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('Could not load the orders');
    expect(screen.queryByText('No active orders')).not.toBeInTheDocument();
    get.mockResolvedValue(ordersPage as never);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Flasks')).toBeInTheDocument();
  });
});
