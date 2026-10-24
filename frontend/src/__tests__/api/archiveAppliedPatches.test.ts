import { describe, expect, it } from 'vitest';
import type { Archive } from '../../api/client';

// Issue #97: the server answers the patches applied before upload as identifiers AND descriptor objects, exactly as
// the dispatch wrote them. The type must hold that answer (`npm run typecheck` checks this file too).
describe('Archive.applied_patches', () => {
  it('holds identifiers and descriptor objects side by side', () => {
    const patches: Archive['applied_patches'] = [
      'mesh_mode_fast_check_off',
      { name: 'gcode_injection', plate_id: 2, detail: { start: ['G28'] } },
    ];
    expect(patches?.map(patch => (typeof patch === 'string' ? patch : patch.name))).toEqual([
      'mesh_mode_fast_check_off',
      'gcode_injection',
    ]);
  });
});
