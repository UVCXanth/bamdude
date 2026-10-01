import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { OrderDeadlines, OrderListItem } from '../../../api/client';
import { OrdersDeadlines } from '../../../components/projects/OrdersDeadlines';

const order = (over: Partial<OrderListItem>): OrderListItem => ({
  id: 1, code: 'OR-0001', name: 'Ten flasks', customer_id: 2, customer_name: 'ACME', color: null, status: 'active',
  stage: 'printing', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00Z', lines_count: 1, ordered: 10, printed: 4,
  covered_units: 4, remaining: 6, from_stock_units: 0, progress: 0.4, prints_in_progress: 0, prints_queued: 0,
  line_products: [], ...over,
}) as OrderListItem;

const answer = (over: Partial<OrderDeadlines> = {}): OrderDeadlines => ({
  start: '2026-10-05',
  days: 14,
  due: [
    { order: order({ id: 1, due_date: '2026-10-07T00:00:00' }), eta: '2026-10-06T09:00:00', late: false, estimate_reasons: [] },
    { order: order({ id: 2, code: 'OR-0002', name: 'Lamp', stage: 'qc', due_date: '2026-10-08T00:00:00' }), eta: '2026-10-12T09:00:00', late: true, estimate_reasons: [] },
  ],
  eta_marks: [{ id: 3, code: 'OR-0003', name: 'Vase', eta: '2026-10-09T09:00:00' }],
  attention: [
    { order: order({ id: 4, code: 'OR-0004', name: 'Old', due_date: '2026-09-01T00:00:00' }), reason: 'overdue', eta: null, estimate_reasons: [] },
    { order: order({ id: 2, code: 'OR-0002', name: 'Lamp', due_date: '2026-10-08T00:00:00' }), reason: 'late_eta', eta: '2026-10-12T09:00:00', estimate_reasons: [] },
    { order: order({ id: 5, code: 'OR-0005', name: 'Open' }), reason: 'no_due', eta: null, estimate_reasons: [] },
  ],
  ...over,
});

describe('OrdersDeadlines', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Only the clock: the queries and the DOM helpers still need real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 7, 12)); // a Wednesday
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('asks for two weeks from this Monday, with the shared filters', async () => {
    const get = vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{ customer_id: 2 }} week={0} onWeek={() => {}} />);
    await screen.findByRole('list', { name: 'Needs attention' });
    expect(get).toHaveBeenCalledWith({ start: '2026-10-05', days: 14, customer_id: 2 });
  });
  it('another week moves the window by whole weeks', async () => {
    const get = vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer({ due: [], eta_marks: [], attention: [] }));
    render(<OrdersDeadlines filters={{}} week={-1} onWeek={() => {}} />);
    await screen.findByText('Nothing needs attention');
    expect(get).toHaveBeenCalledWith({ start: '2026-09-28', days: 14 });
  });
  it('puts a due order on its deadline day, with its stage and forecast; a late one says so in red', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const wednesday = await screen.findByTestId('deadline-day-2026-10-07');
    const onTime = await within(wednesday).findByRole('link', { name: /Ten flasks/ });
    expect(onTime).toHaveAttribute('href', '/projects/1');
    expect(onTime).toHaveTextContent('Printing');
    expect(within(onTime).getByTestId('deadline-eta-1')).not.toHaveClass('text-red-500');
    const late = within(screen.getByTestId('deadline-day-2026-10-08')).getByRole('link', { name: /Lamp/ });
    expect(within(late).getByTestId('deadline-eta-2')).toHaveClass('text-red-500');
    expect(late).toHaveTextContent('late');
  });
  it('marks where another order is forecast to be ready', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const friday = await screen.findByTestId('deadline-day-2026-10-09');
    expect(await within(friday).findByRole('link', { name: /OR-0003 ready ≈/ })).toHaveAttribute('href', '/projects/3');
  });
  it('lists what needs attention, each with its reason', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const list = await screen.findByRole('list', { name: 'Needs attention' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Overdue'),
      expect.stringContaining('Ready after the deadline'),
      expect.stringContaining('No deadline'),
    ]);
  });
  it('a board that could not be read says so, instead of an empty fortnight', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockRejectedValue(new Error('boom'));
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    expect(await screen.findByText('Could not load the deadlines.')).toBeInTheDocument();
    expect(screen.queryByText('Nothing needs attention')).not.toBeInTheDocument();
  });
  it('marks today; Next and Previous step by a week; Today shows only away from this week', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    const onWeek = vi.fn();
    const { unmount } = render(<OrdersDeadlines filters={{}} week={0} onWeek={onWeek} />);
    expect(await screen.findByTestId('deadline-day-2026-10-07')).toHaveAttribute('aria-current', 'date');
    expect(screen.queryByRole('button', { name: 'Today' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onWeek).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onWeek).toHaveBeenCalledWith(-1);
    unmount();
    render(<OrdersDeadlines filters={{}} week={2} onWeek={onWeek} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Today' }));
    expect(onWeek).toHaveBeenLastCalledWith(0);
  });
});
