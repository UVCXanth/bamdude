/**
 * A print whose owed table swap was held says so on the print itself (swap-source-lifecycle spec r4 R2-6): the
 * queue's hold may have no next job to carry the reason. The server records codes; the sentence is composed
 * here, in the reader's language, and says whether our swap cycle had begun.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import i18n from '../../i18n';
import { render } from '../utils';
import { SwapHoldBadge } from '../../components/SwapHoldBadge';
import { swapHoldText } from '../../utils/swapHold';

const t = (key: string) => i18n.t(key);

describe('the swap hold of a print', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it.each([
    ['started', 'The table-swap cycle started but did not finish. Inspect the mechanism and plate before resuming.'],
    [
      'possibly_started',
      'The table-swap cycle may have started, but completion is unconfirmed. Inspect the mechanism and plate before resuming.',
    ],
  ])('says the cycle %s', (cycle, text) => {
    expect(swapHoldText(t, { swap_hold: { reason: 'swap_hold_source_unknown', cycle } })).toBe(text);
  });

  it('gives the reason, and claims no cycle, when ours never started', () => {
    const text = swapHoldText(t, { swap_hold: { reason: 'swap_hold_source_unknown', cycle: 'not_started' } });
    expect(text).toMatch(/does not say whether it carries its own plate-swap sequence/);
    expect(text).not.toMatch(/started/);
  });

  it('says a macro that errored did not finish the swap', () => {
    expect(swapHoldText(t, { swap_hold: { reason: 'swap_hold_macro_error', cycle: 'not_started' } })).toBe(
      "The table swap did not finish: BamDude could not run the printer's change-table macro. Inspect the mechanism and plate, then resume the queue.",
    );
  });

  it('has every sentence in Ukrainian too', async () => {
    await i18n.changeLanguage('uk');
    expect(swapHoldText(t, { swap_hold: { reason: 'swap_hold_source_unknown', cycle: 'started' } })).toBe(
      'Зміну столу розпочато, але не завершено. Огляньте установку й стіл перед продовженням.',
    );
    for (const reason of [
      'swap_hold_source_unknown',
      'swap_hold_source_baked',
      'swap_hold_run_unproven',
      'swap_hold_not_completed',
      'swap_hold_swap_off',
      'swap_hold_outcome_uncertain',
      'swap_hold_macro_error',
      'swap_hold_farm_recovery',
      'swap_hold_attempt_unknown',
    ]) {
      const text = swapHoldText(t, { swap_hold: { reason, cycle: 'not_started' } });
      expect(text).not.toContain('archives.');
      expect(text).toMatch(/[А-Яа-яІіЇїЄєҐґ]/);
    }
  });

  it('shows nothing without a recorded hold, or with one that is not ours', () => {
    expect(swapHoldText(t, null)).toBeNull();
    expect(swapHoldText(t, { keep: 1 })).toBeNull();
    expect(swapHoldText(t, { swap_hold: { reason: 'drop_table', cycle: 'not_started' } })).toBeNull();
    expect(swapHoldText(t, { swap_hold: 'started' })).toBeNull();
  });

  it('renders a badge whose title is the sentence', () => {
    render(<SwapHoldBadge extraData={{ swap_hold: { reason: 'swap_hold_run_unproven', cycle: 'not_started' } }} />);
    const badge = screen.getByText('Swap held');
    expect(badge.closest('span')?.getAttribute('title')).toMatch(/could not be tied to the print BamDude started/);
  });
});
