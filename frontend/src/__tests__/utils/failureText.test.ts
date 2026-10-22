import { describe, it, expect } from 'vitest';
import i18n from '../../i18n';
import { failureText } from '../../utils/failureText';

describe('failureText', () => {
  const t = i18n.getFixedT('en');

  it('puts the translated class before the detail', () => {
    expect(failureText(t, 'dispatchUploadFailed', 'The printer would not accept the file transfer.')).toBe(
      'Dispatch: upload failed: The printer would not accept the file transfer.',
    );
  });

  it('reads the class in Ukrainian on a Ukrainian page', () => {
    expect(failureText(i18n.getFixedT('uk'), 'dispatchNoAcknowledgement', null)).toBe('Відправка: немає підтвердження');
  });

  it('keeps a legacy row as it was', () => {
    expect(failureText(t, null, 'Printer not connected')).toBe('Printer not connected');
    expect(failureText(t, 'the belt snapped', null)).toBe('the belt snapped');
    expect(failureText(t, null, null)).toBe('');
  });
});
