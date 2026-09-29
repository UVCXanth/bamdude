/**
 * The order detail's composition (WS-13 E3 §B): breadcrumbs → header (with the
 * stage row) → banners → the grid of ONE main panel and the side column. The
 * geometry — the ≤ 1150 container rule, the columns — is measured in the
 * browser (spec §I1); here only the order of the zones, which the keyboard's
 * reading order follows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Routes, Route } from 'react-router';
import { render } from '../../utils';
import { OrderPage } from '../../../pages/orders/OrderPage';
import { makeOrder, mockOrderDetailApi } from '../../fixtures/orderDetail';

const precedes = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

function renderPage(path = '/projects/1') {
  window.history.pushState({}, '', path);
  return render(
    <Routes>
      <Route path="/projects/:id" element={<OrderPage />} />
    </Routes>,
  );
}

describe('OrderView composition', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('lays the zones out as head → banners → grid, and the grid as main before side', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const view = await screen.findByTestId('order-view');
    const head = within(view).getByTestId('order-head');
    const banners = within(view).getByTestId('order-banners');
    const grid = within(view).getByTestId('order-grid');
    const main = within(grid).getByTestId('order-main');
    const side = within(grid).getByTestId('order-side');

    expect(precedes(head, banners)).toBe(true);
    expect(precedes(banners, grid)).toBe(true);
    expect(precedes(main, side)).toBe(true);
    // The title and the stage row are the head's; the lines are the main panel's.
    expect(within(head).getByRole('heading', { level: 1, name: 'Ten flasks' })).toBeInTheDocument();
    expect(await within(main).findByText('Flask')).toBeInTheDocument();
  });

  it('puts the page under the Workshop scope', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const view = await screen.findByTestId('order-view');
    expect(view.closest('.workshop')).not.toBeNull();
  });
});
