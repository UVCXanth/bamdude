/**
 * Each tab keeps its own place on a page the document scrolls (WS-13 E9 C03, R05). A
 * hidden panel stays mounted, but the document's scroll position is one for all of them:
 * going down a long tab, over to a short one and back must land where the long one was —
 * whatever moved the tab (a click, Back / Forward through `?tab=`) — and the first visit
 * of a tab puts its strip under the app's header, not past it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useRef, useState } from 'react';
import { useSectionScrollMemory } from '../../hooks/useSectionScrollMemory';

type S = 'a' | 'b' | 'c';
const harness = vi.hoisted(() => ({
  select: null as ((next: 'a' | 'b' | 'c') => void) | null,
  strip: null as HTMLElement | null,
}));

function Page() {
  const strip = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<S>('a');
  useSectionScrollMemory(section, strip);
  useEffect(() => {
    harness.select = setSection;
    harness.strip = strip.current;
  }, []);
  return <div ref={strip}>strip</div>;
}

/** The operator (or the browser clamping a shorter document) scrolled the window. */
function scrollWindow(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function setDocument(scrollHeight: number, innerHeight: number) {
  Object.defineProperty(document.documentElement, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
}

function setStripTop(top: number) {
  harness.strip!.getBoundingClientRect = () =>
    ({ top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
}

const scrollTo = vi.mocked(window.scrollTo);

beforeEach(() => {
  scrollTo.mockClear();
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  setDocument(5000, 600);
});

afterEach(() => {
  document.documentElement.style.removeProperty('--app-top');
});

describe('useSectionScrollMemory', () => {
  it('returning to a tab restores where it was when it was left', () => {
    render(<Page />);
    scrollWindow(1800);
    act(() => harness.select!('b'));
    // The short tab: the browser clamps, the operator scrolls a little.
    scrollWindow(120);
    act(() => harness.select!('a'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1800);
    act(() => harness.select!('b'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 120);
  });

  it('a place below the end of a document that has shrunk is capped by its height', () => {
    render(<Page />);
    scrollWindow(1800);
    act(() => harness.select!('b'));
    setDocument(1000, 600);
    act(() => harness.select!('a'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 400);
  });

  it('a tab returned to before anybody scrolled on it goes back to where it was entered', () => {
    render(<Page />);
    scrollWindow(300);
    act(() => harness.select!('b'));
    expect(scrollTo).not.toHaveBeenCalled();
    scrollWindow(2000);
    act(() => harness.select!('a'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 300);
    act(() => harness.select!('b'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 2000);
  });

  it('a first visit puts a strip hidden under the header just below it', () => {
    document.documentElement.style.setProperty('--app-top', '56px');
    render(<Page />);
    scrollWindow(1200);
    setStripTop(-300);
    act(() => harness.select!('b'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1200 - 300 - 56);
  });

  it('a first visit judges the strip by where the page was BEFORE the switch — not after a shorter tab clamped it', () => {
    // Measured in the browser (WS-13 E9 runner, 390 px): the next tab mounts as a skeleton, the
    // document shrinks, the browser clamps scrollY and the strip lands on screen — then the data
    // comes, the document grows, and the browser puts the old offset back, strip hidden again.
    document.documentElement.style.setProperty('--app-top', '56px');
    render(<Page />);
    scrollWindow(1600);
    // The clamp, as the browser does it: no scroll event reaches the page before the effect.
    Object.defineProperty(window, 'scrollY', { value: 571, configurable: true });
    setStripTop(538);
    act(() => harness.select!('b'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 571 + 538 - 56);
  });

  it('reads a header height given in rem', () => {
    document.documentElement.style.setProperty('--app-top', '3.5rem');
    render(<Page />);
    scrollWindow(1200);
    setStripTop(20);
    act(() => harness.select!('b'));
    expect(scrollTo).toHaveBeenLastCalledWith(0, 1200 + 20 - 56);
  });

  it('a first visit with the strip on screen leaves the page alone', () => {
    document.documentElement.style.setProperty('--app-top', '56px');
    render(<Page />);
    scrollWindow(1200);
    setStripTop(200);
    act(() => harness.select!('c'));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('stops listening when the page goes', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Page />);
    unmount();
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
    remove.mockRestore();
  });
});
