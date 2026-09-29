/**
 * The order's six sections as tabs (WS-13 E3 §F): the mockup's order and
 * labels, counts the server sent, the tab in the URL written with `replace`,
 * each section mounted on its first visit and kept from then on — so a draft
 * survives a look at another tab — and a section nobody opened asks nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { OrderPage } from '../../../pages/orders/OrderPage';
import { makeOrder, mockOrderDetailApi } from '../../fixtures/orderDetail';

function renderPage(path = '/projects/1') {
  window.history.pushState({}, '', path);
  return render(
    <Routes>
      <Route path="/projects/:id" element={<OrderPage />} />
    </Routes>,
  );
}

const tab = (name: RegExp) => screen.getByRole('tab', { name });

describe('OrderView tabs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('lists the six sections in the mockup’s order, starting on the plan', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const strip = await screen.findByRole('tablist', { name: 'Order sections' });
    expect(within(strip).getAllByRole('tab').map((el) => el.textContent?.replace(/\s*\(.*$/s, '').trim())).toEqual([
      'Print plan',
      'Prints',
      'Purchased parts',
      'Issues',
      'Notes',
      'Attachments',
    ]);
    expect(tab(/^Print plan/)).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('plan-block')).toBeInTheDocument();
  });

  it('counts prints and issues from the order, a zero as a zero', async () => {
    mockOrderDetailApi(makeOrder({ counts: { prints: 3, issues: 0 } }));
    renderPage();

    expect(await screen.findByRole('tab', { name: /^Prints/ })).toHaveTextContent('(3)');
    expect(tab(/^Issues/)).toHaveTextContent('(0)');
    expect(tab(/^Notes/)).not.toHaveTextContent('(');
  });

  it('counts the plan’s rows once the plan is read, and not before (CN2)', async () => {
    const spies = mockOrderDetailApi(makeOrder());
    let answer: (value: never) => void = () => {};
    spies.getOrderPlan.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    renderPage();

    const plan = await screen.findByRole('tab', { name: /^Print plan/ });
    expect(plan).toHaveTextContent('(—)');
    answer({ lines: [], totals: { rows: 2, prints: 2, print_time_seconds: 0, filament_used_grams: 0, cost: null } } as never);
    await waitFor(() => expect(plan).toHaveTextContent('(2)'));
  });

  it('has no plan count on a page opened on another tab, where the plan was never read', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage('/projects/1?section=prints');

    const plan = await screen.findByRole('tab', { name: /^Print plan/ });
    expect(tab(/^Prints/)).toHaveAttribute('aria-selected', 'true');
    expect(plan).not.toHaveTextContent('(');
    expect(api.getOrderPlan).not.toHaveBeenCalled();
  });

  it('puts the tab in the URL with replace, and the plan as a clean URL', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();
    await screen.findByTestId('plan-block');
    const depth = window.history.length;

    fireEvent.click(tab(/^Prints/));
    await waitFor(() => expect(window.location.search).toBe('?section=prints'));
    fireEvent.click(tab(/^Print plan/));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(window.history.length).toBe(depth);
  });

  it('reads an unknown tab as the plan and leaves the URL alone', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage('/projects/1?section=bogus');

    expect(await screen.findByRole('tab', { name: /^Print plan/ })).toHaveAttribute('aria-selected', 'true');
    expect(window.location.search).toBe('?section=bogus');
  });

  it('asks nothing for a section nobody opened, and mounts it once (R08)', async () => {
    const spies = mockOrderDetailApi(makeOrder());
    renderPage();
    await screen.findByTestId('plan-block');
    expect(spies.getProjectArchives).not.toHaveBeenCalled();
    expect(spies.getDispatchNotes).not.toHaveBeenCalled();

    fireEvent.click(tab(/^Prints/));
    await waitFor(() => expect(spies.getProjectArchives).toHaveBeenCalledTimes(1));
    fireEvent.click(tab(/^Print plan/));
    fireEvent.click(tab(/^Prints/));
    // Kept mounted: coming back is not a second first visit.
    expect(spies.getProjectArchives).toHaveBeenCalledTimes(1);
  });

  it('keeps a section’s edit state across a look at another tab', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage('/projects/1?section=notes');

    const notes = await screen.findByRole('tabpanel', { name: /^Notes/ });
    fireEvent.click(within(notes).getByRole('button', { name: 'Edit' }));
    expect(within(notes).getByRole('button', { name: /Save/ })).toBeInTheDocument();

    fireEvent.click(tab(/^Prints/));
    fireEvent.click(tab(/^Notes/));
    const again = screen.getByRole('tabpanel', { name: /^Notes/ });
    expect(within(again).getByRole('button', { name: /Save/ })).toBeInTheDocument();
  });

  it('names each section once — by its tab, not by a second heading inside it', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage('/projects/1?section=prints');

    const panel = await screen.findByRole('tabpanel', { name: /^Prints/ });
    expect(within(panel).queryByRole('heading', { name: /^Prints/ })).toBeNull();
  });

  it('never leaves a section blank — an order with no purchases or issues says so', async () => {
    mockOrderDetailApi(makeOrder({ procurement: [] }));
    renderPage('/projects/1?section=procurement');

    const purchases = await screen.findByRole('tabpanel', { name: /^Purchased parts/ });
    expect(purchases).toHaveTextContent('No purchased parts in this order.');

    fireEvent.click(tab(/^Issues/));
    const issues = screen.getByRole('tabpanel', { name: /^Issues/ });
    await waitFor(() => expect(issues).toHaveTextContent(/No dispatch notes|No issues/));
  });
});
