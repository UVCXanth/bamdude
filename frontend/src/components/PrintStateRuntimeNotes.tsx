import { useTranslation } from 'react-i18next';
import type { PrintStateRuntimeView } from '../api/client';

/**
 * Heating a start attempt asked for and nothing has undone (spec printer-runtime-stall r3 R7b).
 *
 * A record of what was sent, not a measured heater: the fresh temperatures are shown beside it when the
 * printer reports them, "unknown" otherwise -- and the operator is told that pausing the queue turns
 * nothing off. Nothing here sends a command.
 */
export function PrintStatePreheatNote({ pinned, temperatures }: {
  pinned: string[] | null | undefined; temperatures: PrintStateRuntimeView['temperatures'] | undefined;
}) {
  const { t } = useTranslation();
  if (!pinned?.length) return null;
  const what = pinned.map(part => t(`printStateRecovery.runtime.heater.${part}`, { defaultValue: part })).join(', ');
  const temp = (value: number | null | undefined) => (value === null || value === undefined ? '—' : Math.round(value));
  return <div className="text-xs space-y-1 text-amber-700 dark:text-amber-300">
    <p>{t('printStateRecovery.runtime.preheat', { what })}</p>
    <p>{temperatures
      ? t('printStateRecovery.runtime.temperatures', {
        bed: temp(temperatures.bed), bedTarget: temp(temperatures.bed_target),
        chamber: temp(temperatures.chamber), chamberTarget: temp(temperatures.chamber_target),
      })
      : t('printStateRecovery.runtime.temperaturesUnknown')}</p>
    <p>{t('printStateRecovery.runtime.heaters')}</p>
  </div>;
}
