/**
 * The dialog body's vertical scroll, remembered per tab (WS-13 E5 B02, R06). The body
 * is the one scroll container of the Modal — a hidden panel does not own it, so
 * without this a short tab clamps the body and coming back lands at the top. The
 * geometry is the browser runner's to prove; this pins the bookkeeping.
 */
import { describe, it, expect } from 'vitest';
import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { scrollParent, useTabScroll } from '../../../../components/projects/add-to-order/useTabScroll';

type Tab = 'a' | 'b';

function Harness() {
  const [tab, setTab] = useState<Tab>('a');
  const anchor = useRef<HTMLDivElement>(null);
  const switchTo = useTabScroll(tab, setTab, anchor);
  return (
    <div data-testid="scroller" style={{ overflowY: 'auto' }}>
      <div ref={anchor}>
        <button onClick={() => switchTo('a')}>A</button>
        <button onClick={() => switchTo('b')}>B</button>
        <span>on {tab}</span>
      </div>
    </div>
  );
}

/** jsdom lays nothing out, so `scrollTop` is a plain stored number here. */
function storedScroll(el: HTMLElement) {
  let top = 0;
  Object.defineProperty(el, 'scrollTop', { get: () => top, set: (v: number) => (top = v), configurable: true });
}

describe('useTabScroll', () => {
  it('finds the nearest ancestor that scrolls', () => {
    render(<Harness />);
    expect(scrollParent(screen.getByText('on a'))).toBe(screen.getByTestId('scroller'));
  });

  it('puts each tab back where it was, and a first visit at the top', () => {
    render(<Harness />);
    const scroller = screen.getByTestId('scroller');
    storedScroll(scroller);
    scroller.scrollTop = 300;
    fireEvent.click(screen.getByText('B'));
    expect(screen.getByText('on b')).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(0);
    scroller.scrollTop = 50;
    fireEvent.click(screen.getByText('A'));
    expect(scroller.scrollTop).toBe(300);
    fireEvent.click(screen.getByText('B'));
    expect(scroller.scrollTop).toBe(50);
  });
});
