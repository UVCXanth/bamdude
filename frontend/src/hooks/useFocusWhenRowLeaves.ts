import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { isAnyModalOpen, onModalStackChange } from '../components/modalStack';

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
 * Returns `watch(trigger)` — call it with the element the focus was given back to, or with
 * the row that holds it: a focus anywhere inside the watched element is still the watch's
 * (a confirmation gives the focus back to its opener, a button INSIDE the row).
 *
 * ⚠️ A confirmation may still be open when the row leaves — the re-read can answer before
 * it closes, or the caller arms the watch from the confirmation's own `send`. While any
 * modal is open, nothing is decided: a focus move there is the confirmation's, and a row
 * that left waits for the stack to empty (`onModalStackChange` — the modal leaves the stack
 * before `useDialogFocus` tries to return the focus to the opener, which left with the row).
 * WS-13 E9 final review: watching the row ended at the first focus inside it, and a row
 * that left under the open confirmation was given up with the focus on the dialog.
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
        unsubscribe();
        document.removeEventListener('focusin', moved, true);
        if (stopRef.current === stop) stopRef.current = null;
      };
      const moved = (e: FocusEvent) => {
        if (isAnyModalOpen()) return;
        if (trigger.isConnected && e.target instanceof Node && trigger.contains(e.target)) return;
        stop();
      };
      const settle = () => {
        if (trigger.isConnected || isAnyModalOpen()) return;
        stop();
        const now = document.activeElement;
        if (now == null || now === document.body) fallbackRef.current?.focus();
      };
      const observer = new MutationObserver(settle);
      observer.observe(document.body, { childList: true, subtree: true });
      const unsubscribe = onModalStackChange(settle);
      document.addEventListener('focusin', moved, true);
      stopRef.current = stop;
    },
    [fallbackRef],
  );
}
