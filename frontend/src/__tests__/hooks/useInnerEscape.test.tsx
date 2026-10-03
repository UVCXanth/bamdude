/**
 * Escape for an INNER layer of a dialog (the modal invariant): while the focus is inside
 * the layer and it has something to cancel, Escape is the layer's — the dialog under it
 * stays; otherwise the key goes on to the modal stack and closes the dialog as ever.
 */

import { useRef, useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Modal } from '../../components/Modal';
import { useInnerEscape } from '../../hooks/useInnerEscape';

function Field({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  useInnerEscape(ref, value !== '', () => setValue(''));
  return (
    <Modal onClose={onClose} title="Dialog">
      <input ref={ref} aria-label="field" value={value} onChange={(e) => setValue(e.target.value)} />
      <button type="button">elsewhere</button>
    </Modal>
  );
}

describe('useInnerEscape', () => {
  it('takes Escape inside the layer while it has something to cancel; the dialog stays', () => {
    const onClose = vi.fn();
    render(<Field onClose={onClose} />);
    const field = screen.getByLabelText('field');
    fireEvent.change(field, { target: { value: 'half' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveValue('');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with nothing to cancel, the next Escape is the dialog’s', () => {
    const onClose = vi.fn();
    render(<Field onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText('field'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('outside the layer, Escape is the dialog’s even while the layer holds text', () => {
    const onClose = vi.fn();
    render(<Field onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('field'), { target: { value: 'half' } });
    fireEvent.keyDown(screen.getByRole('button', { name: 'elsewhere' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('field')).toHaveValue('half');
  });
});
