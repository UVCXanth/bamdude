import { useTranslation } from 'react-i18next';
import type { StepPreviewState } from '../api/client';

const BUNDLES = new Set(['installed', 'missing', 'unsupported', 'unknown']);
const CHOICES = new Set(['enabled', 'disabled', 'none']);

/**
 * The STEP component's line on the System page (spec stage C R11): what the receipt says — "installed", never
 * that it works, which only `install/step-preview.sh status` proves — and, on a native install alone, the
 * administrator's choice and the commands that enable and check it. Docker and the Windows installer ship the
 * component themselves, so they get the state only.
 */
export function StepPreviewComponentRow({ state }: { state: StepPreviewState }) {
  const { t } = useTranslation();
  const native = state.install_kind === 'native';
  const choice = CHOICES.has(state.choice) ? state.choice : 'none';
  const bundle = BUNDLES.has(state.bundle)
    ? t(`system.stepPreview.bundle.${state.bundle}`)
    : t('system.stepPreview.bundle.other', { reason: state.bundle });
  const tone =
    state.bundle === 'installed'
      ? 'text-bambu-green'
      : native && choice !== 'enabled'
        ? 'text-bambu-gray'
        : 'text-yellow-400';
  return (
    <div className="mt-4 pt-4 border-t border-bambu-dark-tertiary">
      <p className="font-medium">{t('system.stepPreview.title')}</p>
      <p className={`mt-1 ${tone}`}>{bundle}</p>
      {native && (
        <>
          <p className="text-sm text-bambu-gray mt-2">{t(`system.stepPreview.choice.${choice}`)}</p>
          <p className="text-sm text-bambu-gray mt-2">
            {t('system.stepPreview.enable')} <code>install/step-preview.sh enable</code>
          </p>
          <p className="text-sm text-bambu-gray mt-2">
            {t('system.stepPreview.check')} <code>install/step-preview.sh status</code>
          </p>
        </>
      )}
    </div>
  );
}
