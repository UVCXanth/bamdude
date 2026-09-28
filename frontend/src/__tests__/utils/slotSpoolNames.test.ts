/**
 * The print dialog names a slot after the spool assigned to it (upstream
 * d5c70477).
 *
 * The dialog described every slot from the printer's telemetry, and a printer
 * cannot describe a spool it did not sell: no brand, no subtype for a non-Bambu
 * spool, and a bare hex resolved against Bambu's catalogue — a Devil Design PLA
 * Basic Orange read "PLA (Sunflower Yellow)" while the printer card, which reads
 * the assignment, named it correctly. The assignment is already loaded on the
 * client, so the name comes from it through the user's own spool-name template.
 */
import { describe, it, expect } from 'vitest';
import { slotSpoolNames } from '../../utils/slotSpoolNames';
import type { InventorySpool } from '../../api/client';

const spool = (over: Partial<InventorySpool>): InventorySpool =>
  ({
    id: 1, material: 'PLA', subtype: 'Basic', brand: 'Devil Design', color_name: 'Orange',
    color_name_is_synthesized: false, rgba: 'FEC600FF', extra_colors: null, effect_type: null,
    ...over,
  }) as InventorySpool;

describe('slotSpoolNames', () => {
  it('names an internal assignment through the template', () => {
    const names = slotSpoolNames({
      spoolmanMode: false,
      template: '{brand} {material} {subtype} {color_name}',
      assignments: [{ ams_id: 0, tray_id: 2, spool: spool({}) }],
    });
    expect(names.get(2)).toBe('Devil Design PLA Basic Orange');
  });

  it('keys the external holder as the dialog does (254 / 255)', () => {
    const names = slotSpoolNames({
      spoolmanMode: false,
      template: '{brand} {color_name}',
      assignments: [{ ams_id: 255, tray_id: 0, spool: spool({}) }],
    });
    expect(names.get(254)).toBe('Devil Design Orange');
  });

  it('names a Spoolman assignment from the Spoolman spool list', () => {
    const names = slotSpoolNames({
      spoolmanMode: true,
      template: '{brand} {material} {color_name}',
      spoolmanAssignments: [{ ams_id: 1, tray_id: 0, spoolman_spool_id: 42 }],
      spoolmanSpools: [spool({ id: 42, brand: 'Ziro', color_name: 'Mist' })],
    });
    expect(names.get(4)).toBe('Ziro PLA Mist');
  });

  it('ignores the other mode\'s rows and a spool it cannot find', () => {
    const names = slotSpoolNames({
      spoolmanMode: true,
      template: '{brand}',
      assignments: [{ ams_id: 0, tray_id: 0, spool: spool({}) }],
      spoolmanAssignments: [{ ams_id: 0, tray_id: 1, spoolman_spool_id: 99 }],
      spoolmanSpools: [],
    });
    expect(names.size).toBe(0);
  });

  it('leaves a slot with nothing assigned to telemetry', () => {
    expect(slotSpoolNames({ spoolmanMode: false, template: null, assignments: [] }).size).toBe(0);
  });
});
