/**
 * A slot's colour is named with its material (upstream 39010432, #2875):
 * #FFFFFF is Jade White in PLA Basic and Ivory White in PLA Matte, and the flat
 * hex map can keep only one of them. The material-qualified map fills the gap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getColorName, setColorCatalog, __resetColorCatalogForTests } from '../../utils/colors';

describe('getColorName with a material (#2875)', () => {
  beforeEach(() => {
    __resetColorCatalogForTests();
    // What the backend ships for a real Bambu catalog: the flat map can only
    // keep one name for #FFFFFF, and the qualified map carries the rest.
    setColorCatalog(
      { ffffff: 'Jade White', '000000': 'Black' },
      { 'pla matte|ffffff': 'Ivory White', 'pla matte|000000': 'Charcoal' },
    );
  });

  it('returns the material-specific name when the caller knows the material', () => {
    expect(getColorName('FFFFFFFF', 'PLA Matte')).toBe('Ivory White');
    expect(getColorName('000000FF', 'PLA Matte')).toBe('Charcoal');
  });

  it('still returns the flat name for a material with no entry of its own', () => {
    expect(getColorName('FFFFFFFF', 'PLA Basic')).toBe('Jade White');
    expect(getColorName('FFFFFFFF', 'Some Third Party Filament')).toBe('Jade White');
  });

  it('ignores case and padding in the material, as tray_sub_brands is not normalized', () => {
    expect(getColorName('FFFFFFFF', '  pla MATTE ')).toBe('Ivory White');
  });

  it('falls back to the flat name when no material is passed', () => {
    expect(getColorName('FFFFFFFF')).toBe('Jade White');
    expect(getColorName('FFFFFFFF', null)).toBe('Jade White');
    expect(getColorName('FFFFFFFF', '')).toBe('Jade White');
  });

  it('keeps Clear ahead of any catalog lookup for a transparent spool', () => {
    expect(getColorName('FFFFFF00', 'PLA Matte')).toBe('Clear');
  });

  it('falls back to HSL when neither map knows the hex', () => {
    expect(getColorName('5F6367', 'PLA Matte')).toBe('Dark Gray');
  });

  it('survives a catalog with no qualified map at all', () => {
    __resetColorCatalogForTests();
    setColorCatalog({ ffffff: 'Jade White' });
    expect(getColorName('FFFFFFFF', 'PLA Matte')).toBe('Jade White');
  });

  it('reads the hex from the last separator, so a material may contain one', () => {
    // Material is free text -- users edit the colour catalog.
    __resetColorCatalogForTests();
    setColorCatalog({ ffffff: 'Jade White' }, { 'pla|matte|ffffff': 'Ivory White' });
    expect(getColorName('FFFFFFFF', 'PLA|Matte')).toBe('Ivory White');
  });

  it('ignores malformed qualified keys instead of poisoning the map', () => {
    __resetColorCatalogForTests();
    setColorCatalog(
      { ffffff: 'Jade White' },
      { 'pla matte|nothex': 'Nope', '|ffffff': 'Nope', 'pla matte': 'Nope', 'pla matte|ffffff': 'Ivory White' },
    );
    expect(getColorName('FFFFFFFF', 'PLA Matte')).toBe('Ivory White');
    expect(getColorName('FFFFFFFF')).toBe('Jade White');
  });
});
