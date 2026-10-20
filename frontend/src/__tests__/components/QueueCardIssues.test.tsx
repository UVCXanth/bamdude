/**
 * The Issues section of a printer's queue card: the «Delete all» button
 * counts the failed + cancelled rows the user may delete (never skipped),
 * asks first — with what it froze at the click — and sends exactly those ids
 * to one bulk-delete call.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { QueueCard } from '../../components/QueueCard';
import { useAuth } from '../../contexts/AuthContext';
import { api, type PrinterQueue } from '../../api/client';

const queue: PrinterQueue = {
  id: 7,
  printer_id: 7,
  printer_name: 'A1-07',
  printer_model: 'A1',
  status: 'idle',
  is_paused: false,
  auto_distribute_eligible: true,
  last_activity_at: null,
  current_item_id: null,
  pending_count: 0,
  completed_count: 145,
  failed_count: 8,
  cancelled_count: 2,
  skipped_count: 1,
  total_count: 156,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-22T00:00:00Z',
};

const row = (id: number, status: string, createdById: number | null = 1) => ({
  id,
  queue_id: 7,
  printer_id: 7,
  archive_id: id,
  position: id,
  status,
  archive_name: 'W49699__upd_plate_1',
  printer_name: 'A1-07',
  source_storage: 'ready',
  created_by_id: createdById,
});

const GATE = 'Jobs set to wait for a successful previous print will no longer be held back by these failures.';

/** Renders the signed-in username, so a test can wait until the permissions it asserts on are loaded. */
function WhoAmI() {
  const { user } = useAuth();
  return <span>{user ? `user:${user.username}` : 'user:none'}</span>;
}

function renderCard() {
  return render(
    <>
      <QueueCard queue={queue} onEditItem={vi.fn()} />
      <WhoAmI />
    </>,
  );
}

function signInAs(username: string, id: number, permissions: string[]) {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id,
        username,
        role: 'user',
        is_active: true,
        is_admin: false,
        groups: [{ id: 2, name: 'Operators' }],
        permissions,
        created_at: '2026-01-01T00:00:00Z',
      }),
    ),
  );
}

function mockQueue(byStatus: Record<string, unknown[]>) {
  const issues = Object.values(byStatus).flat() as Array<{ id: number; status: string }>;
  server.use(
    http.get('/api/v1/queue/', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status') ?? '';
      return HttpResponse.json(byStatus[status] ?? []);
    }),
    http.get('/api/v1/queue/summary', () => HttpResponse.json({
      pending_count: 0,
      groups: [{
        queue_id: 7, printer_id: 7, pending_count: 0,
        failed_count: byStatus.failed?.length ?? 0,
        cancelled_count: byStatus.cancelled?.length ?? 0,
        skipped_count: byStatus.skipped?.length ?? 0,
      }],
    })),
    http.get('/api/v1/queue/issues', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const cursor = Number(params.get('cursor') ?? 0);
      const limit = Number(params.get('limit') ?? 50);
      const selected = issues.filter(item => item.id > cursor).sort((a, b) => a.id - b.id);
      return HttpResponse.json({ items: selected.slice(0, limit), next_cursor: selected.length > limit ? selected[limit - 1].id : null });
    }),
    http.get('/api/v1/printers/7/status', () => HttpResponse.json({ state: 'IDLE' })),
  );
}

function answerBulkDelete(answer: (ids: number[]) => Response | { deleted_count: number; skipped_count: number }) {
  const posted: number[][] = [];
  server.use(
    http.post('/api/v1/queue/bulk-delete', async ({ request }) => {
      const body = (await request.json()) as { item_ids: number[] };
      posted.push(body.item_ids);
      const out = answer(body.item_ids);
      return out instanceof Response ? out : HttpResponse.json({ ...out, message: 'ok' });
    }),
  );
  return posted;
}

