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
import { api } from '../../../api/client';
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

  it('puts the breadcrumbs above the header, outside it (spec B03)', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const view = await screen.findByTestId('order-view');
    const crumbs = within(view).getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByRole('link', { name: 'Orders' })).toHaveAttribute('href', '/projects');
    expect(await within(crumbs).findByText('Ten flasks')).toBeInTheDocument();
    expect(precedes(crumbs, within(view).getByTestId('order-head'))).toBe(true);
  });

  it('keeps the way back to the list while the order is still loading (spec B05)', async () => {
    mockOrderDetailApi(makeOrder());
    vi.spyOn(api, 'getOrder').mockReturnValue(new Promise(() => {}));
    renderPage();

    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByRole('link', { name: 'Orders' })).toBeInTheDocument();
  });

  it('heads the lines with their count and keeps the table in its own scroll region (E06)', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const main = await screen.findByTestId('order-main');
    const heading = await within(main).findByRole('heading', { level: 2, name: /^Lines/ });
    expect(heading).toHaveTextContent('Lines (1)');
    const region = within(main).getByRole('region', { name: 'Lines' });
    expect(within(region).getByRole('table')).toBeInTheDocument();
  });

  it('stacks the side panels as forecast → filament → queue → activity (G01)', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const side = await screen.findByTestId('order-side');
    const titles = await within(side).findAllByRole('heading', { level: 2 });
    expect(titles.map((h) => h.textContent)).toEqual(['Forecast', 'Filament', 'Queue', 'Activity']);
  });

  it('has no forecast for a closed order — three panels', async () => {
    mockOrderDetailApi(makeOrder({ status: 'completed', stage: 'done' }));
    renderPage();

    const side = await screen.findByTestId('order-side');
    const titles = await within(side).findAllByRole('heading', { level: 2 });
    expect(titles.map((h) => h.textContent)).toEqual(['Filament', 'Queue', 'Activity']);
  });

  it('puts the page under the Workshop scope', async () => {
    mockOrderDetailApi(makeOrder());
    renderPage();

    const view = await screen.findByTestId('order-view');
    expect(view.closest('.workshop')).not.toBeNull();
  });
});
