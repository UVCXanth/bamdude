/**
 * The hand correction of free parts (WS-13 E10 I01–I03, F25, R07). The dialog reads the
 * shelf itself (`useProductStock`) — both doors hand it only the product — and shows
 * «now N → will be N + Δ» from a successful CURRENT read only; below zero it says so and
 * waits. A refusal stays in the dialog and the shelf is read again, what was typed kept,
 * nothing sent again by itself.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

/** The dialog over a page whose shelf is already in the cache (`['product-stock', 5]`). */
function mountOverCache(cached: ProductStock, initialPartId?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['product-stock', 5], cached);
  render(
    <QueryClientProvider client={client}>
      <AdjustStockDialog productId={5} productName="Flask kit" initialPartId={initialPartId} onClose={noop} />
    </QueryClientProvider>,
  );
  return client;
}

/** A read held until the test answers it. */
function held() {
  let answer: (s: ProductStock) => void = noop;
  let refuse: (e: Error) => void = noop;
  const promise = new Promise<ProductStock>((resolve, reject) => {
    answer = resolve;
    refuse = reject;
  });
  return { promise, answer: (s: ProductStock) => answer(s), refuse: (e: Error) => refuse(e) };
}

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

  describe('a shelf the page had already read is not the current one (I02; Codex V02)', () => {
    it('cache 0, the opening read says 5: «…» and no old number while it is read, then only the new one', async () => {
      const read = held();
      vi.spyOn(api, 'getProductStock').mockReturnValue(read.promise as never);
      mountOverCache(shelf(0), 1);
      fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '-1' } });
      fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
      expect(screen.getByTestId('stock-adjust-projection')).toHaveTextContent('…');
      expect(screen.getByTestId('stock-adjust-projection')).not.toHaveTextContent(/Now|below zero/);
      expect(within(screen.getByLabelText('Part')).queryByRole('option', { name: /on the shelf/ })).toBeNull();
      // Not judged below zero by a number that is not current: the server is the guard meanwhile.
      expect(save()).toBeEnabled();
      await act(async () => read.answer(shelf(5)));
      expect(await screen.findByText('Now 5 → will be 4')).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Lid (on the shelf 5)' })).toBeInTheDocument();
      expect(screen.getByLabelText(/^Change/)).toHaveValue(-1);
      expect(screen.getByLabelText('Why')).toHaveValue('counted');
      expect(screen.getByLabelText('Part')).toHaveValue('1');
    });

    it('cache 10, the opening read says 4: «…» while it is read, then below zero by the new number', async () => {
      const read = held();
      vi.spyOn(api, 'getProductStock').mockReturnValue(read.promise as never);
      mountOverCache(shelf(10), 1);
      fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '-8' } });
      fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
      expect(screen.getByTestId('stock-adjust-projection')).toHaveTextContent('…');
      expect(screen.queryByText(/Now 10/)).not.toBeInTheDocument();
      await act(async () => read.answer(shelf(4)));
      expect(
        await screen.findByText('Now 4 → will be -4 — below zero — the stock cannot be negative'),
      ).toBeInTheDocument();
      expect(save()).toBeDisabled();
    });

    it('a failed opening read over the cache: the failure and its retry, no projection, the server guards', async () => {
      const read = held();
      vi.spyOn(api, 'getProductStock').mockReturnValueOnce(read.promise as never).mockResolvedValueOnce(shelf(2));
      mountOverCache(shelf(0), 1);
      fireEvent.change(screen.getByLabelText(/^Change/), { target: { value: '-1' } });
      fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
      await act(async () => read.refuse(new Error('HTTP 500')));
      const failed = await screen.findByText('Could not read the stock');
      expect(screen.queryByText(/will be/)).not.toBeInTheDocument();
      expect(save()).toBeEnabled();
      fireEvent.click(within(failed.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('Now 2 → will be 1')).toBeInTheDocument();
    });

    it('a part the cache lacks is not «gone» until a current read says so', async () => {
      const read = held();
      vi.spyOn(api, 'getProductStock').mockReturnValue(read.promise as never);
      mountOverCache({ ...shelf(0), balances: [shelf(0).balances[1]] } as ProductStock, 1);
      expect(screen.queryByText('This part no longer holds stock')).not.toBeInTheDocument();
      await act(async () => read.answer(shelf(3)));
      expect(await screen.findByRole('option', { name: 'Lid (on the shelf 3)' })).toBeInTheDocument();
      expect(screen.getByLabelText('Part')).toHaveValue('1');
      expect(screen.queryByText('This part no longer holds stock')).not.toBeInTheDocument();
    });

    it('a background refresh while it is open is «…» again until it answers', async () => {
      const second = held();
      vi.spyOn(api, 'getProductStock').mockResolvedValueOnce(shelf(5)).mockReturnValueOnce(second.promise as never);
      const client = mountOverCache(shelf(5), 1);
      fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'counted' } });
      expect(await screen.findByText('Now 5 → will be 6')).toBeInTheDocument();
      act(() => {
        void client.invalidateQueries({ queryKey: ['product-stock', 5] });
      });
      await waitFor(() => expect(screen.getByTestId('stock-adjust-projection')).toHaveTextContent('…'));
      await act(async () => second.answer(shelf(7)));
      expect(await screen.findByText('Now 7 → will be 8')).toBeInTheDocument();
    });
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
