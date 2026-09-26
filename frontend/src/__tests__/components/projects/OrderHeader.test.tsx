/**
 * The order header's whole-order actions, and the one pass 8 added.
 *
 * «Bank the surplus» is DISABLED rather than hidden when there is nothing to
 * bank: it is a permanent action of the order, and a button that appears the
 * moment an overprint happens would arrive in the middle of a row nobody was
 * watching.
 *
 * ⚠️ Its enablement is `figures.bankable_surplus` — the surplus MINUS what the
 * order has already banked, summed by the server (Ruling 30). It used to read
 * `parts[].surplus`, a fact about the prints that banking never lowers, so the
 * button stayed lit for ever and every press after the first answered "nothing
 * to bank". The figures come off the page's existing query; the header asks the
 * server nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order, Permission } from '../../../api/client';
import { OrderHeader } from '../../../components/projects/OrderHeader';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));

vi.mock('../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return { ...real, hasPermission: (p: Permission) => auth.granted?.has(p) ?? true };
    },
  };
});

function orderWith(surplus: number, bankable = surplus): Order {
  return {
    id: 1,
    name: 'Ten flasks',
    customer_id: null,
    customer_name: null,
    status: 'active',
    priority: 'normal',
    price: null,
    tags: null,
    due_date: null,
    url: null,
    lines: [
      {
        id: 10,
        product_id: 1,
        product_name: 'Flask',
        quantity: 10,
        parts: [
          { part_id: 1, name: 'flask', qty_per_unit: 1, need: 10, usable: 10, in_progress: 0, remaining: 0, surplus: 0 },
          { part_id: 2, name: 'lid', qty_per_unit: 1, need: 10, usable: 10 + surplus, in_progress: 0, remaining: 0, surplus },
        ],
      },
    ],
    figures: { margin: null, bankable_surplus: bankable },
  } as unknown as Order;
}

const noop = () => {};

function mount(order: Order, onBankSurplus = noop) {
  render(
    <OrderHeader
      order={order}
      onEdit={noop}
      onDuplicate={noop}
      onDelete={noop}
      onSetStatus={noop}
      onBankSurplus={onBankSurplus}
      bankingSurplus={false}
    />,
  );
}

describe('OrderHeader · bank the surplus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = null;
    vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'USD' } as never);
  });

  it('is offered but refused while no line has overprinted', () => {
    mount(orderWith(0));

    const button = screen.getByTestId('order-bank-surplus');
    expect(button).toBeDisabled();
    // The button says why it cannot be pressed rather than leaving the operator
    // to guess which line it is waiting for.
    expect(button).toHaveAttribute('title', expect.stringMatching(/bank/i));
  });

  it('goes dark once the surplus has been banked, though the surplus itself stays', () => {
    // Ruling 30, and the regression that made the button useless: five parts
    // still overprinted, five already on the shelf, nothing left to move.
    mount(orderWith(5, 0));

    const button = screen.getByTestId('order-bank-surplus');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/bank/i));
  });

  it('is enabled by a surplus on any part of any line, and hands the press up', () => {
    const onBank = vi.fn();
    mount(orderWith(5), onBank);

    const button = screen.getByTestId('order-bank-surplus');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    // ⚠️ The header does not POST: the page owns the call and the toast,
    // because only it knows which products the order's lines are for.
    expect(onBank).toHaveBeenCalledTimes(1);
  });

  it('is not offered to a reader', () => {
    auth.granted = new Set(['projects:read']);
    mount(orderWith(5));

    expect(screen.queryByTestId('order-bank-surplus')).not.toBeInTheDocument();
  });
});

describe('OrderHeader · description', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = null;
    vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'USD' } as never);
  });

  it('shows the description under the title, keeping its line breaks', () => {
    mount({ ...orderWith(0), description: 'Line one\nLine two' } as Order);
    const text = screen.getByTestId('order-description');
    expect(text).toHaveTextContent('Line one Line two');
    expect(text).toHaveClass('whitespace-pre-line');
  });

  it('draws nothing for an empty description', () => {
    mount({ ...orderWith(0), description: null } as Order);
    expect(screen.queryByTestId('order-description')).not.toBeInTheDocument();
  });

  it('draws nothing for a description of blanks', () => {
    mount({ ...orderWith(0), description: '  \n ' } as Order);
    expect(screen.queryByTestId('order-description')).not.toBeInTheDocument();
  });
});

describe('OrderHeader · code and contact person', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = null;
    vi.spyOn(api, 'getSettings').mockResolvedValue({ currency: 'USD' } as never);
  });

  it('shows the order code and who receives it, with a phone link', () => {
    mount({
      ...orderWith(0),
      code: 'OR-0001',
      customer_id: 2,
      customer_name: 'ACME',
      contact_id: 10,
      contact: { id: 10, code: 'CT-0010', name: 'Olena', role: null, phone: '+380 1', email: null },
    } as Order);
    expect(screen.getByText('OR-0001')).toBeInTheDocument();
    expect(screen.getByText(/contact: Olena/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '+380 1' })).toHaveAttribute('href', 'tel:+3801');
  });

  it('names a nameless contact by its role, as the customer pages do', () => {
    mount({
      ...orderWith(0),
      code: 'OR-0001',
      contact_id: 11,
      contact: { id: 11, code: 'CT-0011', name: null, role: 'Warehouse', phone: null, email: null },
    } as Order);
    expect(screen.getByText(/contact: Warehouse/)).toBeInTheDocument();
  });

  it('says nothing about a contact when the order has none', () => {
    mount({ ...orderWith(0), code: 'OR-0001', contact_id: null, contact: null } as Order);
    expect(screen.queryByText(/contact:/)).not.toBeInTheDocument();
  });
});
