import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { modelCompatibility } from '../utils/modelCompatibility';

export function ModelCompatChip({ fileModel, targetModel }: {
  fileModel?: string | null;
  targetModel?: string | null;
}) {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['modelCompatibility'], queryFn: api.getModelCompatibility, staleTime: 60 * 60 * 1000,
  });
  const verdict = modelCompatibility(fileModel, targetModel, data?.models);
  if (verdict === 'exact' || !fileModel || !targetModel) return null;
  const label = verdict === 'compatible' ? '≈' : verdict === 'incompatible' ? '!' : '?';
  const title = t(`modelCompatibility.${verdict}`, { fileModel, targetModel });
  return <span
    title={title}
    aria-label={title}
    className={`text-[10px] px-1 rounded border ${verdict === 'compatible'
      ? 'text-amber-300 border-amber-400/40'
      : verdict === 'incompatible' ? 'text-red-400 border-red-400/40' : 'text-bambu-gray border-bambu-gray/40'}`}
  >{label}</span>;
}
