/**
 * Both slot pickers of the print dialog name an assigned slot after its spool
 * (upstream d5c70477): the single-printer mapping panel and the per-printer
 * editor of the multi-printer selector.
 */
import { describe, it, expect } from 'vitest';
import filamentMapping from '../../components/PrintModal/FilamentMapping.tsx?raw';
import printerSelector from '../../components/PrintModal/PrinterSelector.tsx?raw';

describe('the print dialog names assigned slots by their spool', () => {
  it('in the mapping panel', () => {
    expect(filamentMapping).toContain('useSlotSpoolNames(printerId)');
    expect(filamentMapping).toContain('slotNames.get(f.globalTrayId)');
  });

  it('in the multi-printer editor', () => {
    expect(printerSelector).toContain('useSlotSpoolNames(printerResult.printerId)');
    expect(printerSelector).toContain('slotNames.get(f.globalTrayId)');
  });
});
