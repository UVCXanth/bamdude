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
  can_assemble: 0,
};

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

describe('FinishedGoodsTable', () => {
  it('draws a position: code, product, its configuration, location and the three figures', () => {
    renderTable();
    const row = screen.getByTestId('finished-row-3');
    expect(within(row).getByText('SK-0003')).toBeInTheDocument();
    expect(within(row).getByText('Lamp')).toBeInTheDocument();
    expect(within(row).getByText('LMP-1')).toBeInTheDocument();
    expect(within(row).getByText('Shade: Large')).toBeInTheDocument();
    expect(within(row).getByText('A-3')).toBeInTheDocument();
    expect(within(row).getByTestId('finished-on-hand-3')).toHaveTextContent('4');
    expect(within(row).getByTestId('finished-reserved-3')).toHaveTextContent('1');
    expect(within(row).getByTestId('finished-available-3')).toHaveTextContent('3');
  });

  it('marks a position under its minimum and says how many are missing', () => {
    renderTable();
    expect(screen.getByTestId('finished-available-3')).toHaveClass('text-status-warning');
    expect(screen.getByTestId('finished-available-4')).not.toHaveClass('text-status-warning');
    expect(within(screen.getByTestId('finished-row-3')).getByText('short by 2')).toBeInTheDocument();
  });

  it('says «not assigned» for a position without a location and shows what the shelf can assemble', () => {
    renderTable();
    expect(within(screen.getByTestId('finished-row-4')).getByText('not assigned')).toBeInTheDocument();
    expect(within(screen.getByTestId('finished-row-3')).getByText('can assemble 2')).toBeInTheDocument();
    expect(within(screen.getByTestId('finished-row-4')).queryByText(/can assemble/)).not.toBeInTheDocument();
  });

  it('sorts on the server from the headers', () => {
    const { onSortChange } = renderTable();
    fireEvent.click(screen.getByRole('button', { name: /^Available/ }));
    expect(onSortChange).toHaveBeenCalledWith('available-asc');
  });

  it('offers «Assemble» only when the shelf can make one, and hands the row to the action', () => {
    const { onAction } = renderTable();
    fireEvent.click(screen.getByTestId('finished-4-menu'));
    const panel = screen.getByTestId('finished-4-menu-panel');
    expect(within(panel).queryByRole('menuitem', { name: /assemble/i })).not.toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('menuitem', { name: /^Issue/ }));
    expect(onAction).toHaveBeenCalledWith('issue', vase);

    fireEvent.click(screen.getByTestId('finished-3-menu'));
    expect(
      within(screen.getByTestId('finished-3-menu-panel')).getByRole('menuitem', { name: /assemble/i }),
    ).toBeInTheDocument();
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
