import { describe, it, expect } from 'vitest';
import { listViewParser, parseListView } from '../../hooks/usePersistedState';

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
