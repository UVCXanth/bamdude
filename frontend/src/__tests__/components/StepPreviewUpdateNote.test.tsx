/**
 * After an in-app update, the STEP component's own result (spec stage C R4): a component that was refreshed, or
 * was never enabled, says nothing; one that could not be refreshed names its closed reason and how to check it,
 * because the System page's cheap status would still say "Installed".
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18n from '../../i18n';
import { StepPreviewUpdateNote } from '../../components/StepPreviewUpdateNote';

function show(code: string | undefined) {
  return render(
    <I18nextProvider i18n={i18n}>
      <StepPreviewUpdateNote code={code} />
    </I18nextProvider>,
  );
}

describe('StepPreviewUpdateNote', () => {
  it.each(['ok', 'skipped', undefined])('says nothing for %s', (code) => {
    const { container } = show(code);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['pip_failed', 'helper_unproven', 'timeout'])('names %s and the check', (code) => {
    show(code);
    expect(screen.getByText(i18n.t('settings.stepPreviewNotUpdated', { reason: code }))).toBeInTheDocument();
    expect(screen.getByText('install/step-preview.sh status')).toBeInTheDocument();
  });
});
