import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { StockProductsTable } from '../../../components/stock/StockProductsTable';
import type { StockListItem } from '../../../api/client';

const row: StockListItem = {
  id: 1,
  name: 'Lamp',
  is_active: true,
  origin: 'catalog',
  kits_available: 3,
  reserved_kits: 0,
  parts: [],
  reservations: [],
};

describe('StockProductsTable', () => {
  it('keeps the page bar out of the horizontal scroll, so it does not slide away with a wide table', () => {
    render(
      <StockProductsTable
        products={[row]}
        canEdit={false}
        onAdjust={() => {}}
        sort="kits-desc"
        onSortChange={() => {}}
        footer={<div data-testid="page-bar" />}
      />,
    );
    expect(screen.getByRole('table').closest('.overflow-x-auto')).not.toBeNull();
    expect(screen.getByTestId('page-bar').closest('.overflow-x-auto')).toBeNull();
  });
});