describe('QueueCard Issues — Delete all', () => {
  let posted: number[][];

  beforeEach(() => {
    mockQueue({
      failed: [row(1, 'failed'), row(2, 'failed')],
      cancelled: [row(3, 'cancelled')],
      skipped: [row(4, 'skipped')],
    });
    posted = answerBulkDelete((ids) => ({ deleted_count: ids.length, skipped_count: 0 }));
  });

  it('keeps issue rows unloaded while closed, then pages the open section', async () => {
    const many = Array.from({ length: 55 }, (_, index) => ({ ...row(index + 1, 'failed'), archive_name: `Issue ${index + 1}` }));
    mockQueue({ failed: many });
    let detailReads = 0;
    server.use(http.get('/api/v1/queue/issues', ({ request }) => {
      detailReads++;
      const params = new URL(request.url).searchParams;
      const cursor = Number(params.get('cursor') ?? 0);
      const limit = Number(params.get('limit') ?? 50);
      const selected = many.filter(item => item.id > cursor);
      return HttpResponse.json({ items: selected.slice(0, limit), next_cursor: selected.length > limit ? selected[limit - 1].id : null });
    }));
    renderCard();
    const header = await screen.findByText('Issues (55)');
    expect(detailReads).toBe(0);
    fireEvent.click(header);
    expect(await screen.findByText('Issue 50')).toBeInTheDocument();
    expect(screen.queryByText('Issue 55')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more issues' }));
    expect(await screen.findByText('Issue 55')).toBeInTheDocument();
    expect(detailReads).toBe(2);
  });

  it('loads every page before freezing bulk-delete IDs', async () => {
    mockQueue({ failed: Array.from({ length: 101 }, (_, index) => row(index + 1, 'failed')) });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('failed: 101, cancelled: 0?');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posted).toEqual([Array.from({ length: 101 }, (_, index) => index + 1)]));
  });

  it('cannot open confirmation or write after cancelling a slow bulk load', async () => {
    server.use(http.get('/api/v1/queue/issues', async () => {
      await delay(150);
      return HttpResponse.json({ items: [row(1, 'failed')], next_cursor: null });
    }));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel loading' }));
    await screen.findByRole('button', { name: 'Delete all…' });
    await delay(200);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('counts failed and cancelled but not skipped, asks, then sends exactly those ids', async () => {
    renderCard();

    const button = await screen.findByRole('button', { name: 'Delete all…' });
    fireEvent.click(button);

    // Counts stand after labels, never before a noun: two numbers in one
    // sentence cannot both agree with it (uk «1 невдалих»).
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Remove from the queue of A1-07 — failed: 2, cancelled: 1?');
    // Deleting failures is acknowledging them — the dialog says what that releases.
    expect(dialog).toHaveTextContent(GATE);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(posted).toEqual([[1, 2, 3]]));
    expect(await screen.findByText('3 removed')).toBeInTheDocument();
  });

  it('does not mention the previous-success gate when only cancellations go', async () => {
    mockQueue({ cancelled: [row(3, 'cancelled')] });
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('failed: 0, cancelled: 1?');
    expect(dialog).not.toHaveTextContent(GATE);
  });

  it('does not open or close the section', async () => {
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));

    // The rows only render while the section is open; it starts collapsed.
    expect(screen.queryByText('W49699__upd_plate_1')).toBeNull();
  });

  it('counts only the rows this user may delete', async () => {
    // Operators read the whole farm but delete only their own; an external
    // print's row has no creator and needs delete_all.
    signInAs('op', 5, ['queue:read', 'queue:read_all', 'queue:delete_own']);
    mockQueue({
      failed: [row(11, 'failed', 5), row(12, 'failed', 9)],
      cancelled: [row(13, 'cancelled', null)],
    });
    renderCard();

    await screen.findByText('user:op');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('failed: 1, cancelled: 0?');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(posted).toEqual([[11]]));
  });

  it('confirms what it showed, even if the list moved while the dialog was open', async () => {
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    await screen.findByRole('dialog');

    // A later response differs, but the confirmation retains its frozen IDs.
    mockQueue({ failed: [row(1, 'failed'), row(2, 'failed'), row(5, 'failed')], cancelled: [row(3, 'cancelled')] });

    expect(screen.getByRole('dialog')).toHaveTextContent('failed: 2, cancelled: 1?');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(posted).toEqual([[1, 2, 3]]));
  });

  it('says how many were left in place', async () => {
    posted = answerBulkDelete(() => ({ deleted_count: 2, skipped_count: 1 }));
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('2 removed')).toBeInTheDocument();
    expect(await screen.findByText('1 left in place (changed or removed meanwhile)')).toBeInTheDocument();
  });

  it('says nothing was removed instead of "0 removed"', async () => {
    posted = answerBulkDelete(() => ({ deleted_count: 0, skipped_count: 3 }));
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Nothing removed — the jobs changed or were removed meanwhile')).toBeInTheDocument();
    expect(screen.queryByText('0 removed')).toBeNull();
  });

  it('closes the dialog and shows the refusal when the request fails', async () => {
    posted = answerBulkDelete(() => HttpResponse.json({ detail: 'The queue is busy' }, { status: 500 }));
    renderCard();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete all…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('The queue is busy')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('the per-row remove says what it does, in its tooltip and its toast', async () => {
    server.use(http.delete('/api/v1/queue/1', () => HttpResponse.json({ message: 'Queue item deleted' })));
    renderCard();
    fireEvent.click(await screen.findByText('Issues (4)'));

    const removeButtons = await screen.findAllByTitle('Remove from queue');
    expect(removeButtons).toHaveLength(4); // failed ×2, cancelled, skipped
    fireEvent.click(removeButtons[0]);

    expect(await screen.findByText('Removed from queue')).toBeInTheDocument();
  });

  it('is absent without a delete permission', async () => {
    signInAs('viewer', 2, ['queue:read']);
    renderCard();

    // Both the viewer's permissions and the issue rows are in before the check.
    await screen.findByText('user:viewer');
    await screen.findByText('Issues (4)');
    expect(screen.queryByRole('button', { name: /Delete all/ })).toBeNull();
  });
});

