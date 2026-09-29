/**
 * The Workshop dialog frame (WS-13 E2 §D). It is a FRAME over the one Modal —
 * sizes, a subtitle, an error slot, a footer — and decides nothing a form
 * decides: validation, permissions, what to send. What it must get right is the
 * wiring a form leans on: one dialog, a submit button in the footer that belongs
 * to the form in the body, pending that locks the way out, an error that sits
 * outside the scrolling body and never costs the operator what they typed.
 *
 * ⚠️ jsdom performs no implicit submission: Enter in a field, native validation
 * and the real focus trap are proven in the browser (the fixture and OrderModal),
 * not here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { useId, useState } from 'react';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils';
import { WorkshopDialog } from '../../../components/workshop/WorkshopDialog';
import { _resetForTests } from '../../../components/modalStack';

function FormDialog({
  onSubmit,
  onClose = () => {},
  pending = false,
  error,
}: {
  onSubmit: () => void;
  onClose?: () => void;
  pending?: boolean;
  error?: string;
}) {
  const formId = useId();
  const [name, setName] = useState('');
  return (
    <WorkshopDialog
      title="New order"
      subtitle="Who it is for and by when"
      size="lg"
      pending={pending}
      error={error}
      onClose={onClose}
      summary={<span>3 lines</span>}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={formId} disabled={pending}>
            Create
          </button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </form>
    </WorkshopDialog>
  );
}

describe('WorkshopDialog', () => {
  afterEach(() => {
    cleanup();
    _resetForTests();
  });

  it('is one Modal dialog, labelled by its title and described by its subtitle', () => {
    render(<FormDialog onSubmit={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'New order' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(dialog).toHaveAccessibleDescription('Who it is for and by when');
  });

  it('submits the form in the body from the footer button, once — Cancel and the X never do', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<FormDialog onSubmit={onSubmit} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('puts the error between the body and the footer, as an alert, and keeps what was typed', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<FormDialog onSubmit={vi.fn()} />);
    await user.type(screen.getByLabelText('Name'), 'Lamp');

    rerender(<FormDialog onSubmit={vi.fn()} error="That name is taken" />);

    const parts = [...screen.getByRole('dialog').children];
    const alertAt = parts.findIndex((part) => part.contains(screen.getByRole('alert')));
    const bodyAt = parts.findIndex((part) => part.contains(screen.getByLabelText('Name')));
    const footerAt = parts.findIndex((part) => part.contains(screen.getByRole('button', { name: 'Create' })));
    expect(bodyAt).toBeLessThan(alertAt);
    expect(alertAt).toBeLessThan(footerAt);
    expect(screen.getByRole('alert')).toHaveTextContent('That name is taken');
    expect(screen.getByLabelText('Name')).toHaveValue('Lamp');
  });

  it('while pending, neither the X nor Escape closes it, and the submit is locked', () => {
    const onClose = vi.fn();
    render(<FormDialog onSubmit={vi.fn()} onClose={onClose} pending />);

    expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('shows the summary on the footer, beside the actions', () => {
    render(<FormDialog onSubmit={vi.fn()} />);

    const footer = screen.getByRole('button', { name: 'Create' }).closest('[data-workshop-dialog-footer]');
    expect(footer).toHaveTextContent('3 lines');
  });

  it('a nested dialog closes first on Escape and gives the focus back to its opener', async () => {
    const user = userEvent.setup();
    function Nested() {
      const [open, setOpen] = useState(false);
      return (
        <WorkshopDialog title="Outer" size="md" onClose={() => {}}>
          <button type="button" onClick={() => setOpen(true)}>
            Open inner
          </button>
          {open && (
            <WorkshopDialog title="Inner" size="sm" onClose={() => setOpen(false)}>
              inner body
            </WorkshopDialog>
          )}
        </WorkshopDialog>
      );
    }
    render(<Nested />);
    const opener = screen.getByRole('button', { name: 'Open inner' });
    await user.click(opener);
    expect(screen.getByRole('dialog', { name: 'Inner' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('carries the workshop scope class on its panel — the portal is outside every page root', () => {
    render(<FormDialog onSubmit={vi.fn()} />);

    expect(screen.getByRole('dialog')).toHaveClass('workshop');
  });
});
