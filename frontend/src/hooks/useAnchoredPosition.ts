import { useEffect, useState, type RefObject } from 'react';

/** How tall a panel is ASSUMED to be when deciding which side of its trigger
 *  to open on. A guess is enough: `maxHeight` makes a wrong one scroll rather
 *  than overflow, and measuring would need a second render pass. */
export const ESTIMATED_MENU_HEIGHT = 280;

/** Kept clear between the panel and the viewport edge. */
const VIEWPORT_MARGIN = 8;
/** Between the panel and its trigger. */
const TRIGGER_GAP = 4;

export interface AnchoredPosition {
  /** Viewport pixels from the top — set when the panel opens BELOW its trigger.
   *  The panel is `position: fixed`, not laid out. */
  top?: number;
  /** Viewport pixels from the bottom — set when it opens ABOVE, so the gap to
   *  the trigger stays exact however tall the panel turns out to be. */
  bottom?: number;
  /** Distance from the RIGHT edge of the viewport, so the panel's right edge
   *  lines up with the trigger's however wide the panel is. */
  right: number;
  /** The room on the chosen side. A taller panel scrolls (`overflowY: auto`)
   *  instead of running off the screen and losing its first or last entry. */
  maxHeight: number;
}

/**
 * Where to put a portal-rendered panel that hangs off a trigger.
 *
 * Both "…" menus in this app render into `document.body` — the File Manager's
 * row menu to escape the list's `overflow-hidden`, the grid cards' menu because
 * a card is one big `<Link>` and a `<button>` inside an `<a>` is invalid HTML.
 * Out of the flow, neither can be positioned by layout, so both measure the
 * trigger's own box and hang a fixed panel off it. That arithmetic — right-edge
 * alignment, the 4 px gap, the 8 px viewport margin, the flip above when the
 * bottom is close — was written twice and is one behaviour; a fix applied to
 * one copy is a divergence between two menus that look identical on screen.
 * The File Manager's grid card had a third copy that opened above whenever
 * there were 120 px of room, so a seven-entry menu near the top of the screen
 * ran off the top edge and lost its first entry (upstream #2846); it uses this
 * hook now.
 *
 * ⚠️ **The panel never leaves the viewport.** It opens on the side that holds
 * `estimatedHeight`, preferring below, else on the side with more room, and
 * `maxHeight` caps it to that room. Callers pass `maxHeight` and `overflowY:
 * 'auto'` straight into the panel's style.
 *
 * ⚠️ **`capture` on scroll.** A card grid or a file list scrolls in its own
 * container on some layouts, and a listener on `window` alone never hears that
 * scroll — the panel would sit where the trigger used to be.
 *
 * ⚠️ **`null` until the first measurement**, which is after the panel's first
 * render: the caller must keep it `visibility: hidden` until then, or it
 * flashes at the corner of the screen. Closing clears the coordinates, so a
 * reopen cannot show one frame at wherever the trigger was last time.
 */
export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  estimatedHeight: number = ESTIMATED_MENU_HEIGHT,
): AnchoredPosition | null {
  const [coords, setCoords] = useState<AnchoredPosition | null>(null);

  useEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const right = Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.right);
      const roomBelow = window.innerHeight - VIEWPORT_MARGIN - (rect.bottom + TRIGGER_GAP);
      const roomAbove = rect.top - TRIGGER_GAP - VIEWPORT_MARGIN;
      if (roomBelow >= estimatedHeight || roomBelow >= roomAbove) {
        setCoords({ top: rect.bottom + TRIGGER_GAP, right, maxHeight: Math.max(0, roomBelow) });
      } else {
        setCoords({
          bottom: window.innerHeight - rect.top + TRIGGER_GAP,
          right,
          maxHeight: Math.max(0, roomAbove),
        });
      }
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef, estimatedHeight]);

  return coords;
}
