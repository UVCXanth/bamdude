import { useCallback, useEffect, useRef, type RefObject } from 'react';

/**
 * The focus after an action takes its row off the page (WS-13 E9 B11; the product action
 * host's watch of E8-V02, in one place for every page that needs it).
 *
 * A menu or a dialog gives the focus back to its trigger at once, but the row the trigger
 * sits in leaves only when the re-read answers — after an unlink, a delete, a hide while
 * hidden ones are not shown. Once the trigger has left and the focus fell to BODY, the
 * page's heading takes it (F09). The watch has NO time limit: the re-read is the server's
 * and may take any time. It ends when the trigger leaves, when the operator moves the
 * focus (then it is theirs), when another watch starts, or when the page goes.
 *
 * Returns `watch(trigger)` — call it with the element the focus was given back to.
 */
export function useFocusWhenRowLeaves(fallbackRef: RefObject<HTMLElement | null>): (trigger: Element | null) => void {
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  return useCallback(
    (trigger: Element | null) => {
      stopRef.current?.();
      if (!(trigger instanceof HTMLElement) || !trigger.isConnected) return;
      const stop = () => {
        observer.disconnect();
        document.removeEventListener('focusin', moved, true);
        if (stopRef.current === stop) stopRef.current = null;
      };
      const moved = (e: FocusEvent) => {
        if (e.target !== trigger) stop();
      };
      const observer = new MutationObserver(() => {
        if (trigger.isConnected) return;
        stop();
        const now = document.activeElement;
        if (now == null || now === document.body) fallbackRef.current?.focus();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      document.addEventListener('focusin', moved, true);
      stopRef.current = stop;
    },
    [fallbackRef],
  );
}
