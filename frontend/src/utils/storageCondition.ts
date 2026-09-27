import type { LocationHASensorReading, LocationSensorPrimary, ZigbeeSensor } from '../api/client';

export type ConditionCategory = 'temperature' | 'humidity' | 'battery';
export interface ConditionCandidate {
  source: 'ha' | 'zigbee';
  binding_id: number;
  name: string;
  value: number | null;
  unit: string | null;
  reachable: boolean;
}

export function storageConditionCandidates(
  locationId: number, category: ConditionCategory, zigbee: ZigbeeSensor[], ha: LocationHASensorReading[],
): ConditionCandidate[] {
  const candidates: ConditionCandidate[] = [];
  for (const reading of ha) {
    if (reading.device_class === category && reading.show_on_card) {
      candidates.push({ source: 'ha', binding_id: reading.id, name: reading.name, value: reading.value,
        unit: reading.unit, reachable: reading.reachable });
    }
  }
  for (const sensor of zigbee) {
    const measurement = sensor.measurements[category];
    if (!measurement) continue;
    for (const binding of sensor.bindings ?? []) {
      if (binding.storage_location_id === locationId && binding.visible) {
        candidates.push({ source: 'zigbee', binding_id: binding.id,
          name: binding.display_name || sensor.name, value: measurement.stale ? null : measurement.value,
          unit: measurement.unit, reachable: sensor.present && !sensor.unreachable && !measurement.stale });
      }
    }
  }
  return candidates;
}

export function selectStorageCondition(candidates: ConditionCandidate[], primary: LocationSensorPrimary | undefined) {
  if (primary) return candidates.find(item => item.source === primary.source && item.binding_id === primary.binding_id) ?? null;
  return candidates.length === 1 ? candidates[0] : null;
}
