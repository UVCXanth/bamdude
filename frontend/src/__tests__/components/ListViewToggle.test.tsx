import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { Columns3, LayoutGrid, Table } from 'lucide-react';
import { render } from '../utils';
import userEvent from '@testing-library/user-event';
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

  it('names the group and makes an unavailable mode inert', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ListViewToggle value="cards" label="Display" options={[
      options[0], { ...options[1], disabled: true, hint: 'No access' },
    ]} onChange={onChange} />);
    expect(screen.getByRole('group', { name: 'Display' })).toBeInTheDocument();
    const unavailable = screen.getByRole('button', { name: 'Table' });
    expect(unavailable).toBeDisabled();
    expect(unavailable).toHaveAttribute('title', 'No access');
    await user.click(unavailable);
    unavailable.focus();
    await user.keyboard('{Enter} ');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps labels visible in the stacked overflow menu', () => {
    render(<ListViewToggle value="cards" options={options} onChange={() => {}} inMenu />);
    expect(screen.getByRole('group')).toHaveClass('flex-col', 'w-full');
    expect(screen.getByRole('button', { name: 'Cards' }).querySelector('span')).not.toHaveClass('max-[761px]:hidden');
  });
});
