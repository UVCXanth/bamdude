import { describe, it, expect } from 'vitest';
import { resolveDrop } from '../../../../components/projects/board/boardDrop';

describe('resolveDrop', () => {
  it('into another active column sets that stage', () => {
    expect(resolveDrop('prep', 'qc')).toEqual({ kind: 'stage', stage: 'qc' });
    expect(resolveDrop('qc', 'printing')).toEqual({ kind: 'stage', stage: 'printing' });
  });
  it('into «done» completes the order', () => {
    expect(resolveDrop('qc', 'done')).toEqual({ kind: 'complete' });
    expect(resolveDrop('prep', 'done')).toEqual({ kind: 'complete' });
  });
  it('into its own column does nothing', () => {
    expect(resolveDrop('qc', 'qc')).toBeNull();
    expect(resolveDrop('done', 'done')).toBeNull();
  });
  it('a completed card never moves — reopening is the menu’s job', () => {
    expect(resolveDrop('done', 'prep')).toBeNull();
    expect(resolveDrop('done', 'qc')).toBeNull();
  });
});
