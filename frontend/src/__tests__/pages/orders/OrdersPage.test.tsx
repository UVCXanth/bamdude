/**
 * `render` from `__tests__/utils` wraps in a BrowserRouter with no route
 * option — route-aware tests set the URL with pushState first, as the other
 * page tests do.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { FarmNeeds, OrderBoard } from '../../../api/client';
import { OrdersPage } from '../../../pages/orders/OrdersPage';
import { SEARCH_DEBOUNCE_MS } from '../../../hooks/useSearchBox';

const rowA = { id: 1, name: 'A', status: 'active', customer_id: 1, customer_name: 'ACME', ordered: 2, printed: 1, covered_units: 1, remaining: 1, from_stock_units: 0, progress: 0.5, lines_count: 1, priority: 'normal', line_products: [] };
const rowB = { id: 2, name: 'B', status: 'completed', customer_id: null, customer_name: null, ordered: 1, printed: 1, covered_units: 1, remaining: 0, from_stock_units: 0, progress: 1, lines_count: 1, priority: 'normal', line_products: [] };

/** The paged envelope (spec projects-lists-parity): the tabs count from `totals`. */
const pageOf = (
  items: unknown[],
  over: { meta?: Partial<{ total: number; current_page: number; per_page: number; last_page: number }>; totals?: Partial<{ active: number; completed: number; cancelled: number; all: number }> } = {},
) => ({
  items,
  meta: { total: items.length, current_page: 1, per_page: 24, last_page: 1, ...over.meta },
  totals: { active: 1, completed: 1, cancelled: 0, all: 2, ...over.totals },
}) as never;

const boardOf = (over: Partial<OrderBoard> = {}): OrderBoard => ({
  prep: { items: [], total: 0 },
  printing: { items: [], total: 0 },
  qc: { items: [], total: 0 },
  done: { items: [], total: 0 },
  ...over,
}) as OrderBoard;

