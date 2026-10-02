/**
 * The «Orders» tab of the product page (WS-13 E9 H01–H02): the orders that have a line of
 * this product, newest first, in pages of 24 — the order list's own answer with this
 * product's lines in it (`product_lines`, A02) — and the units printed for orders under it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { render } from '../../../utils';
import { api } from '../../../../api/client';
import type { OrderListItem, OrderListPage } from '../../../../api/client';
import { ProductOrdersTab } from '../../../../components/products/detail/ProductOrdersTab';

const handle = vi.hoisted(() => ({ client: null as QueryClient | null }));
function Capture() {
  const qc = useQueryClient();
  useEffect(() => {
    handle.client = qc;
  }, [qc]);
  return null;
}

function order(id: number, over: Partial<OrderListItem> = {}): OrderListItem {
  return {
    id,
    code: `OR-000${id}`,
    name: `Order ${id}`,
    customer_name: 'Acme',
    status: 'active',
    stage: 'printing',
    ordered: 10,
    covered_units: 4,
    progress: 0.4,
    printed: 4,
    from_stock_units: 0,
    product_lines: [],
    ...over,
  } as OrderListItem;
}

function page(items: OrderListItem[], current = 1, last = 1, total = items.length): OrderListPage {
  return {
    items,
    meta: { total, current_page: current, per_page: 24, last_page: last },
    totals: { active: 0, completed: 0, cancelled: 0, all: 0, stages: {} },
  } as unknown as OrderListPage;
}

const config = (option: string | null) => ({
  choices: option ? [{ group_id: 1, group_name: 'Lid', option_id: 11, option_name: option, is_default: false }] : [],
  changed_parts: [],
});

const product = { id: 7, units_printed_total: 12 };

describe('ProductOrdersTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the order list for this product, newest first, 24 a page', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(page([order(1)]));
    render(<ProductOrdersTab product={product} />);
    await screen.findByTestId('product-order-1');
    expect(get).toHaveBeenCalledWith({ product_id: 7, page: 1, per_page: 24, sort_by: 'created-desc' });
  });

  it('a row: the order with its customer, this product’s lines, the stage and the order’s coverage', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(
      page([
        order(1, {
          product_lines: [
            { line_id: 1, mode: 'product', quantity: 2, configuration: config('Cork') },
            { line_id: 2, mode: 'parts', quantity: 1, configuration: config(null) },
          ],
        }),
        order(2, { customer_name: null, stage: null, status: 'cancelled', product_lines: [{ line_id: 3, mode: 'product', quantity: 5, configuration: config(null) }] }),
      ]),
    );
    render(<ProductOrdersTab product={product} />);
    const first = await screen.findByTestId('product-order-1');
    expect(within(first).getByRole('link', { name: 'OR-0001 · Order 1' })).toHaveAttribute('href', '/projects/1');
    expect(within(first).getByText('Acme')).toBeInTheDocument();
    expect(within(first).getByText('× 2 · Lid: Cork')).toBeInTheDocument();
    expect(within(first).getByText('parts only')).toBeInTheDocument();
    expect(within(first).getByText('Printing')).toBeInTheDocument();
    expect(within(first).getByTestId('order-1-coverage')).toBeInTheDocument();
    const second = screen.getByTestId('product-order-2');
    expect(within(second).getByText('No customer')).toBeInTheDocument();
    expect(within(second).getByText('× 5')).toBeInTheDocument();
    expect(within(second).getByText('Cancelled')).toBeInTheDocument();
  });

  it('pages: the next one is asked for, and a page past the end is normalised by its own answer', async () => {
    const get = vi
      .spyOn(api, 'getOrdersPaged')
      .mockResolvedValueOnce(page([order(1)], 1, 3, 60))
      .mockResolvedValueOnce(page([], 3, 2, 30))
      .mockResolvedValue(page([order(2)], 2, 2, 30));
    render(<ProductOrdersTab product={product} />);
    await screen.findByTestId('product-order-1');
    fireEvent.click(screen.getByRole('button', { name: 'Last page' }));
    await screen.findByTestId('product-order-2');
    expect(get.mock.calls.map((c) => c[0].page)).toEqual([1, 3, 2]);
  });

  it('first read: skeleton rows; a failure: an alert with a retry for the same page', async () => {
    const get = vi.spyOn(api, 'getOrdersPaged').mockRejectedValueOnce(new Error('boom'));
    render(<ProductOrdersTab product={product} />);
    expect(screen.getByTestId('product-orders-skeleton')).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the orders');
    get.mockResolvedValue(page([order(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByTestId('product-order-1');
  });

  it('a failed re-read keeps the rows under a note', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValueOnce(page([order(1)])).mockRejectedValue(new Error('boom'));
    render(
      <>
        <Capture />
        <ProductOrdersTab product={product} />
      </>,
    );
    await screen.findByTestId('product-order-1');
    await act(async () => {
      await handle.client!.invalidateQueries({ queryKey: ['projects'] });
    });
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(screen.getByTestId('product-order-1')).toBeInTheDocument();
  });

  it('none: says so; the units printed for orders stand under it', async () => {
    vi.spyOn(api, 'getOrdersPaged').mockResolvedValue(page([]));
    render(<ProductOrdersTab product={product} />);
    expect(await screen.findByText('No order needs this product yet')).toBeInTheDocument();
    expect(screen.getByTestId('product-units-printed-total')).toHaveTextContent('12');
    expect(screen.getByText(/printed for orders/i)).toBeInTheDocument();
  });
});
