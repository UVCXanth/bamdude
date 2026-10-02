import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { OrdersTable } from '../../../components/projects/OrdersTable';
import type { OrderForecast, OrderListItem } from '../../../api/client';
import type { ForecastState } from '../../../components/projects/orderRow/readiness';
import { FORECAST_DEFAULTS, ORDER_ROW_DEFAULTS } from '../../wireDefaults';

// The row menu is permission-gated; the provider stays real, only the hook answers «yes».
vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), hasPermission: () => true }) };
});

const row = (over: Partial<OrderListItem>): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id: 1, code: 'OR-0001', name: 'A', customer_id: null, customer_name: null, color: null, status: 'active',
  stage: 'prep', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal',
  price: null, tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00', lines_count: 1, ordered: 10, printed: 4,
  progress: 0.4, covered_units: 4, remaining: 6, from_stock_units: 0, issued_units: 0, line_products: [], prints_in_progress: 2, prints_queued: 3, ...over,
});

const fc = (over: Partial<OrderForecast>): OrderForecast => ({
  ...FORECAST_DEFAULTS,
  project_id: 1, now_eta: null, now_seconds: null, after_eta: null, after_seconds: null, machine_seconds: null,
  unknown_prints: 0, unroutable_prints: 0, eta_complete: true, ahead_count: 0, assumptions: [], ...over,
});

const forecastOf = (byId: Record<number, OrderForecast> = {}, state: ForecastState = 'data') => ({ state, byId, refetch: () => {} });
const actions = { run: vi.fn(), create: vi.fn() };
const noSort = { sort: 'updated-desc', onSortChange: () => {}, forecast: forecastOf(), actions };
// The order's name is the link in its first cell.
const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((r) => within(within(r).getAllByRole('cell')[0]).getByRole('link').textContent);
const cell = (id: number, col: number) => within(screen.getByTestId(`order-row-${id}`)).getAllByRole('cell')[col];

