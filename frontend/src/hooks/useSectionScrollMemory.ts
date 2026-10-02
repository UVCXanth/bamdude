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
 * first visit moves the page only when the strip is hidden above the screen (under the
 * app's header): then the strip comes to rest just below the header. The memory lives as
 * long as the owner — a page keyed by its record forgets it with the record.
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
    const top = strip ? strip.getBoundingClientRect().top : 0;
    const header = appTopPx();
    if (strip && top < header) {
      const target = Math.max(0, window.scrollY + top - header);
      window.scrollTo(0, target);
      places.current.set(section, target);
      return;
    }
    places.current.set(section, window.scrollY);
  }, [section, stripRef]);
}
