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

/** An operator declaration that already stands, read at the revision its jobs listing answers. */
const STANDING = {
  ...INSPECTED,
  current: true,
  known: true,
  origin: 'operator',
  declaration_id: DECLARED.declaration_id,
  revision: LISTING.source_revision,
};
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
/** The same bytes, declared the other way by someone else after the dialog read them. */
const LISTING_OTHER = { ...LISTING, declaration_id: OTHER_ID, value: false };
const STANDING_OTHER = { ...STANDING, current: false, declaration_id: OTHER_ID };

let puts: Array<Record<string, unknown>>;
let refreshes: Array<Record<string, unknown>>;
let inspections: number;

const HISTORY_LINE = {
  declaration_id: DECLARED.declaration_id,
  action: 'declare',
  old_value: null,
  new_value: true,
  sha256: SHA,
  actor_label: 'admin',
  actor_kind: 'user',
  created_at: '2026-10-14T10:00:00',
};

function api({
  put = () => HttpResponse.json(DECLARED),
  history = () => HttpResponse.json([HISTORY_LINE]),
  listing = () => HttpResponse.json(LISTING),
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
  history?: () => Response;
  listing?: () => Response;
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
    http.get('/api/v1/archives/:id/swap-declaration/history', () => history()),
    http.get('/api/v1/archives/:id/swap-declaration/jobs', () => listing()),
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
    expect(screen.queryByText(/T10:00:00/)).toBeNull(); // a date for people, not the wire's
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
    const autoJob = screen.getByRole('checkbox', { name: /auto queue job #12 \(waiting\)/i });
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
    // The same request again is the same operation: had the first one committed, the server answers its result.
    expect(refreshes[0].operation_id).toBe(refreshes[1].operation_id);
  });
});

describe('a declaration that already stands, and an answer that never came back', () => {
  it('an existing operator declaration can be applied to jobs without declaring again', async () => {
    api({ inspect: () => HttpResponse.json(STANDING) });
    open();

    expect(await screen.findByRole('checkbox', { name: /queue job #11/i })).not.toBeChecked();
    expect(puts).toHaveLength(0);
  });

  it('a save whose answer was lost is retried as the same operation, and a new reading starts a new one', async () => {
    let attempt = 0;
    api({
      put: () => {
        attempt += 1;
        return attempt === 1 ? HttpResponse.error() : HttpResponse.json(DECLARED);
      },
    });
    open();

    fireEvent.click(await carries());
    fireEvent.click(await save());
    await waitFor(() => expect(puts).toHaveLength(1));
    await screen.findByRole('alert');
    fireEvent.click(await save());
    await screen.findByText(/declaration saved/i);

    expect(puts).toHaveLength(2);
    expect(puts[1].operation_id).toBe(puts[0].operation_id);
  });
});

describe('the declaration applied to jobs is the declaration shown', () => {
  it('a listing that answers another declaration than the one shown applies nothing until it is read again', async () => {
    // Codex's T9-A-R2 probe, adapted to the stale-list UI: the assertion that what is applied is what is shown stays.
    let inspected = STANDING;
    api({
      inspect: () => HttpResponse.json(inspected),
      listing: () => HttpResponse.json(LISTING_OTHER),
    });
    open();

    expect(await screen.findByText(/declaration changed since it was shown/i)).toBeInTheDocument();
    expect(screen.getByText('Current declaration').nextElementSibling).toHaveTextContent(
      'Carries its own plate-change sequence',
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /apply to/i })).toBeNull();

    inspected = STANDING_OTHER;
    fireEvent.click(screen.getByRole('button', { name: /read it again/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /queue job #11/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 selected/i }));
    await screen.findByText(/stays failed/i);

    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].declaration_id).toBe(OTHER_ID);
    expect(screen.getByText('Current declaration').nextElementSibling).toHaveTextContent(
      'Does not carry its own plate-change sequence',
    );
  });

  it('a listing read after the save that answers another declaration applies nothing', async () => {
    let inspected: typeof INSPECTED | typeof STANDING_OTHER = INSPECTED;
    api({ inspect: () => HttpResponse.json(inspected), listing: () => HttpResponse.json(LISTING_OTHER) });
    open();
    await declareTrue();

    expect(await screen.findByText(/declaration changed since it was shown/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(refreshes).toHaveLength(0);

    inspected = STANDING_OTHER; // what the source holds now: the other declaration, not the one this dialog saved
    fireEvent.click(screen.getByRole('button', { name: /read it again/i }));
    expect(await screen.findByRole('checkbox', { name: /queue job #11/i })).not.toBeChecked();
    expect(screen.getByText('Current declaration').nextElementSibling).toHaveTextContent(
      'Does not carry its own plate-change sequence',
    );
  });

  it('a list read again after a refused refresh never switches the declaration in silence', async () => {
    let listings = 0;
    api({
      inspect: () => HttpResponse.json(STANDING),
      listing: () => {
        listings += 1;
        return HttpResponse.json(listings === 1 ? LISTING : LISTING_OTHER);
      },
      refresh: () =>
        HttpResponse.json(
          { detail: { error: 'source_changed', message: 'The source changed since its jobs were listed.' } },
          { status: 409 },
        ),
    });
    open();

    fireEvent.click(await screen.findByRole('checkbox', { name: /queue job #11/i }));
    fireEvent.click(screen.getByRole('button', { name: /apply to 1 selected/i }));

    expect(await screen.findByText(/declaration changed since it was shown/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0].declaration_id).toBe(DECLARED.declaration_id);
  });
});

describe('who declared a declaration that already stands', () => {
  it('is shown without a new save, with a date for people', async () => {
    api({ inspect: () => HttpResponse.json(STANDING) });
    open();

    expect(await screen.findByText(/declared by admin/i)).toBeInTheDocument();
    expect(screen.queryByText(/T10:00:00/)).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it('is shown to a read-only operator too', async () => {
    api({ inspect: () => HttpResponse.json(STANDING) });
    open({ canDeclare: false });

    expect(await screen.findByText(/declared by admin/i)).toBeInTheDocument();
  });

  it('says when it could not be read, and when there is no record', async () => {
    api({ inspect: () => HttpResponse.json(STANDING), history: () => HttpResponse.json({ detail: 'x' }, { status: 500 }) });
    const first = open();
    expect(await screen.findByText(/who declared it could not be read/i)).toBeInTheDocument();
    first.unmount();

    api({ inspect: () => HttpResponse.json(STANDING), history: () => HttpResponse.json([]) });
    open();
    expect(await screen.findByText(/no record of who declared it/i)).toBeInTheDocument();
  });

  it('a declaration a backup restored says so', async () => {
    api({
      inspect: () => HttpResponse.json(STANDING),
      history: () => HttpResponse.json([{ ...HISTORY_LINE, action: 'restore', actor_kind: 'restored' }]),
    });
    open();

    expect(await screen.findByText(/restored from a backup/i)).toBeInTheDocument();
  });

  it('a record of another declaration is not passed off as this one', async () => {
    api({
      inspect: () => HttpResponse.json(STANDING),
      history: () => HttpResponse.json([{ ...HISTORY_LINE, declaration_id: OTHER_ID }]),
    });
    open();

    expect(await screen.findByText(/no record of who declared it/i)).toBeInTheDocument();
    expect(screen.queryByText(/declared by admin/i)).toBeNull();
  });
});
