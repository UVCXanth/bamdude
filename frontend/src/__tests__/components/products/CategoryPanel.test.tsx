import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { render } from '../../utils';
import { CategoryPanel } from '../../../components/products/CategoryPanel';

const directory = [
  { id: 3, name: 'Hooks', products_count: 2 },
  { id: 4, name: 'Vases', products_count: 0 },
];
const figures = { categories: [{ id: 3, name: 'Hooks', count: 2 }], uncategorized: 1, all: 7 };

const panel = (over: Partial<ComponentProps<typeof CategoryPanel>> = {}) =>
  render(
    <CategoryPanel
      directory={directory}
      directoryFailed={false}
      onRetryDirectory={vi.fn()}
      figures={figures}
      state="data"
      selected=""
      onSelect={vi.fn()}
      {...over}
    />,
  );

const entry = (name: RegExp) => within(screen.getByRole('navigation', { name: 'Categories' })).getByRole('button', { name });

// WS-13 E8 C06 / C11: the server's numbers, its states, and the directory's own.
describe('CategoryPanel', () => {
  it('C06 the label, «All products» with the server figure, the uncategorized and every category — a missing row is a real 0', () => {
    panel();
    const nav = screen.getByRole('navigation', { name: 'Categories' });
    expect(within(nav).getByText('Categories')).toHaveClass('uppercase');
    expect(entry(/^All products\s*7$/)).toHaveAttribute('aria-pressed', 'true');
    expect(entry(/^Uncategorized\s*1$/)).toHaveAttribute('aria-pressed', 'false');
    expect(entry(/^Hooks\s*2$/)).toBeInTheDocument();
    expect(entry(/^Vases\s*0$/)).toBeInTheDocument();
    expect(nav).toHaveTextContent('Words are searched together, in any order. For example: PLA black or bracket 20.');
  });

  it('C06 sticks below the app header on wide screens and lists everything when narrow — no select', () => {
    panel();
    const nav = screen.getByRole('navigation', { name: 'Categories' });
    expect(nav.className).toContain('min-[761px]:sticky');
    expect(nav.className).toContain('min-[761px]:top-[calc(var(--app-top)+0.75rem)]');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('C06 picks a category and offers the manager only with the right', () => {
    const onSelect = vi.fn();
    const { unmount } = panel({ onSelect });
    fireEvent.click(entry(/^Hooks/));
    expect(onSelect).toHaveBeenCalledWith('3');
    fireEvent.click(entry(/^Uncategorized/));
    expect(onSelect).toHaveBeenLastCalledWith('none');
    expect(screen.queryByRole('button', { name: 'Manage categories' })).not.toBeInTheDocument();
    unmount();
    const onManage = vi.fn();
    panel({ onManage });
    fireEvent.click(screen.getByRole('button', { name: 'Manage categories' }));
    expect(onManage).toHaveBeenCalled();
  });

  it('C11 while the list reads — first time or another key — the counts are «…», never 0 or the old key', () => {
    const { unmount } = panel({ state: 'loading', figures: undefined });
    expect(entry(/^All products\s*…$/)).toBeInTheDocument();
    expect(entry(/^Vases\s*…$/)).toBeInTheDocument();
    unmount();
    panel({ state: 'transition' });
    expect(entry(/^All products\s*…$/)).toBeInTheDocument();
    expect(entry(/^Hooks\s*…$/)).toBeInTheDocument();
  });

  it('C11 a failed list is «—»; a failed re-read keeps the same key’s figures', () => {
    const { unmount } = panel({ state: 'failed', figures: undefined });
    expect(entry(/^All products\s*—$/)).toBeInTheDocument();
    expect(entry(/^Uncategorized\s*—$/)).toBeInTheDocument();
    unmount();
    panel({ state: 'refresh-failed' });
    expect(entry(/^All products\s*7$/)).toBeInTheDocument();
  });

  it('C11 the directory still reading: the categories the list named are there', () => {
    panel({ directory: undefined });
    expect(entry(/^Hooks\s*2$/)).toBeInTheDocument();
    expect(screen.queryByText(/Vases/)).not.toBeInTheDocument();
  });

  it('C11 the directory failed with nothing cached: a note with its own retry, the list’s categories stay', () => {
    const retry = vi.fn();
    panel({ directory: undefined, directoryFailed: true, onRetryDirectory: retry });
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('Could not load the categories');
    fireEvent.click(within(note).getByRole('button', { name: 'Retry' }));
    expect(retry).toHaveBeenCalled();
    expect(entry(/^Hooks\s*2$/)).toBeInTheDocument();
  });

  it('C11 the directory failed to refresh: the cached names stay, a note says so', () => {
    panel({ directoryFailed: true });
    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh the categories');
    expect(entry(/^Vases\s*0$/)).toBeInTheDocument();
  });

  it('C11 a chosen category nobody has named yet is «Category #id», still chosen', () => {
    panel({ selected: '9', directory: undefined, figures: undefined, state: 'loading' });
    expect(entry(/^Category #9/)).toHaveAttribute('aria-pressed', 'true');
  });
});
