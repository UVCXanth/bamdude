/**
 * Assembling finished goods from free parts (WS-13 E12 H02–H04): three doors (R01) — a
 * position (its configuration fixed), a product (its groups chosen) and the stock page's
 * header (the product chosen too); every K, part and shelf from a current read (G08).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../utils';
import { api, ApiError } from '../../../api/client';
import type { StockItemDetail, StockLookup } from '../../../api/client';
import { AssembleDialog } from '../../../components/stock/AssembleDialog';
import { pipeDetail, pipeItem, pipeProduct } from './stockFixtures';

const submit = () => screen.getByTestId('assemble-submit');
const howMany = () => screen.getByLabelText('How many to assemble');

const lookupOf = (canAssemble: number, item: StockLookup['item'] = null): StockLookup => ({
  item,
  configuration: pipeItem.configuration,
  can_assemble: canAssemble,
  parts: [
    { part_id: 11, name: 'flask', per: 1, on_shelf: 4 },
    { part_id: 12, name: 'tail', per: 2, on_shelf: 6 },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('AssembleDialog', () => {
  let assemble: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    assemble = vi.spyOn(api, 'assembleStock').mockResolvedValue(pipeItem);
    vi.spyOn(api, 'getStockItem').mockResolvedValue(pipeDetail);
    vi.spyOn(api, 'getProducts').mockResolvedValue([pipeProduct] as never);
    vi.spyOn(api, 'getProduct').mockResolvedValue(pipeProduct as never);
  });

  it('the frame: its title and what it does', async () => {
    render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog', { name: 'Assemble finished goods from parts' });
    expect(dialog).toHaveAccessibleDescription(
      'Parts leave the free shelf; finished goods go into the position of their configuration',
    );
    expect(submit()).toHaveTextContent('Assemble');
  });

  describe('from a position: its configuration is fixed', () => {
    it('the kit against the shelf, what each part writes off, and the position it grows — from the current read', async () => {
      render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByTestId('assemble-position')).toHaveTextContent('Stock position: SK-0005 · standard · now 5 pcs'));
      expect(screen.queryByRole('combobox')).toBeNull();
      const table = screen.getByRole('table');
      expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
        'Part',
        'Per unit',
        'On the shelf',
        'Written off',
      ]);
      expect(within(screen.getByTestId('assemble-part-12')).getByText('× 2')).toBeInTheDocument();
      expect(screen.getByTestId('assemble-writeoff-12')).toHaveTextContent('2');
      expect(screen.getByText('up to 1')).toBeInTheDocument();
      fireEvent.click(submit());
      await waitFor(() => expect(assemble).toHaveBeenCalledWith({ item_id: 5, qty: 1 }));
    });

    it('a short shelf is amber and says what is missing in words', async () => {
      vi.spyOn(api, 'getStockItem').mockResolvedValue({ ...pipeDetail, can_assemble: 3 });
      render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByText('up to 3')).toBeInTheDocument());
      fireEvent.change(howMany(), { target: { value: '2' } });
      // tail: 2 per unit × 2 = 4 against 3 on the shelf.
      expect(screen.getByTestId('assemble-shelf-12')).toHaveClass('text-status-warning');
      expect(within(screen.getByTestId('assemble-part-12')).getByText('short by 1')).toBeInTheDocument();
      expect(screen.getByTestId('assemble-shelf-11')).not.toHaveClass('text-status-warning');
    });

    it('nothing to assemble: the primary waits and says why', async () => {
      vi.spyOn(api, 'getStockItem').mockResolvedValue({ ...pipeDetail, can_assemble: 0 });
      render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
      await screen.findByTestId('assemble-part-11');
      await waitFor(() =>
        expect(submit()).toHaveAccessibleDescription('Nothing can be assembled from the free parts of this configuration now'),
      );
      expect(submit()).toBeDisabled();
    });

    it('a cached position is not the answer: K comes from the read', async () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
      client.setQueryData(['stock-item', 5], { ...pipeDetail, can_assemble: 9 });
      const read = deferred<StockItemDetail>();
      vi.spyOn(api, 'getStockItem').mockReturnValue(read.promise);
      render(
        <QueryClientProvider client={client}>
          <AssembleDialog item={pipeItem} onClose={() => {}} />
        </QueryClientProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('assemble-limit')).toHaveTextContent('reading…'));
      expect(screen.queryByText('up to 9')).toBeNull();
      expect(submit()).toBeDisabled();
      await act(async () => read.resolve({ ...pipeDetail, can_assemble: 2 }));
      await waitFor(() => expect(screen.getByText('up to 2')).toBeInTheDocument());
    });
  });

  describe('from a product: the product is fixed, the configuration chosen (R01)', () => {
    it('names the product, reads no catalog, and starts from the standard', async () => {
      const lookup = vi.spyOn(api, 'lookupStockItem').mockResolvedValue(lookupOf(1, pipeItem));
      render(<AssembleDialog productId={1} onClose={() => {}} />);
      await waitFor(() => expect(screen.getByTestId('stock-locked-product')).toHaveTextContent('PR-0001 · Pipe'));
      expect(api.getProducts).not.toHaveBeenCalled();
      expect(((await screen.findByLabelText('Tail')) as HTMLSelectElement).value).toBe('100');
      await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, []));
      await waitFor(() => expect(screen.getByTestId('assemble-position')).toHaveTextContent('Stock position: SK-0005 · standard · now 5 pcs'));
    });

    it('a configuration that makes nothing waits with its reason; another one that makes three is open', async () => {
      vi.spyOn(api, 'lookupStockItem').mockImplementation(async (_id: number, options: number[] = []) =>
        options.includes(101) ? lookupOf(3) : lookupOf(0, pipeItem),
      );
      render(<AssembleDialog productId={1} onClose={() => {}} />);
      await waitFor(() =>
        expect(submit()).toHaveAccessibleDescription('Nothing can be assembled from the free parts of this configuration now'),
      );
      const tail = screen.getByLabelText('Tail');
      expect(tail).toBeEnabled();
      fireEvent.change(tail, { target: { value: '101' } });
      await waitFor(() => expect(screen.getByText('up to 3')).toBeInTheDocument());
      expect(screen.getByTestId('assemble-position')).toHaveTextContent('Stock position: new — it appears after the assembly');
      expect(submit()).toBeEnabled();
      fireEvent.click(submit());
      await waitFor(() => expect(assemble).toHaveBeenCalledWith({ product_id: 1, options: [101], qty: 1 }));
    });

    it('another configuration on its way reads «reading…» and the primary waits', async () => {
      const angled = deferred<StockLookup>();
      vi.spyOn(api, 'lookupStockItem').mockImplementation(async (_id: number, options: number[] = []) =>
        options.includes(101) ? angled.promise : lookupOf(2, pipeItem),
      );
      render(<AssembleDialog productId={1} onClose={() => {}} />);
      await waitFor(() => expect(submit()).toBeEnabled());
      fireEvent.change(screen.getByLabelText('Tail'), { target: { value: '101' } });
      await waitFor(() => expect(screen.getByTestId('assemble-limit')).toHaveTextContent('reading…'));
      expect(submit()).toBeDisabled();
    });

    // WS-13 E9 Codex review V01: a group with no standard option showed its first option
    // while the lookup and the assembly sent no choice at all.
    it('a group without a standard reads «No choice» and sends what it shows', async () => {
      const noStandard = { ...pipeProduct, variant_groups: pipeProduct.variant_groups.map((g) => ({ ...g, default_option_id: null })) };
      vi.spyOn(api, 'getProduct').mockResolvedValue(noStandard as never);
      const lookup = vi
        .spyOn(api, 'lookupStockItem')
        .mockResolvedValue({ item: null, configuration: { choices: [], changed_parts: [] }, can_assemble: 1, parts: [] });
      render(<AssembleDialog productId={1} onClose={() => {}} />);
      const select = (await screen.findByRole('combobox', { name: 'Tail' })) as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(select.selectedOptions[0]).toHaveTextContent('No choice');
      fireEvent.change(select, { target: { value: '100' } });
      await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, [100]));
      fireEvent.change(select, { target: { value: '' } });
      await waitFor(() => expect(lookup).toHaveBeenLastCalledWith(1, []));
      await waitFor(() => expect(submit()).toBeEnabled());
      fireEvent.click(submit());
      await waitFor(() => expect(assemble).toHaveBeenCalled());
      expect(assemble.mock.calls[0][0]).toMatchObject({ product_id: 1, options: [] });
    });

    it('a one-off product is not kept in finished stock — the primary says so', async () => {
      vi.spyOn(api, 'getProduct').mockResolvedValue({ ...pipeProduct, origin: 'order' } as never);
      vi.spyOn(api, 'lookupStockItem').mockResolvedValue(lookupOf(2));
      render(<AssembleDialog productId={1} onClose={() => {}} />);
      await waitFor(() => expect(submit()).toHaveAccessibleDescription('A one-off product is not kept in finished stock'));
      expect(submit()).toBeDisabled();
    });
  });

  it('from the header: the product is chosen too, and the cursor starts there', async () => {
    vi.spyOn(api, 'lookupStockItem').mockResolvedValue(lookupOf(1));
    render(<AssembleDialog onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Product')).toHaveFocus());
    fireEvent.click(await screen.findByRole('button', { name: 'PR-0001 · Pipe' }));
    await waitFor(() => expect(screen.getByText('up to 1')).toBeInTheDocument());
  });

  it("the hint about bought parts is the mockup's", async () => {
    render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
    expect(
      await screen.findByText("Bought parts (screws, LEDs) are not written off here — in BamDude they live in an order's procurement, not on a shelf."),
    ).toBeInTheDocument();
  });

  it('a refusal stays in the slot: the focus on the primary, the draft whole, the position read again', async () => {
    vi.spyOn(api, 'getStockItem').mockResolvedValue({ ...pipeDetail, can_assemble: 3 });
    assemble.mockRejectedValue(new ApiError('Only 1 can be assembled from the free parts', 409));
    render(<AssembleDialog item={pipeItem} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText('up to 3')).toBeInTheDocument());
    fireEvent.change(howMany(), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'batch 7' } });
    const reads = (api.getStockItem as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(submit());
    fireEvent.click(submit());
    expect(await screen.findByRole('alert')).toHaveTextContent('Only 1 can be assembled from the free parts');
    expect(assemble).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(submit()).toHaveFocus());
    expect(howMany()).toHaveValue(2);
    expect(screen.getByLabelText('Note')).toHaveValue('batch 7');
    await waitFor(() => expect((api.getStockItem as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(reads));
  });
});
