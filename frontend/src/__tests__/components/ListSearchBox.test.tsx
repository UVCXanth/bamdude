import { describe, it, expect, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '../utils';
import { ListSearchBox } from '../../components/ListSearchBox';
import { Modal } from '../../components/Modal';

describe('ListSearchBox', () => {
  it('«/» focuses the search and the key does not end up in it', () => {
    render(<ListSearchBox value="" onChange={() => {}} placeholder="Search orders" />);
    const box = screen.getByRole('searchbox', { name: 'Search orders' });
    const notPrevented = fireEvent.keyDown(document.body, { key: '/' });
    expect(box).toHaveFocus();
    expect(notPrevented).toBe(false); // default prevented
  });

  it('stays quiet while the user types in another field', () => {
    render(
      <>
        <input aria-label="other" />
        <ListSearchBox value="" onChange={() => {}} placeholder="Search orders" />
      </>,
    );
    const other = screen.getByLabelText('other');
    other.focus();
    const notPrevented = fireEvent.keyDown(other, { key: '/' });
    expect(other).toHaveFocus();
    expect(notPrevented).toBe(true);
  });

  it('stays quiet under a modal', () => {
    render(
      <>
        <ListSearchBox value="" onChange={() => {}} placeholder="Search orders" />
        <Modal onClose={() => {}} title="Dialog">
          body
        </Modal>
      </>,
    );
    fireEvent.keyDown(document.body, { key: '/' });
    expect(screen.getByRole('searchbox', { name: 'Search orders', hidden: true })).not.toHaveFocus();
  });

  it('clears with its button', () => {
    const onChange = vi.fn();
    render(<ListSearchBox value="lamp" onChange={onChange} placeholder="Search orders" />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