describe('QueueCard Issues — Retry all failed', () => {
  let attempts: number[];
  beforeEach(() => {
    vi.restoreAllMocks();
    attempts = [];
    mockQueue({ failed: [row(1, 'failed'), row(2, 'failed')], cancelled: [row(3, 'cancelled')], skipped: [row(4, 'skipped')] });
    server.use(http.post('/api/v1/queue/:id/retry', ({ params }) => {
      attempts.push(Number(params.id));
      return HttpResponse.json(row(Number(params.id), 'pending'));
    }));
  });

  it('loads all pages, confirms one printer and retries only the frozen failed IDs', async () => {
    mockQueue({ failed: Array.from({ length: 101 }, (_, index) => row(index + 1, 'failed')),
      cancelled: [row(102, 'cancelled')], skipped: [row(103, 'skipped')] });
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry all…' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('101');
    expect(dialog).toHaveTextContent('A1-07');
    expect(attempts).toEqual([]);
    mockQueue({ failed: [row(999, 'failed')] });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toHaveLength(101), { timeout: 5000 });
    expect(attempts).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
    expect(await screen.findByText('101 returned to the queue')).toBeInTheDocument();
  });

  it('continues past a source refusal and reports confirmed results without retrying cancellations', async () => {
    mockQueue({ failed: [row(1, 'failed'), row(2, 'failed'), row(5, 'failed')], cancelled: [row(3, 'cancelled')] });
    server.use(http.post('/api/v1/queue/:id/retry', ({ params }) => {
      const id = Number(params.id); attempts.push(id);
      return id === 2 ? HttpResponse.json({ detail: 'Saved source unavailable' }, { status: 409 }) : HttpResponse.json(row(id, 'pending'));
    }));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry all…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Confirmed for 2 of 3 jobs/)).toHaveTextContent('Saved source unavailable');
    expect(attempts).toEqual([1, 2, 5]);
  });

  it.each([403, 503])('stops after an authority or unknown-outcome response (%s), without replaying it', async (status) => {
    mockQueue({ failed: [row(1, 'failed'), row(2, 'failed'), row(5, 'failed')] });
    server.use(http.post('/api/v1/queue/:id/retry', ({ params }) => {
      const id = Number(params.id); attempts.push(id);
      return id === 2 ? HttpResponse.json({ detail: 'Retry unavailable' }, { status }) : HttpResponse.json(row(id, 'pending'));
    }));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry all…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(/Confirmed for 1 of 3 jobs/)).toBeInTheDocument();
    expect(attempts).toEqual([1, 2]);
  });

  it('does not expose bulk retry without update_all or when there are no failures', async () => {
    signInAs('viewer', 2, ['queue:read']);
    const first = renderCard();
    await screen.findByText('user:viewer');
    expect(screen.queryByRole('button', { name: 'Retry all…' })).not.toBeInTheDocument();
    first.unmount();
    signInAs('operator', 3, ['queue:read', 'queue:update_all']);
    mockQueue({ cancelled: [row(3, 'cancelled')], skipped: [row(4, 'skipped')] });
    renderCard();
    await screen.findByText('user:operator');
    await screen.findByText('Issues (2)');
    expect(screen.queryByRole('button', { name: 'Retry all…' })).not.toBeInTheDocument();
  });

  it('can cancel the page load without sending a retry', async () => {
    server.use(http.get('/api/v1/queue/issues', async () => {
      await delay(150); return HttpResponse.json({ items: [row(1, 'failed')], next_cursor: null });
    }));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry all…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel loading' }));
    await screen.findByRole('button', { name: 'Retry all…' });
    await delay(200);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(attempts).toEqual([]);
  });

  it('serializes retries and disables overlapping bulk and row actions', async () => {
    let release = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    server.use(http.post('/api/v1/queue/:id/retry', async ({ params }) => {
      const id = Number(params.id); attempts.push(id);
      if (id === 1) await barrier;
      return HttpResponse.json(row(id, 'pending'));
    }));
    renderCard();
    fireEvent.click(await screen.findByText('Issues (4)'));
    await screen.findAllByTitle('Retry');
    fireEvent.click(screen.getByRole('button', { name: 'Retry all…' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Retry' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await waitFor(() => expect(attempts).toEqual([1]));
    expect(screen.getByRole('button', { name: 'Delete all…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    for (const button of screen.getAllByTitle('Retry')) expect(button).toBeDisabled();
    release();
    expect(await screen.findByText('2 returned to the queue')).toBeInTheDocument();
    expect(attempts).toEqual([1, 2]);
  });

  it('does not start the next retry after the card unmounts', async () => {
    let release = () => {};
    const barrier = new Promise<void>(resolve => { release = resolve; });
    server.use(http.post('/api/v1/queue/:id/retry', async ({ params }) => {
      const id = Number(params.id); attempts.push(id);
      if (id === 1) await barrier;
      return HttpResponse.json(row(id, 'pending'));
    }));
    const retry = vi.spyOn(api, 'retryQueueItem');
    const view = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry all…' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(attempts).toEqual([1]));
    view.unmount();
    release();
    await retry.mock.results[0].value;
    expect(attempts).toEqual([1]);
  });

  it('does not offer confirmation when the fresh pages contain no failed jobs', async () => {
    server.use(http.get('/api/v1/queue/issues', () => HttpResponse.json({ items: [row(1, 'cancelled')], next_cursor: null })));
    renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry all…' }));
    expect(await screen.findByText('No failed jobs left to retry.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(attempts).toEqual([]);
  });
});
