/**
 * The finished-goods table (WS-13 E12 C): the mockup's eight columns — the product with its
 * SKU, code and configuration, a location chip, on hand, reserved, an «available» badge, the
 * minimum with what is missing in words, what the shelf can assemble, and the row's menu.
 */

import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { render } from '../../utils';
import { FinishedGoodsTable } from '../../../components/stock/FinishedGoodsTable';
import type { StockItem } from '../../../api/client';

const lamp: StockItem = {
  id: 3,
  code: 'SK-0003',
  product: { id: 1, name: 'Lamp', sku: 'LMP-1', has_cover: false },
  configuration: {
    choices: [{ group_id: 1, group_name: 'Shade', option_id: 12, option_name: 'Large', is_default: false }],
    changed_parts: [],
  },
  location: 'A-3',
  on_hand: 4,
  reserved: 1,
  available: 3,
  min_qty: 5,
  below_min: true,
  short_by: 2,
  can_assemble: 2,
};
const vase: StockItem = {
  ...lamp,
  id: 4,
  code: 'SK-0004',
  product: { id: 2, name: 'Vase', sku: null, has_cover: false },
  configuration: { choices: [], changed_parts: [] },
  location: null,
  on_hand: 2,
  reserved: 0,
  available: 2,
  min_qty: 0,
  below_min: false,
  short_by: 0,
  can_assemble: 0,
};
const empty: StockItem = { ...vase, id: 5, code: 'SK-0005', on_hand: 0, reserved: 0, available: 0 };

function renderTable(overrides: Partial<Parameters<typeof FinishedGoodsTable>[0]> = {}) {
  const onSortChange = vi.fn();
  const onAction = vi.fn();
  render(
    <FinishedGoodsTable
      items={[lamp, vase]}
      sort="product-asc"
      onSortChange={onSortChange}
      canEdit
      onAction={onAction}
      {...overrides}
    />,
  );
  return { onSortChange, onAction };
}

const headers = () =>
  screen
    .getAllByRole('columnheader')
    .map((th) => (th.getAttribute('aria-label') ?? th.textContent ?? '').replace(/[▲▼]/g, '').trim());

describe('FinishedGoodsTable', () => {
  it("eight columns in the mockup's order, inside its own scroll — no «Code» column", () => {
    renderTable();
    expect(screen.getByRole('region', { name: 'Finished goods' })).toBeInTheDocument();
    expect(headers()).toEqual([
      'Product / configuration',
      'Location',
      'On hand',
      'Reserved',
      'Available',
      'Minimum',
      'Can assemble',
      'Actions',
    ]);
  });

  it('the product cell: the name opens the position; under it SKU · code · configuration — the caption only with a configuration', () => {
    renderTable();
    const row = screen.getByTestId('finished-row-3');
    expect(within(row).getByRole('link', { name: /Lamp/ })).toHaveAttribute('href', '/stock/3');
    expect(within(row).getByText('LMP-1')).toBeInTheDocument();
    expect(within(row).getByText('SK-0003')).toBeInTheDocument();
    // The configuration's accent is the order lines' own (`CONFIG_ACCENT_CLASS`).
    expect(within(row).getByText('Shade: Large')).toHaveAttribute('data-config-accent');
    const plain = screen.getByTestId('finished-row-4');
    expect(within(plain).getByText('SK-0004')).toBeInTheDocument();
    expect(within(plain).queryByText(/:/)).toBeNull();
  });

  it('the location is a chip with its pin; none says «not assigned»', () => {
    renderTable();
    const chip = screen.getByTestId('finished-location-3');
    expect(chip).toHaveTextContent('A-3');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('finished-location-4')).toHaveTextContent('not assigned');
  });

  it('«Available» is a badge — low, positive or zero — and a low one also says what is missing in words', () => {
    // `short_by` is read, never recomputed: the server decides it.
    renderTable({ items: [{ ...lamp, short_by: 9 }, vase, empty] });
    expect(screen.getByTestId('finished-available-3')).toHaveAttribute('data-tone', 'low');
    expect(screen.getByTestId('finished-available-4')).toHaveAttribute('data-tone', 'ok');
    expect(screen.getByTestId('finished-available-5')).toHaveAttribute('data-tone', 'none');
    expect(within(screen.getByTestId('finished-row-3')).getByText('short by 9')).toBeInTheDocument();
  });

  it('what the shelf can assemble — «N from parts» or a dash', () => {
    renderTable();
    expect(within(screen.getByTestId('finished-row-3')).getByText('2 from parts')).toBeInTheDocument();
    expect(within(screen.getByTestId('finished-row-4')).queryByText(/from parts/)).toBeNull();
  });

  it('sorts on the server from the headers; the code has no header of its own', () => {
    const { onSortChange } = renderTable();
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }));
    expect(onSortChange).toHaveBeenCalledWith('available-asc');
    expect(screen.queryByRole('button', { name: /^Code/ })).toBeNull();
  });

  it("the menu in the mockup's order, «Stocktake» after the location and a line before «Open position»", async () => {
    const { onAction } = renderTable();
    fireEvent.click(screen.getByTestId('finished-3-menu'));
    const panel = screen.getByTestId('finished-3-menu-panel');
    // The corrections wait for the signed-in user's `stock:adjust` (WS-13 E13 O06).
    await within(panel).findByRole('menuitem', { name: 'Stocktake' });
    expect(within(panel).getAllByRole('menuitem').map((m) => m.textContent?.trim())).toEqual([
      'Receipt',
      'Assemble from parts',
      'Reserve',
      'Release reservation',
      'Issue',
      'Location and minimum',
      'Stocktake',
      'Open position',
    ]);
    expect(within(panel).getByRole('separator')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('menuitem', { name: 'Issue' }));
    expect(onAction).toHaveBeenCalledWith('issue', lamp);
  });

  it('a move the position cannot take is greyed with its reason — «Assemble» only when the shelf can make one', () => {
    renderTable({ items: [empty] });
    fireEvent.click(screen.getByTestId('finished-5-menu'));
    const panel = screen.getByTestId('finished-5-menu-panel');
    expect(within(panel).queryByRole('menuitem', { name: /Assemble/ })).toBeNull();
    expect(within(panel).getByRole('menuitem', { name: 'Reserve' })).toBeDisabled();
    expect(within(panel).getByRole('menuitem', { name: 'Reserve' })).toHaveAttribute('title', 'Nothing is available to reserve');
    expect(within(panel).getByRole('menuitem', { name: 'Release reservation' })).toHaveAttribute('title', 'Nothing is reserved');
    expect(within(panel).getByRole('menuitem', { name: 'Issue' })).toHaveAttribute('title', 'Nothing is on hand');
  });

  it('a reader gets only «Open position» in the menu', () => {
    const { onAction } = renderTable({ canEdit: false });
    fireEvent.click(screen.getByTestId('finished-3-menu'));
    const items = within(screen.getByTestId('finished-3-menu-panel')).getAllByRole('menuitem');
    expect(items).toHaveLength(1);
    fireEvent.click(items[0]);
    expect(onAction).toHaveBeenCalledWith('open', lamp);
  });
});
