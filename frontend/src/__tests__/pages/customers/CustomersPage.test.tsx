/**
 * `render` from `__tests__/utils` wraps in a BrowserRouter with no route
 * option — route-aware tests set the URL with pushState first, the way
 * `OrdersPage.test.tsx` does.
 *
 * The page asks `getCustomersPaged` (spec projects-lists-parity): search,
 * sort and page live in the URL; the view mode and page size are preferences.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../../utils';
import { server } from '../../mocks/server';
import { api } from '../../../api/client';
import { CustomersPage } from '../../../pages/customers/CustomersPage';

const contact = (over: Record<string, unknown>) => ({
  id: 10,
  code: 'CT-0010',
  name: null,
  role: null,
  phone: null,
  email: null,
  city: null,
  delivery_method_id: null,
  delivery_method_name: null,
  delivery_details: null,
  note: null,
  orders_count: 0,
  ...over,
});
const customers = [
  {
    id: 1,
    code: 'CU-0001',
    name: 'ACME',
    kind: 'regular',
    notes: null,
    contacts: [
      contact({
        id: 10,
        code: 'CT-0010',
        name: 'Olena',
        phone: '+380 67 1',
        email: 'olena@acme.ua',
        city: 'Kyiv',
        delivery_method_name: 'Nova Poshta',
        delivery_details: 'branch 12',
      }),
      contact({ id: 11, code: 'CT-0011', name: 'Serhii', role: 'Warehouse', note: 'mornings only' }),
    ],
    figures: { projects: 3, active: 1, completed: 2, cancelled: 0, total_price: 450 },
  },
];

const pageOf = (items: unknown[], meta: Partial<{ total: number; current_page: number; per_page: number; last_page: number }> = {}) =>
  ({ items, meta: { total: items.length, current_page: 1, per_page: 24, last_page: 1, ...meta } }) as never;

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
        permissions: ['projects:read'],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

async function openMenu(name = 'ACME') {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return within(await screen.findByRole('menu'));
}

describe('CustomersPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(api, 'getCustomersSummary').mockResolvedValue({
      customers: 9,
      regular: 2,
      with_active: 3,
      active_orders: 5,
      total_price: 1234.5,
    });
  });

  it('draws the farm tiles from the summary', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    expect(await screen.findByTestId('customers-tile-customers')).toHaveTextContent('9');
    expect(screen.getByTestId('customers-tile-with-active')).toHaveTextContent('3');
    expect(screen.getByTestId('customers-tile-active-orders')).toHaveTextContent('5');
    // The shared money formatter: symbol in front, two decimals — the digits are the server's.
    expect(screen.getByTestId('customers-tile-total')).toHaveTextContent('$1234.50');
  });

  it('«With active orders» asks the server and lands in the URL; «All» clears it', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    // Underline tabs (S04), not a segmented group (WS-13 E11 B03).
    const tabs = await screen.findByRole('tablist', { name: 'Show' });
    expect(within(tabs).getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(tabs).getByRole('tab', { name: 'With active orders' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ with_active: true, page: 1 })));
    expect(window.location.search).toContain('show=active');
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    fireEvent.click(within(tabs).getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.not.objectContaining({ with_active: true })));
    expect(window.location.search).not.toContain('show=');
  });

  it('«Regular» asks the server for that kind and lands in the URL, exclusive with «With active orders»', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Regular' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'regular', page: 1 })));
    expect(window.location.search).toContain('show=regular');
    fireEvent.click(screen.getByRole('tab', { name: 'With active orders' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ with_active: true })));
    expect(get).toHaveBeenLastCalledWith(expect.not.objectContaining({ kind: 'regular' }));
    expect(window.location.search).toContain('show=active');
  });

  it('the customers tile says how many are regular, in the mockup\'s words', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const tile = await screen.findByTestId('customers-tile-customers');
    expect(tile).toHaveTextContent('Total customers');
    expect(tile).toHaveTextContent('2 regular');
  });

  it('an unknown ?show= is «All», and the URL is left as it is', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
    window.history.pushState({}, '', '/customers?show=zzz');
    render(<CustomersPage />);
    expect(await screen.findByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('?show=zzz');
  });

  describe('the list\'s states (WS-13 E11 B05)', () => {
    it('the first read is a skeleton of the view, never an empty table', async () => {
      vi.spyOn(api, 'getCustomersPaged').mockReturnValue(new Promise(() => {}) as never);
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      const skeleton = await screen.findByTestId('customers-skeleton');
      expect(skeleton).toHaveAttribute('data-shape', 'table');
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(screen.queryByText('No customers yet')).not.toBeInTheDocument();
    });

    it('a failed read is an alert with a retry — never «No customers yet»', async () => {
      const get = vi
        .spyOn(api, 'getCustomersPaged')
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce(pageOf(customers));
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Could not load the customers');
      expect(screen.queryByText('No customers yet')).not.toBeInTheDocument();
      fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('ACME')).toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(2);
    });

    it('a failed background re-read keeps the rows and says so', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
      vi.spyOn(api, 'getCustomersPaged').mockResolvedValueOnce(pageOf(customers)).mockRejectedValueOnce(new Error('HTTP 500'));
      window.history.pushState({}, '', '/customers');
      render(
        <QueryClientProvider client={client}>
          <CustomersPage />
        </QueryClientProvider>,
      );
      await screen.findByText('ACME');
      await act(async () => {
        await client.invalidateQueries({ queryKey: ['customers'] });
      });
      expect(await screen.findByText('Could not refresh')).toBeInTheDocument();
      expect(screen.getByText('ACME')).toBeInTheDocument();
    });

    it('nothing under a search says «No customers found» with its reset; an empty farm says so plainly', async () => {
      const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
      window.history.pushState({}, '', '/customers?q=zzz');
      render(<CustomersPage />);
      expect(await screen.findByText('No customers found')).toBeInTheDocument();
      expect(screen.queryByText('No customers yet')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
      await waitFor(() => expect(get).toHaveBeenLastCalledWith({ sort_by: 'name-asc', page: 1, per_page: 24 }));
      expect(await screen.findByText('No customers yet')).toBeInTheDocument();
    });
  });

  it('a sort key with no column in the table is named above it and can be taken off (B06)', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers?sort=created-desc');
    render(<CustomersPage />);
    const chip = await screen.findByTestId('customers-sort-chip');
    expect(chip).toHaveTextContent('Sorted by: Created ↓');
    fireEvent.click(within(chip).getByRole('button', { name: 'Remove the sorting' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'name-asc', page: 1 })));
    expect(screen.queryByTestId('customers-sort-chip')).not.toBeInTheDocument();
  });

  it('the heading takes the focus a vanished trigger gives up (B01)', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Customers' })).toHaveAttribute('tabindex', '-1');
  });

  describe('a customer\'s actions (WS-13 E11 H)', () => {
    it('one menu on the row: Edit · New order · Delete', async () => {
      vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      const menu = await openMenu();
      expect(menu.getAllByRole('menuitem').map((i) => i.textContent?.trim())).toEqual(['Edit', 'New order', 'Delete']);
      expect(screen.getByRole('menu').querySelector('[role="separator"]')).not.toBeNull();
    });

    it('a reader has no menu', async () => {
      asReader();
      vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      await screen.findByText('ACME');
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Actions for ACME' })).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /new customer/i })).not.toBeInTheDocument();
    });

    it('Delete names the orders it unlinks and what happens to the active ones', async () => {
      vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
      const del = vi.spyOn(api, 'deleteCustomer');
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      (await openMenu()).getByRole('menuitem', { name: 'Delete' }).click();
      const dialog = await screen.findByRole('dialog', { name: 'Delete customer?' });
      expect(dialog).toHaveAccessibleDescription('CU-0001 · ACME');
      expect(dialog).toHaveTextContent('Its orders (3) stay, without a customer.');
      expect(dialog).toHaveTextContent('The active ones (1) will then close to stock instead of being issued.');
      expect(dialog).toHaveTextContent('Issued dispatch notes keep the recipient’s name. The customer’s contacts will be deleted.');
      expect(del).not.toHaveBeenCalled();
    });

    it('a customer with no orders is told only what happens to its notes and contacts (R08)', async () => {
      vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(
        pageOf([{ ...customers[0], figures: { projects: 0, active: 0, completed: 0, cancelled: 0, total_price: 0 } }]),
      );
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      (await openMenu()).getByRole('menuitem', { name: 'Delete' }).click();
      const dialog = await screen.findByRole('dialog', { name: 'Delete customer?' });
      expect(dialog).not.toHaveTextContent('stay, without a customer');
      expect(dialog).not.toHaveTextContent('close to stock');
      expect(dialog).toHaveTextContent('Issued dispatch notes keep the recipient’s name.');
    });

    it('a delete sends once, says so, and the focus goes to the heading when the row is gone', async () => {
      const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValueOnce(pageOf(customers)).mockResolvedValue(pageOf([]));
      const del = vi.spyOn(api, 'deleteCustomer').mockResolvedValue({ message: 'Customer deleted' } as never);
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      (await openMenu()).getByRole('menuitem', { name: 'Delete' }).click();
      const dialog = await screen.findByRole('dialog', { name: 'Delete customer?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      await waitFor(() => expect(del).toHaveBeenCalledWith(1));
      expect(await screen.findByText('Customer deleted')).toBeInTheDocument();
      await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Customers' })).toHaveFocus());
      expect(del).toHaveBeenCalledTimes(1);
    });

    it('«New order» opens the order form with this customer chosen', async () => {
      vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
      vi.spyOn(api, 'getCustomers').mockResolvedValue(customers as never);
      window.history.pushState({}, '', '/customers');
      render(<CustomersPage />);
      (await openMenu()).getByRole('menuitem', { name: 'New order' }).click();
      const dialog = await screen.findByRole('dialog', { name: 'New order' });
      await waitFor(() => expect(within(dialog).getByLabelText('Customer')).toHaveValue('1'));
    });
  });

  it('the table shows code, kind, the main contact and a row that opens to every contact', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const row = await screen.findByTestId('customer-1-row');
    expect(within(row).getByText('Regular · CU-0001')).toBeInTheDocument();
    expect(within(row).getByText('Olena')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '+380 67 1' })).toHaveAttribute('href', 'tel:+380671');
    expect(within(row).getByRole('link', { name: 'olena@acme.ua' })).toHaveAttribute('href', 'mailto:olena@acme.ua');
    expect(within(row).getByText('Kyiv · Nova Poshta · branch 12')).toBeInTheDocument();
    // Named by the customer: every row has one, and a screen reader must tell them apart.
    const toggle = within(row).getByRole('button', { name: 'All contacts of ACME' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const all = await screen.findByTestId('customer-1-contacts');
    expect(within(all).getByText('CT-0011')).toBeInTheDocument();
    // A note may hold several lines (the old contact text moves there whole).
    expect(within(all).getByText('mornings only')).toHaveClass('whitespace-pre-line');
    expect(within(all).getAllByText('main')).toHaveLength(1);
  });

  it('a customer with one contact has no expand button', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(
      pageOf([{ ...customers[0], contacts: [customers[0].contacts[0]] }]),
    );
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const row = await screen.findByTestId('customer-1-row');
    expect(within(row).queryByRole('button', { name: /All contacts/ })).not.toBeInTheDocument();
  });

  it('the card shows code, kind and «main contact +N · city»', async () => {
    localStorage.setItem('bamdude-customers-view', 'cards');
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const card = await screen.findByTestId('customer-1-card');
    expect(within(card).getByText('CU-0001')).toBeInTheDocument();
    expect(within(card).getByText('Regular')).toBeInTheDocument();
    expect(within(card).getByText('Olena +1 · Kyiv')).toBeInTheDocument();
  });

  it('puts the view switch in the page header, beside the title', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const header = await screen.findByTestId('list-page-header');
    expect(within(header).getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(within(header).getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('draws no section tabs — the sidebar carries them', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    await screen.findByTestId('list-page-header');
    expect(screen.queryByRole('navigation', { name: 'Projects' })).not.toBeInTheDocument();
  });

  it('falls back to the default view when the stored one is not a mode', async () => {
    localStorage.setItem('bamdude-customers-view', 'kanban');
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    expect(await screen.findByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('lists customers with their light figures, one page by name', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const row = (await screen.findByText('ACME')).closest('tr')!;
    expect(row.textContent).toContain('3'); // orders
    // total price, through the shared money formatter — symbol in front, two decimals
    expect(row.textContent).toContain('$450.00');
    expect(screen.getByRole('link', { name: 'ACME' })).toHaveAttribute('href', '/customers/1');
    expect(get).toHaveBeenLastCalledWith({ sort_by: 'name-asc', page: 1, per_page: 24 });
  });

  it('searches from the URL and into it', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers?q=acme&page=2');
    render(<CustomersPage />);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ q: 'acme', sort_by: 'name-asc', page: 2, per_page: 24 }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'x.ua' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ q: 'x.ua', sort_by: 'name-asc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('?q=x.ua');
  });

  it('switches to cards, remembers it, and a card shows the same figures', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cards' }));
    const card = await screen.findByTestId('customer-1-card');
    expect(card).toHaveTextContent('Olena +1 · Kyiv');
    expect(card).toHaveTextContent('3 orders');
    expect(card).toHaveTextContent('$450.00');
    expect(localStorage.getItem('bamdude-customers-view')).toBe('cards');
  });

  it('sorts by a column on the server', async () => {
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    await screen.findByText('ACME');
    fireEvent.click(screen.getByRole('button', { name: /Total price/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'total_price-desc' })));
    expect(window.location.search).toContain('sort=total_price-desc');
  });

  it('creates a customer through the modal', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf([]));
    const create = vi
      .spyOn(api, 'createCustomer')
      .mockResolvedValue({ id: 2, code: 'CU-0002', name: 'Bob', kind: 'company', notes: null, contacts: [], figures: {} } as never);
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    fireEvent.click(await screen.findByRole('button', { name: /new customer/i }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: 'Bob', kind: 'company', notes: null, contacts: [] }));
  });
  it('in cards, sorts from the toolbar — the key and both directions', async () => {
    localStorage.setItem('bamdude-customers-view', 'cards');
    const get = vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    await screen.findByTestId('customer-1-card');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'total_price' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'total_price-desc', page: 1 })));
    fireEvent.click(screen.getByRole('button', { name: 'Descending' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'total_price-asc' })));
  });

  it('in the table, the page bar sits inside the table card', async () => {
    vi.spyOn(api, 'getCustomersPaged').mockResolvedValue(pageOf(customers, { total: 30, last_page: 2 }));
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    const range = await screen.findByText('Showing 1-24 of 30 customers');
    expect(range.closest('.rounded-xl')?.querySelector('table')).toBeTruthy();
  });

  it('marks the list busy while the next page is on its way', async () => {
    let release: () => void = () => {};
    vi.spyOn(api, 'getCustomersPaged').mockImplementation((params) =>
      params.page === 2
        ? new Promise((r) => {
            release = () => r(pageOf(customers, { total: 30, last_page: 2, current_page: 2 }));
          })
        : Promise.resolve(pageOf(customers, { total: 30, last_page: 2 })),
    );
    window.history.pushState({}, '', '/customers');
    render(<CustomersPage />);
    await screen.findByText('ACME');
    expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'true'));
    release();
    await waitFor(() => expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'false'));
  });

  it('Back to a later page is not clamped by the previous answer still on screen', async () => {
    let release: () => void = () => {};
    const get = vi.spyOn(api, 'getCustomersPaged').mockImplementation((params) =>
      params.page === 3
        ? new Promise((r) => {
            release = () => r(pageOf(customers, { total: 60, last_page: 3, current_page: 3 }));
          })
        : Promise.resolve(pageOf(customers)),
    );
    window.history.pushState({}, '', '/customers?q=acme');
    render(<CustomersPage />);
    await screen.findByText('ACME');
    window.history.pushState({}, '', '/customers?page=3');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })));
    release();
    expect(await screen.findByText('Showing 49-60 of 60 customers')).toBeInTheDocument();
    expect(window.location.search).toContain('page=3');
  });
});
