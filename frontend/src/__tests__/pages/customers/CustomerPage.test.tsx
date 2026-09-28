/**
 * The `render` helper has no route/path option — the page reads `useParams`,
 * so the URL is set with pushState and the page is mounted under a matching
 * `<Route>` inside the helper's own BrowserRouter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Link, Routes, Route } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { CustomerPage } from '../../../pages/customers/CustomerPage';
import { createAppQueryClient } from '../../../utils/appQueryClient';

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

describe('CustomerPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    // The page lists the customer's issues too (spec workshop-order-issue, rule 30).
    vi.spyOn(api, 'getCustomerIssues').mockResolvedValue({
      items: [],
      meta: { total: 0, current_page: 1, per_page: 20, last_page: 1 },
    });
  });

  it("shows three tiles and one server page of the customer's orders", async () => {
    vi.spyOn(api, 'getCustomer').mockResolvedValue(customer as never);
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(ordersPage as never);

    mountAt();

    expect(await screen.findByText('Flasks')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith({ customer_id: 1, status: 'active', sort_by: 'updated-desc', page: 1, per_page: 24 });
    // Tab counts are the server's totals, not the rows on this page.
    expect(screen.getByRole('tab', { name: /completed/i }).textContent).toContain('3');
    expect(screen.getByTestId('customer-tile-orders')).toHaveTextContent('2');
    // covered / ordered from the detail figures — drawn by ProgressBar, never recomputed.
    expect(screen.getByText('9 / 12')).toBeInTheDocument();
    expect(screen.getByTestId('customer-tile-covered')).toHaveTextContent('printed: 7');
    expect(screen.getByText('VIP')).toBeInTheDocument();
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

  it('keeps the rendered customer when a background refetch fails', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: /actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    expect(screen.getByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    expect(screen.queryByText(/could not load this customer/i)).not.toBeInTheDocument();
  });
  it('says once that it could not refresh, and keeps the customer on screen', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: /actions/i }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));

    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    expect(screen.getAllByText(/could not refresh/i)).toHaveLength(1);
  });

  it('opens the issue dialog from «Mark completed» instead of closing the order', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: /actions/i }));
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
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByText('customer list')).toBeInTheDocument();
    await waitFor(() => expect(client.getQueryData(['customer', 1])).toBeUndefined());
    expect(get).toHaveBeenCalledTimes(1);
  });
});
