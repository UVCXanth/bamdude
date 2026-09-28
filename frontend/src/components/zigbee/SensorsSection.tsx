import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Settings2, Thermometer } from 'lucide-react';

import { api } from '../../api/client';
import type { HADisplayEntity, LocationHASensor, PrinterHASensor, ZigbeeDevice, ZigbeeSensor } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { invalidateSensorViews } from '../../utils/sensorQueryInvalidation';
import { Button } from '../Button';
import { Select } from '../Select';
import { Card, CardContent, CardHeader } from '../Card';
import { ConfirmModal } from '../ConfirmModal';
import { Modal } from '../Modal';
import { HASensorHistoryModal } from '../HASensorHistoryModal';
import { HASensorModal } from '../HASensorModal';
import { LocationHASensorModal } from '../LocationHASensorModal';
import { LocationSensorOptionsModal } from '../LocationSensorOptionsModal';
import { DeviceReportingModal } from './DeviceReportingModal';
import { HASensorCard } from './HASensorCard';
import { groupHASensors } from '../../utils/groupHASensors';
import type { HAGroup, HABinding } from '../../utils/groupHASensors';
import { SensorCard } from './SensorCard';
import { SensorFormModal } from './SensorFormModal';
import { SensorHistoryModal } from './SensorHistoryModal';
import { SensorThresholdsModal } from './SensorThresholdsModal';

interface Props {
  adoptDevice: ZigbeeDevice | null;
  onAdoptHandled: () => void;
}