const EMPTY_FARM: FarmNeeds ={ rows: [], orders_count: 0, unknown_prints: 0, stock_unavailable: false, assumptions: ['slicer_estimate'] };

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('OrdersPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    vi.spyOn(api, 'getCustomers').mockResolvedValue([{ id: 1, name: 'ACME', figures: {} }] as never);
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue(EMPTY_FARM);
    vi.spyOn(api, 'getOrdersSummary').mockResolvedValue({ active: 4, overdue: 1, urgent: 2, printing: 3, queued: 7, remaining: 12, all_covered: 1 });
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(boardOf());
  });
  it('filters by responsible — «Mine» asks for the signed-in user, and the choice lands in the URL', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([{ id: 1, username: 'admin' }, { id: 7, username: 'ira' }]);
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    const select = await screen.findByLabelText('Responsible');
    await screen.findByRole('option', { name: 'ira' });
    fireEvent.change(select, { target: { value: '7' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ responsible_id: 7, page: 1 })));
    expect(window.location.search).toContain('responsible=7');
    fireEvent.change(select, { target: { value: 'me' } });
    // The msw user is id 1 (__tests__/mocks/handlers.ts, /auth/me).
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ responsible_id: 1 })));
  });
  it('draws the farm tiles from the summary, whatever the filter', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects?customer=1&q=lamp');
    render(<OrdersPage />);
    expect(await screen.findByTestId('orders-tile-active')).toHaveTextContent('4');
    expect(screen.getByTestId('orders-tile-active')).toHaveTextContent('overdue: 1 · urgent: 2');
    expect(screen.getByTestId('orders-tile-printing')).toHaveTextContent('3 / 7');
    expect(screen.getByTestId('orders-tile-remaining')).toHaveTextContent('12');
    expect(screen.getByTestId('orders-tile-covered')).toHaveTextContent('1');
    expect(api.getOrdersSummary).toHaveBeenCalledWith();
  });
  it('says the search also looks in tags', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    expect(await screen.findByRole('searchbox')).toHaveAttribute('placeholder', expect.stringMatching(/tag/i));
  });
  it('puts the view switch in the page header, beside the title', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    const header = await screen.findByTestId('list-page-header');
    expect(within(header).getByRole('group', { name: 'View' })).toBeInTheDocument();
    expect(within(header).getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('draws no section tabs — the sidebar carries them', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    await screen.findByTestId('list-page-header');
    expect(screen.queryByRole('navigation', { name: 'Projects' })).not.toBeInTheDocument();
  });
  it('falls back to the default view when the stored one is not a mode', async () => {
    localStorage.setItem('projects.view', 'timeline');
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    expect(await screen.findByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('asks the server for one page of the active tab and counts every tab from totals', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA], { totals: { active: 1, completed: 5, cancelled: 0, all: 6 } }));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    expect(await screen.findByText('A')).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith({ status: 'active', sort_by: 'updated-desc', page: 1, per_page: 24 });
    // Counts come from the server's totals, not from the rows on this page.
    expect(screen.getByRole('tab', { name: /active/i }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /completed/i }).textContent).toContain('5');
    expect(screen.getByRole('tab', { name: /all/i }).textContent).toContain('6');
  });
  it('reads tab, customer, search and page from the URL', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowB]));
    window.history.pushState({}, '', '/projects?tab=completed&customer=1&q=lamp&page=2');
    render(<OrdersPage />);
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith({ status: 'completed', customer_id: 1, q: 'lamp', sort_by: 'updated-desc', page: 2, per_page: 24 }),
    );
    expect(screen.getByRole('searchbox')).toHaveValue('lamp');
  });
  it('changing the tab or typing a search goes back to page 1 and lands in the URL', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA], { meta: { current_page: 3, last_page: 3, total: 60 } }));
    window.history.pushState({}, '', '/projects?page=3');
    render(<OrdersPage />);
    await screen.findByText('A');
    fireEvent.click(screen.getByRole('tab', { name: /all/i }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ sort_by: 'updated-desc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('?tab=all');
    // Exercise the debounce, not the speed of a loaded four-worker host.
    vi.useFakeTimers();
    try {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'gear' } });
      await act(() => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ q: 'gear', sort_by: 'updated-desc', page: 1, per_page: 24 }));
    expect(window.location.search).toContain('q=gear');
  });
  it('filters by customer and groups the page when asked', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA, rowB]));
    window.history.pushState({}, '', '/projects?tab=all');
    render(<OrdersPage />);
    await screen.findByText('A');
    fireEvent.click(screen.getByLabelText(/group by customer/i));
    expect(await screen.findByRole('heading', { name: 'ACME' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /no customer/i })).toBeInTheDocument();
    fireEvent.change(await screen.findByDisplayValue('All customers'), { target: { value: '1' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ customer_id: 1, page: 1 })));
    expect(window.location.search).toContain('customer=1');
  });
  it('the table sorts the whole list on the server — the forecast columns too', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    vi.spyOn(api, 'getOrdersForecast').mockResolvedValue({ orders: [] } as never);
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Table' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Order/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'name-asc' })));
    fireEvent.click(screen.getByRole('button', { name: /^Ready/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'ready-asc', page: 1 })));
    expect(window.location.search).toContain('sort=ready-asc');
  });
  it('an empty search offers to reset it, and the reset keeps the tab', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([], { totals: { active: 0, completed: 0, cancelled: 0, all: 0 } }));
    window.history.pushState({}, '', '/projects?tab=completed&q=zzz');
    render(<OrdersPage />);
    expect(await screen.findByText('Nothing matches your search or filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith({ status: 'completed', sort_by: 'updated-desc', page: 1, per_page: 24 }));
    expect(window.location.search).toBe('?tab=completed');
  });
  it('«Mine» with nothing of mine is a filter that matched nothing, with Reset — not an empty farm', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([], { totals: { active: 0, completed: 0, cancelled: 0, all: 0 } }));
    window.history.pushState({}, '', '/projects?tab=all&responsible=me');
    render(<OrdersPage />);
    expect(await screen.findByText('Nothing matches your search or filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.not.objectContaining({ responsible_id: expect.anything() })));
    expect(window.location.search).not.toContain('responsible');
  });
  it('a responsible user no longer offered still shows as the live filter', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([{ id: 7, username: 'ira' }]);
    window.history.pushState({}, '', '/projects?responsible=9');
    render(<OrdersPage />);
    await screen.findByRole('option', { name: 'ira' });
    expect(screen.getByLabelText('Responsible')).toHaveValue('9');
    expect(screen.getByRole('option', { name: '#9' })).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ responsible_id: 9 })));
  });
  it('the switch offers five views; kanban and deadlines hide the status tabs and the page bar', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA], { meta: { total: 30, last_page: 2 } }));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    await screen.findByText('Showing 1-24 of 30 orders');
    for (const name of ['Table', 'Cards', 'Kanban', 'Workspace', 'Deadlines']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Kanban' }));
    await waitFor(() => expect(screen.queryByRole('tablist')).not.toBeInTheDocument());
    expect(screen.queryByText('Showing 1-24 of 30 orders')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deadlines' }));
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(await screen.findByRole('tablist')).toBeInTheDocument(); // the workspace pages like the list
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    expect(await screen.findByText('Showing 1-24 of 30 orders')).toBeInTheDocument();
  });
  it('a stored kanban is restored, asks for the board with the shared filters and never for the list page', async () => {
    localStorage.setItem('projects.view', 'kanban');
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    const board = vi.spyOn(api, 'getOrderBoard').mockResolvedValue(boardOf());
    window.history.pushState({}, '', '/projects?customer=1&q=lamp');
    render(<OrdersPage />);
    expect(await screen.findByRole('button', { name: 'Kanban' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(board).toHaveBeenCalledWith({ customer_id: 1, q: 'lamp' }));
    expect(screen.getByRole('region', { name: 'Quality check' })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
  it('«…and N more» on the board opens the table with the column’s stage', async () => {
    localStorage.setItem('projects.view', 'kanban');
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(
      boardOf({ printing: { items: [{ ...rowA, code: 'OR-0001', stage: 'printing', prints_in_progress: 0, prints_queued: 0 } as never], total: 3 } }),
    );
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    fireEvent.click(await screen.findByRole('link', { name: 'and 2 more in the list' }));
    expect(await screen.findByText('Stage: Printing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'active', stage: 'printing' })));
  });
  it('a stage filter from the URL reaches the request and shows a chip that clears it', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects?stage=qc');
    render(<OrdersPage />);
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ stage: 'qc' })));
    expect(screen.getByText('Stage: Quality check')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove the stage filter' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.not.objectContaining({ stage: expect.anything() })));
    expect(window.location.search).not.toContain('stage');
  });
  it('draws the pagination bar from meta', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA], { meta: { total: 30, last_page: 2 } }));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    expect(await screen.findByText('Showing 1-24 of 30 orders')).toBeInTheDocument();
  });
  it('the table defaults to the due date, the cards to the last change — an explicit sort holds in both', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA], { meta: { total: 60, last_page: 3, current_page: 2 } }));
    vi.spyOn(api, 'getOrdersForecast').mockResolvedValue({ orders: [] } as never);
    window.history.pushState({}, '', '/projects?page=2');
    render(<OrdersPage />);
    await screen.findByText('A');
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'updated-desc', page: 2 }));
    // Another view is another default order, so the page it stood on means nothing there.
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'due-asc', page: 1 })));
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /^Order/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'name-asc' })));
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    await waitFor(() => expect(localStorage.getItem('projects.view')).toBe('cards'));
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'name-asc' }));
  });
  it('in cards, sorts from the toolbar — every server key, both ways', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    await screen.findByText('A');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'priority' } });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'priority-desc', page: 1 })));
    fireEvent.click(screen.getByRole('button', { name: 'Descending' }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'priority-asc' })));
  });
  it('the table sorts by customer on the server and says which column sorts', async () => {
    localStorage.setItem('projects.view', 'table');
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    vi.spyOn(api, 'getOrdersForecast').mockResolvedValue({ orders: [] } as never);
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    const due = await screen.findByRole('columnheader', { name: /^Due/ });
    expect(due).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(screen.getByRole('button', { name: /^Customer/ }));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sort_by: 'customer-asc' })));
    expect(await screen.findByRole('columnheader', { name: /^Customer/ })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getByRole('columnheader', { name: /^Due/ })).not.toHaveAttribute('aria-sort');
  });
  it('in the table, the page bar sits inside the table card', async () => {
    localStorage.setItem('projects.view', 'table');
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA], { meta: { total: 30, last_page: 2 } }));
    vi.spyOn(api, 'getOrdersForecast').mockResolvedValue({ orders: [] } as never);
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    const range = await screen.findByText('Showing 1-24 of 30 orders');
    expect(range.closest('.rounded-xl')?.querySelector('table')).toBeTruthy();
  });
  it('marks the list busy while the next page is on its way', async () => {
    let release: () => void = () => {};
    vi.spyOn(api, 'getOrdersPaged').mockImplementation((params) =>
      params.page === 2
        ? new Promise((r) => {
            release = () => r(pageOf([rowA], { meta: { total: 30, last_page: 2, current_page: 2 } }));
          })
        : Promise.resolve(pageOf([rowA], { meta: { total: 30, last_page: 2 } })),
    );
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);
    await screen.findByText('A');
    expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'true'));
    release();
    await waitFor(() => expect(screen.getByTestId('list-body')).toHaveAttribute('aria-busy', 'false'));
  });
  it('Back to a later page is not clamped by the previous answer still on screen', async () => {
    let release: () => void = () => {};
    const get = vi.spyOn(api, 'getOrdersPaged').mockImplementation((params) =>
      params.page === 3
        ? new Promise((r) => {
            release = () => r(pageOf([rowA], { meta: { total: 60, last_page: 3, current_page: 3 } }));
          })
        : Promise.resolve(pageOf([rowA])),
    );
    window.history.pushState({}, '', '/projects?q=a');
    render(<OrdersPage />);
    await screen.findByText('A');
    window.history.pushState({}, '', '/projects?page=3');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 })));
    release();
    expect(await screen.findByText('Showing 49-60 of 60 orders')).toBeInTheDocument();
    expect(window.location.search).toContain('page=3');
  });
  it('draws a skeleton grid while the FIRST fetch is in flight, and never over data', async () => {
    // ⚠️ `isLoading`, not `isFetching`. Every order mutation invalidates
    // `['projects']`, so a background refetch is routine — replacing the grid
    // with grey boxes each time would be worse than figures one request old.
    let resolve: (page: unknown) => void = () => {};
    vi.spyOn(api, 'getOrdersPaged').mockReturnValue(
      new Promise((r) => {
        resolve = r as (page: unknown) => void;
      }) as never,
    );
    window.history.pushState({}, '', '/projects');
    render(<OrdersPage />);

    const skeleton = await screen.findByTestId('orders-skeleton');
    expect(skeleton).toBeInTheDocument();
    // ⚠️ The grey boxes are `aria-hidden`, so without this the wait is SILENCE
    // to a screen reader and the page reads as having no orders. The status
    // role carries one visually-hidden sentence; the cards stay hidden so
    // nobody hears six empty ones.
    expect(skeleton).toHaveAttribute('role', 'status');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(within(skeleton).getByText('Loading...')).toBeInTheDocument();
    // The empty-state sentence is not the loading state — it would read as
    // "you have no orders" over a list that is simply still on its way.
    expect(screen.queryByText(/no active orders/i)).not.toBeInTheDocument();

    resolve(pageOf([rowA]));
    expect(await screen.findByText('A')).toBeInTheDocument();
    expect(screen.queryByTestId('orders-skeleton')).not.toBeInTheDocument();
  });

  it('drops the deleted order from the cache, so a click on a reused id cannot render it', async () => {
    // ⚠️ Nothing on THIS page watches `['project', 1]`, so an entry left in the
    // cache is never refetched and never noticed — and the app's `staleTime` is
    // a minute, long enough for the next navigation to render the order that
    // was just deleted straight out of cache. The order PAGE has the opposite
    // problem and removes its entry on unmount instead; the difference is why
    // the id is a parameter (`utils/queryInvalidation`).
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(pageOf([rowA]));
    vi.spyOn(api, 'deleteOrder').mockResolvedValue({} as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['project', 1], { id: 1, name: 'A' });

    window.history.pushState({}, '', '/projects');
    render(
      <QueryClientProvider client={client}>
        <OrdersPage />
      </QueryClientProvider>,
    );
    await screen.findByText('A');

    fireEvent.click(screen.getByTestId('order-1-menu'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /delete/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^confirm$/i }));

    await waitFor(() => expect(client.getQueryState(['project', 1])).toBeUndefined());
  });

  it('shows a chip per material the active orders need, amber when the shelf is short', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue({
      ...EMPTY_FARM, orders_count: 3,
      rows: [
        { material: 'PETG', colour: 'black', need_g: 3200, have_g: 1100, have_type_g: 4200, short_g: 2100, unknown_prints: 0, orders_count: 2 },
        { material: 'PLA', colour: null, need_g: 400, have_g: 900, have_type_g: 900, short_g: 0, unknown_prints: 0, orders_count: 1 },
      ],
    });
    render(<OrdersPage />);
    const chip = await screen.findByTestId('filament-strip-PETG-black');
    expect(chip).toHaveTextContent('PETG · black 3.2kg / 1.1kg');
    expect(chip).toHaveAttribute('data-short', 'true');
    expect(chip).toHaveAttribute('title', '2 orders');
    expect(screen.getByTestId('filament-strip-PLA')).toHaveAttribute('data-short', 'false');
  });

  it('shows chips with a dash for the shelf when it could not be read', async () => {
    // ⚠️ `stock_unavailable` with NOTHING short is the third state, and it is
    // not the collapsed line: «everything is on the shelf» would be a claim
    // the server explicitly refused to make (triage, final review).
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue({
      ...EMPTY_FARM, orders_count: 1, stock_unavailable: true,
      rows: [{ material: 'PETG', colour: null, need_g: 500, have_g: null, have_type_g: null, short_g: null, unknown_prints: 0, orders_count: 1 }],
    });
    render(<OrdersPage />);
    const chip = await screen.findByTestId('filament-strip-PETG');
    expect(chip).toHaveTextContent('/ —');
    expect(chip).toHaveAttribute('data-short', 'false');
    expect(screen.queryByTestId('filament-strip-covered')).not.toBeInTheDocument();
  });

  it('collapses to one line when nothing is short, and hides with no rows', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue({
      ...EMPTY_FARM, orders_count: 1,
      rows: [{ material: 'PLA', colour: null, need_g: 400, have_g: 900, have_type_g: 900, short_g: 0, unknown_prints: 0, orders_count: 1 }],
    });
    render(<OrdersPage />);
    expect(await screen.findByText('Filament: everything is on the shelf')).toBeInTheDocument();
  });

  it('does not claim the shelf covers a partial or wholly unknown requirement', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue({
      ...EMPTY_FARM, orders_count: 1,
      rows: [
        { material: 'PETG', colour: null, need_g: 120, have_g: 900, have_type_g: 900, short_g: 0, unknown_prints: 1, orders_count: 1 },
      ],
    });
    render(<OrdersPage />);
    const chip = await screen.findByTestId('filament-strip-PETG');
    expect(chip).toHaveTextContent('at least 120g / 900g');
    expect(chip).toHaveAttribute('title', '1 order · 1 print without grams');
    expect(screen.queryByTestId('filament-strip-covered')).not.toBeInTheDocument();
  });

  it('shows an untyped unknown requirement instead of hiding the strip', async () => {
    vi.spyOn(api, 'getOrdersFilament').mockResolvedValue({ ...EMPTY_FARM, unknown_prints: 1 });
    render(<OrdersPage />);
    expect(await screen.findByTestId('filament-strip')).toHaveTextContent('1 print with unknown filament');
    expect(screen.queryByTestId('filament-strip-covered')).not.toBeInTheDocument();
  });
});
