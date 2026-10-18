/**
 * The STEP component's row on the System page (spec stage C R11; plan Task 8): what the receipt says —
 * "installed", never "works" — and, on a native install, the administrator's commands to enable and check it.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import { StepPreviewComponentRow } from '../../components/StepPreviewComponentRow';

function show(state: { choice: string; bundle: string; install_kind: string }) {
  return render(
    <I18nextProvider i18n={i18n}>
      <StepPreviewComponentRow state={state} />
    </I18nextProvider>,
  );
}

describe('StepPreviewComponentRow', () => {
  it('tells a native install it is disabled and how to enable and check it', () => {
    show({ choice: 'disabled', bundle: 'missing', install_kind: 'native' });
    expect(screen.getByText(i18n.t('system.stepPreview.choice.disabled'))).toBeInTheDocument();
    expect(screen.getByText('install/step-preview.sh enable')).toBeInTheDocument();
    expect(screen.getByText('install/step-preview.sh status')).toBeInTheDocument();
  });

  it('says installed, never that it works', () => {
    const { container } = show({ choice: 'enabled', bundle: 'installed', install_kind: 'native' });
    expect(screen.getByText(i18n.t('system.stepPreview.bundle.installed'))).toBeInTheDocument();
    expect(container.textContent?.toLowerCase()).not.toContain('works');
  });

  it('gives a docker install the state alone', () => {
    show({ choice: 'none', bundle: 'installed', install_kind: 'docker' });
    expect(screen.getByText(i18n.t('system.stepPreview.bundle.installed'))).toBeInTheDocument();
    expect(screen.queryByText('install/step-preview.sh enable')).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t('system.stepPreview.choice.none'))).not.toBeInTheDocument();
  });

  it('names a closed reason it has no sentence for', () => {
    show({ choice: 'enabled', bundle: 'receipt_mismatch', install_kind: 'native' });
    expect(screen.getByText(i18n.t('system.stepPreview.bundle.other', { reason: 'receipt_mismatch' }))).toBeInTheDocument();
  });
});
