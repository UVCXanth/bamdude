import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Escape for an INNER layer of a dialog — an inline edit, a token field (the modal
 * invariant): a listener on `document`, which the key reaches before the modal stack's
 * one on `window`. While the focus is inside `ref` and `active` says the layer has
 * something to cancel, the key is the layer's: it stops there and `onEscape` runs, so the
 * dialog stays. Otherwise the key goes on, and the next Escape closes the dialog as ever.
 */
export function useInnerEscape(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape: () => void,
): void {
  const handler = useRef(onEscape);
  useLayoutEffect(() => {
    handler.current = onEscape;
  });
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const layer = ref.current;
      if (!layer || !(e.target instanceof Node) || !layer.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      handler.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref, active]);
}
