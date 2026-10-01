/**
 * The one order action model (WS-13 E6 §B): which actions an order offers where,
 * and the page-level host that opens their dialogs. The host outlives the row it
 * was opened from (R02): a refetch that drops the row keeps the confirmation, and
 * focus lands on the page's heading, never on BODY.
 *
 * ⚠️ «Mark completed» is a door to «Stock & issue» — no menu writes the status
 * `completed` (B04); the form's own status door is pinned in its own test (T3).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { FulfilmentState, OrderListItem, Permission } from '../../../../api/client';
import { orderMenuItems } from '../../../../components/projects/orderActions/orderMenu';
import { toOrderRef } from '../../../../components/projects/orderActions/orderRef';
import { useOrderActions } from '../../../../components/projects/orderActions/useOrderActions';
import { OrderActionMenu } from '../../../../components/projects/orderActions/OrderActionMenu';
import { ORDER_ROW_DEFAULTS } from '../../../wireDefaults';
import { makeFigures, makeOrder } from '../../../fixtures/orderDetail';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));

vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? true };
    },
  };
});

const row = (over: Partial<OrderListItem> = {}): OrderListItem => ({
  ...ORDER_ROW_DEFAULTS,
  id: 1,
  code: 'OR-0001',
  name: 'Ten flasks',
  customer_id: 2,
  customer_name: 'ACME',
  color: null,
  status: 'active',
  stage: 'prep',
  responsible_id: null,
  responsible_name: null,
  due_date: null,
  priority: 'normal',
  price: null,
  tags: null,
  cover_image_filename: null,
  created_at: '2026-09-01T00:00:00Z',
  lines_count: 1,
  ordered: 10,
  printed: 4,
  covered_units: 4,
  remaining: 6,
  from_stock_units: 0,
  issued_units: 0,
  progress: 0.4,
  prints_in_progress: 0,
  prints_queued: 0,
  line_products: [],
  ...over,
});

const ALL = { update: true, create: true, remove: true };

describe('orderMenuItems', () => {
  it('offers an active order every action, in the agreed order', () => {
    expect(orderMenuItems(toOrderRef(row({ bankable_surplus: 3 })), ALL, 'list')).toEqual([
      { action: 'open' },
      { action: 'edit' },
      { action: 'duplicate' },
      { action: 'fulfil' },
      { action: 'bank' },
      { action: 'complete' },
      { action: 'cancel' },
      { action: 'delete', danger: true, separatorBefore: true },
    ]);
  });

  it('offers a closed order reopening, never completing or cancelling', () => {
    const actions = orderMenuItems(toOrderRef(row({ status: 'completed' })), ALL, 'list').map((i) => i.action);
    expect(actions).toEqual(['open', 'edit', 'duplicate', 'reopen', 'delete']);
  });

  it('gives the detail the cover and no «open»', () => {
    const actions = orderMenuItems(toOrderRef(row()), ALL, 'detail').map((i) => i.action);
    expect(actions).toEqual(['edit', 'duplicate', 'fulfil', 'complete', 'cancel', 'cover', 'delete']);
  });

  it('offers the surplus only while there is some to bank', () => {
    expect(orderMenuItems(toOrderRef(row({ bankable_surplus: 0 })), ALL, 'list').map((i) => i.action)).not.toContain('bank');
    // A closed order still banks — the server does, whatever the status.
    expect(
      orderMenuItems(toOrderRef(row({ status: 'cancelled', bankable_surplus: 2 })), ALL, 'list').map((i) => i.action),
    ).toContain('bank');
  });

  it('gives a reader no menu at all — «open» alone is not a menu (R06)', () => {
    expect(orderMenuItems(toOrderRef(row()), { update: false, create: false, remove: false }, 'list')).toEqual([]);
  });

  it('keeps «open» and the separator beside a lone delete', () => {
    expect(orderMenuItems(toOrderRef(row()), { update: false, create: false, remove: true }, 'list')).toEqual([
      { action: 'open' },
      { action: 'delete', danger: true, separatorBefore: true },
    ]);
  });
});

describe('toOrderRef', () => {
  it('reads the detail’s surplus from its figures and the row’s from the row', () => {
    const detail = makeOrder({ id: 4, code: 'OR-0004', figures: makeFigures({ bankable_surplus: 7 }) });
    expect(toOrderRef(detail).bankable_surplus).toBe(7);
    expect(toOrderRef(row({ bankable_surplus: 5 })).bankable_surplus).toBe(5);
    expect(toOrderRef(row())).toMatchObject({ id: 1, code: 'OR-0001', name: 'Ten flasks', status: 'active', customer_name: 'ACME' });
  });
});

const harness = vi.hoisted(() => ({ setRows: null as ((rows: OrderListItem[]) => void) | null }));

function Page({ initial, onDeleted }: { initial: OrderListItem[]; onDeleted?: (id: number) => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [rows, setRows] = useState(initial);
  useEffect(() => {
    harness.setRows = setRows;
  }, []);
  const { run, create, dialogs } = useOrderActions({ fallbackFocusRef: heading, onDeleted });
  return (
    <div>
      <h1 ref={heading} tabIndex={-1}>
        Orders
      </h1>
      {rows.map((r) => (
        <div key={r.id}>
          <OrderActionMenu order={toOrderRef(r)} context="list" actions={{ run, create }} testId={`menu-${r.id}`} />
        </div>
      ))}
      {dialogs}
    </div>
  );
}

const openMenu = (code = 'OR-0001') => fireEvent.click(screen.getByRole('button', { name: `Order actions ${code}` }));
const pick = (label: string) => fireEvent.click(screen.getByRole('menuitem', { name: label }));

describe('the order action host', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = null;
    harness.setRows = null;
  });

  it('opens «Stock & issue» for «Mark completed» and writes no status (B04)', async () => {
    const update = vi.spyOn(api, 'updateOrder');
    vi.spyOn(api, 'getFulfilment').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    render(<Page initial={[row()]} />);
    openMenu();
    pick('Mark completed');
    expect(await screen.findByRole('dialog', { name: /Stock & issue/ })).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('asks before cancelling, then writes «cancelled» once', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockResolvedValue(makeOrder({ id: 1, status: 'cancelled' }));
    render(<Page initial={[row()]} />);
    openMenu();
    pick('Cancel');
    const dialog = await screen.findByRole('dialog', { name: 'Cancel order?' });
    expect(dialog).toHaveTextContent('OR-0001 · Ten flasks');
    expect(dialog).toHaveTextContent('The history stays.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(1, { status: 'cancelled' });
  });

  it('sends one request however often a pending confirmation is clicked', async () => {
    const update = vi.spyOn(api, 'updateOrder').mockReturnValue(new Promise(() => {}));
    render(<Page initial={[row()]} />);
    openMenu();
    pick('Cancel');
    const yes = await screen.findByRole('button', { name: 'Cancel order' });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await waitFor(() => expect(yes).toBeDisabled());
    // While the request runs the primary says so (B05: «…»).
    expect(yes).toHaveTextContent('Cancel order…');
    fireEvent.click(yes);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('keeps a refused reopening in its dialog, with the server’s sentence (R01)', async () => {
    vi.spyOn(api, 'updateOrder').mockRejectedValue(new ApiError("This order's stock has moved; duplicate it instead", 409));
    render(<Page initial={[row({ status: 'cancelled' })]} />);
    openMenu();
    pick('Reopen');
    const dialog = await screen.findByRole('dialog', { name: 'Reopen order?' });
    expect(dialog).toHaveTextContent('Stock reservations do not come back');
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("This order's stock has moved; duplicate it instead");
    expect(screen.getByRole('dialog', { name: 'Reopen order?' })).toBeInTheDocument();
    // The refusal leaves focus on the button that sent it, never on BODY.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toHaveFocus());
  });

  it('keeps the confirmation when its row leaves the list, and lands focus on the heading (R02)', async () => {
    let resolve: (value: unknown) => void = () => {};
    vi.spyOn(api, 'updateOrder').mockReturnValue(new Promise((r) => (resolve = r)) as never);
    render(<Page initial={[row()]} />);
    openMenu();
    pick('Cancel');
    await screen.findByRole('dialog', { name: 'Cancel order?' });
    // A refetch drops the row — the trigger the dialog was opened from is gone.
    act(() => harness.setRows?.([]));
    expect(screen.getByRole('dialog', { name: 'Cancel order?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    await act(async () => resolve(makeOrder({ id: 1, status: 'cancelled' })));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Orders' })));
  });

  it('deletes after asking and tells the page which order went (B08)', async () => {
    const remove = vi.spyOn(api, 'deleteOrder').mockResolvedValue({ message: 'Project deleted' } as never);
    const onDeleted = vi.fn();
    render(<Page initial={[row()]} onDeleted={onDeleted} />);
    openMenu();
    pick('Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete order?' });
    expect(dialog).toHaveTextContent('issues stay with the customer');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(1));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('routes «Completed» chosen in the form to «Stock & issue», writing no status (B04 end to end)', async () => {
    const update = vi.spyOn(api, 'updateOrder');
    vi.spyOn(api, 'getOrder').mockResolvedValue(makeOrder({ id: 1, code: 'OR-0001', name: 'Ten flasks', status: 'active' }));
    vi.spyOn(api, 'getCustomers').mockResolvedValue([]);
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
    vi.spyOn(api, 'getFulfilment').mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    render(<Page initial={[row()]} />);
    openMenu();
    pick('Edit');
    const status = (await screen.findByLabelText('Status')) as HTMLSelectElement;
    fireEvent.change(status, { target: { value: 'completed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('dialog', { name: /Stock & issue/ })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Edit order' })).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  // B07 (final review I1): a dialog that swaps for another — a reading shell for the form, the
  // form for a confirmation — still hands focus back to the trigger that opened the first.
  describe('returns focus to the surviving trigger', () => {
    const later = <T,>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 30));
    const EMPTY_STATE = {
      lines: [],
      ordered: 0,
      issued: 0,
      held: 0,
      fully_issued: false,
      can_assemble: 0,
      can_receive: 0,
      can_issue: 0,
      closes_to_stock: false,
      can_complete: false,
      recipient: { name: '', phone: '', delivery_method: '', delivery_details: '' },
    } as unknown as FulfilmentState;
    const trigger = () => screen.getByRole('button', { name: 'Order actions OR-0001' });

    beforeEach(() => {
      vi.spyOn(api, 'getCustomers').mockResolvedValue([]);
      vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
      vi.spyOn(api, 'getDeliveryMethods').mockResolvedValue([]);
    });

    it('after «Stock & issue» read for the first time', async () => {
      vi.spyOn(api, 'getFulfilment').mockImplementation(() => later(EMPTY_STATE));
      render(<Page initial={[row()]} />);
      openMenu();
      pick('Stock & issue…');
      // The reading shell first, then the form in its own dialog.
      await screen.findByTestId('fulfil-performer');
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });

    it('after the form read in full from a card', async () => {
      vi.spyOn(api, 'getOrder').mockImplementation(() => later(makeOrder({ id: 1, code: 'OR-0001', name: 'Ten flasks' })));
      render(<Page initial={[row()]} />);
      openMenu();
      pick('Edit');
      await screen.findByLabelText('Description');
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });

    it('after the form handed over to a confirmation (form → confirmation chain)', async () => {
      vi.spyOn(api, 'getOrder').mockImplementation(() => later(makeOrder({ id: 1, code: 'OR-0001', name: 'Ten flasks', status: 'active' })));
      render(<Page initial={[row()]} />);
      openMenu();
      pick('Edit');
      const status = (await screen.findByLabelText('Status')) as HTMLSelectElement;
      fireEvent.change(status, { target: { value: 'cancelled' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await screen.findByRole('dialog', { name: 'Cancel order?' });
      fireEvent.click(screen.getByRole('button', { name: 'Keep the order' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).toBe(trigger()));
    });
  });

  it('runs no status step the saved order no longer allows (C06 against the order as saved)', async () => {
    // Somebody else cancelled the order while the form was open: the PATCH answers «cancelled».
    const update = vi
      .spyOn(api, 'updateOrder')
      .mockResolvedValue(makeOrder({ id: 1, code: 'OR-0001', name: 'Ten flasks!', status: 'cancelled' }));
    vi.spyOn(api, 'getOrder').mockResolvedValue(makeOrder({ id: 1, code: 'OR-0001', name: 'Ten flasks', status: 'active' }));
    vi.spyOn(api, 'getCustomers').mockResolvedValue([]);
    vi.spyOn(api, 'getOrderAssignees').mockResolvedValue([]);
    render(<Page initial={[row()]} />);
    openMenu();
    pick('Edit');
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Ten flasks!' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'cancelled' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit order' })).not.toBeInTheDocument());
    expect(screen.queryByRole('dialog', { name: 'Cancel order?' })).not.toBeInTheDocument();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('shows a reader no menu trigger at all (R06)', () => {
    auth.granted = new Set(['projects:read']);
    render(<Page initial={[row()]} />);
    expect(screen.queryByRole('button', { name: 'Order actions OR-0001' })).not.toBeInTheDocument();
  });
});
