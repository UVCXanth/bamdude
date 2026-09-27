import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../../api/client';
import type { ZigbeeSensor } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { sensorsForStorage } from '../../utils/sensorReadings';
import { SensorChip } from './SensorChip';
import { SensorHistoryModal } from './SensorHistoryModal';

/** Shared physical readings for every spool filed under this storage place. */
export function StorageLocationConditions({ locationId }: { locationId: number }) {
  const { hasPermission } = useAuth();
  const [charting, setCharting] = useState<ZigbeeSensor | null>(null);
  const mayRead = hasPermission('smart_sensors:read');
  const { data } = useQuery({
    queryKey: ['zigbee-sensors'], queryFn: api.getZigbeeSensors,
    enabled: mayRead, refetchInterval: 30000,
  });
  if (!mayRead) return null;
  const sensors = sensorsForStorage(data?.sensors ?? [], locationId);
  if (sensors.length === 0) return null;

  return <>
    <span className="inline-flex flex-wrap items-center gap-2">
      {sensors.map((sensor) => <SensorChip key={sensor.id} sensor={sensor}
        onOpen={() => setCharting(sensor)} />)}
    </span>
    {charting && <SensorHistoryModal isOpen sensor={charting} onClose={() => setCharting(null)} />}
  </>;
}
