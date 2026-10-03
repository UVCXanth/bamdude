/**
 * The hand correction of free parts (WS-13 E10 I01–I03, F25, R07). The dialog reads the
 * shelf itself (`useProductStock`) — both doors hand it only the product — and shows
 * «now N → will be N + Δ» from a successful CURRENT read only; below zero it says so and
 * waits. A refusal stays in the dialog and the shelf is read again, what was typed kept,
 * nothing sent again by itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { ProductStock } from '../../../api/client';
import { AdjustStockDialog } from '../../../components/products/AdjustStockDialog';

const shelf = (lid: number, flask = 6): ProductStock =>
  ({
    kits_available: 3,
    kits_by_option: [],
    movements: [],
    balances: [
      { part_id: 1, name: 'Lid', qty_per_unit: 1, balance: lid },
      { part_id: 2, name: 'Flask', qty_per_unit: 2, balance: flask },
    ],
  }) as ProductStock;

const noop = () => {};
const save = () => screen.getByRole('button', { name: /^(save|saving…)$/i });

describe('AdjustStockDialog', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('is the mockup’s dialog: its title, the product, «Part (on the shelf N)», the cursor in the first field', async () => {
    vi.spyOn(api, 'getProductStock').mockResolvedValue(shelf(5));
    render(<AdjustStockDialog productId={5} productName="Flask kit" onClose={noop} />);
    const dialog = screen.getByRole('dialog', { name: 'Adjust free parts' });
    expect(dialog).toHaveAccessibleDescription('Flask kit');
    const part = screen.getByLabelText('Part');
    expect(await within(part).findByRole('option', { name: 'Lid (on the shelf 5)' })).toBeInTheDocument();
    expect(within(part).getByRole('option', { name: 'Flask (on the shelf 6)' })).toBeInTheDocument();
    await waitFor(() => expect(part).toHaveFocus());
  });

  it('reads the shelf itself, and starts on the part it was handed', async () => {
    const read = vi.spyOn(api, 'getProductStock').mockResolvedValue(shelf(5));
    render(<AdjustStockDialog productId={5} productName="Flask kit" initialPartId={2} onClose={noop} />);
    await waitFor(() => expect(read).toHaveBeenCalledWith(5));
    await waitFor(() => expect(screen.getByLabelText('Part')).toHaveValue('2'));
  });

  it('«now → will be» from the read; below zero it says so and waits', async () => {
    vi.spyOn(api, 'getProductStock').mockResolvedValue(shelf(5));
    render(<AdjustStockDialog productId={5} productName="Flask kit" onClose={noop} />);
    await screen.findByRole('option', { name: 'Lid (on the shelf 5)' });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted the shelf' } });
    fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '-2' } });
    expect(screen.getByTestId('stock-adjust-projection')).toHaveTextContent('Now 5 → will be 3');
    expect(save()).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '-6' } });
    expect(screen.getByTestId('stock-adjust-projection')).toHaveTextContent(
      'Now 5 → will be -1 — below zero — the stock cannot be negative',
    );
    expect(save()).toBeDisabled();
  });

  it('while the shelf is read, «…»; a failed read says so with a retry and no projection', async () => {
    let fail: (e: Error) => void = noop;
    const read = vi
      .spyOn(api, 'getProductStock')
      .mockReturnValueOnce(new Promise((_r, reject) => (fail = reject)) as never)
      .mockResolvedValueOnce(shelf(5));
    render(<AdjustStockDialog productId={5} productName="Flask kit" initialPartId={1} onClose={noop} />);
    expect(screen.getByTestId('stock-adjust-projection')).toHaveTextContent('…');
    await act(async () => fail(new Error('HTTP 500')));
    const failed = await screen.findByText('Could not read the stock');
    expect(screen.queryByText(/will be/)).not.toBeInTheDocument();
    fireEvent.click(within(failed.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Now 5 → will be 6')).toBeInTheDocument();
  });

  it('a zero change and an empty reason hold «Save», each with its hint', async () => {
    const adjust = vi.spyOn(api, 'adjustProductStock');
    vi.spyOn(api, 'getProductStock').mockResolvedValue(shelf(5));
    render(<AdjustStockDialog productId={5} productName="Flask kit" onClose={noop} />);
    await screen.findByRole('option', { name: 'Lid (on the shelf 5)' });
    expect(screen.getByLabelText('Why')).toHaveAccessibleDescription('Give the reason — it goes into the journal.');
    expect(save()).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
    fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '0' } });
    expect(screen.getByLabelText(/^Change/)).toHaveAccessibleDescription('The change is a whole number, not zero.');
    expect(save()).toBeDisabled();
    expect(adjust).not.toHaveBeenCalled();
  });

  it('a refusal stays in the dialog; the shelf is read again, what was typed kept, nothing sent again', async () => {
    const read = vi.spyOn(api, 'getProductStock').mockResolvedValueOnce(shelf(10)).mockResolvedValueOnce(shelf(4));
    const adjust = vi
      .spyOn(api, 'adjustProductStock')
      .mockRejectedValue(new ApiError('Lid holds 4; stock never goes below 0', 409));
    render(<AdjustStockDialog productId={5} productName="Flask kit" onClose={noop} />);
    await screen.findByRole('option', { name: 'Lid (on the shelf 10)' });
    fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '-8' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted the shelf' } });
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('Lid holds 4; stock never goes below 0');
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Now 4 → will be -4 — below zero — the stock cannot be negative')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Change/)).toHaveValue(-8);
    expect(screen.getByLabelText('Why')).toHaveValue('counted the shelf');
    expect(screen.getByLabelText('Part')).toHaveValue('1');
    expect(adjust).toHaveBeenCalledTimes(1);
  });

  it('a chosen part the new read no longer holds is said so — never swapped for another', async () => {
    vi.spyOn(api, 'getProductStock')
      .mockResolvedValueOnce(shelf(10))
      .mockResolvedValueOnce({ ...shelf(0), balances: [shelf(0).balances[1]] } as ProductStock);
    vi.spyOn(api, 'adjustProductStock').mockRejectedValue(new ApiError('This part is not counted', 422));
    render(<AdjustStockDialog productId={5} productName="Flask kit" onClose={noop} />);
    await screen.findByRole('option', { name: 'Lid (on the shelf 10)' });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
    fireEvent.click(save());
    expect(await screen.findByText('This part no longer holds stock')).toBeInTheDocument();
    expect(screen.getByLabelText('Part')).toHaveValue('1');
    expect(save()).toBeDisabled();
  });

  it('a success refreshes the stock once, says so and closes; nothing closes it under the request', async () => {
    vi.spyOn(api, 'getProductStock').mockResolvedValue(shelf(5));
    let land: () => void = noop;
    const adjust = vi
      .spyOn(api, 'adjustProductStock')
      .mockReturnValue(new Promise((resolve) => (land = () => resolve({} as never))) as never);
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    const onClose = vi.fn();
    render(<AdjustStockDialog productId={5} productName="Flask kit" onClose={onClose} />);
    await screen.findByRole('option', { name: 'Lid (on the shelf 5)' });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
    const submit = save();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    act(() => {
      submit.click();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      cancel.click();
      submit.click();
    });
    await waitFor(() => expect(adjust).toHaveBeenCalledTimes(1));
    expect(adjust).toHaveBeenCalledWith(5, { part_id: 1, delta: 1, note: 'counted' });
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => land());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('The stock and its journal were updated')).toBeInTheDocument();
    expect(invalidate.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === '["stock-movements"]')).toHaveLength(1);
  });
});
