/**
 * Deleting a folder refreshes the trash — its list and its header count.
 *
 * The folder's managed files go to the trash, but the folder delete refreshed
 * only the tree, the files and the stats. A trash already loaded — the header
 * badge, a list visited before — went on showing the trash as it was, so the
 * files seemed to have skipped it (deleting a single file or a selection
 * always refreshed both).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useQuery } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { api } from '../../api/client';
import { FileManagerPage } from '../../pages/FileManagerPage';

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => vi.fn() };
});

/** The trash page's own query, cached beside the file manager as a visited trash would be. */
function TrashListProbe() {
  const { data } = useQuery({ queryKey: ['library-trash'], queryFn: () => api.listLibraryTrash(200, 0) });
  return <div data-testid="trash-list">{data ? data.items.length : 'loading'}</div>;
}

const binnedItem = (id: number) => ({
  id,
  filename: `part_${id}.3mf`,
  file_type: '3mf',
  file_size: 1024,
  thumbnail_path: null,
  deleted_at: '2026-10-22T10:00:00Z',
  auto_purge_at: '2026-11-21T10:00:00Z',
  created_by_id: null,
  created_by_username: null,
});

let binned: ReturnType<typeof binnedItem>[] = [];
let countReads = 0;
let deleteStatus = 200;

describe('deleting a folder', () => {
  beforeEach(() => {
    localStorage.clear();
    binned = [];
    countReads = 0;
    deleteStatus = 200;
    server.use(
      http.get('/api/v1/library/folders', () =>
        HttpResponse.json([
          { id: 5, name: 'Parts', parent_id: null, file_count: 2, products: [], children: [], is_external: false },
        ]),
      ),
      http.get('/api/v1/library/files', () =>
        HttpResponse.json({ items: [], meta: { total: 0, current_page: 1, per_page: 50, last_page: 1 } }),
      ),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({
          total_files: 2,
          total_folders: 1,
          total_size_bytes: 2048,
          disk_free_bytes: 10737418240,
          disk_total_bytes: 107374182400,
        }),
      ),
      http.get('/api/v1/settings/', () =>
        HttpResponse.json({ check_updates: false, check_printer_firmware: false, library_disk_warning_gb: 5 }),
      ),
      http.get('/api/v1/projects/', () => HttpResponse.json([])),
      http.get('/api/v1/library/tags', () => HttpResponse.json([])),
      http.get('/api/v1/library/trash', ({ request }) => {
        if (new URL(request.url).searchParams.get('limit') === '1') countReads += 1;
        return HttpResponse.json({ items: binned, total: binned.length, retention_days: 30 });
      }),
      http.delete('/api/v1/library/folders/5', () => {
        if (deleteStatus !== 200) return HttpResponse.json({ detail: 'Folder not found' }, { status: deleteStatus });
        binned = [binnedItem(11), binnedItem(12)];
        return HttpResponse.json({ status: 'success', message: 'Folder deleted' });
      }),
    );
  });

  const deleteTheFolder = async () => {
    const row = (await screen.findByText('Parts')).parentElement as HTMLElement;
    const trigger = within(row)
      .getAllByRole('button')
      .find((b) => b.querySelector('.lucide-ellipsis-vertical, .lucide-more-vertical'));
    if (!trigger) throw new Error('no ⋮ trigger on the folder row');
    await userEvent.click(trigger);
    await userEvent.click(within(row).getByRole('button', { name: /^Delete$/i }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^Delete$/i }));
  };

  it('shows its files in an already loaded trash and badge, without a reload', async () => {
    render(
      <>
        <FileManagerPage />
        <TrashListProbe />
      </>,
    );
    // Both are loaded — and cached — before the delete.
    await waitFor(() => expect(screen.getByTestId('trash-list')).toHaveTextContent('0'));
    await waitFor(() => expect(countReads).toBe(1));

    await deleteTheFolder();
    // The delete itself went through — what follows is only about the trash.
    expect(await screen.findByText('Folder deleted')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('trash-list')).toHaveTextContent('2'));
    await waitFor(() => expect(countReads).toBe(2));
  });

  it('refreshes nothing in the trash when the delete fails', async () => {
    deleteStatus = 404;
    render(
      <>
        <FileManagerPage />
        <TrashListProbe />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('trash-list')).toHaveTextContent('0'));
    await waitFor(() => expect(countReads).toBe(1));

    await deleteTheFolder();

    expect(await screen.findByText('Folder not found')).toBeInTheDocument();
    expect(screen.getByTestId('trash-list')).toHaveTextContent('0');
    expect(countReads).toBe(1);
  });
});
