import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import { AddToOrderDialog } from '../../../../components/projects/add-to-order/AddToOrderDialog';
import { filesPage, libraryFile, pageOf, plate } from './fixtures';

describe('the one-off tab of «Add to order»', () => {
  let getFiles: ReturnType<typeof vi.spyOn>;
  let getPlates: ReturnType<typeof vi.spyOn>;
  let add: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'getProductsPaged').mockResolvedValue(pageOf([], 0));
    vi.spyOn(api, 'getProductCategories').mockResolvedValue([]);
    vi.spyOn(api, 'getProductFacets').mockResolvedValue({ materials: [], colors: [], models: [] });
    getFiles = vi
      .spyOn(api, 'getLibraryFilesPaged')
      .mockResolvedValue(filesPage([libraryFile(31, 'flask.gcode.3mf'), libraryFile(32, 'model.stl')]) as never);
    getPlates = vi.spyOn(api, 'getLibraryFilePlates').mockImplementation(async (id) => ({
      file_id: id,
      filename: 'flask.gcode.3mf',
      plates: id === 31 ? [plate(1), plate(2, { name: 'Lids', object_count: 1, objects: ['lid'] })] : [],
      is_multi_plate: id === 31,
    }));
    add = vi.spyOn(api, 'addOrderLines').mockResolvedValue({ order: { id: 5, lines: [] } as never, results: [] });
  });

  function open() {
    render(<AddToOrderDialog orderId={5} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
  }

  it('searches the whole library on the server', async () => {
    open();
    expect(await screen.findByRole('button', { name: 'flask.gcode.3mf' })).toBeInTheDocument();
    expect(getFiles).toHaveBeenLastCalledWith({ recursive: true, page: 1, per_page: 24 });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'flask' } });
    await waitFor(() => expect(getFiles).toHaveBeenLastCalledWith({ recursive: true, page: 1, per_page: 24, q: 'flask' }));
  });

  it('adds a plate of the picked file, in copies', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'flask.gcode.3mf' }));
    expect(getPlates).toHaveBeenCalledWith(31);
    const second = await screen.findByRole('radio', { name: /Plate 2 · Lids/ });
    expect(screen.getAllByText('3 objects')).toHaveLength(1);
    expect(screen.getAllByText('1h 30m · 12g')).toHaveLength(2);
    fireEvent.click(second);
    fireEvent.change(screen.getByLabelText('Copies of the plate'), { target: { value: '4' } });
    expect(screen.getByText('A one-off product will be made from the plate')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(5, [{ kind: 'plate', library_file_id: 31, plate_index: 2, copies: 4 }]),
    );
  });

  it('a file with no plates has to be sliced first', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'model.stl' }));
    expect(await screen.findByText('Slice it first — the file has no plates yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeDisabled();
  });

  it('a refusal of the server is its sentence', async () => {
    add.mockRejectedValue(new ApiError('Only 3MF files can be planned', 422));
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'flask.gcode.3mf' }));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    expect(await screen.findByText('Only 3MF files can be planned')).toBeInTheDocument();
  });
});
