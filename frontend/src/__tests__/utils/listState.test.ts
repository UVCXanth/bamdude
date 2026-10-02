import { describe, it, expect } from 'vitest';
import { listState } from '../../utils/listState';

const page = (total: number) => ({ meta: { total } });

// WS-13 E7 C05 (R03): the six states of a list, read off the CURRENT key's query.
describe('listState', () => {
  it('is loading before the first answer', () => {
    expect(listState({ data: undefined, isError: false, isPlaceholderData: false })).toBe('loading');
  });
  it('is a transition while the previous key stands in', () => {
    expect(listState({ data: page(3), isError: false, isPlaceholderData: true })).toBe('transition');
  });
  it('keeps its own rows when a background re-read of the same key fails', () => {
    expect(listState({ data: page(3), isError: true, isPlaceholderData: false })).toBe('refresh-failed');
  });
  it('fails without rows when a new key fails — keepPreviousData drops the old page', () => {
    expect(listState({ data: undefined, isError: true, isPlaceholderData: false })).toBe('failed');
  });
  it('is empty only for an answer with no rows', () => {
    expect(listState({ data: page(0), isError: false, isPlaceholderData: false })).toBe('empty');
    expect(listState({ data: page(2), isError: false, isPlaceholderData: false })).toBe('data');
  });
});
