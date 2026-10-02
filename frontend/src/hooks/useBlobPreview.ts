import { useCallback, useEffect, useRef, useState } from 'react';

/** The picture on screen: what was asked for, and what its read has come to. */
export interface BlobPreview<T> {
  item: T;
  url: string | null;
  failed: boolean;
}

/**
 * A picture read through an authorised fetch and shown from a blob URL (WS-13 E4 R09,
 * lifted out of `OrderAttachments` for the product's documents, E9 R07).
 *
 * ⚠️ **A blob URL is memory the page holds until it is let go:** on close, when another
 * picture replaces it, and on unmount. Each read carries its own ticket: an answer that
 * arrives after its viewer was closed or replaced — or after the page went — opens
 * nothing, and the URL made of it is let go at once. What the viewer shows (the item,
 * its name) is the one the read was started for.
 *
 * `fail()` marks the picture on screen as not shown — for bytes that came but do not
 * decode (`<img onError>`); `open(item)` again is the retry.
 */
export function useBlobPreview<T>(read: (item: T) => Promise<Blob>) {
  const [preview, setPreview] = useState<BlobPreview<T> | null>(null);
  const ticket = useRef(0);
  const shownUrl = useRef<string | null>(null);

  /** Let the picture on screen go, and forget any read still in flight. */
  const close = useCallback(() => {
    ticket.current += 1;
    if (shownUrl.current) window.URL.revokeObjectURL(shownUrl.current);
    shownUrl.current = null;
    setPreview(null);
  }, []);

  const open = async (item: T) => {
    if (shownUrl.current) window.URL.revokeObjectURL(shownUrl.current);
    shownUrl.current = null;
    const mine = ++ticket.current;
    setPreview({ item, url: null, failed: false });
    try {
      const blob = await read(item);
      const url = window.URL.createObjectURL(blob);
      if (ticket.current !== mine) {
        window.URL.revokeObjectURL(url);
        return;
      }
      shownUrl.current = url;
      setPreview({ item, url, failed: false });
    } catch {
      if (ticket.current === mine) setPreview({ item, url: null, failed: true });
    }
  };

  const fail = useCallback(() => {
    setPreview((current) => (current ? { ...current, failed: true, url: null } : current));
    if (shownUrl.current) window.URL.revokeObjectURL(shownUrl.current);
    shownUrl.current = null;
  }, []);

  useEffect(() => () => close(), [close]);

  return { preview, open, close, fail };
}
