import type { QueryClient } from '@tanstack/react-query';

/** Configuration, live cards, and storage conditions share these sensor writes. */
export function invalidateSensorViews(queryClient: QueryClient) {
  for (const key of [
    'zigbee-sensors', 'haSensors', 'locationHaSensors',
    'haSensorManagementReadings', 'locationHaSensorManagementReadings',
    'haSensorReadings', 'locationHaSensorReadings',
    'ha-sensor-history', 'location-ha-sensor-history',
    'locationSensorPrimary', 'inventory-locations',
    'inventory-spools', 'spoolman-inventory-spools',
  ]) {
    void queryClient.invalidateQueries({ queryKey: [key] });
  }
}
