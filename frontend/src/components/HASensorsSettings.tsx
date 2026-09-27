import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gauge, Plus, Settings2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, type LocationHASensor, type PrinterHASensor } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { Button } from './Button';
import { HASensorModal } from './HASensorModal';
import { LocationHASensorModal } from './LocationHASensorModal';
import { LocationSensorOptionsModal } from './LocationSensorOptionsModal';

/** HA bindings live beside Zigbee adoption, but remain independent targets. */
export function HASensorsSettings() {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const canRead = hasPermission('smart_sensors:read');
  const canCreate = hasPermission('smart_sensors:create');
  const canUpdate = hasPermission('smart_sensors:update');
  const { data: printers = [] } = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters, enabled: canRead });
  const { data: locations = [] } = useQuery({ queryKey: ['inventory-locations'], queryFn: api.getLocations, enabled: canRead });
  const { data: printerSensors = [] } = useQuery({ queryKey: ['haSensors'], queryFn: () => api.getHASensors(), enabled: canRead });
  const { data: locationSensors = [] } = useQuery({ queryKey: ['locationHaSensors'], queryFn: () => api.getLocationHASensors(), enabled: canRead });
  const [printerEditor, setPrinterEditor] = useState<PrinterHASensor | true | null>(null);
  const [locationEditor, setLocationEditor] = useState<LocationHASensor | true | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  if (!canRead) return null;

  return <div className="space-y-4">
    <section className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="flex items-center gap-2 text-white font-semibold"><Gauge className="w-4 h-4" />{t('haSensors.label')}</h3>
        {canCreate && <Button size="sm" onClick={() => setPrinterEditor(true)}><Plus className="w-4 h-4" />{t('haSensors.addTitle')}</Button>}
      </div>
      {printerSensors.length === 0 ? <p className="text-sm text-bambu-gray">{t('haSensors.noEntities')}</p> :
        <div className="space-y-1">{printerSensors.map(sensor => <button key={sensor.id} type="button"
          disabled={!canUpdate} onClick={() => setPrinterEditor(sensor)}
          className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm text-white hover:bg-bambu-dark-tertiary disabled:cursor-default">
          <span>{sensor.name} <span className="text-bambu-gray">({printers.find(p => p.id === sensor.printer_id)?.name ?? sensor.printer_id})</span></span>
          <span className="text-xs text-bambu-gray">{sensor.entity_id}</span>
        </button>)}</div>}
    </section>
    <section className="rounded-lg border border-bambu-dark-tertiary bg-bambu-dark-secondary p-4">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="flex items-center gap-2 text-white font-semibold"><Gauge className="w-4 h-4" />{t('locationHaSensors.addTitle')}</h3>
        <div className="flex gap-2">
          {canUpdate && <Button size="sm" variant="secondary" onClick={() => setOptionsOpen(true)}><Settings2 className="w-4 h-4" />{t('locationHaSensors.options.title')}</Button>}
          {canCreate && <Button size="sm" onClick={() => setLocationEditor(true)}><Plus className="w-4 h-4" />{t('locationHaSensors.addTitle')}</Button>}
        </div>
      </div>
      {locationSensors.length === 0 ? <p className="text-sm text-bambu-gray">{t('haSensors.noEntities')}</p> :
        <div className="space-y-1">{locationSensors.map(sensor => <button key={sensor.id} type="button"
          disabled={!canUpdate} onClick={() => setLocationEditor(sensor)}
          className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm text-white hover:bg-bambu-dark-tertiary disabled:cursor-default">
          <span>{sensor.name} <span className="text-bambu-gray">({locations.find(l => l.id === sensor.location_id)?.name ?? sensor.location_id})</span></span>
          <span className="text-xs text-bambu-gray">{sensor.entity_id}</span>
        </button>)}</div>}
    </section>
    {printerEditor && <HASensorModal sensor={printerEditor === true ? null : printerEditor} printers={printers} onClose={() => setPrinterEditor(null)} />}
    {locationEditor && <LocationHASensorModal sensor={locationEditor === true ? null : locationEditor} locations={locations} onClose={() => setLocationEditor(null)} />}
    {optionsOpen && <LocationSensorOptionsModal onClose={() => setOptionsOpen(false)} />}
  </div>;
}
