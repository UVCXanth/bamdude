/**
 * A portal-rendered menu never runs off the viewport (upstream a72f49be, #2846).
 *
 * The File Manager's card menu anchored its bottom above the trigger whenever
 * there were 120 px above it, so a seven-entry menu (~310 px) under a card near
 * the top of the screen ran off the top edge and its FIRST entry — Slice, on an
 * STL — was the one lost. Upstream moved the card to a shared ContextMenu; here
 * every "…" menu already hangs off `useAnchoredPosition` except that card, so
 * the hook learns to fit the viewport and the card joins it: the side with room
 * wins, an upward menu is anchored by its bottom so the gap to the trigger stays
 * exact however tall it is, and `maxHeight` caps it to the space it has — a menu
 * taller than that scrolls instead of being cut.
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ESTIMATED_MENU_HEIGHT, useAnchoredPosition } from '../../hooks/useAnchoredPosition';
import fileManagerSource from '../../pages/FileManagerPage.tsx?raw';
import cardMenuSource from '../../components/CardActionMenu.tsx?raw';

const VIEWPORT = { width: 1280, height: 800 };
const originalSize = { width: window.innerWidth, height: window.innerHeight };

function anchorAt(top: number, height = 28, right = 1200) {
  const el = document.createElement('button');
  el.getBoundingClientRect = () =>
    ({ top, bottom: top + height, right, left: right - 28, width: 28, height, x: right - 28, y: top }) as DOMRect;
  return { current: el };
}

function place(top: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT.height });
  const ref = anchorAt(top);
  return renderHook(() => useAnchoredPosition(ref, true)).result.current!;
}

afterEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalSize.width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalSize.height });
});

describe('useAnchoredPosition', () => {
  it('opens below with the room below as its ceiling', () => {
    const coords = place(100);
    expect(coords.top).toBe(100 + 28 + 4);
    expect(coords.bottom).toBeUndefined();
    expect(coords.maxHeight).toBe(VIEWPORT.height - 8 - (100 + 28 + 4));
  });

  it('opens above, anchored by its bottom, when the room is there and not below', () => {
    const top = VIEWPORT.height - 60;
    const coords = place(top);
    expect(coords.top).toBeUndefined();
    expect(coords.bottom).toBe(VIEWPORT.height - top + 4);
    expect(coords.maxHeight).toBe(top - 4 - 8);
  });

  it('takes the larger side when neither holds the menu, and caps it there', () => {
    // 200 px above, ~560 below: the old card rule (open above past 120 px) ran
    // a 310 px menu off the top edge.
    const coords = place(200);
    expect(coords.top).toBe(200 + 28 + 4);
    expect(coords.maxHeight).toBeGreaterThanOrEqual(ESTIMATED_MENU_HEIGHT);
  });

  it('keeps the 8 px margin on the right', () => {
    expect(place(100).right).toBe(VIEWPORT.width - 1200);
  });
});

describe('every "…" menu uses it', () => {
  it('the File Manager card no longer carries its own arithmetic', () => {
    expect(fileManagerSource).not.toMatch(/minOpenAboveHeight/);
    expect(fileManagerSource).toMatch(/useAnchoredPosition\(triggerRef, showActions\)/);
  });

  it('each panel takes the ceiling and scrolls past it', () => {
    for (const source of [fileManagerSource, cardMenuSource]) {
      const panels = source.match(/maxHeight: coords\?\.maxHeight/g) ?? [];
      expect(panels.length).toBeGreaterThan(0);
      expect(source).toMatch(/overflowY: 'auto'/);
    }
    // Two menus in the File Manager: the list row's and the grid card's.
    expect((fileManagerSource.match(/maxHeight: coords\?\.maxHeight/g) ?? []).length).toBe(2);
  });
});
