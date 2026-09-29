import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Columns3, LayoutGrid, Table } from 'lucide-react';
import { render } from '../utils';
import { ListViewToggle } from '../../components/ListViewToggle';

describe('ListViewToggle', () => {
  const options = [
    { value: 'cards', icon: LayoutGrid, label: 'Cards' },
    { value: 'table', icon: Table, label: 'Table' },
    { value: 'kanban', icon: Columns3, label: 'Board' },
  ] as const;

  it('draws every mode the page gives it, marks the chosen one and reports a pick', () => {
    const onChange = vi.fn();
    render(<ListViewToggle value="table" options={options} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Table' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Board' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(onChange).toHaveBeenCalledWith('kanban');
  });

  it('keeps the name when the label hides on a narrow screen', () => {
    render(<ListViewToggle value="cards" options={options} onChange={() => {}} />);
    const button = screen.getByRole('button', { name: 'Cards' });
    expect(button).toHaveAttribute('aria-label', 'Cards');
    // The label hides at a viewport of 760 and narrower (WS-13 E2 B04; measured in the browser).
    expect(button.querySelector('span')).toHaveClass('max-[761px]:hidden');
  });
});
