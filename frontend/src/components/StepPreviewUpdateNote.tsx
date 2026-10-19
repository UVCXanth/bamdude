import { useTranslation } from 'react-i18next';

/**
 * The STEP component's own result of an in-app update (spec stage C R4): nothing when it was refreshed or never
 * enabled; otherwise its closed reason and the command that checks it — the System page's cheap status would still
 * say "Installed" for a component this update could not refresh.
 */
export function StepPreviewUpdateNote({ code }: { code?: string | null }) {
  const { t } = useTranslation();
  if (!code || code === 'ok' || code === 'skipped') return null;
  return (
    <div className="mt-2 p-2 bg-yellow-500/10 rounded text-sm text-yellow-700 dark:text-yellow-400">
      <p>{t('settings.stepPreviewNotUpdated', { reason: code })}</p>
      <p className="mt-1">
        {t('system.stepPreview.check')} <code>install/step-preview.sh status</code>
      </p>
    </div>
  );
}
