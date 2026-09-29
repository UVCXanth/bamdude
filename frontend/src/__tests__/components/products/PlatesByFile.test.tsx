/**
 * What a product's files actually print.
 *
 * ⚠️ `plate_index: 0` is not "plate zero" — it means the whole file is one
 * recipe (a `.gcode`, an unsliced single-plate 3MF), and calling it "Plate 0"
 * on screen invents a plate the operator will look for and not find.
 *
 * ⚠️ An `unassigned` object is a real object on the plate that no part claims —
 * shown, muted, with the reason in its title. Hiding it is how a product ends
 * up silently under-counting what it prints.
 *
 * ⚠️ The fixture holds TWO different library files both called `lids.3mf` —
 * the ordinary shape of a revised design, one per folder. Grouping on the
 * filename welds them into a single block with two "plate 1"s in it, so the
 * heading count below is what separates grouping per FILE from grouping per
 * name; a fixture whose filenames happened to differ would pass either way.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '../../utils';
import { api } from '../../../api/client';
import { PlatesByFile } from '../../../components/products/PlatesByFile';

describe('PlatesByFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('groups plates by file, names the whole-file plate and mutes objects outside the composition', async () => {
    vi.spyOn(api, 'getProductPlates').mockResolvedValue([
      {
        id: 1,
        library_file_id: 7,
        plate_index: 1,
        filename: 'lids.3mf',
        sliced: true,
        yield: [{ part_id: 1, name: 'lid a', count: 4 }],
        unassigned: [{ name_key: 'lid b', count: 4 }],
        materials: ['PETG'],
        colors: ['#FF0000'],
        printer_model: 'X1C',
        print_time_seconds: 5400,
        filament_used_grams: 33.3,
      },
      {
        id: 2,
        library_file_id: 7,
        plate_index: 2,
        filename: 'lids.3mf',
        sliced: false,
        yield: [],
        unassigned: [],
        materials: [],
        colors: [],
        print_time_seconds: null,
        filament_used_grams: null,
      },
      {
        id: 3,
        library_file_id: 8,
        plate_index: 0,
        filename: 'lids.3mf',
        sliced: true,
        yield: [{ part_id: 2, name: 'flask', count: 1 }],
        unassigned: [],
        materials: ['PLA'],
        colors: [],
        print_time_seconds: 600,
        filament_used_grams: 8,
      },
    ] as never);

    render(<PlatesByFile productId={1} />);

    // Two library files, even though they share a basename.
    expect(await screen.findAllByRole('heading', { level: 3 })).toHaveLength(2);
    expect(screen.getAllByText('lids.3mf')).toHaveLength(2);
    expect(screen.getByText(/whole file/i)).toBeInTheDocument();
    expect(screen.getByText('lid a × 4')).toBeInTheDocument();
    expect(screen.getByText('lid b × 4')).toHaveAttribute('title', expect.stringMatching(/not in composition/i));
    expect(screen.getByText(/not sliced/i)).toBeInTheDocument();
    expect(screen.getByText('1:30')).toBeInTheDocument();
    // The model the plate was sliced for (spec workshop-product-catalog, rule 24).
    expect(screen.getByTitle('Printer model')).toHaveTextContent('X1C');
  });
  it('labels a file the caller cannot open instead of naming it', async () => {
    // WS-13 E1 CL2 / LV4: the plate stays — its numbers are the product's — and the
    // file's name does not reach this caller.
    vi.spyOn(api, 'getProductPlates').mockResolvedValue([
      {
        id: 9,
        library_file_id: 11,
        plate_index: 0,
        filename: null,
        hidden: true,
        sliced: true,
        yield: [{ part_id: 1, name: 'hook', count: 2 }],
        unassigned: [],
        materials: ['PETG'],
        colors: [],
        printer_model: 'P1S',
        print_time_seconds: 3600,
        filament_used_grams: 20,
      },
    ]);
    render(<PlatesByFile productId={3} />);

    expect(await screen.findByRole('heading', { name: 'File you cannot open' })).toBeInTheDocument();
    expect(screen.getByText('P1S')).toBeInTheDocument();
    expect(screen.queryByText('null')).not.toBeInTheDocument();
  });
});