export function SensorsSection({ adoptDevice, onAdoptHandled }: Props) {
  const { t } = useTranslation();
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const mayRead = hasPermission('smart_sensors:read');
  const canCreate = hasPermission('smart_sensors:create');
  const canUpdate = hasPermission('smart_sensors:update');
  const canDelete = hasPermission('smart_sensors:delete');

  const [editing, setEditing] = useState<ZigbeeSensor | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [unbinding, setUnbinding] = useState<ZigbeeSensor | null>(null);
  const [configuring, setConfiguring] = useState<ZigbeeSensor | null>(null);
  const [charting, setCharting] = useState<ZigbeeSensor | null>(null);
  const [thresholding, setThresholding] = useState<ZigbeeSensor | null>(null);
  const [addChoice, setAddChoice] = useState<'source' | 'ha-target' | null>(null);
  const [initialEntity, setInitialEntity] = useState<HADisplayEntity | undefined>();
  const [printerEditor, setPrinterEditor] = useState<PrinterHASensor | true | null>(null);
  const [locationEditor, setLocationEditor] = useState<LocationHASensor | true | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [haHistory, setHaHistory] = useState<{ source: 'printer' | 'location'; id: number; name: string } | null>(null);
  const [haDeleting, setHaDeleting] = useState<HABinding | null>(null);
  const [sourceFilter, setSourceFilter] = useState<'all' | 'zigbee' | 'ha'>('all');
  const [targetFilter, setTargetFilter] = useState<'all' | 'printer' | 'storage' | 'room'>('all');

  const { data: status } = useQuery({ queryKey: ['zigbee-status'], queryFn: api.getZigbeeStatus,
    enabled: mayRead && hasPermission('smart_plugs:read') });
  const zigbee = useQuery({ queryKey: ['zigbee-sensors'], queryFn: api.getZigbeeSensors,
    refetchInterval: 30000, enabled: mayRead });
  const printerSensors = useQuery({ queryKey: ['haSensors'], queryFn: () => api.getHASensors(), enabled: mayRead });
  const locationSensors = useQuery({ queryKey: ['locationHaSensors'], queryFn: () => api.getLocationHASensors(), enabled: mayRead });
  const printerReadings = useQuery({ queryKey: ['haSensorManagementReadings'],
    queryFn: api.getHASensorManagementReadings, refetchInterval: 30000, enabled: mayRead });
  const locationReadings = useQuery({ queryKey: ['locationHaSensorManagementReadings'],
    queryFn: api.getLocationHASensorManagementReadings, refetchInterval: 30000, enabled: mayRead });
  const printers = useQuery({ queryKey: ['printers'], queryFn: api.getPrinters,
    enabled: mayRead && hasPermission('printers:read') });
  const locations = useQuery({ queryKey: ['inventory-locations'], queryFn: api.getLocations,
    enabled: mayRead && hasPermission('inventory:read') });

  useEffect(() => {
    if (!mayRead) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void queryClient.invalidateQueries({ queryKey: ['zigbee-sensors'] });
        void queryClient.invalidateQueries({ queryKey: ['haSensorManagementReadings'] });
        void queryClient.invalidateQueries({ queryKey: ['locationHaSensorManagementReadings'] });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [mayRead, queryClient]);

  const unbind = useMutation({ mutationFn: (id: number) => api.deleteZigbeeSensor(id), onSuccess: () => {
    invalidateSensorViews(queryClient);
    queryClient.invalidateQueries({ queryKey: ['zigbee-devices'] });
    setUnbinding(null);
  } });
  const deleteHA = useMutation({ mutationFn: (binding: HABinding) => binding.source === 'printer'
    ? api.deleteHASensor(binding.config.id) : api.deleteLocationHASensor(binding.config.id),
    onSuccess: () => {
      invalidateSensorViews(queryClient);
      setHaDeleting(null);
    },
  });

  if (!mayRead) return null;

  const sensors = zigbee.data?.sensors ?? [];
  const haConfigured = printerReadings.data?.configured ?? locationReadings.data?.configured;
  const printerReadingById = new Map(printerReadings.data?.readings.map(row => [row.id, row]));
  const locationReadingById = new Map(locationReadings.data?.readings.map(row => [row.id, row]));
  const groups = groupHASensors(printerSensors.data ?? [], locationSensors.data ?? []).map(group => ({
    ...group,
    bindings: group.bindings.map(binding => binding.source === 'printer'
      ? { ...binding, reading: printerReadingById.get(binding.config.id) }
      : { ...binding, reading: locationReadingById.get(binding.config.id) }),
  }));
  const shownZigbee = sourceFilter === 'ha' ? [] : sensors.filter(sensor => {
    if (targetFilter === 'all') return true;
    const bindings = sensor.bindings ?? [];
    if (targetFilter === 'printer') return bindings.some(binding => binding.printer_id != null) ||
      (bindings.length === 0 && sensor.printer_id != null);
    if (targetFilter === 'storage') return bindings.some(binding => binding.storage_location_id != null);
    return bindings.some(binding => binding.printer_location_id != null) ||
      (bindings.length === 0 && sensor.location != null);
  });
  const shownGroups = sourceFilter === 'zigbee' || targetFilter === 'room' ? [] : groups
    .map(group => ({ ...group, bindings: group.bindings.filter(binding => targetFilter === 'all' ||
      binding.source === (targetFilter === 'printer' ? 'printer' : 'location')) }))
    .filter(group => group.bindings.length > 0);
  const printerNames = new Map(printers.data?.map(row => [row.id, row.name]));
  const locationNames = new Map(locations.data?.map(row => [row.id, row.name]));
  const allLoaded = zigbee.isSuccess && printerSensors.isSuccess && locationSensors.isSuccess &&
    printerReadings.isSuccess && locationReadings.isSuccess;
  const anyError = zigbee.isError || printerSensors.isError || locationSensors.isError ||
    printerReadings.isError || locationReadings.isError;

  const addUse = (group: HAGroup) => {
    const first = group.bindings[0].config;
    setInitialEntity({ entity_id: first.entity_id, friendly_name: first.name, state: null,
      domain: first.kind === 'binary' ? 'binary_sensor' : 'sensor',
      device_class: first.device_class, unit_of_measurement: first.unit });
    setAddChoice('ha-target');
  };
  const closeHA = () => { setPrinterEditor(null); setLocationEditor(null); setInitialEntity(undefined); };

  return <Card className="mb-4">
    <CardHeader><div className="flex items-center justify-between gap-3">
      <h3 className="text-base font-semibold text-white flex items-center gap-2">
        <Thermometer className="w-4 h-4 text-bambu-green" />{t('settings.zigbee.sensors.title')}
      </h3>
      <div className="flex gap-2">
        {hasPermission('settings:read') &&
          <Button size="sm" variant="secondary" onClick={() => setOptionsOpen(true)}
            aria-label={t('sensorSettings.storageOptions')} title={t('sensorSettings.storageOptions')}>
            <Settings2 className="w-4 h-4" /><span className="hidden sm:inline">{t('sensorSettings.storageOptions')}</span>
          </Button>}
        {canCreate && <Button size="sm" onClick={() => setAddChoice('source')}>
          {t('settings.zigbee.sensors.add')}
        </Button>}
      </div>
    </div></CardHeader>
    <CardContent>
      {status && status.state !== 'up' && sensors.length > 0 &&
        <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">{t('settings.zigbee.sensors.radioDown')}</p>}
      {anyError && <div className="mb-3 text-sm text-status-error" role="alert">
        {t('sensorSettings.loadFailed')} <Button size="sm" variant="secondary" onClick={() => {
          if (zigbee.isError) void zigbee.refetch();
          if (printerSensors.isError) void printerSensors.refetch();
          if (locationSensors.isError) void locationSensors.refetch();
          if (printerReadings.isError) void printerReadings.refetch();
          if (locationReadings.isError) void locationReadings.refetch();
        }}>{t('sensorSettings.retry')}</Button>
      </div>}
      {!allLoaded && !anyError && <p className="text-sm text-bambu-gray">{t('common.loading')}</p>}
      {allLoaded && sensors.length === 0 && groups.length === 0 &&
        <p className="text-sm text-bambu-gray">{t('sensorSettings.empty')}</p>}
      {(sensors.length > 0 || groups.length > 0) &&
        <div className="mb-3 flex flex-wrap gap-2">
          <Select aria-label={t('sensorSettings.sourceFilter')} value={sourceFilter}
            onChange={event => setSourceFilter(event.target.value as typeof sourceFilter)}
            size="sm" tone="raised">
            <option value="all">{t('sensorSettings.allSources')}</option>
            <option value="zigbee">Zigbee</option>
            <option value="ha">Home Assistant</option>
          </Select>
          <Select aria-label={t('sensorSettings.targetFilter')} value={targetFilter}
            onChange={event => setTargetFilter(event.target.value as typeof targetFilter)}
            size="sm" tone="raised">
            <option value="all">{t('sensorSettings.allTargets')}</option>
            <option value="printer">{t('sensorSettings.printer')}</option>
            <option value="storage">{t('sensorSettings.storage')}</option>
            <option value="room">{t('sensorSettings.room')}</option>
          </Select>
        </div>}
      {(sensors.length > 0 || groups.length > 0) &&
        shownZigbee.length === 0 && shownGroups.length === 0 &&
        <p className="mb-3 text-sm text-bambu-gray">{t('sensorSettings.noMatches')}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {shownZigbee.map(sensor => <SensorCard key={`zigbee:${sensor.id}`} sensor={sensor}
          onEdit={setEditing} onUnbind={setUnbinding} onConfigure={setConfiguring}
          onChart={setCharting} onThresholds={setThresholding}
          canEdit={canUpdate} canDelete={canDelete}
          canConfigure={hasPermission('smart_plugs:update')} />)}
        {shownGroups.map(group => <HASensorCard key={`ha:${group.entityId}`} group={group}
          printerNames={printerNames} locationNames={locationNames} canUpdate={canUpdate}
          canDelete={canDelete} canCreate={canCreate}
          onEdit={binding => binding.source === 'printer'
            ? setPrinterEditor(binding.config) : setLocationEditor(binding.config)}
          onDelete={setHaDeleting}
          onHistory={binding => setHaHistory({ source: binding.source,
            id: binding.config.id, name: binding.config.name })}
          onAddUse={addUse} />)}
      </div>
    </CardContent>

    {addChoice && <Modal onClose={() => setAddChoice(null)} title={t('settings.zigbee.sensors.add')} size="sm">
      <div className="space-y-3 p-4">
        {addChoice === 'source' ? <>
          <Button className="w-full" disabled={!!status && status.state !== 'up'} onClick={() => {
            setAddChoice(null); setAdopting(true);
          }}>{t('sensorSettings.zigbee')}</Button>
          {status && status.state !== 'up' &&
            <p className="text-xs text-bambu-gray">{t('sensorSettings.zigbeeUnavailable')}</p>}
          <Button className="w-full" variant="secondary" onClick={() => setAddChoice('ha-target')}>
            Home Assistant
          </Button>
        </> : <>
          {haConfigured === false && <p className="text-sm text-bambu-gray">{t('sensorSettings.haNotConfigured')}</p>}
          {haConfigured === undefined && <p className="text-sm text-bambu-gray">{t('sensorSettings.loadFailed')}</p>}
          <Button className="w-full" disabled={haConfigured !== true || !hasPermission('printers:read')}
            onClick={() => { setAddChoice(null); setPrinterEditor(true); }}>
            {t('sensorSettings.printer')}
          </Button>
          <Button className="w-full" variant="secondary"
            disabled={haConfigured !== true || !hasPermission('inventory:read') ||
              !!(initialEntity && !['temperature', 'humidity', 'battery'].includes(initialEntity.device_class ?? ''))}
            onClick={() => { setAddChoice(null); setLocationEditor(true); }}>
            {t('sensorSettings.storage')}
          </Button>
        </>}
      </div>
    </Modal>}
    {(adopting || adoptDevice) && <SensorFormModal sensor={null} initialDevice={adoptDevice}
      onClose={() => { setAdopting(false); onAdoptHandled(); }} />}
    {editing && <SensorFormModal sensor={editing} initialDevice={null} onClose={() => setEditing(null)} />}
    {charting && <SensorHistoryModal isOpen onClose={() => setCharting(null)} sensor={charting} />}
    {thresholding && <SensorThresholdsModal isOpen onClose={() => setThresholding(null)} sensor={thresholding} />}
    {configuring && <DeviceReportingModal ieee={configuring.ieee} deviceName={configuring.name}
      onClose={() => setConfiguring(null)} />}
    {unbinding && <ConfirmModal title={t('settings.zigbee.sensors.unbindTitle', { name: unbinding.name })}
      message={t('settings.zigbee.sensors.unbindBody')}
      confirmText={t('settings.zigbee.sensors.unbindConfirm')} variant="danger"
      onConfirm={() => unbind.mutate(unbinding.id)} onCancel={() => setUnbinding(null)} />}
    {printerEditor && <HASensorModal sensor={printerEditor === true ? null : printerEditor}
      printers={printers.data ?? []} initialEntity={printerEditor === true ? initialEntity : undefined}
      configured={haConfigured} onClose={closeHA} />}
    {locationEditor && <LocationHASensorModal sensor={locationEditor === true ? null : locationEditor}
      locations={locations.data ?? []} initialEntity={locationEditor === true ? initialEntity : undefined}
      configured={haConfigured} onClose={closeHA} />}
    {optionsOpen && <LocationSensorOptionsModal onClose={() => setOptionsOpen(false)} />}
    {haHistory && <HASensorHistoryModal sensorId={haHistory.id} source={haHistory.source}
      name={haHistory.name} onClose={() => setHaHistory(null)} />}
    {deleteHA.isError && <p role="alert" className="px-4 text-sm text-status-error">{deleteHA.error.message}</p>}
    {haDeleting && <ConfirmModal title={t('sensorSettings.deleteTitle', { name: haDeleting.config.name })}
      message={t('sensorSettings.deleteBody')} confirmText={t('common.delete')} variant="danger"
      onConfirm={() => deleteHA.mutate(haDeleting)} onCancel={() => setHaDeleting(null)} />}
  </Card>;
}
