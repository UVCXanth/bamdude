/**
 * WS-13 E5 E — «One-off from a file»: the library read only with the right to read it
 * (R04), a file row that says whether its type can be planned and whether it is
 * sliced — three different questions, three different answers (R01) — the plates of a
 * sliced file only, their pictures through the media path, and the copies kept when
 * another file is chosen (R08).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '../../../utils';
import { api, ApiError, withMediaToken } from '../../../../api/client';
import type { Permission } from '../../../../api/client';
import { AddToOrderDialog } from '../../../../components/projects/add-to-order/AddToOrderDialog';
import { filesPage, libraryFile, pageOf, pipe, plate, suggestion } from './fixtures';

const auth = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => ({
      ...actual.useAuth(),
      hasPermission: (p: Permission) => auth.granted.has(p),
      hasAnyPermission: (...ps: Permission[]) => ps.some((p) => auth.granted.has(p)),
    }),
  };
});

const ORDER = { id: 5, code: 'OR-0005', name: 'Flasks for Acme', active: true };

const sliced = libraryFile(31, 'clip.gcode.3mf', { folder_id: 4, sliced_for_model: 'X1C' });
const unsliced = libraryFile(32, 'box.3mf', { file_type: '3mf', file_tags: ['3mf'], plan_eligible: true });
const stl = libraryFile(33, 'model.stl', { file_type: 'stl', file_tags: ['stl'], plan_eligible: false });
const rawGcode = libraryFile(34, 'part.gcode', { file_tags: ['gcode'], sliced_for_model: null });
const other = libraryFile(35, 'hook.gcode.3mf', { folder_id: 3 });

const TREE = [
  { id: 3, name: 'Parts', parent_id: null, children: [{ id: 4, name: 'Clips', parent_id: 3, children: [] }] },
];

describe('the one-off tab of «Add to order» (WS-13 E5 E)', () => {
  let getFiles: ReturnType<typeof vi.spyOn>;
  let getPlates: ReturnType<typeof vi.spyOn>;
  let add: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    auth.granted = new Set(['projects:update', 'library:read_own']);
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([], 0));
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    vi.spyOn(api, 'getLibraryFolders').mockResolvedValue(TREE as never);
    getFiles = vi
      .spyOn(api, 'getLibraryFilesPaged')
      .mockResolvedValue(filesPage([sliced, unsliced, stl, rawGcode, other]) as never);
    getPlates = vi.spyOn(api, 'getLibraryFilePlates').mockImplementation(async (id) => ({
      file_id: id,
      filename: 'x',
      plates:
        id === 31
          ? [
              plate(1, { printable_objects: { 1: 'clip', 2: 'clip', 3: 'big' }, filaments: [{ type: 'PETG' }], has_thumbnail: true, thumbnail_url: '/api/v1/library/files/31/plate-thumbnail/1' }),
              plate(2, { name: 'Lids', objects: ['lid', 'lid', 'cap'] }),
            ]
          : id === 35
            ? [plate(1)]
            : id === 32
              ? [plate(1)]
              : [],
      is_multi_plate: id === 31,
    }));
    add = vi.spyOn(api, 'addOrderLines').mockResolvedValue({ order: { id: 5, lines: [] } as never, results: [] });
  });

  async function openFiles() {
    render(<AddToOrderDialog order={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
    await screen.findByRole('button', { name: /clip\.gcode\.3mf/ });
  }
  const fileRow = (name: RegExp) => screen.getByRole('button', { name });

  it('without the right to read the library, explains and reads nothing (R04)', async () => {
    auth.granted = new Set(['projects:update']);
    render(<AddToOrderDialog order={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
    expect(
      await screen.findByText('A one-off product from a file is added by someone who may read the file library.'),
    ).toBeInTheDocument();
    expect(getFiles).not.toHaveBeenCalled();
    expect(api.getLibraryFolders).not.toHaveBeenCalled();
    expect(getPlates).not.toHaveBeenCalled();
  });

  it('says of each file its folder and whether its type can be planned and it is sliced (R01)', async () => {
    await openFiles();
    expect(within(fileRow(/clip\.gcode\.3mf/)).getByText('Clips')).toBeInTheDocument();
    expect(within(fileRow(/clip\.gcode\.3mf/)).getByText('X1C')).toBeInTheDocument();
    expect(within(fileRow(/box\.3mf/)).getByText('not sliced')).toBeInTheDocument();
    expect(within(fileRow(/box\.3mf/)).getByText('Library')).toBeInTheDocument();
    expect(within(fileRow(/model\.stl/)).getByText('STL — cannot be added')).toBeInTheDocument();
    // Sliced without a model: the model is unknown, the file is NOT «not sliced».
    expect(within(fileRow(/^part\.gcode /)).queryByText('not sliced')).not.toBeInTheDocument();
  });

  it('omits a folder it could not read rather than calling it the library', async () => {
    vi.spyOn(api, 'getLibraryFolders').mockRejectedValue(new ApiError('boom', 500));
    await openFiles();
    expect(within(fileRow(/clip\.gcode\.3mf/)).queryByText('Library')).not.toBeInTheDocument();
    expect(within(fileRow(/clip\.gcode\.3mf/)).queryByText('Clips')).not.toBeInTheDocument();
  });

  it('keeps the chosen plate when the chosen file is clicked again (review M4)', async () => {
    await openFiles();
    fireEvent.click(fileRow(/clip\.gcode\.3mf/));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 2/ }));
    fireEvent.click(fileRow(/clip\.gcode\.3mf/));
    expect(screen.getByRole('radio', { name: /Plate 2/ })).toBeChecked();
  });

  // ---- Codex review E5-V01 / V02: the plates the dialog holds follow their answer ----

  /** A client whose plate answers live a minute, as the app's do — a cached answer is reused. */
  const cachedClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  const platesOf = (id: number, plates: ReturnType<typeof plate>[]) => ({
    file_id: id,
    filename: 'x',
    is_multi_plate: plates.length > 1,
    plates,
  });
  function renderWith(client: QueryClient) {
    render(
      <QueryClientProvider client={client}>
        <AddToOrderDialog order={ORDER} onClose={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
  }

  it('V02: a picture that failed for file A does not hide the cached picture of file B', async () => {
    const client = cachedClient();
    for (const id of [31, 35]) {
      client.setQueryData(['library-file-plates', id], platesOf(id, [
        plate(1, { has_thumbnail: true, thumbnail_url: `/api/v1/library/files/${id}/plate-thumbnail/1` }),
      ]));
    }
    renderWith(client);
    fireEvent.click(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ }));
    const first = (await screen.findByRole('radio', { name: /Plate 1/ })).closest('label') as HTMLElement;
    fireEvent.error(first.querySelector('img') as HTMLImageElement);
    expect(first.querySelector('img')).toBeNull();
    fireEvent.click(fileRow(/hook\.gcode\.3mf/));
    const second = (await screen.findByRole('radio', { name: /Plate 1/ })).closest('label') as HTMLElement;
    expect(second.querySelector('img')).toHaveAttribute('src', withMediaToken('/api/v1/library/files/35/plate-thumbnail/1'));
  });

  it('V02: a new picture address for the same plate is tried again, not taken for the failed one', async () => {
    const client = cachedClient();
    client.setQueryData(['library-file-plates', 31], platesOf(31, [
      plate(1, { has_thumbnail: true, thumbnail_url: '/api/v1/library/files/31/plate-thumbnail/1' }),
    ]));
    renderWith(client);
    fireEvent.click(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ }));
    const label = (await screen.findByRole('radio', { name: /Plate 1/ })).closest('label') as HTMLElement;
    fireEvent.error(label.querySelector('img') as HTMLImageElement);
    expect(label.querySelector('img')).toBeNull();
    await act(async () => {
      client.setQueryData(['library-file-plates', 31], platesOf(31, [
        plate(1, { has_thumbnail: true, thumbnail_url: '/api/v1/library/files/31/plate-thumbnail/1?v=2' }),
      ]));
    });
    const again = (await screen.findByRole('radio', { name: /Plate 1/ })).closest('label') as HTMLElement;
    expect(again.querySelector('img')).not.toBeNull();
  });

  it('V01: a chosen plate that disappears from the answer is no longer chosen nor sent', async () => {
    const client = cachedClient();
    client.setQueryData(['library-file-plates', 31], platesOf(31, [plate(1)]));
    renderWith(client);
    fireEvent.click(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 1/ }));
    expect(screen.getByText('One-off from plate 1 × 1')).toBeInTheDocument();
    await act(async () => {
      client.setQueryData(['library-file-plates', 31], platesOf(31, []));
    });
    expect(await screen.findByText('No plates to add.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeDisabled();
    expect(screen.queryByText(/One-off from plate/)).not.toBeInTheDocument();
  });

  it('V01: plate 2 gone from an answer that keeps plate 1 — nothing chosen, and its return chooses nothing', async () => {
    const client = cachedClient();
    client.setQueryData(['library-file-plates', 31], platesOf(31, [plate(1), plate(2)]));
    renderWith(client);
    fireEvent.click(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 2/ }));
    await act(async () => {
      client.setQueryData(['library-file-plates', 31], platesOf(31, [plate(1)]));
    });
    expect(await screen.findByRole('radio', { name: /Plate 1/ })).not.toBeChecked();
    expect(screen.queryByRole('radio', { name: /Plate 2/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeDisabled();
    // The plate coming back is not chosen silently.
    await act(async () => {
      client.setQueryData(['library-file-plates', 31], platesOf(31, [plate(1), plate(2)]));
    });
    expect(await screen.findByRole('radio', { name: /Plate 2/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeDisabled();
  });

  it('V01: a mixed batch sends the other kinds and not the vanished plate', async () => {
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([pipe], 1));
    vi.spyOn(api, 'suggestStock').mockImplementation(async (items) => ({
      items: items.map((item) => suggestion({ product_id: item.product_id })),
    }));
    const client = cachedClient();
    client.setQueryData(['library-file-plates', 31], platesOf(31, [plate(1)]));
    render(
      <QueryClientProvider client={client}>
        <AddToOrderDialog order={ORDER} onClose={() => {}} />
      </QueryClientProvider>,
    );
    fireEvent.click(within(await screen.findByTestId(`add-product-${pipe.id}`)).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
    fireEvent.click(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 1/ }));
    await act(async () => {
      client.setQueryData(['library-file-plates', 31], platesOf(31, []));
    });
    await screen.findByText('No plates to add.');
    fireEvent.click(screen.getByRole('button', { name: 'Add lines (1)' }));
    await waitFor(() => expect(add).toHaveBeenCalled());
    const [, lines] = add.mock.calls[0] as [number, { kind: string }[]];
    expect(lines.map((l) => l.kind)).toEqual(['product']);
  });

  it('V01: a failed re-read of the plates keeps the chosen plate — an error is not an empty answer', async () => {
    const client = cachedClient();
    client.setQueryData(['library-file-plates', 31], platesOf(31, [plate(1)]));
    renderWith(client);
    fireEvent.click(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 1/ }));
    getPlates.mockRejectedValueOnce(new ApiError('boom', 500));
    await act(async () => {
      await client.refetchQueries({ queryKey: ['library-file-plates', 31] });
    });
    expect(screen.getByRole('radio', { name: /Plate 1/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeEnabled();
  });

  it('reads the whole library, not only the files at its root (WS-13 E5 T7)', async () => {
    await openFiles();
    // Without a folder the server lists the root's files alone unless `include_root` is
    // off, and `recursive` means nothing without a folder (routes/library.py list_files):
    // a library kept in folders showed an empty list.
    expect(getFiles).toHaveBeenCalledWith(expect.objectContaining({ include_root: false }));
    expect(getFiles.mock.calls[0][0]).not.toHaveProperty('recursive');
  });

  it('a type that cannot be planned reads no plates and cannot be added (R01)', async () => {
    await openFiles();
    fireEvent.click(fileRow(/model\.stl/));
    expect(
      await screen.findByText('This type of file cannot be added — slice the model and save it as a 3MF.'),
    ).toBeInTheDocument();
    expect(getPlates).not.toHaveBeenCalled();
  });

  it('an unsliced 3MF is told to be sliced even when its metadata lists plates (R01)', async () => {
    await openFiles();
    fireEvent.click(fileRow(/box\.3mf/));
    expect(await screen.findByText('The file is not sliced — slice it first.')).toBeInTheDocument();
    expect(getPlates).not.toHaveBeenCalled();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('a sliced file without plates says there is nothing to add, not that it is unsliced (R01)', async () => {
    await openFiles();
    fireEvent.click(fileRow(/^part\.gcode /));
    expect(await screen.findByText('No plates to add.')).toBeInTheDocument();
  });

  it('says while the plates are read, and a failed read with retry', async () => {
    getPlates.mockImplementationOnce(() => new Promise(() => {}));
    await openFiles();
    fireEvent.click(fileRow(/clip\.gcode\.3mf/));
    expect(await screen.findByText('Reading the plates…')).toBeInTheDocument();
    getPlates.mockRejectedValueOnce(new ApiError('boom', 500));
    fireEvent.click(fileRow(/hook\.gcode\.3mf/));
    expect(await screen.findByText('Could not read the plates')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('radio', { name: /Plate 1/ })).toBeInTheDocument();
  });

  it('draws a plate: its picture through the media path, its objects counted, time, weight, material', async () => {
    await openFiles();
    fireEvent.click(fileRow(/clip\.gcode\.3mf/));
    const first = (await screen.findByRole('radio', { name: /Plate 1/ })).closest('label') as HTMLElement;
    // A decorative picture (alt="") has no img role; read the element itself.
    expect(first.querySelector('img')).toHaveAttribute('src', withMediaToken('/api/v1/library/files/31/plate-thumbnail/1'));
    expect(within(first).getByText(/clip × 2, big × 1/)).toBeInTheDocument();
    expect(within(first).getByText(/PETG/)).toBeInTheDocument();
    const second = (await screen.findByRole('radio', { name: /Plate 2 · Lids/ })).closest('label') as HTMLElement;
    expect(within(second).getByText(/lid × 2, cap × 1/)).toBeInTheDocument();
    // A picture that does not load leaves the placeholder.
    fireEvent.error(first.querySelector('img') as HTMLImageElement);
    expect(first.querySelector('img')).toBeNull();
  });

  it('keeps the copies when another file is chosen, and picks no plate by itself (R08)', async () => {
    await openFiles();
    fireEvent.click(fileRow(/clip\.gcode\.3mf/));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 2/ }));
    fireEvent.change(screen.getByLabelText('Copies of the plate'), { target: { value: '3' } });
    fireEvent.click(fileRow(/hook\.gcode\.3mf/));
    const only = await screen.findByRole('radio', { name: /Plate 1/ });
    expect(only).not.toBeChecked();
    expect(screen.getByLabelText('Copies of the plate')).toHaveValue(3);
    fireEvent.click(only);
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(5, [{ kind: 'plate', library_file_id: 35, plate_index: 1, copies: 3 }]),
    );
  });

  it('keeps the chosen file when a search takes it off the list (E05)', async () => {
    await openFiles();
    fireEvent.click(fileRow(/clip\.gcode\.3mf/));
    await screen.findByRole('radio', { name: /Plate 1/ });
    getFiles.mockResolvedValue(filesPage([]) as never);
    fireEvent.change(within(screen.getByRole('tabpanel')).getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Plate 1/ })).toBeInTheDocument();
  });

  it('says the library is empty, a failed read with retry', async () => {
    getFiles.mockResolvedValue(filesPage([]) as never);
    render(<AddToOrderDialog order={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
    expect(await screen.findByText('The library has no files')).toBeInTheDocument();
  });

  it('says a failed library read and asks again', async () => {
    getFiles.mockRejectedValue(new ApiError('Forbidden', 403));
    render(<AddToOrderDialog order={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
    expect(await screen.findByText('Could not load the files')).toBeInTheDocument();
    getFiles.mockResolvedValue(filesPage([sliced]) as never);
    fireEvent.click(within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /clip\.gcode\.3mf/ })).toBeInTheDocument();
  });
});
