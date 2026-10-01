import { useQuery } from '@tanstack/react-query';
import { api } from '../../../api/client';
import { isPrintable } from '../../../lib/fileTags';
import type { PlateFile } from './addToOrderState';

/** Whether a chosen file's plates are worth reading: a type that can be planned, sliced (R01). */
export function platesReadable(file: PlateFile | null): boolean {
  return file != null && file.planEligible && isPrintable({ file_tags: file.fileTags });
}

/**
 * The plates of the chosen file — ONE query, read by the pane that draws them and by the
 * dialog that sends them (WS-13 E5-V01), so both judge the chosen plate against the same
 * answer.
 */
export function usePlatesOf(file: PlateFile | null) {
  return useQuery({
    queryKey: ['library-file-plates', file?.id ?? null],
    queryFn: () => api.getLibraryFilePlates(file!.id),
    // Only a sliced file of a type that can be planned has plates worth offering.
    enabled: platesReadable(file),
  });
}
