import { useEffect } from 'react';
import type { RefObject } from 'react';
import { isAnyModalOpen } from '../components/modalStack';

/**
 * `/` focuses the list's search — the archive's shortcut, on every Workshop list
 * (spec workshop-lists, rule 23). Quiet while the user types in a field (the
 * key belongs to the text) and under a modal (the stack owns the keyboard).
 */
export function useSearchHotkey(ref: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (isAnyModalOpen()) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ref]);
}
