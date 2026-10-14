/**
 * The source's swap declaration never rewrites the operator's swap choices (swap-source-lifecycle spec
 * r4 §9). It changes only what THIS job sends: a True source sends no swap macros, and an unknown one
 * sends none after the operator opts this job out. The saved per-model preference and the answer a
 * grouped run carries to its next member keep the choice the operator made — so the next file, whose
 * declaration may be False, still gets the swap macros the operator asked for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../mocks/server';
import { render } from '../utils';
import { PrintModal } from '../../components/PrintModal';

const SWAP_PRINTER = {
  id: 1,
  name: 'P1S-swap',
  model: 'P1S',
  ip_address: '192.168.1.101',
  enabled: true,
  is_active: true,
  swap_mode_enabled: true,
};
const BOTH = ['swap_mode_start', 'swap_mode_change_table'];

let posted: Array<Record<string, unknown>>;
let saved: Array<{ swap_macros: { execute: boolean; events: string[] } }>;

function source(fact: { swap_compatible: boolean; swap_compatibility_known: boolean }) {
  server.use(
    http.get('/api/v1/archives/:id', () =>
      HttpResponse.json({ id: 1, filename: 'a.3mf', sliced_for_model: 'P1S', ...fact }),
    ),
  );
}

beforeEach(() => {
  localStorage.clear();
  posted = [];
  saved = [];
  server.use(
    http.get('/api/v1/printers/', () => HttpResponse.json([SWAP_PRINTER])),
    http.get('/api/v1/printers/:id/status', () =>
      HttpResponse.json({ connected: true, state: 'IDLE', ams: [], vt_tray: [] }),
    ),
    http.get('/api/v1/archives/:id/plates', () => HttpResponse.json({ is_multi_plate: false, plates: [] })),
    http.get('/api/v1/archives/:id/filament-requirements', () => HttpResponse.json({ filaments: [] })),
    http.get('/api/v1/print-option-preferences/:model', () =>
      HttpResponse.json({
        printer_model: 'P1S',
        updated_at: '',
        options: { print_options: {}, swap_macros: { execute: true, events: BOTH } },
      }),
    ),
    http.put('/api/v1/print-option-preferences/:model', async ({ request }) => {
      const body = (await request.json()) as (typeof saved)[number];
      saved.push(body);
      return HttpResponse.json({ printer_model: 'P1S', options: body, updated_at: '' });
    }),
    http.post('/api/v1/queue/', async ({ request }) => {
      posted.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: 1, status: 'pending', created_item_ids: [1] });
    }),
  );
});

function mount(onAnswered = vi.fn()) {
  render(
    <PrintModal
      mode="add-to-queue"
      archiveId={1}
      archiveName="Bracket"
      initialSelectedPrinterIds={[1]}
      onAnswered={onAnswered}
      onClose={vi.fn()}
      onSuccess={vi.fn()}
    />,
  );
  return onAnswered;
}

async function submit() {
  const button = await screen.findByRole('button', { name: /^add to queue$/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(posted).toHaveLength(1));
  await waitFor(() => expect(saved).toHaveLength(1));
}

describe('the swap choices outlive the source’s declaration', () => {
  it('a True source sends no swap macros, and saves and carries the choice as it was', async () => {
    source({ swap_compatible: true, swap_compatibility_known: true });
    const onAnswered = mount();

    await submit();

    expect(posted[0]).toMatchObject({ execute_swap_macros: false, swap_macro_events: null });
    expect(saved[0].swap_macros).toEqual({ execute: true, events: BOTH });
    expect(onAnswered).toHaveBeenCalledWith(
      expect.objectContaining({ swapMacros: { execute: true, events: BOTH } }),
    );
  });

  it('an opt-out on an unknown source is this job’s, not a new preference', async () => {
    source({ swap_compatible: false, swap_compatibility_known: false });
    const onAnswered = mount();

    fireEvent.click(await screen.findByRole('button', { name: /print without the extra swap macros/i }));
    await submit();

    expect(posted[0]).toMatchObject({ execute_swap_macros: false, swap_macro_events: null });
    // The operator turned the swap macros off for THIS job only.
    expect(saved[0].swap_macros).toEqual({ execute: true, events: BOTH });
    expect(onAnswered).toHaveBeenCalledWith(
      expect.objectContaining({ swapMacros: { execute: true, events: BOTH } }),
    );
  });

  it('a known False source sends the saved choice itself', async () => {
    source({ swap_compatible: false, swap_compatibility_known: true });
    mount();

    await submit();

    expect(posted[0]).toMatchObject({ execute_swap_macros: true, swap_macro_events: BOTH });
    expect(saved[0].swap_macros).toEqual({ execute: true, events: BOTH });
  });
});
