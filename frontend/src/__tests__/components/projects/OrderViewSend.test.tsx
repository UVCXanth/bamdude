/**
 * Sending the plan from the order page (WS-13 E3 R03, review 1): between the
 * send and the forecast read after it, the «Ready ≈» tile and the forecast
 * panel show no numbers; the fresh answer brings them back, and a failed
 * re-read ends in the panel's retry — not in «loading» for ever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderPage } from '../../../pages/orders/OrderPage';
import { makeForecast, makeOrder, mockOrderDetailApi } from '../../fixtures/orderDetail';

const plan = {
  lines: [
    {
      line_id: 10,
      product_id: 1,
      product_name: 'Flask',
      material: 'PETG',
      outstanding_before: [{ part_id: 1, name: 'Body', count: 2 }],
      rows: [
        {
          plate_id: 100,
          library_file_id: 5,
          plate_index: 1,
          filename: 'big.3mf',
          hidden: false,
          count: 1,
          useful: [{ part_id: 1, name: 'Body', count: 2 }],
          print_time_seconds: 3600,
          filament_used_grams: 100,
          cost: 2,
          time_unknown: false,
          printer_model: 'X1C',
          alternatives: [],
        },
      ],
      surplus_after: [],
      unsatisfiable: [],
      candidates: [100],
      not_sliced: [],
    },
  ],
  totals: { rows: 1, prints: 1, print_time_seconds: 3600, filament_used_grams: 100, cost: 2 },
};

function renderPage() {
  window.history.pushState({}, '', '/projects/1');
  return render(
    <Routes>
      <Route path="/projects/:id" element={<OrderPage />} />
    </Routes>,
  );
}

async function sendThePlan(reread: Promise<never>) {
  const spies = mockOrderDetailApi(makeOrder());
  spies.getOrderPlan.mockResolvedValue(plan as never);
  spies.getOrderForecast.mockResolvedValueOnce(makeForecast({ now_eta: '2026-09-26T09:37:00Z' }));
  vi.spyOn(api, 'enqueueOrderPlan').mockResolvedValue({ created: [{ line_id: 10, plate_id: 100, queue_item_ids: [7] }] } as never);
  renderPage();

  const ready = await screen.findByTestId('order-tile-ready');
  await waitFor(() => expect(ready).toHaveTextContent(/26/));
  spies.getOrderForecast.mockReturnValue(reread);
  fireEvent.click(await screen.findByTestId('plan-enqueue-all'));
  return spies;
}

describe('OrderView · sending the plan', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('shows no numbers until the forecast after the send arrives, then shows it', async () => {
    let answer: (value: never) => void = () => {};
    await sendThePlan(new Promise((resolve) => (answer = resolve)));

    const ready = screen.getByTestId('order-tile-ready');
    await waitFor(() => expect(ready).toHaveTextContent('…'));
    expect(within(screen.getByTestId('order-forecast-panel')).queryByTestId('order-forecast-eta')).toBeNull();

    answer(makeForecast({ now_eta: '2026-09-28T09:37:00Z' }) as never);
    await waitFor(() => expect(ready).toHaveTextContent(/28/));
    expect(screen.getByTestId('order-forecast-eta')).toBeInTheDocument();
  });

  // E3-V02 (Codex review 1): the first forecast read is still in flight when the
  // plan is sent. TanStack hands that in-flight read back to the invalidation (a
  // query without data reuses its fetch), so its late answer — the PREVIOUS plan's
  // — must not open the numbers; a read started after the send must.
  async function sendWhileTheFirstReadIsHeld(second: Promise<never>) {
    const spies = mockOrderDetailApi(makeOrder());
    spies.getOrderPlan.mockResolvedValue(plan as never);
    let releaseFirst: (value: never) => void = () => {};
    // Both answers are set up front: the read after the send starts inside the send's own success.
    spies.getOrderForecast
      .mockReturnValueOnce(new Promise((resolve) => (releaseFirst = resolve)) as never)
      .mockReturnValueOnce(second);
    vi.spyOn(api, 'enqueueOrderPlan').mockResolvedValue({ created: [{ line_id: 10, plate_id: 100, queue_item_ids: [7] }] } as never);
    renderPage();
    fireEvent.click(await screen.findByTestId('plan-enqueue-all'));
    await waitFor(() => expect(api.enqueueOrderPlan).toHaveBeenCalled());
    return { spies, releaseFirst };
  }

  it('does not take the answer of a read started before the send as the fresh forecast', async () => {
    let answer: (value: never) => void = () => {};
    const { spies, releaseFirst } = await sendWhileTheFirstReadIsHeld(new Promise((resolve) => (answer = resolve)));

    releaseFirst(makeForecast({ now_eta: '2026-09-26T09:37:00Z' }) as never);
    const ready = screen.getByTestId('order-tile-ready');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ready).not.toHaveTextContent(/26/);
    expect(ready).toHaveTextContent('…');
    expect(within(screen.getByTestId('order-forecast-panel')).queryByTestId('order-forecast-eta')).toBeNull();
    expect(spies.getOrderForecast).toHaveBeenCalledTimes(2);

    answer(makeForecast({ now_eta: '2026-09-28T09:37:00Z' }) as never);
    await waitFor(() => expect(ready).toHaveTextContent(/28/));
  });

  it('ends a failed read after the send in the retry even when the first read was still in flight', async () => {
    let fail: (e: Error) => void = () => {};
    const { spies, releaseFirst } = await sendWhileTheFirstReadIsHeld(new Promise((_, reject) => (fail = reject)));

    releaseFirst(makeForecast({ now_eta: '2026-09-26T09:37:00Z' }) as never);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId('order-tile-ready')).not.toHaveTextContent(/26/);
    expect(spies.getOrderForecast).toHaveBeenCalledTimes(2);
    fail(new Error('boom'));
    const panel = screen.getByTestId('order-forecast-panel');
    expect(await within(panel).findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByTestId('order-tile-ready')).toHaveTextContent('—');
  });

  it('ends a failed re-read after the send in the panel’s retry', async () => {
    let fail: (e: Error) => void = () => {};
    await sendThePlan(new Promise((_, reject) => (fail = reject)));

    const panel = screen.getByTestId('order-forecast-panel');
    await waitFor(() => expect(screen.getByTestId('order-tile-ready')).toHaveTextContent('…'));
    fail(new Error('boom'));
    expect(await within(panel).findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByTestId('order-tile-ready')).toHaveTextContent('—');
  });
});
