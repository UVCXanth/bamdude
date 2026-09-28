import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { api } from '../api/client';
import { parseUTCDate } from '../utils/date';
import { Modal } from './Modal';
import { Select } from './Select';

interface Props {
  sensorId: number;
  source: 'printer' | 'location';
  name: string;
  onClose: () => void;
}

export function HASensorHistoryModal({ sensorId, source, name, onClose }: Props) {
  const { t } = useTranslation();
  const [hours, setHours] = useState(24);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const { data = [], isLoading, error } = useQuery({
    queryKey: ['ha-sensor-history', source, sensorId, hours],
    queryFn: () => source === 'printer' ? api.getHASensorHistory(sensorId, hours) : api.getLocationHASensorHistory(sensorId, hours),
    refetchInterval: 60000,
  });
  const revisions = useMemo(() => [...new Set(data.map(point => point.revision))].sort((a, b) => b - a), [data]);
  const revision = selectedRevision && revisions.includes(selectedRevision) ? selectedRevision : revisions[0];
  const points = data.filter(point => point.revision === revision);
  const last = points.at(-1);
  const formatTime = (value: string) => parseUTCDate(value)?.toLocaleString() ?? value;
  const chartData = points.filter(point => point.value !== null).map(point => ({
    time: formatTime(point.observed_at), value: point.value,
  }));

  return <Modal onClose={onClose} title={`${name} — ${t('haSensors.history')}`} size="2xl">
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap gap-2">
        {[6, 24, 48, 168].map(value => <button key={value} type="button" onClick={() => setHours(value)}
          className={`rounded px-3 py-1 text-sm ${hours === value ? 'bg-bambu-green text-black' : 'bg-bambu-dark-tertiary text-white'}`}>
          {value < 48 ? `${value}h` : `${value / 24}d`}
        </button>)}
        {revisions.length > 1 && <Select aria-label={t('haSensors.historyRevision')} value={revision}
          onChange={event => setSelectedRevision(Number(event.target.value))}
          size="sm" tone="raised">
          {revisions.map(value => <option value={value} key={value}>{t('haSensors.historyRevision')} {value}</option>)}
        </Select>}
      </div>
      {isLoading ? <p className="text-bambu-gray">{t('common.loading')}</p> : error ?
        <p className="text-red-400">{error.message}</p> : points.length === 0 ?
        <p className="text-bambu-gray">{t('haSensors.historyEmpty')}</p> : <>
          <p className="text-xs text-bambu-gray">{last?.entity_id} · {last?.unit ?? t('haSensors.historyUnitless')}</p>
          {last?.kind === 'numeric' && chartData.length > 0 ?
            <div className="h-60" role="img" aria-label={t('haSensors.history')}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}><CartesianGrid stroke="#555" strokeDasharray="3 3" />
                  <XAxis dataKey="time" tick={{ fontSize: 10 }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip /><Line type="monotone" dataKey="value" stroke="#00ae8e" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div> : null}
          <div className="max-h-56 overflow-y-auto space-y-1" aria-label={t('haSensors.history')}>
            {points.slice().reverse().map(point => <div key={point.id} className="flex justify-between gap-4 border-b border-bambu-dark-tertiary py-1 text-xs text-bambu-gray">
              <time>{formatTime(point.observed_at)}</time><span className="text-white">{point.state} {point.unit ?? ''}</span>
            </div>)}
          </div>
        </>}
    </div>
  </Modal>;
}
