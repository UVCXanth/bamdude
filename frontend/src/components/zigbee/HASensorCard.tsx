import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '../Card';
import { Button } from '../Button';
import { describeHASensorReading, iconForHASensor } from '../../utils/haSensorDisplay';
import type { HABinding, HAGroup } from '../../utils/groupHASensors';

interface Props {
  group: HAGroup;
  printerNames: Map<number, string>;
  locationNames: Map<number, string>;
  canUpdate: boolean;
  canDelete: boolean;
  onEdit: (binding: HABinding) => void;
  onDelete: (binding: HABinding) => void;
  onHistory: (binding: HABinding) => void;
  onAddUse: (group: HAGroup) => void;
  canCreate: boolean;
}

export function HASensorCard({ group, printerNames, locationNames, canUpdate, canDelete,
  onEdit, onDelete, onHistory, onAddUse, canCreate }: Props) {
  const { t } = useTranslation();
  const first = group.bindings[0];
  const sameName = group.bindings.every(binding => binding.config.name === first.config.name);
  const title = sameName ? first.config.name : group.entityId;

  const rows = group.bindings.map(binding => {
    const { config, reading, source } = binding;
    const ownerId = source === 'printer' ? config.printer_id : config.location_id;
    const ownerName = source === 'printer' ? printerNames.get(ownerId) : locationNames.get(ownerId);
    const Icon = iconForHASensor({ kind: config.kind, device_class: config.device_class,
      state: reading?.state ?? config.last_state });
    const displayed = reading ? describeHASensorReading(reading, t) : t('haSensors.unavailable');
    return <div key={`${source}:${config.id}`} className="border-t border-bambu-dark-tertiary py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="min-w-0 text-bambu-gray">
          <span className="text-white">{source === 'printer' ? t('sensorSettings.printer') : t('sensorSettings.storage')}: </span>
          {ownerName ?? `#${ownerId}`}
          {!sameName && <span className="block text-xs">{config.name}</span>}
          {!(source === 'printer' ? config.show_on_printer_card : config.show_on_card) &&
            <span className="ml-2 text-xs">{t('sensorSettings.hiddenOnCard')}</span>}
        </div>
        <span className={reading?.alerting ? 'text-status-error' : 'text-white'}>
          <Icon className="inline h-4 w-4 mr-1" />{displayed}
        </span>
      </div>
      {reading && !reading.fresh && <p className="text-xs text-bambu-gray">{t('sensorSettings.oldReading')}</p>}
      <details className="mt-1 text-xs text-bambu-gray">
        <summary className="cursor-pointer">{t('sensorSettings.details')}</summary>
        <div className="mt-1 space-y-1">
          {config.alert_state && <p>{t('sensorSettings.alertState')}: {config.alert_state}</p>}
          {config.alert_below != null && <p>{t('sensorSettings.below')}: {config.alert_below} {config.unit ?? ''}</p>}
          {config.alert_above != null && <p>{t('sensorSettings.above')}: {config.alert_above} {config.unit ?? ''}</p>}
          <p>{t('sensorSettings.notifications')}: {config.notify_on_alert ? t('sensorSettings.yes') : t('sensorSettings.no')}</p>
          {source === 'printer' && <p>{t('sensorSettings.blocksPrint')}: {config.block_print
            ? t('sensorSettings.yes') : t('sensorSettings.no')}</p>}
        </div>
      </details>
      <div className="mt-1 flex flex-wrap gap-3 text-xs">
        <button type="button" className="text-bambu-green hover:underline" onClick={() => onHistory(binding)}>
          {t('haSensors.history')}
        </button>
        {canUpdate && <button type="button" className="text-bambu-green hover:underline" onClick={() => onEdit(binding)}>
          {t('common.edit')}
        </button>}
        {canDelete && <button type="button" className="text-status-error hover:underline" onClick={() => onDelete(binding)}>
          {t('common.delete')}
        </button>}
      </div>
    </div>;
  });

  return <Card><CardContent>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-white" title={title}>{title}</p>
        {title !== group.entityId && <p className="truncate text-xs text-bambu-gray" title={group.entityId}>{group.entityId}</p>}
      </div>
      <span className="shrink-0 rounded bg-bambu-dark-tertiary px-2 py-0.5 text-xs text-bambu-gray">Home Assistant</span>
    </div>
    <div className="mt-3">
      {rows.length === 1 ? rows[0] :
        <details><summary className="cursor-pointer text-sm text-bambu-gray">
          {t('sensorSettings.uses', { count: rows.length })}
        </summary><div className="mt-2">{rows}</div></details>}
    </div>
    {canCreate && <Button size="sm" variant="secondary" className="mt-3" onClick={() => onAddUse(group)}>
      {t('sensorSettings.addUse')}
    </Button>}
  </CardContent></Card>;
}
