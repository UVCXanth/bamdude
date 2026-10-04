/**
 * Filing a selection under an order (WS-13 E13 D03): the shared server-side order
 * choice, the line picker, and a refusal (403 rights, 409 a print that cannot leave
 * its order) kept in the dialog in the server's words — nothing filed, nothing lost.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import { BatchAssignOrderModal } from '../../../components/projects/BatchAssignOrderModal';

const flasks = { id: 5, code: 'OR-0005', name: 'Flasks', status: 'active', customer_name: null, lines: [] };

describe('BatchAssignOrderModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue({
      items: [flasks],
      meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
      totals: { active: 1, completed: 0, cancelled: 0, all: 1, stages: {} },
    } as never);
    vi.spyOn(api, 'getOrder').mockResolvedValue(flasks as never);
  });

  it('files the selection under the order chosen from the server search', async () => {
    const add = vi.spyOn(api, 'addArchivesToOrder').mockResolvedValue({} as never);
    const onClose = vi.fn();
    render(<BatchAssignOrderModal archiveIds={[3, 4]} onClose={onClose} />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    await waitFor(() => expect(add).toHaveBeenCalledWith(5, [3, 4], null));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // One print from its card or row (WS-13 E13 D03): the same dialog, opened on the
  // print's own order and line — a closed order included, named with its status.
  it('opens one print on its own order and line, even a closed order', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue({
      id: 9,
      code: 'OR-0009',
      name: 'Shipped',
      status: 'completed',
      customer_name: null,
      lines: [{ id: 90, product_name: 'Vase', quantity: 1, mode: 'product', configuration: { choices: [], changed_parts: [] } }],
    } as never);
    render(<BatchAssignOrderModal archiveIds={[3]} bound={{ orderId: 9, lineId: 90 }} onClose={() => {}} />);
    const order = screen.getByRole('combobox', { name: 'Order' }) as HTMLSelectElement;
    await waitFor(() => expect(order.selectedOptions[0]).toHaveTextContent('OR-0009 · Shipped · Completed'));
    const line = screen.getByRole('combobox', { name: 'Line' }) as HTMLSelectElement;
    await waitFor(() => expect(line.selectedOptions[0]).toHaveTextContent('Vase × 1'));
  });

  // WS-13 E13 final review #6 (D01): a print filed under a CLOSED order is shown there, but
  // nothing new is filed into that order — no other line, no «Assign»; it can only leave.
  it('files nothing new into the closed order a print sits in — it can only leave', async () => {
    vi.spyOn(api, 'getOrder').mockResolvedValue({
      id: 9,
      code: 'OR-0009',
      name: 'Shipped',
      status: 'completed',
      customer_name: null,
      lines: [{ id: 90, product_name: 'Vase', quantity: 1, mode: 'product', configuration: { choices: [], changed_parts: [] } }],
    } as never);
    render(<BatchAssignOrderModal archiveIds={[3]} bound={{ orderId: 9, lineId: 90 }} onClose={() => {}} />);
    const order = screen.getByRole('combobox', { name: 'Order' }) as HTMLSelectElement;
    await waitFor(() => expect(order.selectedOptions[0]).toHaveTextContent('OR-0009 · Shipped · Completed'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Line' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove from order' })).not.toBeDisabled();
  });

  // V01: the order's own command, which asks the Workshop's filing right — never the archive editor.
  it('takes one print out of its order through the order', async () => {
    const remove = vi.spyOn(api, 'removeArchivesFromProject').mockResolvedValue({} as never);
    const patch = vi.spyOn(api, 'updateArchive');
    const onClose = vi.fn();
    render(<BatchAssignOrderModal archiveIds={[3]} bound={{ orderId: 5, lineId: null }} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove from order' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(5, [3]));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(patch).not.toHaveBeenCalled();
  });

  // WS-13 E13 T9 (the acceptance frame): «Cancel» and «Assign» are one group, so when the
  // footer is too narrow for all three the PAIR moves under «Remove from order» — the primary
  // never ends up on a row of its own, away from its «Cancel».
  it('keeps «Cancel» and «Assign» together, apart from «Remove from order»', async () => {
    render(<BatchAssignOrderModal archiveIds={[3]} bound={{ orderId: 5, lineId: null }} onClose={() => {}} />);
    const remove = await screen.findByRole('button', { name: 'Remove from order' });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const assign = screen.getByRole('button', { name: 'Assign' });
    expect(cancel.parentElement).toBe(assign.parentElement);
    expect(remove.parentElement).not.toBe(cancel.parentElement);
  });

  it('offers no removal for a selection, nor for a print in no order', async () => {
    const { unmount } = render(<BatchAssignOrderModal archiveIds={[3, 4]} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    expect(screen.queryByRole('button', { name: 'Remove from order' })).not.toBeInTheDocument();
    unmount();
    render(<BatchAssignOrderModal archiveIds={[3]} bound={{ orderId: null, lineId: null }} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    expect(screen.queryByRole('button', { name: 'Remove from order' })).not.toBeInTheDocument();
  });

  it('keeps a refusal in the dialog, in the server’s words', async () => {
    vi.spyOn(api, 'addArchivesToOrder').mockRejectedValue(
      new ApiError('These prints went onto the shelf for the order — they cannot leave it', 409),
    );
    const onClose = vi.fn();
    render(<BatchAssignOrderModal archiveIds={[3]} onClose={onClose} />);
    await screen.findByRole('option', { name: 'OR-0005 · Flasks · no customer' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Order' }), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'These prints went onto the shelf for the order — they cannot leave it',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
