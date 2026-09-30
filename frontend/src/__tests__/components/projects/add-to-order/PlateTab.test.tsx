import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import { AddToOrderDialog } from '../../../../components/projects/add-to-order/AddToOrderDialog';
import { filesPage, libraryFile, pageOf, plate } from './fixtures';


/** The order the dialog is opened from (WS-13 E5: the dialog names it). */
const ORDER = { id: 5, code: 'OR-0005', name: 'Flasks for Acme', active: true };

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
      .mockResolvedValue(filesPage([libraryFile(31, 'flask.gcode.3mf'), libraryFile(32, 'model.stl', { file_type: 'stl', file_tags: ['stl'], plan_eligible: false })]) as never);
    getPlates = vi.spyOn(api, 'getLibraryFilePlates').mockImplementation(async (id) => ({
      file_id: id,
      filename: 'flask.gcode.3mf',
      plates: id === 31 ? [plate(1), plate(2, { name: 'Lids', object_count: 1, objects: ['lid'] })] : [],
      is_multi_plate: id === 31,
    }));
    add = vi.spyOn(api, 'addOrderLines').mockResolvedValue({ order: { id: 5, lines: [] } as never, results: [] });
  });

  function open() {
    render(<AddToOrderDialog order={ORDER} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'One-off from a file' }));
  }

  it('searches the whole library on the server', async () => {
    open();
    expect(await screen.findByRole('button', { name: /^flask\.gcode\.3mf/ })).toBeInTheDocument();
    expect(getFiles).toHaveBeenLastCalledWith({ recursive: true, page: 1, per_page: 24 });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'flask' } });
    await waitFor(() => expect(getFiles).toHaveBeenLastCalledWith({ recursive: true, page: 1, per_page: 24, q: 'flask' }));
  });

  it('adds a plate of the picked file, in copies', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^flask\.gcode\.3mf/ }));
    expect(getPlates).toHaveBeenCalledWith(31);
    const second = await screen.findByRole('radio', { name: /Plate 2 · Lids/ });
    // WS-13 E5 E07: each plate's objects counted, then time and weight.
    expect(screen.getByText('lid × 1 · 1h 30m · 12g')).toBeInTheDocument();
    expect(screen.getAllByText(/1h 30m · 12g/)).toHaveLength(2);
    fireEvent.click(second);
    fireEvent.change(screen.getByLabelText('Copies of the plate'), { target: { value: '4' } });
    // WS-13 E5 B03: the summary names the plate and the copies.
    expect(screen.getByText('One-off from plate 2 × 4')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(5, [{ kind: 'plate', library_file_id: 31, plate_index: 2, copies: 4 }]),
    );
  });

  it('a file whose type cannot be planned says so and cannot be added', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^model\.stl/ }));
    // WS-13 E5 R01: a type that cannot be planned is said as such, and reads no plates.
    expect(
      await screen.findByText('This type of file cannot be added — slice the model and save it as a 3MF.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and add' })).toBeDisabled();
  });

  it('a refusal of the server is its sentence', async () => {
    add.mockRejectedValue(new ApiError('Only 3MF files can be planned', 422));
    open();
    fireEvent.click(await screen.findByRole('button', { name: /^flask\.gcode\.3mf/ }));
    fireEvent.click(await screen.findByRole('radio', { name: /Plate 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create and add' }));
    expect(await screen.findByText('Only 3MF files can be planned')).toBeInTheDocument();
  });
});
