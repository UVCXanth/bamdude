import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { OrderDeadlines, OrderListItem } from '../../../api/client';
import { OrdersDeadlines } from '../../../components/projects/OrdersDeadlines';
import { ORDER_ROW_DEFAULTS } from '../../wireDefaults';

const order = (over: Partial<OrderListItem>): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id: 1, code: 'OR-0001', name: 'Ten flasks', customer_id: 2, customer_name: 'ACME', color: null, status: 'active',
  stage: 'printing', responsible_id: null, responsible_name: null, due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00Z', lines_count: 1, ordered: 10, printed: 4,
  covered_units: 4, remaining: 6, from_stock_units: 0, issued_units: 0, progress: 0.4, prints_in_progress: 0, prints_queued: 0,
  line_products: [], ...over,
}) as OrderListItem;

const answer = (over: Partial<OrderDeadlines> = {}): OrderDeadlines => ({
  start: '2026-10-05',
  days: 14,
  due: [
    { order: order({ id: 1, due_date: '2026-10-07T00:00:00', color: '#4eac48' }), eta: '2026-10-06T09:00:00', late: false, estimate_reasons: [] },
    { order: order({ id: 2, code: 'OR-0002', name: 'Lamp', stage: 'qc', due_date: '2026-10-08T00:00:00' }), eta: '2026-10-12T09:00:00', late: true, estimate_reasons: [] },
  ],
  eta_marks: [{ id: 3, code: 'OR-0003', name: 'Vase', eta: '2026-10-09T09:00:00' }],
  attention: [
    { order: order({ id: 4, code: 'OR-0004', name: 'Old', due_date: '2026-09-01T00:00:00' }), reason: 'overdue', eta: null, estimate_reasons: [] },
    { order: order({ id: 2, code: 'OR-0002', name: 'Lamp', due_date: '2026-10-08T00:00:00' }), reason: 'late_eta', eta: '2026-10-12T09:00:00', estimate_reasons: [] },
    { order: order({ id: 6, code: 'OR-0006', name: 'Bowl', customer_id: null, customer_name: null, due_date: '2026-10-15T00:00:00' }), reason: 'partial', eta: null, estimate_reasons: [{ code: 'no_plate', count: 2 }] },
    { order: order({ id: 5, code: 'OR-0005', name: 'Open' }), reason: 'no_due', eta: null, estimate_reasons: [] },
  ],
  ...over,
});

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

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
    await screen.findByText('No risks');
    expect(get).toHaveBeenCalledWith({ start: '2026-09-28', days: 14 });
  });
  it('names the fortnight and explains its marks, risk included', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    expect(await screen.findByTestId('deadlines-range')).toHaveTextContent(`${day(2026, 10, 5)} — ${day(2026, 10, 18)}`);
    const legend = screen.getByTestId('deadlines-legend');
    expect(legend).toHaveTextContent('Card — the deadline');
    expect(legend).toHaveTextContent('the day the forecast promises');
    expect(legend).toHaveTextContent('red frame — forecast after the deadline');
  });
  it('lays the fortnight out as one 7×2 grid in its own horizontal scroll', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const region = await screen.findByRole('region', { name: 'Deadlines calendar' });
    expect(region.className).toContain('overflow-x-auto');
    const rows = region.querySelectorAll('[data-week-row]');
    expect(rows).toHaveLength(2);
    rows.forEach((r) => {
      expect(r.className).toContain('grid-cols-[repeat(7,minmax(140px,1fr))]');
      expect(r.querySelectorAll('[data-testid^="deadline-day-"]')).toHaveLength(7);
    });
    const wednesday = screen.getByTestId('deadline-day-2026-10-07');
    expect(wednesday).toHaveAttribute('aria-current', 'date');
    expect(wednesday).toHaveTextContent('Today');
    expect(screen.getByTestId('deadline-day-2026-10-10').className).toContain('bg-bambu-dark');
  });
  it('puts a due order on its deadline day: rail, code · deadline, name, customer, coverage, stage, forecast', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const wednesday = await screen.findByTestId('deadline-day-2026-10-07');
    const card = await within(wednesday).findByRole('link', { name: /Ten flasks/ });
    expect(card).toHaveAttribute('href', '/projects/1');
    expect(card).toHaveTextContent('OR-0001 · deadline');
    expect(card).toHaveTextContent('ACME');
    expect(card).toHaveTextContent('Printing');
    expect(card).toHaveTextContent('4 / 10');
    expect(card).toHaveStyle({ borderLeftColor: '#4eac48' });
    expect(within(card).getByTestId('deadline-eta-1')).toHaveTextContent(`ready ≈ ${day(2026, 10, 6)}`);
    expect(within(card).getByTestId('deadline-eta-1')).not.toHaveClass('text-red-500');
  });
  it('marks risk only where the server says late — never by its own date math', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(
      answer({
        due: [
          // The forecast falls after the deadline, yet the server says not late: no risk.
          { order: order({ id: 1, due_date: '2026-10-07T00:00:00' }), eta: '2026-10-09T09:00:00', late: false, estimate_reasons: [] },
          // The forecast falls before the deadline, yet the server says late: risk.
          { order: order({ id: 2, code: 'OR-0002', name: 'Lamp', due_date: '2026-10-08T00:00:00' }), eta: '2026-10-06T09:00:00', late: true, estimate_reasons: [] },
        ],
      }),
    );
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const first = await within(await screen.findByTestId('deadline-day-2026-10-07')).findByRole('link', { name: /Ten flasks/ });
    const second = within(screen.getByTestId('deadline-day-2026-10-08')).getByRole('link', { name: /Lamp/ });
    expect(first).not.toHaveAttribute('data-risk');
    expect(second).toHaveAttribute('data-risk', 'true');
    expect(within(second).getByTestId('deadline-eta-2')).toHaveClass('text-red-500');
    expect(second).toHaveTextContent('late');
  });
  it('tells a partial estimate from none, and keeps a date beside its reasons', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(
      answer({
        due: [
          { order: order({ id: 1, due_date: '2026-10-07T00:00:00' }), eta: '2026-10-06T09:00:00', late: false, estimate_reasons: [{ code: 'no_plate', count: 6 }] },
          { order: order({ id: 2, code: 'OR-0002', name: 'Lamp', due_date: '2026-10-08T00:00:00' }), eta: null, late: false, estimate_reasons: [{ code: 'needs_slicing', count: 1 }] },
          { order: order({ id: 7, code: 'OR-0007', name: 'Cup', due_date: '2026-10-09T00:00:00' }), eta: null, late: false, estimate_reasons: [] },
          { order: order({ id: 8, code: 'OR-0008', name: 'Done', status: 'completed', stage: 'done', due_date: '2026-10-09T00:00:00' }), eta: null, late: false, estimate_reasons: null },
        ],
      }),
    );
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const withDate = await screen.findByTestId('deadline-eta-1');
    expect(withDate).toHaveTextContent(`ready ≈ ${day(2026, 10, 6)}`);
    expect(within(withDate).getByRole('img', { name: /Parts on no plate: 6/ })).toBeInTheDocument();
    expect(screen.getByTestId('deadline-eta-2')).toHaveTextContent('incomplete estimate');
    expect(screen.getByTestId('deadline-eta-7')).toHaveTextContent('no estimate');
    expect(screen.queryByTestId('deadline-eta-8')).not.toBeInTheDocument();
  });
  it('marks where another order is forecast to be ready, with the time', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const friday = await screen.findByTestId('deadline-day-2026-10-09');
    const mark = await within(friday).findByRole('link', { name: /OR-0003 ready ≈/ });
    expect(mark).toHaveAttribute('href', '/projects/3');
    expect(mark.getAttribute('title')).toMatch(/^Forecast: /);
  });
  it('lists what needs attention: order and customer on the left, the server’s reason on the right', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer());
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const list = await screen.findByRole('list', { name: 'Needs attention' });
    const rows = within(list).getAllByRole('listitem');
    expect(within(rows[0]).getByRole('link', { name: 'OR-0004 · Old' })).toHaveAttribute('href', '/projects/4');
    expect(rows[0]).toHaveTextContent('ACME');
    expect(rows[0]).toHaveTextContent('overdue');
    expect(rows[1]).toHaveTextContent(`ready ≈ ${day(2026, 10, 12)} with the deadline ${day(2026, 10, 8)}`);
    expect(rows[2]).toHaveTextContent('No customer');
    expect(rows[2]).toHaveTextContent(`incomplete estimate · deadline ${day(2026, 10, 15)}`);
    expect(within(rows[2]).getByLabelText(/Parts on no plate: 2/)).toBeInTheDocument();
    expect(rows[3]).toHaveTextContent('no deadline');
  });
  it('says no risks when nothing needs attention', async () => {
    vi.spyOn(api, 'getOrderDeadlines').mockResolvedValue(answer({ attention: [] }));
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    expect(await screen.findByText('No risks')).toBeInTheDocument();
    expect(screen.getByText('Every active order makes its deadline.')).toBeInTheDocument();
  });
  it('a board that could not be read says so with a retry, instead of an empty fortnight', async () => {
    const get = vi.spyOn(api, 'getOrderDeadlines').mockRejectedValue(new Error('boom'));
    render(<OrdersDeadlines filters={{}} week={0} onWeek={() => {}} />);
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('Could not load the deadlines.');
    expect(screen.queryByText('No risks')).not.toBeInTheDocument();
    get.mockResolvedValue(answer());
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('list', { name: 'Needs attention' })).toBeInTheDocument());
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
