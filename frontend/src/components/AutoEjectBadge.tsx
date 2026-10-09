import { useTranslation } from 'react-i18next';

export function AutoEjectBadge({ mode }: { mode?: unknown }) {
  const { t } = useTranslation();
  return mode === true ? <span className="inline-flex rounded bg-bambu-green/10 px-1.5 py-0.5 text-xs text-bambu-green"
    title={t('autoEject.requirements')}>{t('autoEject.badge')}</span> : null;
}
