import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CARDS_TABLE_MODES, listViewParser, parseListView, parseArchivesView, parseLibraryView, parseQueueView, parsePrintersPageView } from '../../hooks/usePersistedState';
import { useCardsTableViews } from '../../hooks/useCardsTableViews';

describe('the cards/table modes have one list', () => {
  it('the switch offers exactly the modes the stored choice may hold', () => {
    const { result } = renderHook(() => useCardsTableViews());
    expect(result.current.map((o) => o.value)).toEqual([...CARDS_TABLE_MODES]);
    for (const mode of CARDS_TABLE_MODES) expect(parseListView(mode)).toBe(mode);
  });
});

it('accepts the existing page modes and legacy compact without accepting garbage', () => {
  expect(parseArchivesView('calendar')).toBe('calendar');
  expect(parseArchivesView('broken')).toBeUndefined();
  expect(parseLibraryView('list')).toBe('list');
  expect(parseLibraryView('broken')).toBeUndefined();
  expect(parseQueueView('compact')).toBe('expanded');
  expect(parseQueueView('timeline')).toBe('timeline');
  expect(parseQueueView('broken')).toBeUndefined();
  expect(parsePrintersPageView('camwall')).toBe('camwall');
  expect(parsePrintersPageView('broken')).toBeUndefined();
});

describe('listViewParser', () => {
  it('accepts only the given modes — an old or future value reads as absent', () => {
    const parse = listViewParser(['cards', 'table', 'kanban'] as const);
    expect(parse('kanban')).toBe('kanban');
    expect(parse('calendar')).toBeUndefined();
    expect(parseListView('table')).toBe('table');
    expect(parseListView('kanban')).toBeUndefined();
    expect(parseListView('')).toBeUndefined();
  });
});
