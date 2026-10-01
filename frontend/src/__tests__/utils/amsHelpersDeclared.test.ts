/**
 * Strict checks read what the operator declared to the AMS (owner, 2026-09-30).
 *
 * A backup group built from leftovers under the backup-compatibility emulation
 * outranks the «exact colour» box and the strict profile: both are judged by
 * the colour / profile BamDude told the AMS, the same rule the server's
 * `FeedSource.rule_color` / `rule_variant` apply. Base material stays the spool's.
 */
import { describe, it, expect } from 'vitest';

import { declaredColor, filamentColorMatches, filamentRequirementMatches } from '../../utils/amsHelpers';

const masked = {
  type: 'PETG',
  color: '#FF0000',
  advertisedColor: '#000000',
  trayInfoIdx: 'GFG02',
  advertisedTrayInfoIdx: 'GFG99',
};

describe('strict checks read what the operator declared to the AMS', () => {
  it('judges an exact colour by the declared colour', () => {
    expect(filamentColorMatches({ color: '#000000', strict_color_match: true }, masked)).toBe(true);
    expect(filamentColorMatches({ color: '#FF0000', strict_color_match: true }, masked)).toBe(false);
  });

  it('keeps the spool colour for the informational match', () => {
    expect(filamentColorMatches({ color: '#FF0000' }, masked)).toBe(true);
  });

  it('judges a strict profile by the declared profile', () => {
    const req = { type: 'PETG', color: '#000000', strict_profile_match: true };
    expect(filamentRequirementMatches({ ...req, tray_info_idx: 'GFG99' }, masked)).toBe(true);
    expect(filamentRequirementMatches({ ...req, tray_info_idx: 'GFG02' }, masked)).toBe(false);
  });

  it('falls back to the spool when nothing is declared', () => {
    expect(declaredColor({ color: '#123456' })).toBe('#123456');
  });
});
