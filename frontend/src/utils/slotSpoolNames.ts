/**
 * The name of the spool assigned to each AMS slot, keyed by global tray id.
 *
 * The print dialog described a slot from telemetry alone, and a printer cannot
 * describe a spool it did not sell: a tray record has no brand, no subtype for a
 * non-Bambu spool, and a bare hex that resolves against Bambu's own catalogue —
 * a Devil Design PLA Basic Orange read "PLA (Sunflower Yellow)" while the
 * printer card named it correctly (upstream d5c70477). The assignment is the
 * user's word for what is in the slot, so it names the slot, through the same
 * spool-name template every other surface uses. Matching is untouched: routing
 * still reads type, colour and tray_info_idx off telemetry.
 */
import type { InventorySpool } from '../api/client';
import { getGlobalTrayId } from './amsHelpers';
import { formatSpoolDisplayName } from './spoolName';

interface SlotRow {
  ams_id: number;
  tray_id: number;
}

export function slotSpoolNames(input: {
  spoolmanMode: boolean;
  template: string | null | undefined;
  /** Internal inventory: `/inventory/assignments?printer_id=…`. */
  assignments?: readonly (SlotRow & { spool?: InventorySpool | null })[];
  /** Spoolman: `/spoolman/inventory/slot-assignments/all?printer_id=…`. */
  spoolmanAssignments?: readonly (SlotRow & { spoolman_spool_id: number })[];
  spoolmanSpools?: readonly InventorySpool[];
}): Map<number, string> {
  const names = new Map<number, string>();
  const put = (row: SlotRow, spool: InventorySpool | null | undefined) => {
    if (!spool) return;
    const name = formatSpoolDisplayName(spool, input.template).trim();
    if (name) names.set(getGlobalTrayId(row.ams_id, row.tray_id, row.ams_id === 255), name);
  };
  if (input.spoolmanMode) {
    const byId = new Map((input.spoolmanSpools ?? []).map((s) => [s.id, s]));
    for (const row of input.spoolmanAssignments ?? []) put(row, byId.get(row.spoolman_spool_id));
  } else {
    for (const row of input.assignments ?? []) put(row, row.spool);
  }
  return names;
}
