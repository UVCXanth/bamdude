import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** The nearest ancestor of `el` that scrolls vertically — a dialog's body. */
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * The dialog body's vertical scroll, per tab (WS-13 E5 B02, R06).
 *
 * ⚠️ The body is the Modal's ONE scroll container; a panel kept mounted with
 * `hidden` keeps its own DOM (a table's sideways scroll, a list's inner scroll)
 * but not the body's `scrollTop` — a short tab clamps it, and coming back would
 * land at the top. So the switch remembers where the body stood for the tab it
 * leaves, and the tab that returns is put back there after it renders (a tab
 * seen for the first time starts at the top). `Modal` stays as it is.
 *
 * Returns the switch to call instead of `setTab`.
 */
export function useTabScroll<T extends string>(
  tab: T,
  setTab: (next: T) => void,
  anchor: RefObject<HTMLElement | null>,
): (next: T) => void {
  const saved = useRef(new Map<T, number>());

  const switchTo = useCallback(
    (next: T) => {
      const scroller = scrollParent(anchor.current);
      if (scroller) saved.current.set(tab, scroller.scrollTop);
      setTab(next);
    },
    [tab, setTab, anchor],
  );

  useLayoutEffect(() => {
    const scroller = scrollParent(anchor.current);
    if (scroller) scroller.scrollTop = saved.current.get(tab) ?? 0;
  }, [tab, anchor]);

  return switchTo;
}