describe('OrdersTable (WS-13 E7 D)', () => {
  it('has exactly the nine columns of the mockup, in order', () => {
    render(<OrdersTable orders={[row({})]} {...noSort} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim() || h.getAttribute('aria-label'));
    expect(headers).toEqual(['Order / customer', 'Stage', 'Coverage', 'Print / queue', 'Due', 'Ready ≈', 'Material', 'Responsible', 'Actions']);
  });

  it('scrolls sideways in its own named region inside the panel, the page bar under it and outside the scroll', () => {
    render(<OrdersTable orders={[row({})]} {...noSort} footer={<div data-testid="page-bar">pages</div>} />);
    const region = screen.getByRole('region', { name: 'Orders' });
    expect(within(region).getByRole('table')).toBeInTheDocument();
    const bar = screen.getByTestId('page-bar');
    expect(region.contains(bar)).toBe(false);
    expect(region.parentElement?.contains(bar)).toBe(true);
  });

  it('names the order, its code above, the customer and the lines below', () => {
    render(<OrdersTable orders={[row({ id: 1, customer_name: 'ACME', lines_count: 3 }), row({ id: 2, code: 'OR-0002', name: 'B' })]} {...noSort} />);
    const first = cell(1, 0);
    expect(within(first).getByRole('link', { name: 'A' })).toHaveAttribute('href', '/projects/1');
    expect(first.textContent).toMatch(/^OR-0001A/);
    expect(first).toHaveTextContent('ACME · 3 lines');
    expect(cell(2, 0)).toHaveTextContent('No customer · 1 line');
  });

  it('keeps the server order and asks the server to sort from the five mockup headers', async () => {
    const onSort = vi.fn();
    render(<OrdersTable orders={[row({ id: 1, name: 'A' }), row({ id: 2, name: 'B' })]} {...noSort} onSortChange={onSort} />);
    expect(names()).toEqual(['A', 'B']);
    await userEvent.click(screen.getByRole('button', { name: 'Order / customer' }));
    expect(onSort).toHaveBeenLastCalledWith('name-asc');
    await userEvent.click(screen.getByRole('button', { name: 'Stage' }));
    expect(onSort).toHaveBeenLastCalledWith('stage-asc');
    await userEvent.click(screen.getByRole('button', { name: 'Coverage' }));
    expect(onSort).toHaveBeenLastCalledWith('progress-desc');
    await userEvent.click(screen.getByRole('button', { name: 'Due' }));
    expect(onSort).toHaveBeenLastCalledWith('due-asc');
    await userEvent.click(screen.getByRole('button', { name: 'Ready ≈' }));
    expect(onSort).toHaveBeenLastCalledWith('ready-asc');
    for (const plain of ['Print / queue', 'Material', 'Responsible']) {
      expect(screen.queryByRole('button', { name: plain })).not.toBeInTheDocument();
    }
  });

  it('marks the active header, and none for a key no header carries', () => {
    const { unmount } = render(<OrdersTable orders={[row({})]} {...noSort} sort="due-desc" />);
    expect(screen.getByRole('columnheader', { name: /Due/ })).toHaveAttribute('aria-sort', 'descending');
    unmount();
    render(<OrdersTable orders={[row({})]} {...noSort} sort="hours-desc" />);
    expect(screen.getAllByRole('columnheader').filter((h) => h.hasAttribute('aria-sort'))).toHaveLength(0);
  });

  it('puts the stage, «issued X of Y» and a non-normal priority in the stage cell', () => {
    render(<OrdersTable orders={[row({ id: 1, stage: 'printing', issued_units: 3, priority: 'high' }), row({ id: 2, stage: null, status: 'cancelled' })]} {...noSort} />);
    expect(cell(1, 1)).toHaveTextContent('Printing');
    expect(cell(1, 1)).toHaveTextContent('issued 3 of 10');
    expect(cell(1, 1)).toHaveTextContent('High');
    expect(cell(2, 1)).toHaveTextContent('Cancelled');
    expect(cell(2, 1)).not.toHaveTextContent('issued');
  });

  it('shows coverage with its sources, live counts, materials and the responsible person', () => {
    render(
      <OrdersTable
        orders={[row({ id: 1, from_stock_units: 2, covered_units: 6, progress: 0.6, materials: ['PLA', 'PETG'], responsible_name: 'olena.koval' }), row({ id: 2, prints_in_progress: 0, prints_queued: 0 })]}
        {...noSort}
      />,
    );
    expect(cell(1, 2)).toHaveTextContent('6 / 10');
    expect(cell(1, 2)).toHaveTextContent('60%');
    expect(cell(1, 2)).toHaveTextContent('printed 4 · from stock 2');
    expect(within(cell(1, 3)).getByLabelText('printing 2, queued 3')).toBeInTheDocument();
    expect(cell(2, 3)).toHaveTextContent('—');
    expect(cell(1, 6)).toHaveTextContent('PLA, PETG');
    expect(cell(2, 6)).toHaveTextContent('—');
    expect(cell(1, 7)).toHaveTextContent('olena.koval');
    expect(cell(2, 7)).toHaveTextContent('unassigned');
  });

  it('reddens a past deadline with «overdue» under it, but not today’s', () => {
    const p = (n: number) => String(n).padStart(2, '0');
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T00:00:00`;
    };
    render(<OrdersTable orders={[row({ id: 1, due_date: day(0) }), row({ id: 2, due_date: day(-1) })]} {...noSort} />);
    expect(screen.getByTestId('order-1-due')).not.toHaveTextContent('overdue');
    expect(screen.getByTestId('order-2-due')).toHaveTextContent('overdue');
  });

  it('reads «Ready ≈» through one rule, and a failed forecast is a dash, never «no estimate»', () => {
    const byId = {
      1: fc({ project_id: 1, now_eta: '2026-09-07T10:00:00Z', after_eta: '2026-09-08T10:00:00Z', ahead_count: 1 }),
      2: fc({ project_id: 2, eta_complete: false, now_eta: '2026-09-07T10:00:00Z', incomplete_reasons: [{ code: 'unroutable', count: 1 }] }),
      3: fc({ project_id: 3, now_eta: '2026-09-07T10:00:00Z', incomplete_reasons: [{ code: 'no_plate', count: 6 }] }),
      4: fc({ project_id: 4 }),
    };
    const orders = [row({ id: 1 }), row({ id: 2 }), row({ id: 3 }), row({ id: 4 }), row({ id: 5, remaining: 0 }), row({ id: 6, status: 'completed' })];
    const { unmount } = render(<OrdersTable orders={orders} {...noSort} forecast={forecastOf(byId)} />);
    expect(screen.getByTestId('order-1-ready')).toHaveTextContent(/after 1 more urgent order/);
    expect(screen.getByTestId('order-2-ready')).toHaveTextContent('incomplete estimate');
    expect(within(screen.getByTestId('order-3-ready')).getByRole('img', { name: /Parts on no plate: 6/ })).toBeInTheDocument();
    expect(screen.getByTestId('order-4-ready')).toHaveTextContent('no estimate');
    expect(screen.getByTestId('order-5-ready')).toHaveTextContent('all covered');
    expect(screen.getByTestId('order-6-ready')).toHaveTextContent('—');
    unmount();
    render(<OrdersTable orders={[row({ id: 1 })]} {...noSort} forecast={forecastOf({}, 'error')} />);
    expect(screen.getByTestId('order-1-ready')).toHaveTextContent('—');
    expect(screen.getByTestId('order-1-ready')).not.toHaveTextContent('no estimate');
  });

  it('has the order menu in its last column', async () => {
    render(<OrdersTable orders={[row({ id: 1 })]} {...noSort} />);
    const trigger = within(cell(1, 8)).getByRole('button', { name: 'Order actions OR-0001' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
  });

  // V04 (Codex r1): the forecast's assumptions keep their hint beside the date (B03).
  it('keeps the forecast’s assumptions beside the date, apart from the reasons', () => {
    render(<OrdersTable orders={[row({ id: 1 })]} {...noSort} forecast={forecastOf({ 1: fc({ project_id: 1, now_eta: '2026-10-06T09:00:00Z', assumptions: ['stagger'] }) })} />);
    expect(within(cell(1, 5)).getByLabelText(/^Not counted in this estimate:/)).toBeInTheDocument();
    expect(within(cell(1, 5)).queryByRole('img', { name: /^Incomplete estimate/ })).not.toBeInTheDocument();
  });
});
