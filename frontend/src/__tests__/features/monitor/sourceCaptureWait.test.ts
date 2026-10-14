/**
 * A queued job whose source copy found the queue busy waits by itself and retries in a minute
 * (swap-source-lifecycle spec r4 §6, R2-4). The monitor shows it as an ordinary wait under its own
 * label, in both languages — not as a failure, and not as a raw code.
 */

import { describe, expect, it, afterEach } from 'vitest';
import i18n from '../../../i18n';
import { monitorPrinter } from '../../../features/monitor/fixtures';
import { tileState } from '../../../features/monitor/state';

describe('the source_capture wait', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('is a wait, not an alarm', () => {
    const p = monitorPrinter({ state: 'IDLE' });
    p.queue!.waiting = { code: 'source_capture', since: '2026-10-14T10:00:00Z', until: null };
    expect(tileState(p, 'queues')).toMatchObject({ kind: 'waiting', tone: 'info', attention: false });
  });

  it.each([
    ['en', 'Waiting to copy the source'],
    ['uk', 'Очікує копіювання джерела'],
  ])('has its own label in %s', async (lang, label) => {
    await i18n.changeLanguage(lang);
    expect(i18n.t('monitor.waits.source_capture')).toBe(label);
  });
});
