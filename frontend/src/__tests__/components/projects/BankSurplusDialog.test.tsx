/**
 * «Surplus to free stock» (WS-13 E6 F01): a confirmation with the server's own preview —
 * each part's `bankable` (H01) and the order's total — never a difference of client
 * counters; one request per press; a refusal kept in the dialog; a toast from what
 * the server actually moved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { Order } from '../../../api/client';
import { BankSurplusDialog } from '../../../components/projects/BankSurplusDialog';
import { toOrderRef } from '../../../components/projects/orderActions/orderRef';
import { makeFigures, makeLine, makeOrder } from '../../fixtures/orderDetail';

const part = (part_id: number, name: string, bankable: number) => ({
  part_id,
  name,
  qty_per_unit: 1,
  need: 2,
  usable: 2 + bankable,
  in_progress: 0,
  remaining: 0,
  surplus: bankable,
  variant: false,
  queued: 0,
  bankable,
});

const ORDER: Order = makeOrder({
  id: 4,
  code: 'OR-0004',
  name: 'Diffusers',
  figures: makeFigures({ bankable_surplus: 5 }),
  lines: [
    makeLine({ id: 10, product_name: 'Diffuser', parts: [part(1, 'shade', 3), part(2, 'base', 0)] }),
    makeLine({ id: 11, product_name: 'Lamp', parts: [part(3, 'arm', 2)] }),
  ],
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('BankSurplusDialog', () => {
  it('lists the server’s bankable parts and its total, and moves on one press', async () => {
    const bank = vi
      .spyOn(api, 'bankOrderSurplus')
      .mockResolvedValue({ moved: [{ part_id: 1, name: 'shade', delta: 3 }, { part_id: 3, name: 'arm', delta: 2 }], nothing_to_bank: false });
    const onClose = vi.fn();
    render(<BankSurplusDialog order={toOrderRef(ORDER)} detail={ORDER} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Surplus to free stock' });
    expect(dialog).toHaveTextContent('OR-0004 · Diffusers');
    const rows = within(dialog).getAllByRole('row').slice(1).map((r) => r.textContent);
    expect(rows).toEqual(['shadeDiffuser3', 'armLamp2']);
    expect(dialog).toHaveTextContent('recounts the surplus at the moment');
    const go = screen.getByRole('button', { name: 'Move (5)' });
    fireEvent.click(go);
    fireEvent.click(go);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(bank).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/3 shade, 2 arm/)).toBeInTheDocument();
  });

  it('reads the full order when opened from a list', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue(ORDER);
    render(<BankSurplusDialog order={toOrderRef(ORDER)} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Move (5)' })).toBeEnabled();
  });

  it('says there is nothing to move, and moves nothing', () => {
    const empty = { ...ORDER, figures: makeFigures({ bankable_surplus: 0 }), lines: [] };
    render(<BankSurplusDialog order={toOrderRef(empty)} detail={empty} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toHaveTextContent('There is no surplus to move.');
    expect(screen.getByRole('button', { name: 'Move (0)' })).toBeDisabled();
  });

  it('keeps a refusal in the dialog', async () => {
    vi.spyOn(api, 'bankOrderSurplus').mockRejectedValue(new ApiError('Only 2 held for this order', 409));
    render(<BankSurplusDialog order={toOrderRef(ORDER)} detail={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move (5)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Only 2 held for this order');
    // The refusal leaves focus on the button that sent it, never on BODY.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move (5)' })).toHaveFocus());
  });

  it('says on its primary that the move is on its way', async () => {
    vi.spyOn(api, 'bankOrderSurplus').mockReturnValue(new Promise(() => {}));
    render(<BankSurplusDialog order={toOrderRef(ORDER)} detail={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move (5)' }));
    expect(await screen.findByRole('button', { name: 'Move (5)…' })).toBeDisabled();
  });
});
