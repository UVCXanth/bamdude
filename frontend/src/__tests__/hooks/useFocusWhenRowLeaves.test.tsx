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
      {row && <button type="button">Row menu</button>}
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

  it('watches nothing for a trigger that is not on the page', () => {
    render(<Page />);
    const observe = vi.spyOn(MutationObserver.prototype, 'observe');
    act(() => harness.watch!(null));
    act(() => harness.watch!(document.createElement('button')));
    expect(observe).not.toHaveBeenCalled();
    observe.mockRestore();
  });
});
