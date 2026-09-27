import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { storageConditionCandidates, selectStorageCondition, type ConditionCategory } from '../utils/storageCondition';

/** Shared query keys keep one reading per location, regardless of spool count. */
export function useStorageCondition(locationId: number, category: ConditionCategory) {
  const { hasPermission } = useAuth();
  const enabled = hasPermission('smart_sensors:read');
  const { data: zigbee } = useQuery({ queryKey: ['zigbee-sensors'], queryFn: api.getZigbeeSensors,
    enabled, refetchInterval: 30000 });
  const { data: ha = [] } = useQuery({ queryKey: ['locationHaSensorReadings', locationId],
    queryFn: () => api.getLocationHASensorReadings(locationId), enabled, refetchInterval: 120000 });
  const { data: primaries = [] } = useQuery({ queryKey: ['locationSensorPrimary'],
    queryFn: api.getLocationSensorPrimary, enabled });
  const candidates = useMemo(() => storageConditionCandidates(locationId, category, zigbee?.sensors ?? [], ha),
    [locationId, category, zigbee, ha]);
  const primary = primaries.find(row => row.location_id === locationId && row.category === category);
  return { candidates, selected: selectStorageCondition(candidates, primary), primary };
}
