import { describe, expect, it } from 'vitest';
import type { LocationHASensorReading, ZigbeeSensor } from '../../api/client';
import { selectStorageCondition, storageConditionCandidates } from '../../utils/storageCondition';

describe('mixed storage sensor selection', () => {
  it('requires an explicit source when HA and Zigbee binding IDs overlap', () => {
    const ha = [{ id: 7, name: 'HA humidity', device_class: 'humidity', show_on_card: true,
      value: 48, unit: '%', reachable: true }] as LocationHASensorReading[];
    const zigbee = [{ id: 2, name: 'Zigbee humidity', present: true, unreachable: false,
      measurements: { humidity: { value: 49, unit: '%', stale: false } },
      bindings: [{ id: 7, storage_location_id: 3, visible: true, display_name: null }],
    }] as unknown as ZigbeeSensor[];
    const candidates = storageConditionCandidates(3, 'humidity', zigbee, ha);
    expect(candidates).toHaveLength(2);
    expect(selectStorageCondition(candidates, undefined)).toBeNull();
    expect(selectStorageCondition(candidates, { location_id: 3, category: 'humidity', source: 'zigbee', binding_id: 7 })?.value).toBe(49);
    expect(selectStorageCondition(candidates, { location_id: 3, category: 'humidity', source: 'ha', binding_id: 7 })?.value).toBe(48);
  });

  it('does not turn stale physical readings into a fresh value', () => {
    const zigbee = [{ id: 2, name: 'Old', present: true, unreachable: false,
      measurements: { temperature: { value: 24, unit: '°C', stale: true } },
      bindings: [{ id: 8, storage_location_id: 3, visible: true, display_name: null }],
    }] as unknown as ZigbeeSensor[];
    const candidates = storageConditionCandidates(3, 'temperature', zigbee, []);
    expect(selectStorageCondition(candidates, undefined)).toMatchObject({ value: null, reachable: false });
  });
});
