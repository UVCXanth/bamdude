import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import type { TimelineEvent } from '../../../api/client';
import { OrderTimeline } from '../../../components/projects/OrderTimeline';

const ev = (event_type: string, metadata: Record<string, unknown>, title = 'x'): TimelineEvent => ({
  event_type,
  timestamp: '2026-09-26T10:00:00',
  title,
  description: null,
  metadata,
});

describe('OrderTimeline · the order journal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('says each journal line as a sentence in the reader’s language, with who did it', async () => {
    vi.spyOn(api, 'getProjectTimeline').mockResolvedValue([
      ev('stage_changed', { from: 'prep', to: 'qc', user_name: 'ira' }),
      ev('fields_changed', { fields: ['name', 'due_date'], user_name: null }),
      ev('order_created', { source: 'copy', from_code: 'OR-0003' }),
      ev('responsible_changed', { from: null, to: { id: 2, name: 'ira' } }),
      ev('mystery', {}, 'Mystery'),
    ]);
    render(<OrderTimeline orderId={5} />);
    expect(await screen.findByText('Stage: Preparation → Quality check')).toBeInTheDocument();
    expect(screen.getByText(/· ira/)).toBeInTheDocument();
    expect(screen.getByText('Order details changed: name, due date')).toBeInTheDocument();
    expect(screen.getByText('Created as a copy of OR-0003')).toBeInTheDocument();
    expect(screen.getByText('Responsible: Not assigned → ira')).toBeInTheDocument();
    expect(screen.getByText('Mystery')).toBeInTheDocument(); // an unknown type keeps the server's title
  });
});
