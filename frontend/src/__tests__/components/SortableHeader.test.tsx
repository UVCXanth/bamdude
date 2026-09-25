import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SortableHeader } from '../../components/SortableHeader';

const inTable = (cell: ReactNode) => (
  <table>
    <thead>
      <tr>{cell}</tr>
    </thead>
  </table>
);

describe('SortableHeader', () => {
  it('marks the active key and flips it on click', () => {
    const onSort = vi.fn();
    render(inTable(<SortableHeader sortKey="kits" label="Kits" sort="kits-desc" onSort={onSort} descFirst />));
    expect(screen.getByRole('columnheader', { name: /Kits/ })).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(screen.getByRole('button', { name: /Kits/ }));
    expect(onSort).toHaveBeenCalledWith('kits-asc');
  });
  it('an inactive key has no aria-sort and starts at its first direction', () => {
    const onSort = vi.fn();
    render(inTable(<SortableHeader sortKey="name" label="Name" sort="kits-desc" onSort={onSort} />));
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort');
    fireEvent.click(screen.getByRole('button', { name: 'Name' }));
    expect(onSort).toHaveBeenCalledWith('name-asc');
  });
});
