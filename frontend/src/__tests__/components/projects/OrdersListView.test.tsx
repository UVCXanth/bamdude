import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils';
import type { OrderListItem, OrderListPage } from '../../../api/client';
import { OrdersListView } from '../../../components/projects/OrdersListView';
import { ORDER_ROW_DEFAULTS } from '../../wireDefaults';

const row: OrderListItem = {
  ...ORDER_ROW_DEFAULTS,
  id: 1, code: 'OR-0001', name: 'Flasks', customer_id: null, customer_name: null, color: null, status: 'completed',
  stage: 'done', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00', lines_count: 1, ordered: 2, printed: 2,
  progress: 1, covered_units: 2, remaining: 0, from_stock_units: 0, issued_units: 2, line_products: [],
  prints_in_progress: 0, prints_queued: 0,
};
const page: OrderListPage = {
  items: [row],
  meta: { total: 1, current_page: 1, per_page: 24, last_page: 1 },
  totals: { active: 0, completed: 1, cancelled: 0, all: 1, stages: { prep: 0, printing: 0, qc: 0 } },
} as OrderListPage;

const base = {
  isPlaceholderData: false,
  sort: 'due-asc',
  onSortChange: () => {},
  perPage: 24,
  onPageChange: () => {},
  onPerPageChange: () => {},
  actions: { run: () => {}, create: () => {} },
};

// WS-13 E7 D04: a group's count is read with its heading — as text, not as a label on a <small>.
describe('OrdersListView groups', () => {
  it('names each customer group with the count of its rows on this page', () => {
    const named = { ...row, customer_id: 4, customer_name: 'ACME', status: 'active' as const };
    render(<OrdersListView {...base} data={{ ...page, items: [named] } as OrderListPage} isError={false} onRetry={() => {}} view="table" groupByCustomer />);
    const heading = screen.getByRole('heading', { level: 3, name: /ACME/ });
    // Text a screen reader reads with the heading — an aria-label on a <small> is not.
    expect(heading).toHaveTextContent('1 on this page');
  });
});

// WS-13 E7 C05: the list draws loading, transition and failures off listState.
describe('OrdersListView states', () => {
  it('waits with a skeleton shaped like the view', () => {
    const { unmount } = render(<OrdersListView {...base} data={undefined} isError={false} onRetry={() => {}} view="table" />);
    expect(screen.getByTestId('orders-skeleton')).toHaveAttribute('data-shape', 'table');
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    unmount();
    render(<OrdersListView {...base} data={undefined} isError={false} onRetry={() => {}} view="cards" />);
    expect(screen.getByTestId('orders-skeleton')).toHaveAttribute('data-shape', 'cards');
  });

  it('fails with an alert and a retry, and no rows, when its own key has nothing', () => {
    const retry = vi.fn();
    render(<OrdersListView {...base} data={undefined} isError onRetry={retry} view="table" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load the orders');
    within(alert).getByRole('button', { name: 'Retry' }).click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps its own rows and says a background re-read failed', () => {
    render(<OrdersListView {...base} data={page} isError onRetry={() => {}} view="table" />);
    expect(screen.getByText('Flasks')).toBeInTheDocument();
    expect(screen.getByText('Could not refresh')).toBeInTheDocument();
  });

  // V01 (Codex r1): an empty answer whose re-read failed — the note and its retry, no empty table.
  it('says a failed re-read of an empty answer with its retry, and draws no empty table', () => {
    const empty = { ...page, items: [], meta: { ...page.meta, total: 0 } } as OrderListPage;
    const retry = vi.fn();
    render(<OrdersListView {...base} data={empty} isError onRetry={retry} view="table" />);
    expect(screen.getByText('Could not refresh')).toBeInTheDocument();
    within(screen.getByText('Could not refresh').closest('p') as HTMLElement).getByRole('button', { name: 'Retry' }).click();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('draws nothing for an empty answer — the page owns its empty state', () => {
    const empty = { ...page, items: [], meta: { ...page.meta, total: 0 } } as OrderListPage;
    const { container } = render(<OrdersListView {...base} data={empty} isError={false} onRetry={() => {}} view="table" />);
    expect(container.querySelector('[data-testid="list-body"]')).toBeNull();
  });
});
