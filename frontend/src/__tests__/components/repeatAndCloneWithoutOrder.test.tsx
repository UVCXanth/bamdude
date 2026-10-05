/**
 * New work copied from work under an order — a plate's «Repeat» and a queue row's «Clone» —
 * keeps the order only for whoever may file work under it (Fф, WS-13 E13 R11 / Q-02), and
 * only while the order is open. For anybody else the button says, before anything is sent,
 * that the copy goes without the order, and the request says so too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { PrinterQueueWidget } from '../../components/PrinterQueueWidget';
import { QueueCard } from '../../components/QueueCard';
import type { Permission, PrinterQueue } from '../../api/client';

const auth = vi.hoisted(() => ({ granted: new Set<string>(), userId: 5 }));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
      canModify: (resource: string, action: string, createdById: number | null | undefined) =>
        auth.granted.has(`${resource}:${action}_all`) ||
        (auth.granted.has(`${resource}:${action}_own`) && createdById === auth.userId),
    }),
  };
});

const pending = (over: Record<string, unknown> = {}) => ({
  id: 11,
  queue_id: 1,
  printer_id: 1,
  archive_id: 500,
  archive_name: 'next_job.gcode.3mf',
  position: 1,
  status: 'pending',
  manual_start: false,
  created_at: '2026-01-01T00:00:00Z',
  created_by_id: 5,
  source_storage: 'ready',
  project_id: null,
  ...over,
});

const waiting = (over: Record<string, unknown> = {}) => ({
  archive_id: 77,
  print_name: 'Lamp',
  status: 'completed',
  quantity: 1,
  defective_count: 0,
  gate_token: 'tok',
  parts: [],
  repeat_order_code: 'OR-0004',
  repeat_order_open: true,
  ...over,
});

describe('«Repeat» of a print under an order', () => {
  let sent: Record<string, unknown> | null;
  let waitingAsked: boolean;

  beforeEach(() => {
    sent = null;
    waitingAsked = false;
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([pending()])),
      http.post('/api/v1/printers/:id/repeat-print', async ({ request }) => {
        sent = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ success: true, item_id: 11, ledger_refused_parts: 0 });
      }),
    );
  });

  async function pressRepeat(name: RegExp) {
    render(<PrinterQueueWidget printerId={1} printerState="FINISH" awaitingPlateClear={true} />);
    // The answer names the run on the plate: wait for it, as the operator sees it before pressing.
    await waitFor(() => expect(waitingAsked).toBe(true));
    const button = await screen.findByRole('button', { name });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(sent).not.toBeNull());
  }

  function serveWaiting(over: Record<string, unknown> = {}) {
    server.use(
      http.get('/api/v1/printers/:id/waiting-print', () => {
        waitingAsked = true;
        return HttpResponse.json(waiting(over));
      }),
    );
  }

  it('the filing right repeats it under the order', async () => {
    auth.granted = new Set(['printers:clear_plate', 'queue:read_all', 'orders:file_prints']);
    serveWaiting();
    await pressRepeat(/^Repeat print$/);
    expect(sent).not.toHaveProperty('without_order');
  });

  it('without it the button says «without order» and the answer carries it', async () => {
    auth.granted = new Set(['printers:clear_plate', 'queue:read_all']);
    serveWaiting();
    await pressRepeat(/Repeat without order/);
    expect(sent).toMatchObject({ without_order: true });
  });

  // Final review: until the plate's run is read, whether the repeat keeps its order is unknown —
  // a press then went without `without_order` and came back 403 for a caller without Fф.
  it('«Repeat» waits until the plate’s run is read', async () => {
    auth.granted = new Set(['printers:clear_plate', 'queue:read_all']);
    let answer: () => void = () => {};
    server.use(
      http.get('/api/v1/printers/:id/waiting-print', async () => {
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return HttpResponse.json(waiting());
      }),
    );
    render(<PrinterQueueWidget printerId={1} printerState="FINISH" awaitingPlateClear={true} />);
    const button = await screen.findByRole('button', { name: /^Repeat print$/ });
    expect(button).toBeDisabled();
    answer();
    expect(await screen.findByRole('button', { name: /Repeat without order/ })).toBeEnabled();
  });

  it('a closed order is not inherited, whatever the rights', async () => {
    auth.granted = new Set(['printers:clear_plate', 'queue:read_all', 'orders:update']);
    serveWaiting({ repeat_order_open: false });
    await pressRepeat(/Repeat without order/);
    expect(sent).toMatchObject({ without_order: true });
  });
});

// One question, one answer (WS-13 E13 V06): a double press — or «Clear» right after «Repeat» —
// lands before the mutation says it is pending; the hook decides it synchronously. The server
// answers a duplicate with the first repeat's row, but the card said «printing again» twice.
describe('a plate answer is sent once', () => {
  let answers: string[];

  beforeEach(() => {
    answers = [];
    auth.granted = new Set(['printers:clear_plate', 'queue:read_all']);
    server.use(
      http.get('/api/v1/queue/', () => HttpResponse.json([pending()])),
      http.get('/api/v1/printers/:id/status', () =>
        HttpResponse.json({ state: 'FINISH', connected: true, awaiting_plate_clear: true, repeat_available: true }),
      ),
      http.get('/api/v1/printers/:id/waiting-print', () => HttpResponse.json(waiting())),
      http.post('/api/v1/printers/:id/repeat-print', async () => {
        answers.push('repeat');
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ success: true, item_id: 11, ledger_refused_parts: 0 });
      }),
      http.post('/api/v1/printers/:id/clear-plate', async () => {
        answers.push('clear');
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({ success: true, ledger_refused_parts: 0 });
      }),
    );
  });

  async function pair() {
    const repeat = await screen.findByRole('button', { name: /Repeat without order/ });
    await waitFor(() => expect(repeat).toBeEnabled());
    return { repeat, clear: screen.getByRole('button', { name: /Clear/ }) };
  }

  it('the queue widget: a double press repeats once', async () => {
    render(<PrinterQueueWidget printerId={1} printerState="FINISH" awaitingPlateClear={true} />);
    const { repeat } = await pair();
    fireEvent.click(repeat);
    fireEvent.click(repeat);
    await waitFor(() => expect(answers).toEqual(['repeat']));
    await new Promise((r) => setTimeout(r, 150));
    expect(answers).toEqual(['repeat']);
  });

  it('the queue widget: «Clear» right after «Repeat» is not a second answer', async () => {
    render(<PrinterQueueWidget printerId={1} printerState="FINISH" awaitingPlateClear={true} />);
    const { repeat, clear } = await pair();
    fireEvent.click(repeat);
    fireEvent.click(clear);
    await new Promise((r) => setTimeout(r, 150));
    expect(answers).toEqual(['repeat']);
  });

  it('the queue page card: a double press repeats once', async () => {
    const queue = { id: 1, printer_id: 1, printer_name: 'A1-01', printer_model: 'A1', status: 'idle', is_paused: false,
      auto_distribute_eligible: true, last_activity_at: null, current_item_id: null, pending_count: 1, completed_count: 0,
      failed_count: 0, cancelled_count: 0, skipped_count: 0, total_count: 1, created_at: '', updated_at: '' } as PrinterQueue;
    render(<QueueCard queue={queue} onEditItem={vi.fn()} />);
    const { repeat } = await pair();
    fireEvent.click(repeat);
    fireEvent.click(repeat);
    await new Promise((r) => setTimeout(r, 150));
    expect(answers).toEqual(['repeat']);
  });

  it('a refused answer frees the pair for the next press', async () => {
    server.use(
      http.post('/api/v1/printers/:id/repeat-print', () => {
        answers.push('repeat');
        return HttpResponse.json({ detail: 'busy' }, { status: 409 });
      }),
    );
    render(<PrinterQueueWidget printerId={1} printerState="FINISH" awaitingPlateClear={true} />);
    const { repeat } = await pair();
    fireEvent.click(repeat);
    await waitFor(() => expect(answers).toEqual(['repeat']));
    await waitFor(() => expect(repeat).toBeEnabled());
    fireEvent.click(repeat);
    await waitFor(() => expect(answers).toEqual(['repeat', 'repeat']));
  });
});

describe('«Clone» of a queue row under an order', () => {
  const queue: PrinterQueue = {
    id: 1,
    printer_id: 1,
    printer_name: 'A1-01',
    printer_model: 'A1',
    status: 'idle',
    is_paused: false,
    auto_distribute_eligible: true,
    last_activity_at: null,
    current_item_id: null,
    pending_count: 1,
    completed_count: 0,
    failed_count: 0,
    cancelled_count: 0,
    skipped_count: 0,
    total_count: 1,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-22T00:00:00Z',
  };
  let cloned: URL | null;

  beforeEach(() => {
    cloned = null;
    server.use(
      http.get('/api/v1/queue/', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        return HttpResponse.json(status === 'pending' || status === null ? [pending({ project_id: 4 })] : []);
      }),
      http.get('/api/v1/printers/1/status', () => HttpResponse.json({ state: 'IDLE' })),
      http.post('/api/v1/queue/:id/clone', ({ request }) => {
        cloned = new URL(request.url);
        return HttpResponse.json(pending({ id: 12 }));
      }),
    );
  });

  async function clone(label: RegExp) {
    render(<QueueCard queue={queue} onEditItem={vi.fn()} />);
    fireEvent.click(await screen.findByTitle('More'));
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(cloned).not.toBeNull());
  }

  it('the filing right clones it under the order', async () => {
    auth.granted = new Set(['queue:read_all', 'queue:create', 'queue:update_all', 'orders:update']);
    await clone(/^Clone$/);
    expect(cloned?.searchParams.get('keep_order')).not.toBe('false');
  });

  it('without it the entry says «without order» and the request carries it', async () => {
    auth.granted = new Set(['queue:read_all', 'queue:create', 'queue:update_all']);
    await clone(/Clone — without order/);
    expect(cloned?.searchParams.get('keep_order')).toBe('false');
  });
});
