import { useTranslation } from 'react-i18next';

import { useStorageCondition } from '../hooks/useStorageCondition';
import { formatReading } from '../utils/sensorReadings';
import type { ConditionCategory } from '../utils/storageCondition';

export function StorageConditionCell({ locationId, category }: { locationId: number; category: ConditionCategory }) {
  const { t } = useTranslation();
  const { selected, candidates } = useStorageCondition(locationId, category);
  if (!selected) return <span className="text-bambu-gray" title={candidates.length > 1 ? t('haSensors.choosePrimaryHint') : undefined}>—</span>;
  return <span title={`${selected.name} (${selected.source})`} className={selected.reachable ? 'text-white' : 'text-bambu-gray'}>
    {selected.reachable ? `${formatReading(selected.value)} ${selected.unit ?? ''}`.trim() : '—'}
  </span>;
}
