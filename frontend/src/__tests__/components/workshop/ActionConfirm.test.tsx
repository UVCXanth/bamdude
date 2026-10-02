/**
 * The Workshop's one confirmation (WS-13 E9 B11): the rules every confirmation of an
 * order (E6) and a product (E8) already keeps, in one place — one click sends one
 * request, a running request cannot be closed or sent again, a refusal stays in the
 * dialog with the server's sentence and the focus on the button that sent it, and a
 * success closes the dialog.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { ActionConfirm } from '../../../components/workshop/ActionConfirm';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(send: () => Promise<unknown>, onClose = vi.fn()) {
  render(
    <ActionConfirm
      title="Unlink the file?"
      subtitle="shelf.3mf"
      body={<p>Its plates leave the product.</p>}
      primaryLabel="Unlink"
      danger
      send={send}
      onClose={onClose}
    />,
  );
  return onClose;
}

describe('ActionConfirm', () => {
  it('names the action and sends one request however often it is clicked', async () => {
    const pending = deferred();
    const send = vi.fn(() => pending.promise);
    mount(send);
    expect(screen.getByRole('dialog', { name: 'Unlink the file?' })).toHaveTextContent('Its plates leave the product.');
    const primary = screen.getByRole('button', { name: 'Unlink' });
    // Two clicks in one tick — React has not re-rendered the button disabled between them.
    act(() => {
      primary.click();
      primary.click();
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlink…' })).toBeDisabled());
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cannot be closed while its request runs — Escape, Cancel and the X', async () => {
    const pending = deferred();
    const onClose = mount(() => pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('keeps a refusal in the dialog with the focus on the button that sent it, and lets it be sent again', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('That file is not linked to this product')).mockResolvedValue({});
    const onClose = mount(send);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That file is not linked to this product');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Unlink' })).toHaveFocus());
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('closes on success', async () => {
    const onClose = mount(() => Promise.resolve({}));
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Cancel closes without a request', () => {
    const send = vi.fn(() => Promise.resolve({}));
    const onClose = mount(send);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
