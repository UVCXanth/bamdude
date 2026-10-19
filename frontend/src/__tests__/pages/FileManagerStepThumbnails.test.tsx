/**
 * STEP thumbnails in the File Manager (spec §5, plan A6): the button belongs to library:update_all only and
 * queues a background job — never a picture at once; the old picture stays while it waits and when it fails;
 * the job's own closed reason reaches the operator (a newer server's code gets the generic sentence); an earlier
 * session's job makes the page read the file again; a cancel too late says so; a STEP file has no 3D view; and
 * the batch button queues the STEP files missing a picture beside the STL/OBJ ones, one page at a time.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => vi.fn() };
});

// The real polling owner, only with a short interval: a test waits milliseconds, not the production seconds.
vi.mock('../../hooks/useStepThumbnailJobs', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useStepThumbnailJobs')>('../../hooks/useStepThumbnailJobs');
  return {
    ...actual,
    useStepThumbnailJobs: (...args: Parameters<typeof actual.useStepThumbnailJobs>) =>
      actual.useStepThumbnailJobs(args[0], { ...args[1], pollMs: 20 }),
  };
});

const JOBS = '/api/v1/library/thumbnail-jobs';
const EPOCH = 'e'.repeat(32);

const file = (over: Record<string, unknown>) => ({
  file_path: '/library/x',
  file_size: 1024,
  product_ids: [],
  folder_id: null,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: null,
  duplicate_count: 0,
  print_count: 0,
  tags: [],
  created_by_id: 1,
  created_at: '2024-01-01T00:00:00Z',
  ...over,
});

const mockFiles = [
  file({ id: 5, filename: 'bracket.step', file_type: 'step', file_tags: ['step', 'geometry'], print_name: 'Bracket', thumbnail_path: '/thumbnails/old.png' }),
  file({ id: 6, filename: 'cube.stl', file_type: 'stl', file_tags: ['stl', 'geometry'], print_name: 'Cube' }),
];

let filesRequests = 0;

function me(permissions: string[] | null) {
  server.use(
    http.get('/api/v1/auth/me', () =>
      HttpResponse.json({
        id: 1,
        username: 'operator',
        role: 'user',
        is_active: true,
        is_admin: permissions === null,
        groups: [],
        permissions: permissions ?? [],
        created_at: '2024-01-01T00:00:00Z',
      }),
    ),
  );
}

const openMenuOf = async (name: string) => {
  const card = (await screen.findByText(name)).closest('.group') as HTMLElement;
  const trigger = within(card)
    .getAllByRole('button')
    .find((b) => b.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical'));
  if (!trigger) throw new Error('no ⋮ trigger found on the card');
  await userEvent.click(trigger);
};

const openRowMenuOf = async (name: string) => {
  const row = (await screen.findByText(name)).closest('[data-file-row]') as HTMLElement;
  const trigger = within(row)
    .getAllByRole('button')
    .find((b) => b.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical'));
  if (!trigger) throw new Error('no ⋮ trigger found on the row');
  await userEvent.click(trigger);
};

function jobsAnswer(sequence: Array<Record<string, unknown>>) {
  let index = 0;
  server.use(
    http.get(JOBS, () => {
      const receipt = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      return HttpResponse.json({ jobs_epoch: EPOCH, receipts: [receipt], missing: [] });
    }),
  );
}

describe('File Manager — STEP thumbnails', () => {
  beforeEach(() => {
    localStorage.clear();
    filesRequests = 0;
    me(null);
    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', () => {
        filesRequests += 1;
        return HttpResponse.json({ items: mockFiles, meta: { total: 2, current_page: 1, per_page: 50, last_page: 1 } });
      }),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({ total_files: 2, total_folders: 0, total_size_bytes: 2048, disk_free_bytes: 1e10, disk_total_bytes: 1e11 }),
      ),
      http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false, check_printer_firmware: false, library_disk_warning_gb: 5 })),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/library/tags', () => HttpResponse.json([])),
    );
  });

  it('queues a background job for a STEP file, keeps the old picture meanwhile, then shows the new one', async () => {
    const posted: unknown[] = [];
    server.use(
      http.post(JOBS, async ({ request }) => {
        posted.push(await request.json());
        return HttpResponse.json({ jobs_epoch: EPOCH, results: [{ file_id: 5, receipt_id: 'r5', state: 'queued', error_code: null }], next_after_id: null }, { status: 202 });
      }),
    );
    jobsAnswer([
      { file_id: 5, receipt_id: 'r5', state: 'queued', error_code: null },
      { file_id: 5, receipt_id: 'r5', state: 'succeeded', error_code: null },
    ]);
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    await userEvent.click(await screen.findByRole('button', { name: /^Generate Thumbnail$/i }));
    expect(await screen.findByText(/STEP thumbnail queued/i)).toBeInTheDocument();
    expect(posted).toEqual([{ file_ids: [5] }]);
    const card = (await screen.findByText('Bracket')).closest('.group') as HTMLElement;
    const before = within(card).getAllByRole('img', { hidden: true }).map((img) => img.getAttribute('src'));
    expect(before.some((src) => src?.includes('/library/files/5/thumbnail'))).toBe(true); // the old picture stays
    expect(await screen.findByText('STEP thumbnail ready')).toBeInTheDocument();
    await waitFor(() => {
      const after = within(card).getAllByRole('img', { hidden: true }).map((img) => img.getAttribute('src'));
      expect(after.some((src) => src?.includes('/library/files/5/thumbnail') && src?.includes('v='))).toBe(true);
    });
  });

  it('a failed job says why in the closed vocabulary and keeps the old picture', async () => {
    server.use(
      http.post(JOBS, () => HttpResponse.json({ jobs_epoch: EPOCH, results: [{ file_id: 5, receipt_id: 'r5', state: 'queued', error_code: null }], next_after_id: null }, { status: 202 })),
    );
    jobsAnswer([{ file_id: 5, receipt_id: 'r5', state: 'failed', error_code: 'cad_unavailable' }]);
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    await userEvent.click(await screen.findByRole('button', { name: /^Generate Thumbnail$/i }));
    expect(await screen.findByText(/not available on this server/i)).toBeInTheDocument();
    const card = (await screen.findByText('Bracket')).closest('.group') as HTMLElement;
    const srcs = within(card).getAllByRole('img', { hidden: true }).map((img) => img.getAttribute('src'));
    expect(srcs.some((src) => src?.includes('/library/files/5/thumbnail'))).toBe(true);
  });

  it('a code this build does not know gets the generic sentence, never the CAD-component sentence', async () => {
    server.use(
      http.post(JOBS, () => HttpResponse.json({ jobs_epoch: EPOCH, results: [{ file_id: 5, receipt_id: null, state: null, error_code: 'some_future_code' }], next_after_id: null }, { status: 202 })),
    );
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    await userEvent.click(await screen.findByRole('button', { name: /^Generate Thumbnail$/i }));
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
    expect(screen.queryByText(/not available on this server/i)).not.toBeInTheDocument();
  });

  it('an earlier session’s job makes the page read the file again and offer a retry', async () => {
    server.use(
      http.post(JOBS, () => HttpResponse.json({ jobs_epoch: EPOCH, results: [{ file_id: 5, receipt_id: 'r5', state: 'queued', error_code: null }], next_after_id: null }, { status: 202 })),
      http.get(JOBS, () => HttpResponse.json({ detail: { error: 'preview_job_expired', message: 'old' } }, { status: 410 })),
    );
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    const loadsBefore = filesRequests;
    await userEvent.click(await screen.findByRole('button', { name: /^Generate Thumbnail$/i }));
    expect(await screen.findByText(/no longer available/i)).toBeInTheDocument();
    await waitFor(() => expect(filesRequests).toBeGreaterThan(loadsBefore)); // the file is read again
  });

  it('jobs that end in the same poll are told in one toast per kind, never one per file', async () => {
    const batchJobs = (results: Array<Record<string, unknown>>) =>
      http.post(JOBS, () => HttpResponse.json({ jobs_epoch: EPOCH, results, next_after_id: null }, { status: 202 }));
    const queued = [5, 7, 8].map((id) => ({ file_id: id, receipt_id: `r${id}`, state: 'queued', error_code: null }));
    server.use(
      http.post('/api/v1/library/generate-stl-thumbnails', () => HttpResponse.json({ processed: 0, succeeded: 0, failed: 0, results: [] })),
      batchJobs(queued),
      http.get(JOBS, () => HttpResponse.json({ detail: { error: 'preview_job_expired', message: 'old' } }, { status: 410 })),
    );
    render(<FileManagerPage />);
    const button = await screen.findByRole('button', { name: /Generate Thumbnails/i });
    await userEvent.click(button);
    expect(await screen.findByText('3 thumbnail jobs are no longer available. The files were refreshed — you can try again.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.getAllByText(/no longer available/i)).toHaveLength(1);

    server.use(
      batchJobs(queued),
      http.get(JOBS, () =>
        HttpResponse.json({
          jobs_epoch: EPOCH,
          receipts: [
            { receipt_id: 'r5', file_id: 5, state: 'succeeded', error_code: null },
            { receipt_id: 'r7', file_id: 7, state: 'succeeded', error_code: null },
            { receipt_id: 'r8', file_id: 8, state: 'failed', error_code: 'cad_unavailable' },
          ],
          missing: [],
        }),
      ),
    );
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(await screen.findByText('2 STEP thumbnails ready')).toBeInTheDocument();
    expect(await screen.findByText(/^STEP thumbnail failed: .*not available on this server/i)).toBeInTheDocument();
    expect(screen.queryByText(/^STEP thumbnail ready$/)).not.toBeInTheDocument();
  });

  it('a running job offers a cancel, and a cancel too late says so', async () => {
    server.use(
      http.post(JOBS, () => HttpResponse.json({ jobs_epoch: EPOCH, results: [{ file_id: 5, receipt_id: 'r5', state: 'queued', error_code: null }], next_after_id: null }, { status: 202 })),
      http.delete(`${JOBS}/r5`, () => HttpResponse.json({ detail: { error: 'cancel_too_late', message: 'late' } }, { status: 409 })),
    );
    jobsAnswer([{ file_id: 5, receipt_id: 'r5', state: 'running', error_code: null }]);
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    await userEvent.click(await screen.findByRole('button', { name: /^Generate Thumbnail$/i }));
    await screen.findByText(/STEP thumbnail queued/i);
    await openMenuOf('Bracket');
    await userEvent.click(await screen.findByRole('button', { name: /^Cancel thumbnail$/i }));
    expect(await screen.findByText(/can no longer be canceled/i)).toBeInTheDocument();
  });

  it('the STEP button is update_all’s alone; an own-file updater keeps the STL one', async () => {
    me(['library:read_own', 'library:read_all', 'library:update_own', 'library:read']);
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    const stepItem = await screen.findByRole('button', { name: /^Generate Thumbnail$/i });
    expect(stepItem).toBeDisabled();
    expect(stepItem).toHaveAttribute('title', expect.stringMatching(/update all library files/i));
  });

  it('an own-file updater keeps the STL button', async () => {
    me(['library:read_own', 'library:read_all', 'library:update_own', 'library:read']);
    render(<FileManagerPage />);
    await openMenuOf('Cube');
    expect(await screen.findByRole('button', { name: /^Generate Thumbnail$/i })).toBeEnabled();
  });

  it('a STEP file has no 3D view, in the card menu or the list row', async () => {
    render(<FileManagerPage />);
    await openMenuOf('Bracket');
    expect(await screen.findByRole('button', { name: /^Download$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^3D View$/i })).not.toBeInTheDocument();
  });

  it('a STEP row has no 3D view either and offers the STEP thumbnail', async () => {
    localStorage.setItem('library-view-mode', 'list');
    render(<FileManagerPage />);
    await openRowMenuOf('Bracket');
    const entry = await screen.findByRole('button', { name: /^Generate Thumbnail$/i });
    const menu = entry.parentElement as HTMLElement;
    expect(within(menu).queryByRole('button', { name: /^3D View$/i })).not.toBeInTheDocument();
    const row = screen.getByText('Bracket').closest('[data-file-row]') as HTMLElement;
    expect(within(row).queryByTitle('3D View')).not.toBeInTheDocument(); // the STL row keeps its own
  });

  it('the batch button queues the STEP files missing a picture beside the STL ones, one page at a time', async () => {
    const stepBodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post('/api/v1/library/generate-stl-thumbnails', () =>
        HttpResponse.json({ processed: 1, succeeded: 1, failed: 0, results: [{ file_id: 6, filename: 'cube.stl', success: true }] }),
      ),
      http.post(JOBS, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        stepBodies.push(body);
        return HttpResponse.json(
          {
            jobs_epoch: EPOCH,
            results: [{ file_id: 5, receipt_id: `r${stepBodies.length}`, state: 'queued', error_code: null }],
            next_after_id: stepBodies.length === 1 ? 5 : null,
          },
          { status: 202 },
        );
      }),
    );
    jobsAnswer([{ file_id: 5, receipt_id: 'r1', state: 'queued', error_code: null }]);
    render(<FileManagerPage />);
    const button = await screen.findByRole('button', { name: /Generate Thumbnails/i });
    await userEvent.click(button);
    expect(await screen.findByText(/1 STEP thumbnail queued in the background/i)).toBeInTheDocument();
    expect(await screen.findByText(/press again to queue the next batch/i)).toBeInTheDocument();
    expect(stepBodies[0]).toEqual({ all_missing: true, after_id: 0 });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    await waitFor(() => expect(stepBodies[1]).toEqual({ all_missing: true, after_id: 5 })); // the explicit next page
  });

  it('an older server’s batch answer without error_code still reads', async () => {
    server.use(
      http.post('/api/v1/library/generate-stl-thumbnails', () =>
        HttpResponse.json({ processed: 1, succeeded: 0, failed: 1, results: [{ file_id: 6, filename: 'cube.stl', success: false, error: 'File not found on disk' }] }),
      ),
      http.post(JOBS, () => HttpResponse.json({ jobs_epoch: EPOCH, results: [], next_after_id: null }, { status: 202 })),
    );
    render(<FileManagerPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Generate Thumbnails/i }));
    expect(await screen.findByText(/File not found on disk/)).toBeInTheDocument();
  });
it('a refused STEP half of the batch says so, beside the STL result', async () => {
    server.use(
      http.post('/api/v1/library/generate-stl-thumbnails', () =>
        HttpResponse.json({ processed: 1, succeeded: 1, failed: 0, results: [{ file_id: 6, filename: 'cube.stl', success: true }] }),
      ),
      http.post(JOBS, () =>
        HttpResponse.json({ detail: { error: 'unavailable', message: 'STEP thumbnail jobs are not running.' } }, { status: 503 }),
      ),
    );
    render(<FileManagerPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Generate Thumbnails/i }));
    expect(await screen.findByText(/STEP thumbnail not queued: the preview service is not available right now/i)).toBeInTheDocument();
  });
});
