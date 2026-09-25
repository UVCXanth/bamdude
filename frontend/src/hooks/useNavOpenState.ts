import { useCallback, useState } from 'react';

const STORAGE_KEY = 'sidebarNavOpen';

function readAll(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Whether a sidebar parent shows its children (spec workshop-nav, rule 3) —
 * a per-browser preference beside `sidebarOrder`, open by default. Storage may
 * be missing or throw (private windows, blocked site data): every read and
 * write is guarded, anything but a stored boolean reads as open, and a choice
 * that cannot be remembered still applies for this visit.
 */
export function useNavOpenState(parentId: string): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(() => {
    const stored = readAll()[parentId];
    return typeof stored === 'boolean' ? stored : true;
  });
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [parentId]: next }));
      } catch {
        // Not remembered; still applies now.
      }
    },
    [parentId],
  );
  return [open, setOpen];
}
