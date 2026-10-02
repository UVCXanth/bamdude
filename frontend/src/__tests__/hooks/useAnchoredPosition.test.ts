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

  // WS-13 E9 (390 px): the product page's «⋮» wraps under the title, to the LEFT edge, and a
  // panel hung by its right edge from there ran off the screen with every item cut.
  function measured(triggerRight: number, panelWidth: number, viewport = 390) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
    const anchor = anchorAt(100, 28, triggerRight);
    const panel = document.createElement('div');
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: panelWidth });
    const panelRef = { current: panel };
    return renderHook(() => useAnchoredPosition(anchor, true, ESTIMATED_MENU_HEIGHT, panelRef)).result.current!;
  }

  it('a panel that would leave the screen on the left hangs from the trigger’s left edge instead', () => {
    const coords = measured(46, 236);
    expect(coords.right).toBeUndefined();
    expect(coords.left).toBe(46 - 28);
  });

  it('a panel hung from the left is pulled back inside the right margin', () => {
    // Too wide for either edge of the trigger: it still keeps the 8 px margin on the right.
    const coords = measured(200, 300);
    expect(coords.left).toBe(390 - 8 - 300);
  });

  it('a measured panel that fits keeps its right edge on the trigger’s', () => {
    const coords = measured(380, 236);
    expect(coords.left).toBeUndefined();
    expect(coords.right).toBe(390 - 380);
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

  it('the card menu lets the hook measure its panel and takes either edge', () => {
    expect(cardMenuSource).toMatch(/useAnchoredPosition\(triggerRef, open, estimatedHeight, panelRef\)/);
    expect(cardMenuSource).toMatch(/left: coords\?\.left/);
  });
});
