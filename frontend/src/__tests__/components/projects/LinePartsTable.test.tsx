/**
 * WS-13 E4 C01–C04: a line's parts, expanded. Every number is the server's; the table
 * only decides how each row reads — a variant part, a part out of the kit, a part
 * bought rather than printed — and keeps the same seven columns for either kind of
 * line, so the columns do not jump between two expanded lines.
 */
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { render } from '../../utils';
import type { LinePurchasedPart, PartFigures } from '../../../api/client';
import { LinePartsTable } from '../../../components/projects/LinePartsTable';

function part(over: Partial<PartFigures> = {}): PartFigures {
  return {
    part_id: 1,
    name: 'shade',
    qty_per_unit: 1,
    need: 4,
    usable: 2,
    in_progress: 1,
    remaining: 2,
    surplus: 0,
    variant: false,
    queued: 0,
    bankable: 0,
    ...over,
  };
}

const SCREW: LinePurchasedPart = { part_id: 9, name: 'M3 screw', per: 4, need: 16, variant: false };

function rowOf(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

describe('LinePartsTable', () => {
  it('keeps the seven columns in order for a product line and a parts line alike', () => {
    const headers = ['Part', 'Per unit', 'Need', 'Usable', 'In progress / queued', 'Remaining', 'Surplus'];
    const { unmount } = render(<LinePartsTable parts={[part()]} purchased={[]} mode="product" />);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(headers);
    unmount();

    render(<LinePartsTable parts={[part({ qty_per_unit: 3 })]} purchased={[]} mode="parts" />);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual(headers);
    // A parts line has no «per unit»: the cell says so rather than disappearing.
    expect(within(rowOf('shade')).getAllByRole('cell')[1]).toHaveTextContent('—');
  });

  it('shows the per-unit count, the in-progress and queued pair, and the server figures', () => {
    render(<LinePartsTable parts={[part({ qty_per_unit: 2, in_progress: 3, queued: 5 })]} purchased={[]} mode="product" />);
    const cells = within(rowOf('shade')).getAllByRole('cell').map((td) => td.textContent);
    expect(cells).toEqual(['shade', '× 2', '4', '2', '3 / 5', '2', '0']);
  });

  it('marks a part bound to a variant option', () => {
    render(
      <LinePartsTable
        parts={[part(), part({ part_id: 2, name: 'clip', variant: true })]}
        purchased={[]}
        mode="product"
      />,
    );
    expect(within(rowOf('clip')).getByText('variant')).toBeInTheDocument();
    expect(within(rowOf('shade')).queryByText('variant')).not.toBeInTheDocument();
  });

  it('says a part the configuration dropped is out of the kit instead of «× 0»', () => {
    render(<LinePartsTable parts={[part({ qty_per_unit: 0, need: 0, surplus: 3 })]} purchased={[]} mode="product" />);
    const cells = within(rowOf('shade')).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('out of the kit');
    expect(cells[1]).not.toHaveTextContent('× 0');
  });

  it('lists purchased parts after the printed ones and sends the reader to their tab', () => {
    render(<LinePartsTable parts={[part()]} purchased={[{ ...SCREW, variant: true }]} mode="product" />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['shade', 'M3 screwboughtvariant']);
    const cells = within(rowOf('M3 screw')).getAllByRole('cell');
    expect(cells.map((td) => td.textContent)).toEqual([
      'M3 screwboughtvariant',
      '× 4',
      '16',
      'counted in «Purchased parts»',
    ]);
    expect(cells[3]).toHaveAttribute('colspan', '4');
  });

  it('makes the work left and a surplus loud, and leaves zeros quiet', () => {
    render(
      <LinePartsTable
        parts={[part({ remaining: 2, surplus: 0 }), part({ part_id: 2, name: 'arm', remaining: 0, surplus: 3 })]}
        purchased={[]}
        mode="product"
      />,
    );
    expect(screen.getByTestId('part-1-remaining')).toHaveClass('font-semibold');
    expect(screen.getByTestId('part-2-remaining')).not.toHaveClass('font-semibold');
    expect(screen.getByTestId('part-2-surplus').className).toMatch(/amber/);
    expect(screen.getByTestId('part-1-surplus').className).not.toMatch(/amber/);
  });

  it('says there are no parts when the line counts none, printed or bought', () => {
    const { unmount } = render(<LinePartsTable parts={[]} purchased={[]} mode="product" />);
    expect(screen.getByText('No printed parts counted — set quantities on the product.')).toBeInTheDocument();
    unmount();
    // Bought parts alone are still parts of the line: the table shows them.
    render(<LinePartsTable parts={[]} purchased={[SCREW]} mode="product" />);
    expect(screen.getByText('M3 screw')).toBeInTheDocument();
  });
});
