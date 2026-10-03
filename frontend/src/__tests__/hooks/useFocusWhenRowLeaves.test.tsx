/**
 * The focus after an action takes its row off the page (WS-13 E9 B11, from the product
 * action host's E8-V02 watch): the trigger the menu or dialog gave the focus back to
 * may leave with a re-read — when it has, and the focus fell to BODY, the page's
 * heading takes it. The watch has no time limit (a re-read is the server's), ends when
 * the operator moves the focus, when another watch starts, or when the page goes.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { useFocusWhenRowLeaves } from '../../hooks/useFocusWhenRowLeaves';
import { _resetForTests, register, unregister } from '../../components/modalStack';

const harness = vi.hoisted(() => ({
  watch: null as ((trigger: Element | null) => void) | null,
  setRow: null as ((on: boolean) => void) | null,
}));

function Page() {
  const heading = useRef<HTMLHeadingElement>(null);
  const [row, setRow] = useState(true);
  const watch = useFocusWhenRowLeaves(heading);
  useEffect(() => {
    harness.watch = watch;
    harness.setRow = setRow;
  }, [watch]);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Products
      </h1>
      {row && (
        <div data-testid="row">
          <button type="button">Row menu</button>
        </div>
      )}
      <button type="button">Elsewhere</button>
    </>
  );
}

describe('useFocusWhenRowLeaves', () => {
  it('gives the heading the focus when the trigger leaves with the focus on BODY — however late', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Row menu' });
    act(() => trigger.focus());
    act(() => harness.watch!(trigger));
    clock.mockReturnValue(120_000);
    act(() => harness.setRow!(false));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
    clock.mockRestore();
  });

  it('leaves a focus the operator moved, and stops watching', async () => {
    render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Row menu' });
    act(() => trigger.focus());
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    act(() => harness.watch!(trigger));
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(disconnect).toHaveBeenCalled();
    act(() => harness.setRow!(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
    disconnect.mockRestore();
  });

  it('stops watching when the page goes', () => {
    const { unmount } = render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Row menu' });
    act(() => trigger.focus());
    act(() => harness.watch!(trigger));
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    unmount();
    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
  });

  it('a new watch ends the previous one', () => {
    render(<Page />);
    const trigger = screen.getByRole('button', { name: 'Row menu' });
    act(() => trigger.focus());
    act(() => harness.watch!(trigger));
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect');
    act(() => harness.watch!(trigger));
    expect(disconnect).toHaveBeenCalledTimes(1);
    disconnect.mockRestore();
  });

  // WS-13 E9 final review: the tabs watch the ROW (its trigger may be a menu's or a dialog's
  // opener inside it); the confirmation gives the focus back to that button, inside the row.
  it('watching a row: the focus given back to a button inside it is still the watch’s', async () => {
    render(<Page />);
    act(() => harness.watch!(screen.getByTestId('row')));
    act(() => screen.getByRole('button', { name: 'Row menu' }).focus());
    act(() => harness.setRow!(false));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  it('a row that leaves while a confirmation is still open: the heading takes the focus once it closes', async () => {
    _resetForTests();
    render(<Page />);
    // The confirmation is open and holds the focus when the watch starts (its `send`).
    const confirm = document.createElement('button');
    document.body.appendChild(confirm);
    act(() => confirm.focus());
    register('confirm', [], { current: { onClose: () => {} } } as never, { current: null });
    act(() => harness.watch!(screen.getByTestId('row')));
    // The re-read lands first: the row leaves under the open confirmation.
    act(() => harness.setRow!(false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('heading', { name: 'Products' })).not.toHaveFocus();
    // Then the confirmation closes: its node goes, then it leaves the stack.
    act(() => confirm.remove());
    await new Promise((resolve) => setTimeout(resolve, 20));
    act(() => unregister('confirm'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  it('a focus moved inside an open confirmation is not the operator leaving', async () => {
    _resetForTests();
    render(<Page />);
    const first = document.createElement('button');
    const second = document.createElement('button');
    document.body.append(first, second);
    act(() => first.focus());
    register('confirm', [], { current: { onClose: () => {} } } as never, { current: null });
    act(() => harness.watch!(screen.getByTestId('row')));
    act(() => second.focus());
    act(() => harness.setRow!(false));
    act(() => {
      first.remove();
      second.remove();
    });
    act(() => unregister('confirm'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Products' })).toHaveFocus());
  });

  it('watches nothing for a trigger that is not on the page', () => {
    render(<Page />);
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    act(() => harness.watch!(null));
    act(() => harness.watch!(document.createElement('button')));
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });
});
