import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { OrdersTable } from '../../../components/projects/OrdersTable';
import type { OrderForecast, OrderListItem } from '../../../api/client';

const row = (over: Partial<OrderListItem>): OrderListItem => ({
  id: 1, code: 'OR-0001', name: 'A', customer_id: null, customer_name: null, color: null, status: 'active',
  stage: 'prep', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal',
  price: null, tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00', lines_count: 1, ordered: 10, printed: 4,
  progress: 0.4, covered_units: 4, remaining: 6, from_stock_units: 0, issued_units: 0, line_products: [], prints_in_progress: 2, prints_queued: 3, ...over,
});

const fc = (over: Partial<OrderForecast>): OrderForecast => ({
  project_id: 1, now_eta: null, now_seconds: null, after_eta: null, after_seconds: null, machine_seconds: null,
  unknown_prints: 0, unroutable_prints: 0, eta_complete: true, ahead_count: 0, assumptions: ['drying'], ...over,
});

const noSort = { sort: 'updated-desc', onSortChange: () => {} };
// The order's name is the link in its first cell; the code sits beneath it.
const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(within(r).getAllByRole('cell')[0]).getByRole('link').textContent);

describe('OrdersTable', () => {
  it('keeps the server order and asks the server to sort — a fresh numeric column most-first', async () => {
    const onSort = vi.fn();
    render(
      <OrdersTable
        orders={[row({ id: 1, name: 'A', prints_queued: 3 }), row({ id: 2, name: 'B', prints_queued: 9 })]}
        sort="updated-desc"
        onSortChange={onSort}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Queued (jobs)' }));
    expect(onSort).toHaveBeenLastCalledWith('queued-desc');
    // The table never reorders what the server sent.
    expect(names()).toEqual(['A', 'B']);
    expect(screen.getAllByText('OR-0001')).toHaveLength(2); // the fixture's code, under each name
    expect(screen.getByTestId('order-1-queued')).toHaveTextContent('3');
    expect(screen.getByTestId('order-1-printing')).toHaveTextContent('2');
  });

  it('flips the active column, and name / due start ascending', async () => {
    const onSort = vi.fn();
    render(<OrdersTable orders={[row({ id: 1 })]} sort="queued-desc" onSortChange={onSort} />);
    expect(screen.getByRole('columnheader', { name: /Queued/ })).toHaveAttribute('aria-sort', 'descending');
    await userEvent.click(screen.getByRole('button', { name: /Queued/ }));
    expect(onSort).toHaveBeenLastCalledWith('queued-asc');
    await userEvent.click(screen.getByRole('button', { name: 'Order' }));
    expect(onSort).toHaveBeenLastCalledWith('name-asc');
    await userEvent.click(screen.getByRole('button', { name: 'Due' }));
    expect(onSort).toHaveBeenLastCalledWith('due-asc');
  });

  it('the forecast columns sort on the server too — soonest ready first, most machine time first', async () => {
    const onSort = vi.fn();
    render(<OrdersTable orders={[row({ id: 1 })]} sort="updated-desc" onSortChange={onSort} />);
    const ready = screen.getByRole('button', { name: 'Ready' });
    expect(ready).not.toHaveAttribute('title');
    await userEvent.click(ready);
    expect(onSort).toHaveBeenLastCalledWith('ready-asc');
    await userEvent.click(screen.getByRole('button', { name: 'Machine h' }));
    expect(onSort).toHaveBeenLastCalledWith('hours-desc');
  });

  it('reddens a past deadline but not today’s', () => {
    const p = (n: number) => String(n).padStart(2, '0');
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
    };
    render(<OrdersTable orders={[row({ id: 1, due_date: day(0) }), row({ id: 2, due_date: day(-1) })]} {...noSort} />);
    expect(screen.getByTestId('order-1-due')).not.toHaveClass('text-red-500');
    expect(screen.getByTestId('order-2-due')).toHaveClass('text-red-500');
  });

  it('shows ready-at and machine hours from the forecast', () => {
    const forecasts = {
      1: fc({ project_id: 1, now_eta: '2026-09-07T10:00:00Z', now_seconds: 7200, after_eta: '2026-09-08T10:00:00Z', after_seconds: 93600, machine_seconds: 5400, ahead_count: 1 }),
      2: fc({ project_id: 2, now_eta: '2026-09-06T14:00:00Z', now_seconds: 3600, after_eta: '2026-09-06T14:00:00Z', after_seconds: 3600, machine_seconds: 3600 }),
    };
    render(<OrdersTable orders={[row({ id: 1, name: 'A' }), row({ id: 2, name: 'B' })]} forecasts={forecasts} {...noSort} />);
    expect(screen.getByTestId('order-1-machine-hours')).toHaveTextContent('1:30');
    expect(screen.getByTestId('order-1-after')).toHaveTextContent(/after 1 more urgent order/);
    expect(screen.queryByTestId('order-2-after')).not.toBeInTheDocument();
  });

  it('renders «…» while the forecast is missing and «No estimate» for a null ETA', () => {
    render(<OrdersTable orders={[row({ id: 1, name: 'A' })]} forecasts={{ 1: fc({ unknown_prints: 3 }) }} {...noSort} />);
    expect(screen.getByTestId('order-1-ready')).toHaveTextContent('No estimate');
    render(<OrdersTable orders={[row({ id: 5, name: 'C' })]} {...noSort} />);
    expect(screen.getByTestId('order-5-ready')).toHaveTextContent('…');
  });

  it('does not call the placed subset ready when the forecast is incomplete', () => {
    render(
      <OrdersTable
        orders={[row({ id: 1, name: 'A' })]}
        forecasts={{ 1: fc({ now_eta: '2026-09-07T10:00:00Z', eta_complete: false, unroutable_prints: 1 }) }}
        {...noSort}
      />,
    );
    expect(screen.getByTestId('order-1-ready')).toHaveTextContent('Incomplete estimate');
    expect(screen.getByTestId('order-1-ready')).not.toHaveTextContent('Sep');
  });

  it('a failed fetch reads as an error, never as «No estimate»', () => {
    // ⚠️ Three states share these cells and only one is about the farm.
    // Mapping a dead request onto «No estimate» — which means «the simulation
    // could place nothing» — sends the operator hunting a scheduling problem
    // that is really a broken request.
    render(<OrdersTable orders={[row({ id: 1, name: 'A' })]} forecastError {...noSort} />);
    const ready = screen.getByTestId('order-1-ready');
    expect(ready).toHaveTextContent('—');
    expect(ready).not.toHaveTextContent('No estimate');
    expect(within(ready).getByTitle('Forecast unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('order-1-machine-hours')).toHaveTextContent('—');
  });

  it('a closed order is dashed in both cells — closed means nothing is planned', () => {
    // The batch is not even asked about it (spec Decision 9), so `forecasts`
    // legitimately has no entry; without this branch the cell would read
    // «No estimate» and invite somebody to go looking for a printer.
    render(
      <OrdersTable
        orders={[row({ id: 1, name: 'A', status: 'completed' })]}
        forecasts={{ 2: fc({ project_id: 2 }) }}
        {...noSort}
      />,
    );
    const ready = screen.getByTestId('order-1-ready');
    expect(ready).toHaveTextContent('—');
    expect(ready).not.toHaveTextContent('No estimate');
    expect(screen.getByTestId('order-1-machine-hours')).toHaveTextContent('—');
  });

  it('shows the stage in place of the status, sorts by it, and names who is responsible', async () => {
    const onSort = vi.fn();
    render(
      <OrdersTable
        orders={[row({ id: 1, stage: 'printing', responsible_name: 'olena.koval' }), row({ id: 2, stage: null, status: 'cancelled' })]}
        sort="updated-desc"
        onSortChange={onSort}
      />,
    );
    expect(screen.queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument();
    expect(screen.getByText('Printing')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument(); // a cancelled order has no stage
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.getByText('olena.koval')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Responsible' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stage' }));
    expect(onSort).toHaveBeenLastCalledWith('stage-asc');
  });
});
