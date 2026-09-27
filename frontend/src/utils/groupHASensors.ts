import type {
  LocationHASensor, LocationHASensorManagementReading, PrinterHASensor,
  PrinterHASensorManagementReading,
} from '../api/client';

export type HABinding =
  | { source: 'printer'; config: PrinterHASensor; reading?: PrinterHASensorManagementReading }
  | { source: 'location'; config: LocationHASensor; reading?: LocationHASensorManagementReading };

export interface HAGroup {
  entityId: string;
  bindings: HABinding[];
}

export function groupHASensors(printers: PrinterHASensor[], locations: LocationHASensor[]): HAGroup[] {
  const groups = new Map<string, HAGroup>();
  const add = (binding: HABinding) => {
    const entityId = binding.config.entity_id;
    const group = groups.get(entityId) ?? { entityId, bindings: [] };
    group.bindings.push(binding);
    groups.set(entityId, group);
  };
  printers.forEach(config => add({ source: 'printer', config }));
  locations.forEach(config => add({ source: 'location', config }));
  return [...groups.values()].sort((a, b) => a.entityId.localeCompare(b.entityId));
}
