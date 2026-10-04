/**
 * «Add to order…» from the file manager (WS-13 E13 C01–C03): on a file the server can
 * plan (`plan_eligible`) and only with `orders:update`, from the card's menu, the
 * list row's menu and the plate gallery. It opens the add-to-order dialog with no
 * order — which ACTIVE order is asked first — on the «One-off from a file» tab with
 * the file already picked, and from the gallery with its plate too. Opening it writes
 * the manager's place (folder, page, selection) into the address, so Back from the
 * order the batch went to lands on the same place.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { render } from '../utils';
import { server } from '../mocks/server';
import { FileManagerPage } from '../../pages/FileManagerPage';
import type { Permission } from '../../api/client';

const auth = vi.hoisted(() => ({ granted: new Set<string>(), userId: 5 }));

vi.mock('../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
      canModify: (resource: string, action: string, createdById: number | null | undefined) => {
        if (auth.granted.has(`${resource}:${action}_all`)) return true;
        if (auth.granted.has(`${resource}:${action}_own`)) return createdById != null && createdById === auth.userId;
        return false;
      },
    }),
  };
});

const file = (id: number, name: string, over: Record<string, unknown> = {}) => ({
  id,
  filename: name,
  file_path: `/library/${name}`,
  file_size: 1024,
  file_type: 'gcode',
  file_tags: ['gcode', '3mf', 'sliced'],
  plan_eligible: true,
  product_ids: [],
  folder_id: null,
  thumbnail_path: null,
  print_name: null,
  print_time_seconds: 60,
  duplicate_count: 0,
  created_at: '2026-10-01T00:00:00Z',
  created_by_id: 5,
  ...over,
});

const FILES = [
  file(1, 'clip.gcode.3mf', { file_tags: ['gcode', '3mf', 'sliced', 'multiplate'] }),
  file(2, 'bracket.stl', { file_type: 'stl', file_tags: ['stl', 'geometry'], plan_eligible: false }),
];

const PLATES = {
  file_id: 1,
  filename: 'clip.gcode.3mf',
  is_multi_plate: true,
  plates: [1, 2].map((index) => ({
    index,
    name: `Plate ${index}`,
    objects: ['clip'],
    printable_objects: { [String(index)]: 'clip' },
    object_count: 1,
    has_thumbnail: false,
    thumbnail_url: null,
    print_time_seconds: 60,
    filament_used_grams: 2,
    filaments: [],
  })),
};

const BASE = ['library:read_all', 'library:upload', 'library:update_all', 'orders:read', 'products:read', 'customers:read', 'stock:read'];

function cardOf(name: string): HTMLElement {
  return screen.getByText(name).closest('.group') as HTMLElement;
}

async function openCardMenu(name: string) {
  fireEvent.click(within(cardOf(name)).getByRole('button', { name: 'File actions' }));
}

describe('FileManagerPage — «Add to order…» (E13 C)', () => {
  let filesQueries: URLSearchParams[];

  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/files');
    filesQueries = [];
    auth.granted = new Set([...BASE, 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
    server.use(
      http.get('/api/v1/library/folders', () => HttpResponse.json([])),
      http.get('/api/v1/library/files', ({ request }) => {
        filesQueries.push(new URL(request.url).searchParams);
        return HttpResponse.json({ items: FILES, meta: { total: 2, current_page: 1, per_page: 50, last_page: 3 } });
      }),
      http.get('/api/v1/library/files/:id/plates', () => HttpResponse.json(PLATES)),
      http.get('/api/v1/library/stats', () =>
        HttpResponse.json({ total_files: 2, total_folders: 0, total_size_bytes: 1, disk_free_bytes: 1, disk_total_bytes: 2 }),
      ),
      http.get('/api/v1/settings/', () => HttpResponse.json({ check_updates: false, check_printer_firmware: false })),
      http.get('/api/v1/projects/', () =>
        HttpResponse.json({
          items: [{ id: 5, code: 'OR-0005', name: 'Flasks', status: 'active', customer_name: null }],
          meta: { total: 1, current_page: 1, per_page: 20, last_page: 1 },
        }),
      ),
    );
  });

  it('opens the dialog on the file, at «One-off from a file», asking which active order', async () => {
    render(<FileManagerPage />);
    await screen.findByText('clip.gcode.3mf');
    await openCardMenu('clip.gcode.3mf');
    fireEvent.click(await screen.findByRole('button', { name: 'Add to order…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to order' });
    expect(within(dialog).getByRole('tab', { name: 'One-off from a file' })).toHaveAttribute('aria-selected', 'true');
    expect(await within(dialog).findByRole('radiogroup', { name: 'Plates' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Order' })).toBeInTheDocument();
    expect(await within(dialog).findByRole('option', { name: 'OR-0005 · Flasks · no customer' })).toBeInTheDocument();
  });

  it('offers it only on a file the server can plan, and only with the right to change orders', async () => {
    const { unmount } = render(<FileManagerPage />);
    await screen.findByText('bracket.stl');
    await openCardMenu('bracket.stl');
    await screen.findByRole('button', { name: /Download/ });
    expect(screen.queryByRole('button', { name: 'Add to order…' })).not.toBeInTheDocument();
    unmount();
    auth.granted = new Set(BASE);
    render(<FileManagerPage />);
    await screen.findByText('clip.gcode.3mf');
    await openCardMenu('clip.gcode.3mf');
    await screen.findByRole('button', { name: /Download/ });
    expect(screen.queryByRole('button', { name: 'Add to order…' })).not.toBeInTheDocument();
  });

  it('offers it from the list row’s menu too', async () => {
    localStorage.setItem('library-view-mode', 'list');
    render(<FileManagerPage />);
    const row = (await screen.findByText('clip.gcode.3mf')).closest('[data-file-row]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'File actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to order…' }));
    expect(await screen.findByRole('dialog', { name: 'Add to order' })).toBeInTheDocument();
  });

  it('opens on the plate the gallery shows', async () => {
    render(<FileManagerPage />);
    await screen.findByText('clip.gcode.3mf');
    fireEvent.click(within(cardOf('clip.gcode.3mf')).getByTitle('Plate gallery'));
    const gallery = await screen.findByRole('dialog', { name: /Plate gallery/ });
    fireEvent.click(await within(gallery).findByRole('button', { name: '2' }));
    fireEvent.click(within(gallery).getByRole('button', { name: 'Add to order…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to order' });
    const plates = await within(dialog).findByRole('radiogroup', { name: 'Plates' });
    await waitFor(() => expect(within(plates).getAllByRole('radio')[1]).toBeChecked());
  });

  it('writes its place into the address when the dialog opens, so Back returns there', async () => {
    render(<FileManagerPage />);
    await screen.findByText('clip.gcode.3mf');
    fireEvent.click(within(cardOf('clip.gcode.3mf')).getByLabelText('Select file'));
    await openCardMenu('clip.gcode.3mf');
    fireEvent.click(await screen.findByRole('button', { name: 'Add to order…' }));
    await screen.findByRole('dialog', { name: 'Add to order' });
    const params = new URLSearchParams(window.location.search);
    expect(params.get('page')).toBe('1');
    expect(params.get('selected')).toBe('1');
  });

  it('comes back to the folder, the page and the selection the address names', async () => {
    window.history.replaceState({}, '', '/files?page=2&selected=1');
    render(<FileManagerPage />);
    await screen.findByText('clip.gcode.3mf');
    await waitFor(() => expect(filesQueries.some((q) => q.get('page') === '2')).toBe(true));
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
  });
});
