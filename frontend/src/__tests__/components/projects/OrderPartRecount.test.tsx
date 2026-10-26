import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError, type OrderPartRecount } from '../../../api/client';
import { OrderPartRecountDialog } from '../../../components/projects/OrderPartRecountDialog';

function snapshot(): OrderPartRecount {
  return { token: 'a'.repeat(64), blocked: null, parts: [
    { part_id: 1, name: 'Part A', usable: 36, protected: 6, book: 30, adjustment: 0 },
    { part_id: 2, name: 'Part B', usable: 10, protected: 2, book: 8, adjustment: -2 },
  ] };
}
const door = { orderId: 11, lineId: 22, product: 'Product A' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(api, 'getOrderPartRecount').mockResolvedValue(snapshot());
  vi.spyOn(api, 'recountOrderParts').mockResolvedValue(snapshot());
});

it('requires actual counts, reason, review and explicit confirmation before writing', async () => {
  const close = vi.fn();
  const changed = vi.fn();
  render(<OrderPartRecountDialog door={{ ...door, onChanged: changed }} onClose={close} />);
  const input = await screen.findByRole('spinbutton', { name: 'Actually counted: Part B' });
  expect(input).toHaveValue(8);
  expect(screen.getByText(/future prints add their output normally/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Review correction' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '0' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason (required)' }), { target: { value: 'Counted missing parts' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review correction' }));
  expect(api.recountOrderParts).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Confirm recount' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /I have counted/ })).toHaveFocus();
  fireEvent.click(screen.getByRole('checkbox', { name: /I have counted/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm recount' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(changed).toHaveBeenCalledOnce();
  expect(api.recountOrderParts).toHaveBeenCalledWith(11, 22, { expected_token: 'a'.repeat(64), reason: 'Counted missing parts', parts: [{ part_id: 2, actual: 0 }] });
});

it('invalidates confirmation when counts or reason change and rejects fractional quantities', async () => {
  render(<OrderPartRecountDialog door={door} onClose={vi.fn()} />);
  const input = await screen.findByRole('spinbutton', { name: 'Actually counted: Part B' });
  fireEvent.change(input, { target: { value: '1.5' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason (required)' }), { target: { value: 'Recounted' } });
  expect(screen.getByRole('button', { name: 'Review correction' })).toBeDisabled();
  fireEvent.change(input, { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review correction' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /I have counted/ }));
  fireEvent.change(input, { target: { value: '6' } });
  expect(screen.queryByRole('button', { name: 'Confirm recount' })).not.toBeInTheDocument();
  expect(api.recountOrderParts).not.toHaveBeenCalled();
});

it('retains the editing token across a background refresh and does not replay a stale request', async () => {
  vi.mocked(api.recountOrderParts).mockRejectedValue(new ApiError('Changed', 409, 'order_recount_changed'));
  render(<OrderPartRecountDialog door={door} onClose={vi.fn()} />);
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'Actually counted: Part B' }), { target: { value: '7' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason (required)' }), { target: { value: 'Recounted' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review correction' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /I have counted/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm recount' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Confirm recount' })).not.toBeInTheDocument();
  expect(api.recountOrderParts).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Reload counts and re-enter' }));
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Actually counted: Part B' })).toHaveValue(8));
});

it('explains ambiguous shared output and prevents a correction', async () => {
  vi.mocked(api.getOrderPartRecount).mockResolvedValue({ ...snapshot(), blocked: 'order_recount_shared' });
  render(<OrderPartRecountDialog door={door} onClose={vi.fn()} />);
  await screen.findByText(/File those prints under their actual lines/);
  expect(screen.getByRole('spinbutton', { name: 'Actually counted: Part B' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Review correction' })).toBeDisabled();
});

it('offers an explicit reviewed reversal even when later pooled output is shared', async () => {
  vi.mocked(api.getOrderPartRecount).mockResolvedValue({ ...snapshot(), blocked: 'order_recount_shared' });
  render(<OrderPartRecountDialog door={door} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review reversal of existing corrections' }));
  expect(screen.getByRole('spinbutton', { name: 'Actually counted: Part B' })).toHaveValue(10);
  expect(api.recountOrderParts).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Reason (required)' }), { target: { value: 'Undo before editing line' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review correction' }));
  expect(screen.getByRole('button', { name: 'Confirm recount' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /I have counted/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Confirm recount' }));
  await waitFor(() => expect(api.recountOrderParts).toHaveBeenCalledWith(11, 22, {
    expected_token: 'a'.repeat(64), reason: 'Undo before editing line', parts: [{ part_id: 2, actual: 10 }],
  }));
});
