/**
 * WS-13 E4 G03 (R04): the notes editor is open from the start, against the REAL
 * `RichTextEditor` — a stand-in textarea would pass every test below while the
 * visible editor, which reads `content` only when it is created, kept showing the
 * old text. The contract: a baseline (the saved text, an empty document counting as
 * empty), «Discard changes» puts the visible text back, a clean editor follows a
 * background re-read and a dirty one does not, and a successful save makes the SENT
 * text the baseline whatever the next read says.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { Order } from '../../../api/client';
import { OrderNotes } from '../../../components/projects/OrderNotes';

const order = (notes: string | null) => ({ id: 1, notes }) as unknown as Order;

/** The visible editor — ProseMirror's contenteditable. */
const editor = () => document.querySelector('.ProseMirror') as HTMLElement;

/** Type into the editor the way the browser would: change the DOM ProseMirror
 *  observes, and let its observer turn the mutation into a transaction. */
async function typeInto(text: string) {
  const el = editor();
  await act(async () => {
    el.innerHTML = `<p>${text}</p>`;
    await new Promise((r) => setTimeout(r, 30));
  });
}

const save = () => screen.getByRole('button', { name: 'Save notes' });
const discard = () => screen.queryByRole('button', { name: 'Discard changes' });

describe('OrderNotes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the editor straight away, with Save off until something changed', async () => {
    render(<OrderNotes order={order('<p>Check the fit</p>')} canEdit />);
    await waitFor(() => expect(editor()).toHaveTextContent('Check the fit'));
    expect(save()).toBeDisabled();
    expect(discard()).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('does not call an empty order’s empty document a change', async () => {
    render(<OrderNotes order={order(null)} canEdit />);
    await waitFor(() => expect(editor()).toBeInTheDocument());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(save()).toBeDisabled();
    expect(discard()).not.toBeInTheDocument();
  });

  it('«Discard changes» puts the saved text back on screen', async () => {
    render(<OrderNotes order={order('<p>Check the fit</p>')} canEdit />);
    await waitFor(() => expect(editor()).toHaveTextContent('Check the fit'));
    await typeInto('Something else');
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(discard() as HTMLElement);
    await waitFor(() => expect(editor()).toHaveTextContent('Check the fit'));
    expect(editor()).not.toHaveTextContent('Something else');
    expect(save()).toBeDisabled();
  });

  it('follows a background re-read while clean, and keeps the operator’s text while dirty', async () => {
    const { rerender } = render(<OrderNotes order={order('<p>One</p>')} canEdit />);
    await waitFor(() => expect(editor()).toHaveTextContent('One'));
    rerender(<OrderNotes order={order('<p>Two</p>')} canEdit />);
    await waitFor(() => expect(editor()).toHaveTextContent('Two'));

    await typeInto('Mine');
    await waitFor(() => expect(save()).toBeEnabled());
    rerender(<OrderNotes order={order('<p>Three</p>')} canEdit />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(editor()).toHaveTextContent('Mine');
    // «Discard» now goes back to what the server holds NOW.
    fireEvent.click(discard() as HTMLElement);
    await waitFor(() => expect(editor()).toHaveTextContent('Three'));
  });

  it('makes the sent text the baseline, whatever the next read brings', async () => {
    const patch = vi.spyOn(api, 'updateOrder').mockResolvedValue({} as never);
    render(<OrderNotes order={order('<p>Old</p>')} canEdit />);
    await waitFor(() => expect(editor()).toHaveTextContent('Old'));
    await typeInto('New');
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    await waitFor(() => expect(patch).toHaveBeenCalledWith(1, { notes: '<p>New</p>' }));
    // The re-read has not landed (or failed): the order still says «Old», yet the
    // editor is clean — what was sent is what is saved.
    await waitFor(() => expect(save()).toBeDisabled());
    expect(discard()).not.toBeInTheDocument();
    expect(editor()).toHaveTextContent('New');
  });

  it('keeps text typed while the save was in flight as a change', async () => {
    let finish: () => void = () => {};
    vi.spyOn(api, 'updateOrder').mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({} as never);
      }) as never,
    );
    render(<OrderNotes order={order('<p>Old</p>')} canEdit />);
    await waitFor(() => expect(editor()).toHaveTextContent('Old'));
    await typeInto('New');
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    await waitFor(() => expect(save()).toBeDisabled());
    expect(discard()).toBeDisabled();
    await typeInto('Newer');
    await act(async () => finish());
    await waitFor(() => expect(save()).toBeEnabled());
    expect(editor()).toHaveTextContent('Newer');
  });

  it('shows a reader the notes, or says there are none', async () => {
    const { rerender } = render(<OrderNotes order={order('<p>Check the fit</p>')} canEdit={false} />);
    expect(screen.getByText('Check the fit')).toBeInTheDocument();
    expect(editor()).toBeNull();
    rerender(<OrderNotes order={order(null)} canEdit={false} />);
    expect(screen.getByText('No notes yet.')).toBeInTheDocument();
  });
});
