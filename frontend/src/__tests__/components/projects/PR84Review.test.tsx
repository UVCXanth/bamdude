import { afterEach, expect, it, vi } from 'vitest';
import { act, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order, OrderPlan } from '../../../api/client';
import { OrderPage } from '../../../pages/orders/OrderPage';
import { makeOrder, mockOrderDetailApi } from '../../fixtures/orderDetail';

afterEach(() => { vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

it('reviews the current order configuration alongside its freshly read plan', async () => {
  const old = makeOrder();
  const reads = mockOrderDetailApi(old);
  vi.spyOn(api, 'getProductPlates').mockResolvedValue([]);
  window.history.pushState({}, '', '/projects/1?section=prints');
  render(<Routes><Route path="/projects/:id" element={<OrderPage />} /></Routes>);
  const shortcut = await screen.findByRole('button', { name: 'Whole order to auto queue…' });
  // Another client switches this line to parts-only; this tab missed that event.
  // The newly fetched plan will belong to that configuration, not the cached kit.
  reads.getOrder.mockResolvedValue({ ...old, lines: old.lines.map(line => ({ ...line, mode: 'parts' })) });
  reads.getOrderPlan.mockResolvedValue({
    lines: [{ line_id: 10, product_id: 1, product_name: 'Flask', material: 'PETG',
      outstanding_before: [], surplus_after: [], unsatisfiable: [], candidates: [100], not_sliced: [],
      rows: [{ plate_id: 100, library_file_id: 5, plate_index: 1, filename: 'parts-only.3mf',
        hidden: false, count: 1, useful: [], print_time_seconds: 60, filament_used_grams: 1,
        cost: null, time_unknown: false, printer_model: 'P1S', alternatives: [] }] }],
    totals: { rows: 1, prints: 1, print_time_seconds: 60, filament_used_grams: 1, cost: null },
  });
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  expect(dialog).toHaveTextContent('parts only');
});

function plan(): OrderPlan {
  return {
    lines: [{ line_id: 10, product_id: 1, product_name: 'Flask', material: 'PETG',
      outstanding_before: [], surplus_after: [], unsatisfiable: [], candidates: [100], not_sliced: [],
      rows: [{ plate_id: 100, library_file_id: 5, plate_index: 1, filename: 'Product-A.3mf',
        hidden: false, count: 1, useful: [], print_time_seconds: 60, filament_used_grams: 1,
        cost: null, time_unknown: false, printer_model: 'P1S', alternatives: [] }] }],
    totals: { rows: 1, prints: 1, print_time_seconds: 60, filament_used_grams: 1, cost: null },
  };
}

async function page(section = 'prints') {
  const order = makeOrder();
  const reads = mockOrderDetailApi(order);
  reads.getOrderPlan.mockResolvedValue(plan());
  vi.spyOn(api, 'getProductPlates').mockResolvedValue([]);
  const send = vi.spyOn(api, 'enqueueOrderPlan').mockResolvedValue({ created: [] });
  window.history.pushState({}, '', `/projects/1?section=${section}`);
  render(<Routes><Route path="/projects/:id" element={<OrderPage />} /></Routes>);
  const shortcut = await screen.findByRole('button', { name: 'Whole order to auto queue…' });
  return { order, reads, send, shortcut };
}

it('reviews a changed variant from fresh order details', async () => {
  const { order, reads, shortcut, send } = await page();
  reads.getOrder.mockResolvedValue({ ...order, lines: order.lines.map(line => ({ ...line,
    config_key: 'synthetic-wide',
    configuration: { choices: [{ group_id: 1, group_name: 'Size', option_id: 2, option_name: 'Wide', is_default: false }], changed_parts: [] },
  })) });
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  expect(dialog).toHaveTextContent('Size: Wide');
  expect(dialog).not.toHaveTextContent('standard configuration');
  expect(send).not.toHaveBeenCalled();
});

it('waits for slow order details even when a newly mounted plan already succeeded', async () => {
  const { order, reads, shortcut, send } = await page();
  let resolve!: (value: Order) => void;
  reads.getOrder.mockReturnValue(new Promise<Order>(done => { resolve = done; }));
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  const button = within(dialog).getByRole('button', { name: 'Send to auto queue' });
  await waitFor(() => expect(reads.getOrderPlan).toHaveResolved());
  expect(button).toBeDisabled();
  expect(dialog).not.toHaveTextContent('standard configuration');
  fireEvent.click(button);
  expect(send).not.toHaveBeenCalled();
  await act(async () => resolve({ ...order, lines: order.lines.map(line => ({ ...line, mode: 'parts' })) }));
  await waitFor(() => expect(button).toBeEnabled());
  expect(dialog).toHaveTextContent('parts only');
  // The early plan read was cancelled/re-read after the order became current.
  expect(reads.getOrderPlan.mock.calls.length).toBeGreaterThan(1);
});

it('keeps Send blocked on a failed detail refresh and retries both reads', async () => {
  const { order, reads, shortcut, send } = await page();
  reads.getOrder.mockRejectedValue(new Error('synthetic detail failure'));
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  const retry = await within(dialog).findByRole('button', { name: 'Retry' });
  expect(dialog).toHaveTextContent('Could not refresh the order and its plan');
  expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  reads.getOrder.mockResolvedValue({ ...order, lines: order.lines.map(line => ({ ...line, mode: 'parts' })) });
  const before = reads.getOrderPlan.mock.calls.length;
  fireEvent.click(retry);
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  expect(dialog).toHaveTextContent('parts only');
  expect(reads.getOrderPlan.mock.calls.length).toBeGreaterThan(before);
});

it('waits for the plan read that starts after current details, not an earlier late answer', async () => {
  const { reads, shortcut } = await page();
  let resolve!: (value: OrderPlan) => void;
  reads.getOrderPlan.mockResolvedValueOnce(plan()).mockReturnValueOnce(new Promise<OrderPlan>(done => { resolve = done; }));
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  const button = within(dialog).getByRole('button', { name: 'Send to auto queue' });
  await waitFor(() => expect(reads.getOrderPlan).toHaveBeenCalledTimes(2));
  expect(button).toBeDisabled();
  await act(async () => resolve(plan()));
  await waitFor(() => expect(button).toBeEnabled());
});

it('keeps edited counts when the refreshed plan still means the same thing', async () => {
  const { reads, shortcut, send } = await page('plan');
  const count = await screen.findByTestId('plan-row-10-100-count');
  fireEvent.change(count, { target: { value: '3' } });
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  expect(dialog).toHaveTextContent('Total: 3 print runs');
  expect(reads.getOrder.mock.calls.length).toBeGreaterThan(1);
  expect(count).toHaveValue(3);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send to auto queue' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(1, { target: { kind: 'auto' }, items: [{ line_id: 10, plate_id: 100, count: 3 }] }));
});

it('a cancelled slow review cannot overwrite the next review', async () => {
  const { order, reads, shortcut, send } = await page();
  let resolveOld!: (value: Order) => void;
  const before = reads.getOrder.mock.calls.length;
  reads.getOrder.mockReturnValue(new Promise<Order>(done => { resolveOld = done; }));
  fireEvent.click(shortcut);
  const first = await screen.findByRole('dialog');
  await waitFor(() => expect(reads.getOrder.mock.calls.length).toBeGreaterThan(before));
  expect(within(first).getByRole('button', { name: 'Send to auto queue' })).toBeDisabled();
  fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
  reads.getOrder.mockResolvedValue({ ...order, lines: order.lines.map(line => ({ ...line, mode: 'parts' })) });
  fireEvent.click(shortcut);
  const second = await screen.findByRole('dialog');
  await waitFor(() => expect(within(second).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  await act(async () => resolveOld(order));
  await waitFor(() => expect(within(second).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  expect(second).toHaveTextContent('parts only');
  expect(send).not.toHaveBeenCalled();
});

it('does not send a plan whose lines no longer match the refreshed order', async () => {
  const { order, reads, shortcut, send } = await page();
  reads.getOrder.mockResolvedValue({ ...order, lines: order.lines.map(line => ({ ...line, product_id: 99 })) });
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('button', { name: 'Retry' });
  expect(dialog).toHaveTextContent('Could not refresh the order and its plan');
  expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

it('retries both reads after details succeed but the plan fails', async () => {
  const { reads, shortcut, send } = await page('plan');
  await screen.findByTestId('plan-row-10-100-count');
  reads.getOrderPlan.mockRejectedValue(new Error('synthetic plan failure'));
  fireEvent.click(shortcut);
  const dialog = await screen.findByRole('dialog');
  const retry = await within(dialog).findByRole('button', { name: 'Retry' });
  expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
  const before = reads.getOrder.mock.calls.length;
  reads.getOrderPlan.mockResolvedValue(plan());
  fireEvent.click(retry);
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Send to auto queue' })).toBeEnabled());
  expect(reads.getOrder.mock.calls.length).toBeGreaterThan(before);
});
