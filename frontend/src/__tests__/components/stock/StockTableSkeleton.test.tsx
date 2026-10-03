/**
 * The stock tabs' first read (WS-13 E12 B04): the shape of a table, announced once.
 */

import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { StockTableSkeleton } from '../../../components/stock/StockTableSkeleton';

describe('StockTableSkeleton', () => {
  it('is one busy status named for the wait, with the tab it stands for', () => {
    render(<StockTableSkeleton tab="journal" />);
    const skeleton = screen.getByRole('status');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton).toHaveAttribute('data-testid', 'stock-skeleton');
    expect(skeleton).toHaveAttribute('data-tab', 'journal');
    expect(skeleton).toHaveTextContent('Loading');
  });
});
