import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../api/client';
import type { LocationHASensorReading, ZigbeeSensor } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { describeHASensorReading, iconForHASensor } from '../../utils/haSensorDisplay';
import { useTranslation } from 'react-i18next';
import { sensorsForStorage } from '../../utils/sensorReadings';
import { SensorChip } from './SensorChip';
import { SensorHistoryModal } from './SensorHistoryModal';
import { HASensorHistoryModal } from '../HASensorHistoryModal';
import { useStorageCondition } from '../../hooks/useStorageCondition';
import type { ConditionCategory } from '../../utils/storageCondition';
import { useToast } from '../../contexts/ToastContext';

function PrimarySelector({ locationId, category }: { locationId: number; category: ConditionCategory }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { candidates, primary } = useStorageCondition(locationId, category);
  const mutation = useMutation({
    mutationFn: api.setLocationSensorPrimary,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['locationSensorPrimary'] });
      void queryClient.invalidateQueries({ queryKey: ['inventory-spools', 'page'] });
    },
    onError: (error: Error) => showToast(error.message || t('haSensors.selectPrimaryFailed'), 'error'),
  });
  if (candidates.length < 2 || !hasPermission('smart_sensors:update')) return null;
  return <label className="inline-flex items-center gap-1 text-xs text-bambu-gray" onClick={event => event.stopPropagation()}>
    {t(`inventory.${category}`)}: {t('haSensors.primary')}
    <select aria-label={`${t(`inventory.${category}`)} ${t('haSensors.primary')}`}
      value={primary ? `${primary.source}:${primary.binding_id}` : ''}
      onChange={event => {
        const chosen = candidates.find(item => `${item.source}:${item.binding_id}` === event.target.value);
        if (chosen) mutation.mutate({ location_id: locationId, category, source: chosen.source, binding_id: chosen.binding_id });
      }} className="rounded bg-bambu-dark-tertiary px-1 py-0.5 text-white" disabled={mutation.isPending}>
      <option value="">{t('haSensors.selectPrimary')}</option>
      {candidates.map(item => <option key={`${item.source}:${item.binding_id}`} value={`${item.source}:${item.binding_id}`}>
        {item.name} ({item.source === 'ha' ? 'HA' : 'Zigbee'})
      </option>)}
    </select>
  </label>;
}

/** Shared physical readings for every spool filed under this storage place. */
export function StorageLocationConditions({ locationId }: { locationId: number }) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const [charting, setCharting] = useState<ZigbeeSensor | null>(null);
  const [haCharting, setHaCharting] = useState<LocationHASensorReading | null>(null);
  const mayRead = hasPermission('smart_sensors:read');
  const { data } = useQuery({
    queryKey: ['zigbee-sensors'], queryFn: api.getZigbeeSensors,
    enabled: mayRead, refetchInterval: 30000,
  });
  const { data: haReadings } = useQuery({
    queryKey: ['locationHaSensorReadings', locationId],
    queryFn: () => api.getLocationHASensorReadings(locationId),
    enabled: mayRead,
    refetchInterval: 120000,
  });
  if (!mayRead) return null;
  const sensors = sensorsForStorage(data?.sensors ?? [], locationId);
  if (sensors.length === 0 && !haReadings?.length) return null;

  return <>
    <span className="inline-flex flex-wrap items-center gap-2">
      {sensors.map((sensor) => <SensorChip key={sensor.id} sensor={sensor}
        onOpen={() => setCharting(sensor)} />)}
      {haReadings?.map(reading => {
        const Icon = iconForHASensor(reading);
        return <button type="button" key={`ha-${reading.id}`} title={reading.entity_id}
          onClick={event => { event.stopPropagation(); setHaCharting(reading); }}
          className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${reading.alerting ? 'bg-red-500/20 text-red-400' : 'bg-bambu-dark-tertiary text-bambu-gray'}`}>
          <Icon className="w-3 h-3" />{reading.name}: {describeHASensorReading(reading, t)}
        </button>;
      })}
    </span>
    {charting && <SensorHistoryModal isOpen sensor={charting} onClose={() => setCharting(null)} />}
    {haCharting && <HASensorHistoryModal source="location" sensorId={haCharting.id} name={haCharting.name} onClose={() => setHaCharting(null)} />}
    {(['temperature', 'humidity', 'battery'] as const).map(category =>
      <PrimarySelector key={category} locationId={locationId} category={category} />)}
  </>;
}
