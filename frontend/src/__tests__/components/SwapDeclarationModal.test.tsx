/**
 * The swap declaration dialog (swap-source-declaration spec r3 §4-§7).
 *
 * It reads the file first and shows what it read; neither answer is chosen for the operator, and
 * only the bytes that were read get the declaration. A source that changed in between is a
 * conflict, never a success. After the save, applying it to jobs is a separate step: nothing is
 * selected for the operator, only the selected jobs are sent, and a refused refresh keeps the saved
 * declaration -- trying again sends the refresh alone. A refresh is no Retry.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { SwapDeclarationModal } from '../../components/SwapDeclarationModal';

const SHA = 'ab'.repeat(32);
const INSPECTED = {
  kind: 'archive',
  id: 5,
  sha256: SHA,
  size_bytes: 2048,
  display_filename: 'plate.gcode.3mf',
  current: null,
  known: false,
  revision: 'cd'.repeat(32),
  origin: null,
  declaration_id: null,
};
const DECLARED = {
  kind: 'archive',
  id: 5,
  declaration_id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
  value: true,
  sha256: SHA,
  revision: 'ef'.repeat(32),
  replayed: false,
};
const LISTING = {
  kind: 'archive',
  id: 5,
  declaration_id: DECLARED.declaration_id,
  value: true,
  sha256: SHA,
  source_revision: 'ef'.repeat(32),
  jobs: [
    { kind: 'queue', id: 11, revision: '1'.repeat(64), status: 'failed', eligible: true, reason: null },
    { kind: 'auto_queue', id: 12, revision: '2'.repeat(64), status: 'pending', eligible: true, reason: null },
    { kind: 'queue', id: 13, revision: '3'.repeat(64), status: 'pending', eligible: false, reason: 'snapshot_known' },
  ],
  counts: { eligible: 2, refused: 1 },
};

let puts: Array<Record<string, unknown>>;
let refreshes: Array<Record<string, unknown>>;
let inspections: number;

function api({
  put = () => HttpResponse.json(DECLARED),
  refresh = () =>
    HttpResponse.json({
      operation_id: 'x',
      declaration_id: DECLARED.declaration_id,
      value: true,
      refreshed: [{ kind: 'queue', id: 11 }],
      replayed: false,
    }),
  inspect = () => HttpResponse.json(INSPECTED),
}: {
  put?: () => Response;
  refresh?: () => Response;
  inspect?: () => Response;
} = {}) {
  server.use(
    http.post('/api/v1/archives/:id/swap-declaration/inspect', () => {
      inspections += 1;
      return inspect();
    }),
    http.put('/api/v1/archives/:id/swap-declaration', async ({ request }) => {
      puts.push((await request.json()) as Record<string, unknown>);
      return put();
    }),
    http.get('/api/v1/archives/:id/swap-declaration/history', () =>
      HttpResponse.json([
        {
          declaration_id: DECLARED.declaration_id,
          action: 'declare',
          old_value: null,
          new_value: true,
          sha256: SHA,
          actor_label: 'admin',
          actor_kind: 'user',
          created_at: '2026-10-14T10:00:00',
        },
      ]),
    ),
    http.get('/api/v1/archives/:id/swap-declaration/jobs', () => HttpResponse.json(LISTING)),
    http.post('/api/v1/archives/:id/swap-declaration/jobs/refresh', async ({ request }) => {
      refreshes.push((await request.json()) as Record<string, unknown>);
      return refresh();
    }),
  );
}

beforeEach(() => {
  puts = [];
  refreshes = [];
  inspections = 0;
});

const open = (props: Partial<React.ComponentProps<typeof SwapDeclarationModal>> = {}) =>
  render(<SwapDeclarationModal kind="archive" id={5} name="plate.gcode.3mf" canDeclare onClose={vi.fn()} {...props} />);

const carries = () => screen.findByRole('radio', { name: /carries its own plate-change sequence/i });
const doesNot = () => screen.findByRole('radio', { name: /does not carry its own plate-change sequence/i });
const save = () => screen.findByRole('button', { name: /save declaration/i });

async function declareTrue() {
  fireEvent.click(await carries());
  fireEvent.click(await save());
  await screen.findByText(/declaration saved/i);
}

describe('reading and declaring', () => {
  it('shows what it read, and chooses neither answer for the operator', async () => {
    api();
    open();

    expect(await screen.findByText('plate.gcode.3mf')).toBeInTheDocument();
    expect(screen.getByText(SHA.slice(0, 12), { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/unknown/i)).toBeInTheDocument();
    expect(await carries()).not.toBeChecked();
    expect(await doesNot()).not.toBeChecked();
    expect(await save()).toBeDisabled();
  });

  it('declares exactly the bytes it read, with a fresh operation id', async () => {
    api();
    open();

    await declareTrue();

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ value: true, expected_sha256: SHA, expected_revision: INSPECTED.revision });
    expect(String(puts[0].operation_id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/admin/)).toBeInTheDocument(); // the audit of what was saved
  });

  it('a read-only operator sees the declaration and no way to change it', async () => {
    api();
    open({ canDeclare: false });

    expect(await screen.findByText('plate.gcode.3mf')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /save declaration/i })).toBeNull();
  });

  it('a source that changed since it was read is a conflict, never a success -- and it can be read again', async () => {
    api({
      put: () =>
        HttpResponse.json(
          { detail: { error: 'swap_source_changed', message: 'The source changed since it was inspected.' } },
          { status: 409 },
        ),
    });
    open();

    fireEvent.click(await carries());
    fireEvent.click(await save());

    expect(await screen.findByText(/changed since it was read/i)).toBeInTheDocument();
    expect(screen.queryByText(/declaration saved/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /read it again/i }));
    await waitFor(() => expect(inspections).toBe(2));
    expect(await carries()).not.toBeChecked(); // a new reading asks again
  });

  it('a refused reading says why and offers to try again', async () => {
    api({
      inspect: () =>
        HttpResponse.json(
          { detail: { error: 'library_refresh_required', message: 'Scan its folder first.' } },
          { status: 409 },
        ),
    });
    open();

    expect(await screen.findByText(/scan its folder first/i)).toBeInTheDocument();
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(inspections).toBe(2));
  });
});

describe('applying the declaration to selected jobs', () => {
  it('selects nothing, sends only what was selected, and says a failed job stays failed', async () => {
    api();
    open();
    await declareTrue();

    const failedJob = await screen.findByRole('checkbox', { name: /queue job #11/i });
    const autoJob = screen.getByRole('checkbox', { name: /auto queue job #12/i });
    expect(failedJob).not.toBeChecked();
    expect(autoJob).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /#13/ })).toBeNull(); // refused: shown with its reason
    expect(screen.getByText(/already has its own answer/i)).toBeInTheDocument();
    const apply = screen.getByRole('button', { name: /apply to 0 selected/i });
    expect(apply).toBeDisabled();

    fireEvent.click(failedJob);
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 selected/i }));

    await screen.findByText(/stays failed/i);
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({
      declaration_id: DECLARED.declaration_id,
      source_revision: LISTING.source_revision,
      jobs: [{ kind: 'queue', id: 11, revision: '1'.repeat(64) }],
    });
  });

  it('a refused refresh keeps the saved declaration, and trying again sends the refresh alone', async () => {
    let attempt = 0;
    api({
      refresh: () => {
        attempt += 1;
        return attempt === 1
          ? HttpResponse.json(
              {
                detail: {
                  error: 'jobs_changed',
                  message: 'Some of the selected jobs changed since they were listed.',
                  jobs: [{ kind: 'queue', id: 11 }],
                },
              },
              { status: 409 },
            )
          : HttpResponse.json({
              operation_id: 'y',
              declaration_id: DECLARED.declaration_id,
              value: true,
              refreshed: [{ kind: 'queue', id: 11 }],
              replayed: false,
            });
      },
    });
    open();
    await declareTrue();

    fireEvent.click(await screen.findByRole('checkbox', { name: /queue job #11/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 selected/i }));
    expect(await screen.findByText(/declaration is saved; the selected jobs were not changed/i)).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('checkbox', { name: /queue job #11/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 selected/i }));
    await screen.findByText(/stays failed/i);

    expect(puts).toHaveLength(1); // never a second declaration
    expect(refreshes).toHaveLength(2);
    expect(refreshes[0].operation_id).not.toBe(refreshes[1].operation_id);
  });
});
