import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import type { OrderBoard, OrderListItem } from '../../../../api/client';
import { OrdersBoard } from '../../../../components/projects/board/OrdersBoard';
import { NO_ACTIONS, WithOrderActions } from '../../../fixtures/orderActionsHost';
import { ORDER_ROW_DEFAULTS } from '../../../wireDefaults';

// Dragging is gated on `orders:update`, and the real provider resolves the
// admin only after its own request — the hook alone is replaced.
const auth = vi.hoisted(() => ({ canUpdate: true }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return { ...actual, useAuth: () => ({ ...actual.useAuth(), hasPermission: () => auth.canUpdate }) };
});

const order = (over: Partial<OrderListItem>): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id: 1, code: 'OR-0001', name: 'Ten flasks', customer_id: 2, customer_name: 'ACME', color: null, status: 'active',
  stage: 'prep', responsible_id: 7, responsible_name: 'Ira Koval', due_date: null, priority: 'normal', price: null,
  tags: null, cover_image_filename: null, created_at: '2026-09-01T00:00:00Z', lines_count: 1, ordered: 10, printed: 4,
  covered_units: 4, remaining: 6, from_stock_units: 0, progress: 0.4, prints_in_progress: 0, prints_queued: 0,
  issued_units: 0, line_products: [], ...over,
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
    render(<OrdersBoard filters={{ customer_id: 2, q: 'lamp' }} onOpenList={() => {}} actions={NO_ACTIONS} />);
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
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const card = await screen.findByTestId('board-card-2');
    expect(within(card).getByText('OR-0002')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Lamp' })).toHaveAttribute('href', '/projects/2');
    expect(within(card).getByText('ACME')).toBeInTheDocument();
    expect(within(card).getByTestId('order-2-coverage')).toHaveTextContent('Covered 4 / 10');
    expect(within(card).getByLabelText('printing 1, queued 3')).toBeInTheDocument();
    expect(within(card).getByText('IK')).toBeInTheDocument();
  });
  // spec workshop-order-issue-followups, rule 50: the list card's line, the same rule.
  it('an active card says how much went out; a done one does not', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(
      board({ prep: { items: [order({ id: 1, issued_units: 4 })], total: 1 } }),
    );
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const card = await screen.findByTestId('board-card-1');
    expect(within(card).getByTestId('board-card-1-issued')).toHaveTextContent('issued 4 of 10');
    expect(within(screen.getByTestId('board-card-3')).queryByTestId('board-card-3-issued')).not.toBeInTheDocument();
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
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    expect(await screen.findByTestId('order-1-due')).toHaveTextContent('· overdue');
    expect(screen.getByTestId('order-4-due')).not.toHaveTextContent('overdue');
  });
  it('active cards carry a drag handle; completed cards do not', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const active = await screen.findByTestId('board-card-1');
    expect(within(active).getByRole('button', { name: 'Move OR-0001' })).toHaveAttribute('aria-roledescription', 'draggable');
    const done = screen.getByTestId('board-card-3');
    expect(within(done).queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(within(done).queryByRole('button', { name: /^Stage / })).not.toBeInTheDocument();
    expect(done.querySelector('[aria-roledescription]')).toBeNull();
  });
  it('«…and N more» opens the list with the column’s filter, keeping the shared ones', async () => {
    window.history.pushState({}, '', '/projects?customer=2&q=lamp&page=3');
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    const onOpenList = vi.fn();
    render(<OrdersBoard filters={{ customer_id: 2, q: 'lamp' }} onOpenList={onOpenList} actions={NO_ACTIONS} />);
    const printingMore = await screen.findByRole('link', { name: 'and 1 more in the list' });
    expect(printingMore).toHaveAttribute('href', '/projects?customer=2&q=lamp&tab=active&stage=printing');
    const doneMore = screen.getByRole('link', { name: '…and 8 more completed — in the list' });
    expect(doneMore).toHaveAttribute('href', '/projects?customer=2&q=lamp&tab=completed');
    expect(within(screen.getByRole('region', { name: 'Preparation' })).queryByRole('link', { name: /more in the list/ })).toBeNull();
    fireEvent.click(printingMore);
    expect(onOpenList).toHaveBeenCalled();
  });
  it('a viewer who may not move orders is not invited to drop cards', async () => {
    auth.canUpdate = false;
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const qc = await screen.findByRole('region', { name: 'Quality check' });
    expect(await within(qc).findByText('No orders')).toBeInTheDocument();
    expect(screen.queryByText('Drop a card here')).not.toBeInTheDocument();
    // No handle, no stage choice and — with nothing permitted — no menu (E6-B03).
    expect(within(screen.getByTestId('board-card-1')).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('orders-board-hint')).toHaveTextContent('The stage is set by hand.');
  });
  it('a filter that matches nothing says so and offers the reset', async () => {
    const empty = { items: [], total: 0 };
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue({ prep: empty, printing: empty, qc: empty, done: empty });
    const onReset = vi.fn();
    render(<OrdersBoard filters={{ q: 'zzz' }} onOpenList={() => {}} onReset={onReset} actions={NO_ACTIONS} />);
    expect(await screen.findByText('Nothing matches your search or filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalled();
  });
  it('a board that could not be read says so with a retry, instead of four empty columns', async () => {
    const get = vi.spyOn(api, 'getOrderBoard').mockRejectedValue(new Error('boom'));
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent('Could not load the board.');
    expect(screen.queryByTestId('board-total-prep')).not.toBeInTheDocument();
    get.mockResolvedValue(board());
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Lamp')).toBeInTheDocument();
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
    // The drop is the page's «complete» door (WS-13 E6 B04): the PAGE's host opens the dialog.
    render(<WithOrderActions>{(actions) => <OrdersBoard filters={{}} onOpenList={() => {}} actions={actions} />}</WithOrderActions>);
    const handle = await screen.findByRole('button', { name: 'Move OR-0002' });
    await keyboardDrag(handle, ['ArrowRight', 'ArrowRight']); // printing → qc → done
    expect(await screen.findByRole('dialog', { name: 'Stock & issue' })).toBeInTheDocument();
    await waitFor(() => expect(state).toHaveBeenCalledWith(2));
    expect(update).not.toHaveBeenCalled();
  });
  // V05.1 (Codex r1, browser kanban-drop-done@768): a card translated INSIDE the board's own scroll
  // box widened that box as it moved, and the board's auto-scroll ran away from the column aimed
  // at. The card in hand is a preview over the page; the card itself stays where it is.
  it('drags a preview over the page and leaves the card itself in place', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    stubColumnGeometry();
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const handle = await screen.findByRole('button', { name: 'Move OR-0001' });
    handle.focus();
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(await screen.findByTestId('board-drag-preview')).toHaveTextContent('OR-0001');
    expect(screen.getByTestId('board-card-1').style.transform).toBe('');
    fireEvent.keyDown(document, { code: 'Escape', key: 'Escape' });
  });

  it('moves a card to the next column from the keyboard', async () => {
    vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
    const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
    stubColumnGeometry();
    render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
    const handle = await screen.findByRole('button', { name: 'Move OR-0001' });
    await keyboardDrag(handle, ['ArrowRight']);
    await waitFor(() => expect(stage).toHaveBeenCalledWith(1, 'printing'));
  });
  describe('WS-13 E7 F', () => {
    it('lays four columns side by side in ONE horizontally scrolling region, columns growing down', async () => {
      vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
      render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
      await screen.findByText('Lamp');
      const region = screen.getByRole('region', { name: 'Kanban' });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(region.className).toContain('overflow-x-auto');
      expect(region.className).toContain('grid-cols-[repeat(4,minmax(240px,1fr))]');
      const columns = region.querySelectorAll('[data-board-column]');
      expect(columns).toHaveLength(4);
      columns.forEach((c) => expect(c.className).not.toMatch(/overflow-y|max-h-/));
    });

    it('draws the compact card of the mockup: rail, thumbnails · code · stage, name, customer, coverage, line, footer', async () => {
      vi.spyOn(api, 'getOrderBoard').mockResolvedValue(
        board({ printing: { items: [order({ id: 2, code: 'OR-0002', name: 'Lamp', stage: 'printing', color: '#5983b1', due_date: '2099-10-07T00:00:00', prints_in_progress: 1, prints_queued: 3, products: [{ product_id: 9, has_cover: false }] })], total: 1 } }),
      );
      render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
      const card = await screen.findByTestId('board-card-2');
      const parts = Array.from(card.querySelectorAll('[data-part]')).map((el) => el.getAttribute('data-part'));
      expect(parts).toEqual(['rail', 'top', 'name', 'customer', 'coverage', 'line', 'footer']);
      expect(card.querySelector('[data-part="rail"]')).toHaveStyle({ backgroundColor: '#5983b1' });
      expect(within(card).getByTestId('order-2-thumbs')).toBeInTheDocument();
      expect(within(card).getByLabelText('printing 1, queued 3')).toBeInTheDocument();
      expect(within(card).getByTestId('order-2-menu')).toBeInTheDocument();
    });

    it('explains under the board that the stage is the operator’s, and how to move it', async () => {
      vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
      render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
      await screen.findByText('Lamp');
      const hint = screen.getByTestId('orders-board-hint');
      expect(hint).toHaveTextContent('The stage is set by hand');
      expect(hint).toHaveTextContent('closes by issuing');
      expect(hint).not.toHaveTextContent(/itself|automatic/i);
    });

    it('changes the stage from the card’s stage menu with the keyboard — one write, none for the current stage', async () => {
      vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
      const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
      render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
      const trigger = await screen.findByRole('button', { name: 'Stage OR-0001: Preparation — change' });
      trigger.focus();
      fireEvent.click(trigger);
      const current = await screen.findByRole('menuitemradio', { name: 'Preparation' });
      expect(current).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(current);
      expect(stage).not.toHaveBeenCalled();
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Quality check' }));
      await waitFor(() => expect(stage).toHaveBeenCalledWith(1, 'qc'));
      expect(stage).toHaveBeenCalledTimes(1);
    });

    it('«Done» in the stage menu opens Stock & issue, and cancelling it closes nothing', async () => {
      vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
      const update = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
      const stage = vi.spyOn(api, 'setOrderStage').mockResolvedValue({} as never);
      vi.spyOn(api, 'getFulfilment').mockResolvedValue({
        lines: [], ordered: 0, issued: 0, held: 0, fully_issued: true, closes_to_stock: false, can_complete: true,
        can_assemble: 0, can_receive: 0, can_issue: 0,
        recipient: { name: null, phone: null, delivery_method: null, delivery_details: null },
      });
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
      render(<WithOrderActions>{(actions) => <OrdersBoard filters={{}} onOpenList={() => {}} actions={actions} />}</WithOrderActions>);
      fireEvent.click(await screen.findByRole('button', { name: 'Stage OR-0002: Printing — change' }));
      const done = await screen.findByRole('menuitem', { name: 'Done — stock and issue…' });
      fireEvent.click(done);
      const dialog = await screen.findByRole('dialog', { name: 'Stock & issue' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Stock & issue' })).not.toBeInTheDocument());
      expect(update).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
    });

    it('holds a card while its stage is written — dimmed, no second write — and leaves it when the write is refused', async () => {
      vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
      let refuse!: (e: Error) => void;
      const stage = vi.spyOn(api, 'setOrderStage').mockImplementation(() => new Promise((_, reject) => { refuse = reject; }));
      render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Stage OR-0001: Preparation — change' }));
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Printing' }));
      const card = screen.getByTestId('board-card-1');
      await waitFor(() => expect(card).toHaveAttribute('aria-busy', 'true'));
      expect(card).toHaveTextContent('Moving…');
      // Neither door goes away while the card is held, so the focus stays where it was (F07):
      // the stage menu opens with its stages unavailable, the handle is there but inert.
      const held = within(card).getByRole('button', { name: 'Stage OR-0001: Preparation — change' });
      expect(held).not.toBeDisabled();
      expect(within(card).getByRole('button', { name: 'Move OR-0001' })).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(held);
      const qc = await screen.findByRole('menuitemradio', { name: 'Quality check' });
      expect(qc).toBeDisabled();
      fireEvent.click(qc);
      // The other card is not held.
      expect(screen.getByTestId('board-card-2')).not.toHaveAttribute('aria-busy', 'true');
      await act(async () => refuse(new Error('This order is not active')));
      await waitFor(() => expect(card).not.toHaveAttribute('aria-busy', 'true'));
      expect(within(screen.getByRole('region', { name: 'Preparation' })).getByTestId('board-card-1')).toBeInTheDocument();
      expect(await screen.findByText('This order is not active')).toBeInTheDocument();
      expect(stage).toHaveBeenCalledTimes(1);
    });

    // F07 (final review): the re-read moves the card to its new column — a new element — and the
    // focus the operator left on its stage would fall to the page. It follows the card instead.
    it('keeps the focus on the card’s stage when the re-read moves it to another column', async () => {
      const get = vi.spyOn(api, 'getOrderBoard').mockResolvedValue(board());
      vi.spyOn(api, 'setOrderStage').mockImplementation(async () => {
        get.mockResolvedValue(board({ prep: { items: [], total: 0 }, qc: { items: [order({ id: 1, stage: 'qc' })], total: 1 } }));
        return {} as never;
      });
      render(<OrdersBoard filters={{}} onOpenList={() => {}} actions={NO_ACTIONS} />);
      const trigger = await screen.findByRole('button', { name: 'Stage OR-0001: Preparation — change' });
      trigger.focus();
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Quality check' }));
      const column = screen.getByRole('region', { name: 'Quality check' });
      const moved = await within(column).findByRole('button', { name: 'Stage OR-0001: Quality check — change' });
      await waitFor(() => expect(moved).toHaveFocus());
    });
  });
});

/** jsdom lays nothing out: give each column a box side by side, and each card a box inside its column.
 *  The drag preview starts where the card in hand is (dnd-kit's DragOverlay does in a browser). */
function stubColumnGeometry() {
  const columns = ['prep', 'printing', 'qc', 'done'];
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const held = this.closest('[data-testid="board-drag-preview"]') ? document.querySelector('[data-testid^="board-card-"].opacity-40') : null;
    const column = (held ?? this).closest('[data-board-column]');
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
