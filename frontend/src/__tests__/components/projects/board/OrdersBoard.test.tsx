import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import type { OrderBoard, OrderListItem } from '../../../../api/client';
import { OrdersBoard } from '../../../../components/projects/board/OrdersBoard';

// Dragging is gated on `projects:update`, and the real provider resolves the
// admin only after its own request — the hook alone is replaced.
const auth = vi.hoisted(() => ({ canUpdate: true }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), hasPermission: () => auth.canUpdate }) };
});

const order = (over: Partial<OrderListItem>): OrderListItem => ({
  id: 1, code: 'OR-0001', name: 'Ten flasks', customer_id: 2, customer_name: 'ACME', color: null, status: 'active',
  stage: 'prep', responsible_id: 7, responsible_name: 'Ira Koval', due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00Z', lines_count: 1, ordered: 10, printed: 4,
  covered_units: 4, remaining: 6, from_stock_units: 0, progress: 0.4, prints_in_progress: 0, prints_queued: 0,
  line_products: [], ...over,
}) as OrderListItem;

const board = (over: Partial<OrderBoard> = {}): OrderBoard => ({
  prep: { items: [order({ id: 1 })], total: 1 },
  printing: {
    items: [order({ id: 2, code: 'OR-0002', name: 'Lamp', stage: 'printing', prints_in_progress: 1, prints_queued: 3 })],
    total: 2,
  },
  qc: { items: [], total: 0 },
  done: { items: [order({ id: 3, code: 'OR-0003', name: 'Vase', status: 'completed', stage: 'done' })], total: 9 },
  ...over,
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

describe('OrdersBoard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.canUpdate = true;
    window.history.pushState({}, '', '/projects');
  });
  it('draws four columns with their titles and totals, and asks with the filters', async () => {
    const get = vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    render(<OrdersBoard filters={{ customer_id: 2, q: 'lamp' }} onOpenList={() => {}} />);
    await screen.findByText('Lamp');
    expect(get).toHaveBeenCalledWith({ customer_id: 2, q: 'lamp' });
    for (const [key, title, total] of [['prep', 'Preparation', '1'], ['printing', 'Printing', '2'], ['qc', 'Quality check', '0'], ['done', 'Done', '9']]) {
      const column = screen.getByRole('region', { name: title });
      expect(within(column).getByTestId(`board-total-${key}`)).toHaveTextContent(total);
    }
    expect(within(screen.getByRole('region', { name: 'Quality check' })).getByText('Drop a card here')).toBeInTheDocument();
  });
  it('a card shows code, name, customer, coverage, the live prints and who is responsible', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    const card = await screen.findByTestId('board-card-2');
    expect(within(card).getByText('OR-0002')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Lamp' })).toHaveAttribute('href', '/projects/2');
    expect(within(card).getByText('ACME')).toBeInTheDocument();
    expect(within(card).getByText('4 / 10')).toBeInTheDocument();
    expect(within(card).getByText('printing 1 print(s) · queued 3 job(s)')).toBeInTheDocument();
    expect(within(card).getByText('IK')).toBeInTheDocument();
  });
  it('an overdue deadline is red, a future one is not', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(
      board({
        prep: {
          items: [order({ id: 1, due_date: '2020-01-01T00:00:00' }), order({ id: 4, code: 'OR-0004', due_date: '2099-01-01T00:00:00' })],
          total: 2,
        },
      }),
    );
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    expect(await screen.findByTestId('board-card-1-due')).toHaveClass('text-red-500');
    expect(screen.getByTestId('board-card-4-due')).not.toHaveClass('text-red-500');
  });
  it('active cards carry a drag handle; completed cards do not', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    const active = await screen.findByTestId('board-card-1');
    expect(within(active).getByRole('button', { name: 'Move OR-0001' })).toHaveAttribute('aria-roledescription', 'draggable');
    const done = screen.getByTestId('board-card-3');
    expect(within(done).queryByRole('button')).not.toBeInTheDocument();
    expect(done.querySelector('[aria-roledescription]')).toBeNull();
  });
  it('«…and N more» opens the list with the column’s filter, keeping the shared ones', async () => {
    window.history.pushState({}, '', '/projects?customer=2&q=lamp&page=3');
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    const onOpenList = vi.fn();
    render(<OrdersBoard filters={{ customer_id: 2, q: 'lamp' }} onOpenList={onOpenList} />);
    const printingMore = await screen.findByRole('link', { name: 'and 1 more in the list' });
    expect(printingMore).toHaveAttribute('href', '/projects?customer=2&q=lamp&tab=active&stage=printing');
    const doneMore = screen.getByRole('link', { name: 'and 8 more in the list' });
    expect(doneMore).toHaveAttribute('href', '/projects?customer=2&q=lamp&tab=completed');
    expect(within(screen.getByRole('region', { name: 'Preparation' })).queryByRole('link', { name: /more in the list/ })).toBeNull();
    fireEvent.click(printingMore);
    expect(onOpenList).toHaveBeenCalled();
  });
  it('a viewer who may not move orders is not invited to drop cards', async () => {
    auth.canUpdate = false;
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    const qc = await screen.findByRole('region', { name: 'Quality check' });
    expect(await within(qc).findByText('No orders')).toBeInTheDocument();
    expect(screen.queryByText('Drop a card here')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('board-card-1')).queryByRole('button')).not.toBeInTheDocument();
  });
  it('a filter that matches nothing says so and offers the reset', async () => {
    const empty = { items: [], total: 0 };
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue({ prep: empty, printing: empty, qc: empty, done: empty });
    const onReset = vi.fn();
    render(<OrdersBoard filters={{ q: 'zzz' }} onOpenList={() => {}} onReset={onReset} />);
    expect(await screen.findByText('Nothing matches your search or filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalled();
  });
  it('a board that could not be read says so, instead of four empty columns', async () => {
    vi.spyOn(api, 'getOrderBoard').mockRejectedValue(new Error('boom'));
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    expect(await screen.findByText('Could not load the board.')).toBeInTheDocument();
    expect(screen.queryByTestId('board-total-prep')).not.toBeInTheDocument();
  });
  it('a drop onto «done» opens the issue dialog instead of closing the order', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    const state = vi.spyOn(api, 'getFulfilment').mockResolvedValue({
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
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    stubColumnGeometry();
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    const handle = await screen.findByRole('button', { name: 'Move OR-0002' });
    await keyboardDrag(handle, ['ArrowRight', 'ArrowRight']); // printing → qc → done
    expect(await screen.findByRole('dialog', { name: 'Stock & issue' })).toBeInTheDocument();
    await waitFor(() => expect(state).toHaveBeenCalledWith(2));
    expect(update).not.toHaveBeenCalled();
  });
  it('moves a card to the next column from the keyboard', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    stubColumnGeometry();
    render(<OrdersBoard filters={{}} onOpenList={() => {}} />);
    const handle = await screen.findByRole('button', { name: 'Move OR-0001' });
    await keyboardDrag(handle, ['ArrowRight']);
    await waitFor(() => expect(stage).toHaveBeenCalledWith(1, 'printing'));
  });
});

/** jsdom lays nothing out: give each column a box side by side, and each card a box inside its column. */
function stubColumnGeometry() {
  const columns = ['prep', 'printing', 'qc', 'done'];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const column = this.closest('[data-board-column]');
    const index = column ? columns.indexOf(column.getAttribute('data-board-column') ?? '') : -1;
    const left = index < 0 ? 0 : index * 300;
    const isColumn = this === column;
    const box = isColumn ? { left, top: 0, width: 280, height: 600 } : { left: left + 10, top: 60, width: 260, height: 100 };
    return { ...box, x: box.left, y: box.top, right: box.left + box.width, bottom: box.top + box.height, toJSON: () => box } as DOMRect;
  });
}

/** Space picks up, each arrow moves, Space drops — the keyboard sensor listens on the document after a tick. */
async function keyboardDrag(handle: HTMLElement, moves: string[]) {
  handle.focus();
  fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  for (const code of moves) {
    fireEvent.keyDown(document, { code, key: code });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  fireEvent.keyDown(document, { code: 'Space', key: ' ' });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
