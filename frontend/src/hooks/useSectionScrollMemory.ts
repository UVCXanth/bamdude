import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** The fixed compact header's height (`--app-top`, set by `Layout` on `<html>` in px or rem). */
function appTopPx(): number {
  const root = document.documentElement;
  const raw = root.style.getPropertyValue('--app-top').trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  if (raw.endsWith('rem')) return value * (parseFloat(getComputedStyle(root).fontSize) || 16);
  return value;
}

/**
 * Each tab of a page keeps its own place in the document (WS-13 E9 C03, R05).
 *
 * The document scrolls the page (`<main>` is no scroll box), so one `scrollY` serves every
 * tab, while the hidden ones stay mounted. The place of the open tab is recorded as the
 * window scrolls — not when a tab is clicked — so a change of tab through the URL (Back /
 * Forward over `?tab=`) leaves its tab's place recorded too. ⚠️ It is never read at the
 * change itself: by then the next tab is in the DOM and a shorter document has already
 * clamped `scrollY`.
 *
 * Returning to a tab restores its place after layout, capped by the document's height. A
 * first visit moves the page only when the strip was hidden above the screen (under the
 * app's header): then the strip comes to rest just below the header. ⚠️ «Was» is judged by
 * the place the previous tab was left at, not by `scrollY` at the effect: a first visit
 * usually mounts a skeleton, the document shrinks and the browser clamps `scrollY` with the
 * strip on screen — and when the data comes and the document grows, the browser puts the
 * old offset back with the strip hidden again (measured in Chrome, WS-13 E9 runner). An
 * explicit scroll replaces that remembered offset. The strip's place in the document does
 * not depend on the tab below it, so `rect.top + scrollY` reads it whatever the clamp did.
 * The memory lives as long as the owner — a page keyed by its record forgets it with it.
 */
export function useSectionScrollMemory<S extends string>(section: S, stripRef: RefObject<HTMLElement | null>): void {
  const places = useRef(new Map<S, number>());
  const current = useRef(section);

  useEffect(() => {
    places.current.set(current.current, window.scrollY);
    const onScroll = () => places.current.set(current.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    if (current.current === section) return;
    const left = places.current.get(current.current);
    current.current = section;
    const saved = places.current.get(section);
    if (saved != null) {
      const bottom = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const target = Math.min(saved, bottom);
      window.scrollTo(0, target);
      places.current.set(section, target);
      return;
    }
    const strip = stripRef.current;
    const header = appTopPx();
    // Where the strip sits in the document, and where it was on screen before the switch.
    const stripY = strip ? strip.getBoundingClientRect().top + window.scrollY : 0;
    const wasAt = stripY - (left ?? window.scrollY);
    if (strip && wasAt < header) {
      const target = Math.max(0, stripY - header);
      window.scrollTo(0, target);
      places.current.set(section, target);
      return;
    }
    places.current.set(section, window.scrollY);
  }, [section, stripRef]);
}
