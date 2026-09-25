import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useNavOpenState } from '../../hooks/useNavOpenState';

describe('useNavOpenState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is open by default and remembers a close across mounts', () => {
    const first = renderHook(() => useNavOpenState('projects'));
    expect(first.result.current[0]).toBe(true);
    act(() => first.result.current[1](false));
    expect(first.result.current[0]).toBe(false);
    first.unmount();
    const second = renderHook(() => useNavOpenState('projects'));
    expect(second.result.current[0]).toBe(false);
  });

  it('keeps other parents untouched', () => {
    localStorage.setItem('sidebarNavOpen', JSON.stringify({ other: false }));
    const { result } = renderHook(() => useNavOpenState('projects'));
    act(() => result.current[1](false));
    expect(JSON.parse(localStorage.getItem('sidebarNavOpen')!)).toEqual({ other: false, projects: false });
  });

  it('falls back to open on garbage or a storage that throws', () => {
    localStorage.setItem('sidebarNavOpen', '{not json');
    expect(renderHook(() => useNavOpenState('projects')).result.current[0]).toBe(true);
    localStorage.setItem('sidebarNavOpen', JSON.stringify({ projects: 'no' }));
    expect(renderHook(() => useNavOpenState('projects')).result.current[0]).toBe(true);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useNavOpenState('projects'));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false)); // must not throw
    expect(result.current[0]).toBe(false); // still applies for this visit
  });
});
