import { describe, it, expect } from 'vitest';
import i18n from '../../../i18n';
import type { TimelineEvent } from '../../../api/client';
import { journalText } from '../../../components/projects/orderJournal';

const t = i18n.t.bind(i18n);
const event = (event_type: string, metadata: Record<string, unknown>) =>
  ({ event_type, timestamp: '2026-09-27T10:00:00Z', title: '', description: null, metadata }) as TimelineEvent;

describe('the order journal · stock of a line', () => {
  it('says how many ready units and kits a new line took from stock', () => {
    expect(
      journalText(event('line_added', { product: 'Pipe', quantity: 6, from_finished: 2, from_stock: 3 }), t),
    ).toBe('Line added: Pipe × 6, 2 ready from stock, 3 kits from stock');
  });

  it('says nothing about stock when a line took none', () => {
    expect(journalText(event('line_added', { product: 'Pipe', quantity: 6, from_finished: 0, from_stock: 0 }), t)).toBe(
      'Line added: Pipe × 6',
    );
  });

  it('reads in Ukrainian as the spec words it', () => {
    const uk = i18n.getFixedT('uk');
    expect(journalText(event('line_added', { product: 'Pipe', quantity: 6, from_finished: 2, from_stock: 0 }), uk)).toBe(
      'Додано позицію «Pipe» × 6, готових 2 зі складу',
    );
  });

  it('names the ready units among a line’s changed fields', () => {
    expect(journalText(event('line_changed', { product: 'Pipe', changes: { from_finished: [2, 0] } }), t)).toBe(
      'Line changed: Pipe (ready from stock)',
    );
  });
});
