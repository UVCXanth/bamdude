import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import i18n from '../../../i18n';
import { LinePartsTable } from '../../../components/projects/LinePartsTable';
import { productALine, productBLine } from '../../fixtures/orderPartProgress';

describe('LinePartsTable current API contract', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });

  it('preserves stock-adjusted server need rather than substituting the full BOM', () => {
    render(<LinePartsTable parts={productALine.parts} />);
    const row = screen.getByRole('row', { name: /^Part A / });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['Part A', '× 3', '9', '4', '3', '5', '0']);
  });

  it('shows expected parts in progress, without subtracting them from server remaining', () => {
    render(<LinePartsTable parts={productALine.parts} />);
    const row = screen.getByRole('row', { name: /^Part A / });
    expect(within(row).getAllByRole('cell')[4]).toHaveTextContent('3');
    expect(screen.getByTestId('part-301-remaining')).toHaveTextContent('5');
  });

  it('retains the not-started part even when its sibling is printing', () => {
    render(<LinePartsTable parts={productALine.parts} />);
    const row = screen.getByRole('row', { name: /^Part B / });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['Part B', '× 1', '3', '0', '0', '3', '0']);
  });

  it('renders the second product separately even when an archive is shared', () => {
    render(<>
      <section aria-label="Product A"><LinePartsTable parts={productALine.parts} /></section>
      <section aria-label="Product B"><LinePartsTable parts={productBLine.parts} /></section>
    </>);
    const a = screen.getByRole('region', { name: 'Product A' });
    const b = screen.getByRole('region', { name: 'Product B' });
    expect(within(a).queryByText('Part C')).not.toBeInTheDocument();
    expect(within(b).queryByText('Part A')).not.toBeInTheDocument();
    expect(within(b).getByTestId('part-303-remaining')).toHaveTextContent('3');
  });

  it('uses refreshed server totals rather than applying a client completion delta', () => {
    const { rerender } = render(<LinePartsTable parts={productALine.parts} />);
    const next = productALine.parts.map((part) => part.part_id === 301
      ? { ...part, usable: 6, in_progress: 0, remaining: 3 }
      : part);
    rerender(<LinePartsTable parts={next} />);
    const row = screen.getByRole('row', { name: /^Part A / });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['Part A', '× 3', '9', '6', '0', '3', '0']);
  });

  it('does not label usable completed output as accepted output', () => {
    render(<LinePartsTable parts={productALine.parts} />);
    expect(screen.getByRole('columnheader', { name: 'Usable' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /accepted/i })).not.toBeInTheDocument();
  });
});
