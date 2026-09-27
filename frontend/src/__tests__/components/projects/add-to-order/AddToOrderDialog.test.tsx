import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import { AddToOrderDialog } from '../../../../components/projects/add-to-order/AddToOrderDialog';
import { lamp, pageOf, pipe, pipeDetail, suggestion } from './fixtures';

const orders = {
  items: [
    { id: 5, code: 'OR-0005', name: 'Flasks for Acme', status: 'active' },
    { id: 6, code: 'OR-0006', name: 'Spares', status: 'active' },
  ],
  meta: { total: 2, current_page: 1, per_page: 20, last_page: 1 },
  totals: { active: 2, completed: 0, cancelled: 0, all: 2, stages: {} },
};

describe('AddToOrderDialog', () => {
  let add: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([pipe, lamp], 2));
    vi.spyOn(api, 'getProduct').mockResolvedValue(pipeDetail as never);
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    vi.spyOn(api, 'getProductParts').mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } });
    vi.spyOn(api, 'getLibraryFilesPaged').mockResolvedValue({ items: [], meta: { total: 0, current_page: 1, per_page: 24, last_page: 1 } } as never);
    vi.spyOn(api, 'suggestStock').mockImplementation(async (items) => ({
      items: items.map((item) =>
        item.product_id === 1
          ? suggestion({ from_finished: 2, from_kits: 3, to_print: Math.max(0, item.quantity - 5) })
          : suggestion({ product_id: 2, finished_free: 0, kits_free: 1, from_finished: 0, from_kits: 1, to_print: item.quantity - 1 }),
      ),
    }));
    add = vi.spyOn(api, 'addOrderLines').mockImplementation(async (_order, lines) => ({
      order: { id: 5 } as never,
      results: lines.map((_line, i) => ({ line_id: 40 + i, asked_finished: 0, got_finished: 0, asked_kits: 0, got_kits: 0 })),
    }));
  });

  async function tick(id: number) {
    const row = await screen.findByTestId(`add-product-${id}`);
    fireEvent.click(within(row).getByRole('checkbox'));
    return row;
  }

  it('three tabs switch without losing the picks', async () => {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    await tick(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Parts of a product' }));
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Products' }));
    expect(within(await screen.findByTestId('add-product-1')).getByRole('checkbox')).toBeChecked();
  });

  it('says what is picked and adds every line in one request', async () => {
    const onClose = vi.fn();
    render(<AddToOrderDialog orderId={5} onClose={onClose} />);
    const pipeRow = await tick(1);
    fireEvent.change(within(pipeRow).getByLabelText('Quantity'), { target: { value: '6' } });
    fireEvent.change(await within(pipeRow).findByLabelText('Tail'), { target: { value: '101' } });
    const lampRow = await tick(2);
    await waitFor(() => expect(within(lampRow).getByLabelText('Kits')).toHaveValue(1));
    fireEvent.change(within(lampRow).getByLabelText('Kits'), { target: { value: '0' } });
    fireEvent.change(within(lampRow).getByLabelText('Material'), { target: { value: 'PLA' } });
    expect(screen.getByText('Selected: 2 products · 7 pcs')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add lines (2)' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(5, [
        { kind: 'product', product_id: 1, quantity: 6, choices: { 10: 101 }, material: null, color: null, stock: 'auto' },
        {
          kind: 'product',
          product_id: 2,
          quantity: 1,
          choices: {},
          material: 'PLA',
          color: null,
          stock: { from_finished: 0, from_kits: 0 },
        },
      ]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('warns when the shelf gave less than was asked', async () => {
    add.mockResolvedValue({
      order: { id: 5, lines: [{ id: 40, product_name: 'Pipe' }] } as never,
      results: [{ line_id: 40, asked_finished: 2, got_finished: 1, asked_kits: 0, got_kits: 0 }],
    });
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    await tick(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add lines (1)' }));
    expect(await screen.findByText(/Pipe: ready 1 of 2/)).toBeInTheDocument();
  });

  it('a refusal is the server sentence, and the dialog stays', async () => {
    add.mockRejectedValue(new ApiError('Product not found', 404));
    const onClose = vi.fn();
    render(<AddToOrderDialog orderId={5} onClose={onClose} />);
    await tick(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add lines (1)' }));
    expect(await screen.findByText('Product not found')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('from a product page: the product is ticked and an active order is chosen first', async () => {
    const getOrders = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(orders as never);
    render(<AddToOrderDialog preselectProductId={1} onClose={() => {}} />);
    expect(within(await screen.findByTestId('add-product-1')).getByRole('checkbox')).toBeChecked();
    expect(getOrders).toHaveBeenLastCalledWith({ status: 'active', page: 1, per_page: 20 });
    const submit = screen.getByRole('button', { name: 'Add lines (1)' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Order'), { target: { value: '6' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(add).toHaveBeenCalledWith(6, expect.any(Array)));
  });
});
