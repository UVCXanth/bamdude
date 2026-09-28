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

describe('the order journal · stock and issue', () => {
  it('says what was assembled, received, issued and taken', () => {
    expect(journalText(event('kits_assembled', { line_id: 1, product: 'Pipe', units: 3 }), t)).toBe(
      'Pipe: 3 kits assembled for the order',
    );
    expect(journalText(event('goods_received', { line_id: 1, product: 'Pipe', units: 5 }), t)).toBe(
      'Pipe: received into stock — 5',
    );
    expect(
      journalText(event('goods_received', { line_id: 2, product: 'Lamp', parts: [['shade', 2], ['base', 1]] }), t),
    ).toBe('Lamp: received into stock — shade × 2, base × 1');
    expect(journalText(event('goods_issued', { issue_id: 7, units: 4, waybill: '2045' }), t)).toBe(
      'Issued to the customer — 4, waybill 2045',
    );
    expect(journalText(event('goods_issued', { issue_id: 7, units: 4, waybill: null }), t)).toBe(
      'Issued to the customer — 4',
    );
    expect(journalText(event('stock_taken', { line_id: 1, product: 'Pipe', from_finished: 2, kits: 3 }), t)).toBe(
      'Taken from stock for Pipe, 2 ready from stock, 3 kits from stock',
    );
  });
});

describe('the order journal · write-offs and closing to stock', () => {
  it('says what was written off and what went to free stock', () => {
    expect(journalText(event('goods_written_off', { line_id: 1, product: 'Pipe', units: 1, note: 'dropped' }), t)).toBe(
      'Pipe: written off — 1 (dropped)',
    );
    expect(
      journalText(event('goods_written_off', { line_id: 2, product: 'Lamp', parts: [['shade', 1]], note: 'warped' }), t),
    ).toBe('Lamp: written off — shade × 1 (warped)');
    expect(journalText(event('goods_stocked', { line_id: 1, product: 'Pipe', units: 3 }), t)).toBe(
      'Pipe: moved to free stock — 3',
    );
  });
});
