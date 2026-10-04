/**
 * The «Plates and files» tab of the product page (WS-13 E9 E01–E05): one card per linked
 * file from `GET /products/{id}/files` — its plates, what each gives, time, filament and
 * material — the linked folders, and the doors: re-read the card, link in the File
 * Manager, unlink a file or a folder. A file is unlinked by the link that holds it NOW:
 * one inside a linked folder goes with its folder (the server keeps no history of how a
 * file joined). The tab asks nothing of `/library/*`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { render } from '../../../utils';
import { api, ApiError } from '../../../../api/client';
import type { Permission, PlateRecipe, Product, ProductFileGroup, ProductFileGroups } from '../../../../api/client';
import { PlatesFilesTab } from '../../../../components/products/detail/PlatesFilesTab';

const auth = vi.hoisted(() => ({ granted: null as Set<string> | null }));
vi.mock('../../../../contexts/AuthContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../contexts/AuthContext')>();
  return {
    ...actual,
    useAuth: () => {
      const real = actual.useAuth();
      return {
        ...real,
        hasPermission: (p: Permission) => auth.granted?.has(p) ?? real.hasPermission(p),
        hasAnyPermission: (...ps: Permission[]) => (auth.granted ? ps.some((p) => auth.granted!.has(p)) : real.hasAnyPermission(...ps)),
      };
    },
  };
});

function plate(over: Partial<PlateRecipe> & Pick<PlateRecipe, 'id' | 'library_file_id' | 'plate_index'>): PlateRecipe {
  return {
    filename: null,
    hidden: false,
    sliced: true,
    yield: [],
    unassigned: [],
    materials: [],
    colors: [],
    printer_model: null,
    print_time_seconds: null,
    filament_used_grams: null,
    ...over,
  };
}

function file(over: Partial<ProductFileGroup> & Pick<ProductFileGroup, 'library_file_id'>): ProductFileGroup {
  return {
    filename: null,
    hidden: false,
    folder_id: null,
    folder_name: null,
    file_type: '3mf',
    plan_eligible: true,
    printer_model: null,
    sliced_any: true,
    plates: [],
    is_3mf: true,
    in_linked_folder: false,
    ...over,
  };
}

const groups: ProductFileGroups = {
  files: [
    file({
      library_file_id: 30,
      filename: 'body.3mf',
      folder_id: 16,
      folder_name: 'Flask',
      printer_model: 'X1C',
      in_linked_folder: true,
      plates: [
        plate({
          id: 1,
          library_file_id: 30,
          plate_index: 1,
          yield: [{ part_id: 1, name: 'Body', count: 2 }],
          unassigned: [{ name_key: 'cube', count: 1 }],
          materials: ['PLA', 'PETG'],
          colors: ['#FF0000'],
          print_time_seconds: 3600,
          filament_used_grams: 12.5,
        }),
      ],
    }),
    file({ library_file_id: 31, filename: 'lid.stl', file_type: 'stl', plan_eligible: false, sliced_any: false, is_3mf: false }),
    file({
      library_file_id: 32,
      filename: 'whole.gcode',
      file_type: 'gcode',
      is_3mf: false,
      plates: [plate({ id: 3, library_file_id: 32, plate_index: 0, print_time_seconds: 60, filament_used_grams: 2 })],
    }),
    file({
      library_file_id: 40,
      hidden: true,
      printer_model: 'P1S',
      plates: [plate({ id: 4, library_file_id: 40, plate_index: 2, hidden: true, print_time_seconds: 120, filament_used_grams: 3 })],
    }),
    file({ library_file_id: 41, hidden: true, in_linked_folder: true }),
  ],
  hidden_files: 2,
  folders: [
    { folder_id: 16, name: 'Flask', hidden: false },
    { folder_id: 20, name: null, hidden: true },
  ],
};

const product = { id: 7, code: 'PR-0007', name: 'Flask' } as Product;
const onReread = vi.fn();

function Host() {
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Flask
      </h1>
      <PlatesFilesTab product={product} headingRef={heading} onReread={onReread} />
    </>
  );
}

const card = (id: number) => screen.getByTestId(`product-file-${id}`);
const EDITOR_WITH_LIBRARY = ['orders:read', 'products:read', 'customers:read', 'stock:read', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust', 'library:read_all'];

describe('PlatesFilesTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    onReread.mockReset();
    auth.granted = new Set(EDITOR_WITH_LIBRARY);
    vi.spyOn(api, 'getProductFileGroups').mockResolvedValue(groups);
  });

  describe('E02–E03 the file cards and their plates', () => {
    it('one card per file in the server’s order — the files you cannot open after the named ones', async () => {
      render(<Host />);
      await screen.findByTestId('product-file-30');
      const cards = screen.getAllByTestId(/^product-file-\d+$/);
      expect(cards.map((c) => c.dataset.testid)).toEqual([
        'product-file-30',
        'product-file-31',
        'product-file-32',
        'product-file-40',
        'product-file-41',
      ]);
      expect(within(card(30)).getByText('body.3mf')).toBeInTheDocument();
      expect(within(card(30)).getByText('Flask')).toBeInTheDocument();
      // No «N more»: the hidden files ARE these cards.
      expect(screen.queryByText(/more/i)).not.toBeInTheDocument();
    });

    it('right of the name: the model, «sliced» without one, amber «not sliced» by `sliced_any`', async () => {
      render(<Host />);
      expect(within(await screen.findByTestId('product-file-30')).getByTestId('product-model-chip')).toHaveTextContent('X1C');
      expect(within(card(32)).getByText('sliced')).toBeInTheDocument();
      expect(within(card(31)).getByText('not sliced')).toBeInTheDocument();
    });

    it('a plate’s row: number, the parts it gives, time, filament, material and colour', async () => {
      render(<Host />);
      const row = within(await screen.findByTestId('product-file-30')).getByTestId('plate-1');
      expect(within(row).getByText('Plate 1')).toBeInTheDocument();
      expect(within(row).getByText('Body × 2')).toBeInTheDocument();
      // An object no part claims is shown, dashed, with why.
      const stray = within(row).getByText('cube × 1');
      expect(stray).toHaveAttribute('title', expect.stringMatching(/not in composition/i));
      expect(stray.className).toContain('border-dashed');
      expect(within(row).getByText('1h 0m')).toBeInTheDocument();
      expect(within(row).getByText('13g')).toBeInTheDocument();
      expect(within(row).getByText('PLA, PETG')).toBeInTheDocument();
      expect(within(row).getByTitle('Red')).toBeInTheDocument();
    });

    it('plate 0 is the whole file; an STL has no plates and says what to do', async () => {
      render(<Host />);
      expect(within(await screen.findByTestId('product-file-32')).getByText('the whole file')).toBeInTheDocument();
      expect(within(card(31)).getByText(/has no plates: slice it/i)).toBeInTheDocument();
    });

    it('a file you cannot open: its plates and numbers, no name, folder or link', async () => {
      render(<Host />);
      const hidden = await screen.findByTestId('product-file-40');
      expect(within(hidden).getByText('A file you cannot open')).toBeInTheDocument();
      expect(within(hidden).getByText('Plate 2')).toBeInTheDocument();
      expect(within(hidden).getByText('2m')).toBeInTheDocument();
      expect(within(hidden).queryByRole('link')).not.toBeInTheDocument();
    });
  });

  describe('E02 unlinking a file by the link that holds it', () => {
    it('a file in a linked folder has no unlink of its own — it goes with the folder', async () => {
      render(<Host />);
      const linked = await screen.findByTestId('product-file-30');
      expect(within(linked).queryByRole('button', { name: 'Unlink file' })).not.toBeInTheDocument();
      expect(within(linked).getByText('through the folder «Flask»')).toBeInTheDocument();
      expect(within(card(41)).getByText('through a linked folder')).toBeInTheDocument();
    });

    it('a file linked on its own is unlinked with the consequences said, and the views refresh', async () => {
      const unlink = vi.spyOn(api, 'unlinkProductFile').mockResolvedValue({} as never);
      render(<Host />);
      fireEvent.click(within(await screen.findByTestId('product-file-31')).getByRole('button', { name: 'Unlink file' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Unlink the file «lid.stl» from the product?')).toBeInTheDocument();
      expect(within(dialog).getByText(/plates leave the product/i)).toBeInTheDocument();
      act(() => {
        within(dialog).getByRole('button', { name: 'Unlink' }).click();
        within(dialog).getByRole('button', { name: 'Unlink' }).click();
      });
      await waitFor(() => expect(unlink).toHaveBeenCalledTimes(1));
      expect(unlink).toHaveBeenCalledWith(7, 31);
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(api.getProductFileGroups).toHaveBeenCalledTimes(2));
    });

    it('the unlinked card leaves with the re-read and the heading takes the focus', async () => {
      vi.spyOn(api, 'unlinkProductFile').mockResolvedValue({} as never);
      // The re-read answers after the confirmation has closed and given the focus back.
      let reread: (v: ProductFileGroups) => void = () => {};
      vi.spyOn(api, 'getProductFileGroups')
        .mockResolvedValueOnce(groups)
        .mockReturnValueOnce(new Promise<ProductFileGroups>((resolve) => (reread = resolve)));
      render(<Host />);
      const opener = within(await screen.findByTestId('product-file-31')).getByRole('button', { name: 'Unlink file' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog');
      act(() => within(dialog).getByRole('button', { name: 'Unlink' }).click());
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(opener).toHaveFocus();
      await act(async () => reread({ ...groups, files: groups.files.filter((f) => f.library_file_id !== 31) }));
      await waitFor(() => expect(screen.queryByTestId('product-file-31')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Flask' })).toHaveFocus());
    });

    it('a file you cannot open is named neutrally', async () => {
      render(<Host />);
      fireEvent.click(within(await screen.findByTestId('product-file-40')).getByRole('button', { name: 'Unlink file' }));
      expect(await screen.findByText('Unlink the file you cannot open (#40) from the product?')).toBeInTheDocument();
    });

    it('a refusal stays in the dialog', async () => {
      vi.spyOn(api, 'unlinkProductFile').mockRejectedValue(new ApiError('Not linked', 404));
      render(<Host />);
      fireEvent.click(within(await screen.findByTestId('product-file-31')).getByRole('button', { name: 'Unlink file' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
      expect(await within(dialog).findByText('Not linked')).toBeInTheDocument();
    });
  });

  describe('E04 the linked folders', () => {
    it('a chip per folder — a link into the File Manager — and «a folder you cannot open» without a name', async () => {
      render(<Host />);
      const folders = await screen.findByTestId('product-folders');
      expect(within(folders).getByRole('link', { name: /Flask/ })).toHaveAttribute('href', '/files?folder=16');
      expect(within(folders).getByText('A folder you cannot open')).toBeInTheDocument();
    });

    it('unlinking a folder says everything it takes with it', async () => {
      const unlink = vi.spyOn(api, 'unlinkProductFolder').mockResolvedValue({} as never);
      render(<Host />);
      const folders = await screen.findByTestId('product-folders');
      fireEvent.click(within(folders).getByRole('button', { name: 'Unlink folder «Flask»' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Unlink the folder «Flask» from the product?')).toBeInTheDocument();
      expect(within(dialog).getByText(/files linked on their own too/i)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }));
      await waitFor(() => expect(unlink).toHaveBeenCalledWith(7, 16));
    });
  });

  describe('E01 the doors and the reader’s rights', () => {
    it('re-read and link for an editor who reads the library', async () => {
      render(<Host />);
      await screen.findByTestId('product-file-30');
      fireEvent.click(screen.getByRole('button', { name: 'Re-read the card from a file…' }));
      expect(onReread).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('link', { name: 'Link a file…' })).toHaveAttribute('href', '/files');
    });

    it('an editor without the library: no «Link a file…», no links into it — unlinking stays', async () => {
      auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read', 'orders:update', 'products:update', 'customers:update', 'stock:move', 'stock:adjust']);
      render(<Host />);
      await screen.findByTestId('product-file-30');
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('product-folders')).getByText('Flask')).toBeInTheDocument();
      expect(within(card(31)).getByRole('button', { name: 'Unlink file' })).toBeInTheDocument();
    });

    it('a reader: no doors at all', async () => {
      auth.granted = new Set(['orders:read', 'products:read', 'customers:read', 'stock:read', 'library:read_all']);
      render(<Host />);
      await screen.findByTestId('product-file-30');
      expect(screen.queryByRole('button', { name: 'Re-read the card from a file…' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Link a file…' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /unlink/i })).not.toBeInTheDocument();
    });

    it('asks nothing of the library', async () => {
      const library = vi.spyOn(api, 'getLibraryFiles');
      const folders = vi.spyOn(api, 'getFoldersByProduct');
      render(<Host />);
      await screen.findByTestId('product-file-30');
      expect(library).not.toHaveBeenCalled();
      expect(folders).not.toHaveBeenCalled();
    });
  });

  describe('E05 empty and failed', () => {
    it('no files: says so, with the way to the File Manager for a library reader', async () => {
      vi.spyOn(api, 'getProductFileGroups').mockResolvedValue({ files: [], hidden_files: 0, folders: [] });
      render(<Host />);
      expect(await screen.findByText('No files yet')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Link a file or a folder in the File Manager.' })).toHaveAttribute('href', '/files');
    });

    it('a failure with nothing to show is a sentence and a retry — never «no files»', async () => {
      const get = vi.spyOn(api, 'getProductFileGroups').mockRejectedValueOnce(new Error('boom'));
      render(<Host />);
      expect(await screen.findByText('Could not load the product’s files')).toBeInTheDocument();
      expect(screen.queryByText('No files yet')).not.toBeInTheDocument();
      get.mockResolvedValue(groups);
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByTestId('product-file-30')).toBeInTheDocument();
    });
  });
});
