import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api, ApiError, type OrderPlan, type PlateFitResponse } from '../../../api/client';
import { PlateFitDialog, type PlateFitDoor } from '../../../components/projects/PlateFitDialog';
import { makeOrder, makeLine } from '../../fixtures/orderDetail';

const order = makeOrder({ id: 41, lines: [makeLine({ id: 17, product_name: 'Product A', quantity: 1000 }), makeLine({ id: 18, product_name: 'Product B', quantity: 20 })] });
const door: PlateFitDoor = { orderId: 41, lineId: 17, selectedPlates: { 17: [7] }, onApplied: vi.fn() };
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
// Testing Library normalizes NBSP in text; preserve locale grouping while matching it.
function numberText(text: string) {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s/g, '\\s'));
}
async function calculate(d = door) {
  render(<PlateFitDialog door={d} onClose={vi.fn()} />);
  await screen.findByText(/Product A · Currently ordered/);
  fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
  await screen.findByText(numberText(`${(1000).toLocaleString()} → ${(3000).toLocaleString()}`));
}

describe.each(['en-US', 'uk-UA'])('whole-plate quantity review (%s)', locale => {
  beforeEach(() => {
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number) {
      return new Intl.NumberFormat(locale).format(Number(this));
    });
  });
  it('extended search is opt-in, invalidates the review and never changes the queue by itself', async () => {
    await calculate();
    const extended = screen.getByRole('checkbox', { name: /Extended search/ });
    expect(extended).not.toBeChecked();
    expect(api.getPlateFit).toHaveBeenLastCalledWith(41, 17, { around: 1000, plate_ids: [7], steps: 1 });
    fireEvent.click(extended);
    expect(screen.queryByRole('button', { name: 'Show more options' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByRole('button', { name: 'Show more options' });
    expect(api.getPlateFit).toHaveBeenLastCalledWith(41, 17, { around: 1000, plate_ids: [7], steps: 1, extended_search: true });
    fireEvent.click(extended);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByRole('button', { name: 'Show more options' });
    expect(api.getPlateFit).toHaveBeenLastCalledWith(41, 17, { around: 1000, plate_ids: [7], steps: 1 });
    expect(api.updateOrderLine).not.toHaveBeenCalled();
    expect(door.onApplied).not.toHaveBeenCalled();
  });
  it('extended search names its bounded wait and cannot change mode while running', async () => {
    let resolve!: (value: PlateFitResponse) => void;
    vi.mocked(api.getPlateFit).mockReturnValueOnce(new Promise<PlateFitResponse>(done => { resolve = done; }));
    render(<PlateFitDialog door={door} onClose={vi.fn()} />);
    const extended = await screen.findByRole('checkbox', { name: /Extended search/ });
    fireEvent.click(extended);
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    expect(extended).toBeDisabled();
    expect(screen.getByText(/Searching.*30 seconds/)).toBeInTheDocument();
    resolve({ ...result([900]), upper: 'limited' });
    await screen.findByRole('button', { name: numberText(`${(900).toLocaleString()} · -100`) });
    expect(screen.getByText(/The calculation reached its limit/)).toBeInTheDocument();
    expect(extended).toBeEnabled();
    expect(api.updateOrderLine).not.toHaveBeenCalled();
  });
  it('an apply whose re-check ran out of time drops the option and asks for a new calculation', async () => {
    vi.mocked(api.updateOrderLine).mockRejectedValue(new ApiError('busy', 429, 'plate_fit_busy'));
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
    await screen.findByText(/could not be re-checked in time\. Calculate again/);
    expect(screen.queryByText(/Another quantity calculation is running/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
    expect(door.onApplied).not.toHaveBeenCalled();
  });
  it.each(['plate_fit_busy', 'plate_fit_invalid_plan', 'plate_fit_stale'])(
    'a refused apply (%s) drops the whole review: nothing of it can be applied again without a new calculation',
    async code => {
      vi.mocked(api.updateOrderLine).mockRejectedValueOnce(new ApiError('refused', code === 'plate_fit_busy' ? 429 : 409, code));
      await calculate();
      fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
      fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
      await screen.findByRole('alert');
      expect(screen.queryByRole('button', { name: numberText(`${(3000).toLocaleString()} ·`) })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: numberText(`${(900).toLocaleString()} ·`) })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
      expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));  // a new calculation is the way on
      await screen.findByText(numberText(`${(1000).toLocaleString()} → ${(3000).toLocaleString()}`));
      expect(api.getPlateFit).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeChecked();
    },
  );
  it('shows the greedy free-stock reservation before applying and rechecks the resulting plan', async () => {
    const reply = result([900, 3000]);
    reply.options[1] = { ...reply.options[1], from_finished: 2, from_kits: 3, stock_parts: { '1': 4 },
      parts: [{ ...reply.options[1].parts[0], free_stock: 9, new_printed: 2921 }] };
    vi.mocked(api.getPlateFit).mockResolvedValue(reply);
    const plan = readyPlan(); plan.lines[0].outstanding_before[0].count = 2921;
    vi.mocked(api.getOrderPlan).mockResolvedValue(plan);
    await calculate();
    expect(screen.getByText('Applying will reserve free stock: 2 finished products, 3 kits and 4 individual parts.')).toBeInTheDocument();
    expect(api.updateOrderLine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
    await waitFor(() => expect(door.onApplied).toHaveBeenCalled());
  });
  it('requires separate consent to remove only the reviewed pending auto jobs', async () => {
    vi.mocked(api.getPlateFit).mockResolvedValue({ ...result([900, 3000]), removable_auto_ids: [91, 92] });
    render(<PlateFitDialog door={door} onClose={vi.fn()} />);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('checkbox', { name: /Recalculate unassigned Auto Queue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByText(numberText(`${(1000).toLocaleString()} → ${(3000).toLocaleString()}`));
    expect(api.getPlateFit).toHaveBeenCalledWith(41, 17, expect.objectContaining({ replace_pending: true }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    const apply = screen.getByRole('button', { name: numberText(`Set ${(3000).toLocaleString()} and remove 2 pending jobs`) });
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm removing these 2 jobs/ }));
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await waitFor(() => expect(api.updateOrderLine).toHaveBeenCalledWith(41, 17, expect.objectContaining({ plate_fit: expect.objectContaining({ replace_pending: true, acknowledge_queue_change: true }) })));
  });
  it('sends only selected recipes and requires a blank acknowledgement above 10%', async () => {
    await calculate();
    expect(api.getPlateFit).toHaveBeenCalledWith(41, 17, { around: 1000, plate_ids: [7], steps: 1 });
    const apply = screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) });
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
    fireEvent.click(screen.getByRole('button', { name: numberText(`${(3000).toLocaleString()} · +${(2000).toLocaleString()}`) }));
    expect(screen.getByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) })).toBeDisabled();
  });
  it('browses discrete quantities near 20,000 without a global production slider', async () => {
    vi.mocked(api.getPlateFit).mockResolvedValue({ ...result([19992, 20004, 20016]), around: 20000 });
    render(<PlateFitDialog door={door} onClose={vi.fn()} />);
    const input = await screen.findByRole('spinbutton', { name: /Desired quantity/ });
    fireEvent.change(input, { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByRole('button', { name: 'Show more options' });
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more options' }));
    await screen.findByRole('slider');
    expect(api.getPlateFit).toHaveBeenCalledWith(41, 17, { around: 20000, plate_ids: [7], steps: 3 });
    expect(screen.getByRole('slider')).toHaveAttribute('max', '2');
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: numberText(`Set quantity to ${(20016).toLocaleString()}`) })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeChecked();
  });
  it('loads the wider range on demand and resets consent without writing or enqueueing', async () => {
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    vi.mocked(api.getPlateFit).mockResolvedValue(result([900, 3000, 6000]));
    fireEvent.click(screen.getByRole('button', { name: 'Show more options' }));
    await screen.findByRole('slider');
    expect(api.getPlateFit).toHaveBeenLastCalledWith(41, 17, { around: 1000, plate_ids: [7], steps: 3 });
    expect(screen.getByRole('checkbox', { name: /I understand that the quantity/ })).not.toBeChecked();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: numberText(`Set quantity to ${(6000).toLocaleString()}`) })).toBeDisabled();
    expect(api.updateOrderLine).not.toHaveBeenCalled();
  });
  it('can retry a failed expansion and keeps subsequent calculations in the wider range', async () => {
    await calculate();
    vi.mocked(api.getPlateFit).mockRejectedValueOnce(new Error('preview unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Show more options' }));
    await screen.findByText('preview unavailable');
    expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
    vi.mocked(api.getPlateFit).mockResolvedValue(result([19992, 20004, 20016]));
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '20000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByRole('slider');
    expect(api.getPlateFit).toHaveBeenLastCalledWith(41, 17, { around: 20000, plate_ids: [7], steps: 3 });
    expect(api.updateOrderLine).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
    await screen.findByText(/print results, queue or plate yields changed/);
    expect(door.onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Set quantity to —' })).toBeDisabled();
  });
  it('does not replay a saved quantity patch after the following plan read fails', async () => {
    vi.mocked(api.getOrderPlan).mockRejectedValueOnce(new Error('read failed')).mockResolvedValue(readyPlan());
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
    await screen.findByText('read failed');
    fireEvent.click(screen.getByRole('button', { name: 'Load the saved plan again' }));
    await waitFor(() => expect(door.onApplied).toHaveBeenCalled());
    expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
    expect(api.getOrderPlan).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('R2 refreshes cached queue views after committed removal even when plan read fails=%s', async (readFails) => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const keys = [['auto-queue', { page: 1 }], ['auto-queue', 'summary'], ['queue', 'summary'], ['queues'], ['queue-forecast']];
    for (const key of keys) qc.setQueryData(key, { ids: [91], total: 1 });
    vi.mocked(api.getPlateFit).mockResolvedValue({ ...result([900, 3000]), removable_auto_ids: [91] });
    if (readFails) vi.mocked(api.getOrderPlan).mockRejectedValueOnce(new Error('saved plan unavailable'));
    render(<QueryClientProvider client={qc}><PlateFitDialog door={door} onClose={vi.fn()} /></QueryClientProvider>);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('checkbox', { name: /Recalculate unassigned Auto Queue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByText(numberText(`${(1000).toLocaleString()} → ${(3000).toLocaleString()}`));
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm removing these 1 jobs/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set ${(3000).toLocaleString()} and remove 1 pending jobs`) }));
    if (readFails) await screen.findByText('saved plan unavailable');
    else await waitFor(() => expect(door.onApplied).toHaveBeenCalled());
    for (const key of keys) expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
    expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
    qc.clear();
  });
  it('R2 does not invalidate queues for a failed replacement PATCH', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(['auto-queue', { page: 1 }], { ids: [91] });
    qc.setQueryData(['queue-forecast'], { count: 1 });
    vi.mocked(api.getPlateFit).mockResolvedValue({ ...result([900, 3000]), removable_auto_ids: [91] });
    vi.mocked(api.updateOrderLine).mockRejectedValueOnce(new Error('not committed'));
    render(<QueryClientProvider client={qc}><PlateFitDialog door={door} onClose={vi.fn()} /></QueryClientProvider>);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('checkbox', { name: /Recalculate unassigned Auto Queue/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByText(numberText(`${(1000).toLocaleString()} → ${(3000).toLocaleString()}`));
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /I confirm removing these 1 jobs/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set ${(3000).toLocaleString()} and remove 1 pending jobs`) }));
    await screen.findByText('not committed');
    expect(qc.getQueryState(['auto-queue', { page: 1 }])?.isInvalidated).toBe(false);
    expect(qc.getQueryState(['queue-forecast'])?.isInvalidated).toBe(false);
    expect(api.getOrderPlan).not.toHaveBeenCalled();
    qc.clear();
  });
  it('R3 retries a post-save HTTP 409 read without replaying the successful PATCH', async () => {
    vi.mocked(api.getOrderPlan).mockRejectedValueOnce(new ApiError('saved read conflict', 409)).mockResolvedValue(readyPlan());
    await calculate();
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
    await screen.findByText('saved read conflict');
    expect(door.onApplied).not.toHaveBeenCalled();
    const retry = screen.getByRole('button', { name: 'Load the saved plan again' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    await waitFor(() => expect(door.onApplied).toHaveBeenCalled());
    expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
    expect(api.getOrderPlan).toHaveBeenCalledTimes(2);
  });
  it('R3 offers actionable recovery after changed demand without attaching stale runs or replaying PATCH', async () => {
    const changed = readyPlan(); changed.lines[0].outstanding_before[0].count = 2929;
    vi.mocked(api.getOrderPlan).mockResolvedValueOnce(changed);
    const onClose = vi.fn();
    render(<PlateFitDialog door={door} onClose={onClose} />);
    await screen.findByRole('spinbutton');
    fireEvent.click(screen.getByRole('button', { name: 'Calculate' }));
    await screen.findByText(numberText(`${(1000).toLocaleString()} → ${(3000).toLocaleString()}`));
    fireEvent.click(screen.getByRole('checkbox', { name: /I understand that the quantity/ }));
    fireEvent.click(screen.getByRole('button', { name: numberText(`Set quantity to ${(3000).toLocaleString()}`) }));
    await screen.findByText(/print results, queue or plate yields changed/);
    expect(door.onApplied).not.toHaveBeenCalled();
    expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
    const recovery = screen.getByRole('button', { name: /Load the saved plan again|Close to recalculate/ });
    expect(recovery).toBeEnabled();
    fireEvent.click(recovery);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(door.onApplied).not.toHaveBeenCalled();
    expect(api.updateOrderLine).toHaveBeenCalledTimes(1);
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
