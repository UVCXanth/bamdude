import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError, type OrderPlan, type PlateFitResponse } from '../../../api/client';
import { PlateFitDialog, type PlateFitDoor } from '../../../components/projects/PlateFitDialog';
import { makeOrder, makeLine } from '../../fixtures/orderDetail';

const order = makeOrder({ id: 41, lines: [makeLine({ id: 17, product_name: 'Product A', quantity: 1000 }), makeLine({ id: 18, product_name: 'Product B', quantity: 20 })] });
const door: PlateFitDoor = { orderId: 41, lineId: 17, mode: 'nearest', selectedPlates: { 17: [7] }, onApplied: vi.fn() };
function readyPlan(): OrderPlan {
  return { lines: [{ line_id: 17, product_id: 1, product_name: 'Product A', material: null, outstanding_before: [{ part_id: 1, name: 'Part A', count: 2930 }], rows: [], surplus_after: [], unsatisfiable: [], candidates: [7], not_sliced: [] }], totals: { prints: 0, rows: 0, print_time_seconds: 0, filament_used_grams: 0, cost: null }, truncated: false };
}
function result(quantities = [900, 1100, 3000]): PlateFitResponse {
  return { line_id: 17, current_quantity: 1000, around: 1000, basis: 'a'.repeat(64), plate_ids: [7],
    plates: [{ plate_id: 7, library_file_id: 6, plate_index: 1, filename: 'Product A.gcode.3mf', printer_model: 'A1 Mini', hidden: false, print_time_seconds: 60, filament_used_grams: 1 }],
    options: quantities.map(quantity => ({ quantity, runs: [{ plate_id: 7, count: quantity / 10 }], parts: [{ part_id: 1, name: 'Part A', required: quantity, allocated: 20, completed: 30, printing: 10, queued: 10, new_printed: quantity - 70 }], print_time_seconds: quantity * 6, filament_used_grams: quantity / 10 })),
    lower: 'found', upper: 'found', current: 'none', quantity_limit: 1_000_000, removable_auto_ids: [] };
}
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  vi.spyOn(api, 'getOrder').mockResolvedValue(order);
  vi.spyOn(api, 'getPlateFit').mockResolvedValue(result([900, 3000]));
  vi.spyOn(api, 'updateOrderLine').mockResolvedValue(makeOrder({ ...order, lines: [makeLine({ id: 17, quantity: 3000 })] }));
  vi.spyOn(api, 'getOrderPlan').mockResolvedValue(readyPlan());
});
async function calculate(d = door) {
  render(<PlateFitDialog door={d} onClose={vi.fn()} />);
  await screen.findByText(/Product A · Currently ordered/);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
  await screen.findByText(/1,000 → 3,000/);
}

describe('whole-plate quantity review', () => {
  it('requires separate consent to remove only the reviewed pending auto jobs', async () => {
    vi.mocked(api.getPlateFit).mockResolvedValue({ ...result([900, 3000]), removable_auto_ids: [91, 92] });
    render(<PlateFitDialog door={door} onClose={vi.fn()} />);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('checkbox', { name: /Recalculate unassigned Auto Queue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByText(/1,000 → 3,000/);
    expect(api.getPlateFit).toHaveBeenCalledWith(41, 17, expect.objectContaining({ replace_pending: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    const apply = screen.getByRole('button', { name: 'Set 3,000 and remove 2 pending jobs' });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm removing these 2 jobs/ }));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(api.updateOrderLine).toHaveBeenCalledWith(41, 17, expect.objectContaining({ plate_fit: expect.objectContaining({ replace_pending: true, acknowledge_queue_change: true }) })));
  });
  it('sends only selected recipes and requires a blank acknowledgement above 10%', async () => {
    await calculate();
    expect(api.getPlateFit).toHaveBeenCalledWith(41, 17, { around: 1000, plate_ids: [7], steps: 1 });
    const apply = screen.getByRole('button', { name: 'Set quantity to 3,000' });
    expect(apply).toBeDisabled();
    const ack = screen.getByRole('checkbox', { name: /I understand that the quantity/ });
    expect(ack).not.toBeChecked();
    fireEvent.click(ack);
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(api.updateOrderLine).toHaveBeenCalledWith(41, 17, { quantity: 3000, plate_fit: { basis: 'a'.repeat(64), plate_ids: [7], runs: [{ plate_id: 7, count: 300 }], acknowledge_large_change: true } }));
    await waitFor(() => expect(door.onApplied).toHaveBeenCalledWith(expect.objectContaining({ lineId: 17, quantity: 3000, rows: [expect.objectContaining({ plate_id: 7, count: 300 })] })));
  });
  it('allows exactly 10% without extra acknowledgement and never applies a previous selection acknowledgement', async () => {
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: /900 · -100/ }));
    expect(screen.queryByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set quantity to 900' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: /3,000 · \+2,000/ }));
    expect(screen.getByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Set quantity to 3,000' })).toBeDisabled();
  });
  it('browses discrete quantities near 20,000 without a global production slider', async () => {
    vi.mocked(api.getPlateFit).mockResolvedValue(result([19992, 20004, 20016]));
    render(<PlateFitDialog door={{ ...door, mode: 'browse' }} onClose={vi.fn()} />);
    const input = await screen.findByRole('spinbutton', { name: /Desired quantity/ });
    fireEvent.change(input, { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByRole('slider');
    expect(api.getPlateFit).toHaveBeenCalledWith(41, 17, { around: 20000, plate_ids: [7], steps: 3 });
    expect(screen.getByRole('slider')).toHaveAttribute('max', '2');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Set quantity to 20,016' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeChecked();
  });
  it('invalidates results and acknowledgement when desired quantity or line changes', async () => {
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20000' } });
    expect(screen.queryByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '18' } });
    expect(screen.getByRole('spinbutton')).toHaveValue(20);
  });
  it('keeps a stale proposal from applying after defects change', async () => {
    vi.mocked(api.updateOrderLine).mockRejectedValue(new ApiError('changed', 409, 'plate_fit_stale'));
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Set quantity to 3,000' }));
    await screen.findByText(/print results, queue or plate yields changed/);
    expect(door.onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
  });
  it('does not replay a saved quantity patch after the following plan read fails', async () => {
    vi.mocked(api.getOrderPlan).mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(readyPlan());
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Set quantity to 3,000' }));
    await screen.findByText('read failed');
    fireEvent.click(screen.getByRole('button', { name: 'Load the saved plan again' }));
    await waitFor(() => expect(door.onApplied).toHaveBeenCalled());
    expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
    expect(api.getOrderPlan).toHaveBeenCalledTimes(2);
  });
  it('shows a bounded search as unfinished instead of claiming infeasibility', async () => {
    vi.mocked(api.getPlateFit).mockResolvedValue({ ...result([]), lower: 'limited', upper: 'limited', current: 'limited' });
    render(<PlateFitDialog door={door} onClose={vi.fn()} />);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByText(/unfinished search does not prove/);
    expect(api.updateOrderLine).not.toHaveBeenCalled();
  });
});
